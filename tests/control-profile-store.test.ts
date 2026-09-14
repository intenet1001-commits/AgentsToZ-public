import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,renameSync,existsSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ControlProfileStore,controlMemoryRevision,readControlProfileAccess,controlProfileAccessPath,type ControlProfileCandidate,type ControlProfileSeed} from '../src/controlProfileStore';
import {addressedAgentsToZ,CONTROL_PROFILE_MARKER} from '../src/controlProfileContract';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'control-profile-'));dirs.push(dir);let candidates:ControlProfileCandidate[]=[],seed:ControlProfileSeed|null=null,restoreCalls=0,saveCalls=0;
 const memories=new Map<string,{memoryId:string;document:string;savedAt:string}>();
 const deps={candidates:async()=>candidates,seed:async()=>seed,restore:async(s:ControlProfileSeed)=>{restoreCalls++;throw new Error('offline');},initialize:async(root:string,memoryId:string)=>{if(!memories.has(root))memories.set(root,{memoryId,document:'# Operating memory\n',savedAt:'2026-09-14T00:00:00Z'});},snapshot:(root:string)=>{const m=memories.get(root);if(!m)throw new Error('missing');return {...m,root};},save:async(root:string,expected:string,entry:{id:string;title:string;body:string})=>{const m=memories.get(root)!;expect(controlMemoryRevision(m.document)).toBe(expected);m.document+=`\n### ${entry.title}\n<!-- memory-entry-id:${entry.id} -->\n${entry.body}\n`;saveCalls++;},register:async()=>randomUUID()};
 return {dir,memories,deps,store:new ControlProfileStore(dir,deps),setCandidates:(c:ControlProfileCandidate[])=>candidates=c,setSeed:(s:ControlProfileSeed)=>seed=s,restoreCalls:()=>restoreCalls,saveCalls:()=>saveCalls};
}
describe('user-wide Control profile',()=>{
 test('status is read-only; a new profile needs no registered project; restarts reuse memory and access',async()=>{
  const f=fixture();expect(f.store.status().state).toBe('unprepared');expect(existsSync(join(f.dir,'control-profile'))).toBe(false);
  const first=await f.store.prepare();expect(first.state).toBe('ready');expect(first.projectId).toBeNull();expect(first.backend).toBe('app-data');
  const access=readControlProfileAccess(f.dir)!;expect(f.store.authorize(access.token)).toBe(true);expect(f.store.authorize('x'.repeat(64))).toBe(false);
  const again=await new ControlProfileStore(f.dir,f.deps).prepare();expect(again.profileId).toBe(first.profileId);expect(again.memoryId).toBe(first.memoryId);expect(readControlProfileAccess(f.dir)).toEqual(access);
 });
 test('adopts existing memory without initialization and follows identity after folder rename',async()=>{
  const f=fixture(),root=join(f.dir,'Control'),memoryId=randomUUID();mkdirSync(root);f.memories.set(root,{memoryId,document:'### Preference\nKeep my decisions\n',savedAt:'2026-09-01'});f.setCandidates([{root,memoryId,projectId:'registered'}]);
  const first=await f.store.prepare();expect(first.state).toBe('ready');expect(first.memoryId).toBe(memoryId);expect(f.store.read().snapshot.document).toContain('Keep my decisions');
  const moved=join(f.dir,'Renamed');renameSync(root,moved);f.memories.set(moved,f.memories.get(root)!);f.memories.delete(root);f.setCandidates([{root:moved,memoryId,projectId:'registered'}]);
  const again=await f.store.prepare();expect(again.state).toBe('ready');expect(again.profileId).toBe(first.profileId);expect(JSON.parse(readFileSync(join(moved,CONTROL_PROFILE_MARKER),'utf8')).memoryId).toBe(memoryId);
 });
 test('uncertain restore never falls back to an empty new memory',async()=>{
  const f=fixture(),seed:ControlProfileSeed={schemaVersion:1,profileId:randomUUID(),memoryId:randomUUID(),repositoryUrl:'https://github.com/test-owner/Control.git',repositoryNodeId:'R_test'};f.setSeed(seed);
  expect((await f.store.prepare()).state).toBe('needs-attention');expect(f.memories.size).toBe(0);expect(f.restoreCalls()).toBe(1);
  expect((await f.store.prepare()).profileId).toBe(seed.profileId);expect(f.memories.size).toBe(0);
 });
 test('concurrent starts produce one identity and preserve incomplete/corrupt files',async()=>{
  const f=fixture();const [a,b]=await Promise.all([f.store.prepare(),f.store.prepare()]);expect(a.profileId).toBe(b.profileId);
  writeFileSync(join(f.dir,'control-profile','binding.json'),'broken');await f.store.prepare();expect(readFileSync(join(f.dir,'control-profile','binding.json'),'utf8')).toBe('broken');
 });
 test('two OS-user data directories do not share capabilities',async()=>{
  const a=fixture(),b=fixture();await a.store.prepare();await b.store.prepare();expect(b.store.authorize(readControlProfileAccess(a.dir)!.token)).toBe(false);
 });
 test('lost access key and memory ID mismatch remain blocked, without silent regeneration',async()=>{
  const f=fixture();await f.store.prepare();rmSync(controlProfileAccessPath(f.dir));expect((await f.store.prepare()).state).toBe('needs-attention');expect(existsSync(controlProfileAccessPath(f.dir))).toBe(false);
  const g=fixture();await g.store.prepare();const m=[...g.memories.values()][0]!;m.memoryId=randomUUID();expect((await g.store.prepare()).state).toBe('needs-attention');
 });
 test('proposal is not a save, retries deduplicate, review saves once and conflicts preserve candidates',async()=>{
  const f=fixture();await f.store.prepare();const input={requestId:'request-1',title:'Operating preference',body:'Prefer verified results.',evidence:'The user requested this.',expectedRevision:f.store.status().revision};
  const p=await f.store.propose(input);expect(p.state).toBe('pending');expect(f.saveCalls()).toBe(0);expect((await f.store.propose(input)).id).toBe(p.id);
  await expect(f.store.propose({...input,body:'Different'})).rejects.toThrow();
  const saved=await f.store.review(p.id,true,input.expectedRevision!);expect(saved.state).toBe('saved');await f.store.review(p.id,true,input.expectedRevision!);expect(f.saveCalls()).toBe(1);
  await expect(f.store.propose({...input,requestId:'new'})).rejects.toThrow();
 });
 test('a document committed before receipt persistence is recognized on retry',async()=>{
  const f=fixture();await f.store.prepare();const p=await f.store.propose({requestId:'recover',title:'Durable',body:'Keep',evidence:'User',expectedRevision:f.store.status().revision});
  await f.store.review(p.id,true,f.store.status().revision!);const file=join(f.dir,'control-profile','proposals.json'),data=JSON.parse(readFileSync(file,'utf8'));data.items[0].state='pending';writeFileSync(file,JSON.stringify(data));
  expect((await f.store.review(p.id,true,p.baseRevision)).state).toBe('saved');expect(f.saveCalls()).toBe(1);
 });
 test('attaching an existing Control preserves both memories and refuses a nonempty operating profile',async()=>{
  const f=fixture(),first=await f.store.prepare(),oldRoot=f.store.read().binding.root,root=join(f.dir,'Existing'),memoryId=randomUUID();mkdirSync(root);
  f.memories.set(root,{memoryId,document:'# Existing decisions\n',savedAt:'2026-09-14'});f.setCandidates([{root,memoryId,projectId:'existing'}]);
  const oldAccess=readControlProfileAccess(f.dir)!;
  const attached=await f.store.attach('existing',first.profileId!);expect(attached.memoryId).toBe(memoryId);expect(attached.profileId).toBe(memoryId);expect(f.memories.get(oldRoot)?.document).toBe('# Operating memory\n');
  expect(f.store.authorize(oldAccess.token)).toBe(false);expect((await f.store.prepare()).memoryId).toBe(memoryId);
  const g=fixture();await g.store.prepare();g.memories.get(g.store.read().binding.root)!.document+='User decision';g.setCandidates([{root,memoryId,projectId:'existing'}]);
  await expect(g.store.attach('existing',g.store.status().profileId!)).rejects.toThrow('현재 운영 기억');
 });
 test('an interrupted explicit attachment resumes its exact planned capability at every commit boundary',async()=>{
  for(const phase of ['planned','binding','access','ready']){
   const f=fixture();await f.store.prepare();const old=f.store.read().binding,access=readControlProfileAccess(f.dir)!,root=join(f.dir,'Existing'),memoryId=randomUUID();mkdirSync(root);
   f.memories.set(root,{memoryId,document:'# Restored decisions\n',savedAt:'2026-09-14'});
   const next={...old,profileId:memoryId,memoryId,root,projectId:'existing',backend:'control-folder',state:'preparing'},nextAccess={schemaVersion:1,profileId:memoryId,token:'d'.repeat(64)};
   writeFileSync(join(f.dir,'control-profile','attach-transition.json'),JSON.stringify({schemaVersion:1,previousProfileId:old.profileId,previousAccessHash:controlMemoryRevision(access.token),next,nextAccess}),{mode:0o600});
   if(phase!=='planned')writeFileSync(join(f.dir,'control-profile','binding.json'),JSON.stringify({...next,state:phase==='ready'?'ready':'preparing'}));
   if(phase==='access'||phase==='ready')writeFileSync(controlProfileAccessPath(f.dir),JSON.stringify(nextAccess));
   const restarted=new ControlProfileStore(f.dir,f.deps);expect((await restarted.prepare()).state).toBe('ready');expect(restarted.status().memoryId).toBe(memoryId);expect(restarted.authorize(nextAccess.token)).toBe(true);expect(existsSync(join(f.dir,'control-profile','attach-transition.json'))).toBe(false);
  }
 });
 test('separate store instances serialize startup without creating a second identity',async()=>{
  const f=fixture(),other=new ControlProfileStore(f.dir,f.deps);await Promise.all([f.store.prepare(),other.prepare()]);
  expect((await other.prepare()).profileId).toBe(f.store.status().profileId);expect(f.memories.size).toBe(1);
 });
 test('multiple existing Controls require a listed selection and never create a blank replacement',async()=>{
  const f=fixture(),items=['one','two'].map(projectId=>{const root=join(f.dir,projectId),memoryId=randomUUID();mkdirSync(root);f.memories.set(root,{memoryId,document:'# Prior memory\n',savedAt:'2026-09-14'});return {root,memoryId,projectId};});f.setCandidates(items);
  expect((await f.store.prepare()).state).toBe('needs-attention');expect(f.memories.size).toBe(2);
  const selected=await f.store.prepare('two');expect(selected.state).toBe('ready');expect(selected.memoryId).toBe(items[1]!.memoryId);
 });
 test('name recognition handles aliases, but not quotations or mere mentions',()=>{
  for(const name of ['agentstoz','AGENTSTOZ','아젠투지','에이전츠투지','/agentstoz','$agentstoz'])expect(addressedAgentsToZ(`${name}, 목록 보여줘`)?.request).toBe('목록 보여줘');
  expect(addressedAgentsToZ('아젠투지')).toEqual({request:''});expect(addressedAgentsToZ('"아젠투지, 삭제해"라는 문장')).toBeNull();expect(addressedAgentsToZ('agentstoz-project')).toBeNull();expect(addressedAgentsToZ('설명에 아젠투지를 넣어')).toBeNull();
 });
});
