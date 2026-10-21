import {afterAll,beforeAll,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory} from '../project-memory-server';
import {CONTROL_PROFILE_CONTROLLER,CONTROL_PROFILE_HEADER} from '../src/controlProfileContract';
import {readControlProfileAccess} from '../src/controlProfileStore';
import {startTestApiServer} from './startTestApiServer';

/**
 * One real API (isolated HOME and app data). Review 2026-09-29:
 * - C5: resolve-target used the OPS profile's bound project for the OPS role, but list-projects and
 *   project-status did not — an OPS folder with its own name was 'ops' in one answer and 'managed'
 *   (or 'unknown') in the others for the same id.
 * - C6: text resolved against every registered folder that exists, voice against the runtime
 *   inventory, which leaves out rows sharing one folder — 「쌍둥이」 resolved in chat but not by voice
 *   (and no workroom can start there).
 */
let f:Awaited<ReturnType<typeof fixture>>;
beforeAll(async()=>{f=await fixture();},60_000);
afterAll(async()=>{f?.child.kill();await f?.child.exited;if(f)rmSync(f.home,{recursive:true,force:true});});

async function fixture(){
  const home=realpathSync(mkdtempSync(join(tmpdir(),'agentstoz-use-consistency-')));
  const data=join(home,'app-data'),ops=join(home,'운영센터'),plain=join(home,'projects','plain-app'),twin=join(home,'projects','twin');
  for(const path of [data,ops,plain,twin])mkdirSync(path,{recursive:true});
  for(const path of [ops,plain,twin])expect(Bun.spawnSync(['git','init','-q',path]).success).toBe(true);
  initializeProjectMemory({folderPath:ops,projectName:'운영센터',autoBackup:false});
  writeFileSync(join(ops,'CONTROL.md'),'# AgentsToZ OPS fixture\n');
  // Registered under the OPS name first so the profile can be prepared on it; renamed below.
  const ports=[
    {id:'ops-project',name:'AgentsToZ-OPS',folderPath:ops},
    {id:'plain-project',name:'plain-app',folderPath:plain},
    {id:'twin-a',name:'쌍둥이',folderPath:twin},
    {id:'twin-b',name:'쌍둥이 사본',folderPath:twin},
  ];
  writeFileSync(join(data,'ports.json'),JSON.stringify(ports));
  const bin=join(home,'.local','bin');mkdirSync(bin,{recursive:true});
  for(const agent of ['codex','claude','hermes','agy']){writeFileSync(join(bin,agent),'#!/bin/sh\nstty -echo\nprintf "READY\\n"\nwhile IFS= read -r line; do :; done\n');chmodSync(join(bin,agent),0o755);}
  const env={...process.env,HOME:home,APP_DATA_DIR:data,NODE_ENV:'test',AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP:'1',AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1',AGENTSTOZ_SKIP_HERMES_SYNC:'1',AGENTSTOZ_TEST_SURFACE_LOG:'1'};
  const {baseUrl,child}=await startTestApiServer({cwd:join(import.meta.dir,'..'),env,entrypoint:'tests/fixtures/ops-surface-api.ts'});
  const prepared=await fetch(`${baseUrl}/api/control-profile/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()) as any;
  expect(prepared.profile).toMatchObject({state:'ready',projectId:'ops-project'});
  // The person renames the OPS project; neither its name nor its folder says OPS any more.
  writeFileSync(join(data,'ports.json'),JSON.stringify(ports.map(port=>port.id==='ops-project'?{...port,name:'운영센터'}:port)));
  const post=async(body:Record<string,unknown>)=>{
    const response=await fetch(`${baseUrl}/api/agentstoz-use/action`,{method:'POST',headers:{'Content-Type':'application/json',[CONTROL_PROFILE_HEADER]:readControlProfileAccess(data)!.token},body:JSON.stringify({controllerPortId:CONTROL_PROFILE_CONTROLLER,...body})});
    return {status:response.status,body:await response.json() as any};
  };
  return {home,data,child,post};
}

test('the OPS profile\'s project is ops in list-projects, project-status and resolve-target alike',async()=>{
  expect(JSON.parse(readFileSync(join(f.data,'ports.json'),'utf8')).find((port:{id:string})=>port.id==='ops-project').name).toBe('운영센터');
  const resolved=await f.post({action:'resolve-target',targetAlias:'운영센터'});
  expect(resolved.body).toMatchObject({success:true,resolution:{kind:'project',projectId:'ops-project',role:'ops'}});
  const listed=await f.post({action:'list-projects'});
  expect(listed.status).toBe(200);
  expect(listed.body.projects.find((project:{projectId:string})=>project.projectId==='ops-project')).toMatchObject({projectName:'운영센터',role:'ops'});
  const status=await f.post({action:'project-status',portId:'ops-project'});
  expect(status.body.project).toMatchObject({projectId:'ops-project',role:'ops'});
  // A project the profile is not bound to keeps its own role.
  expect(listed.body.projects.find((project:{projectId:string})=>project.projectId==='plain-project')).toMatchObject({role:'managed'});
},30_000);

test('two registrations of one folder resolve for neither text nor voice; other projects still resolve',async()=>{
  const twin=await f.post({action:'resolve-target',targetAlias:'쌍둥이'});
  expect(twin.status).toBe(400);
  expect(twin.body).toMatchObject({success:false,code:'TARGET_ALIAS_NOT_FOUND'});
  expect(twin.body.candidates.map((candidate:{id:string})=>candidate.id)).not.toContain('twin-a');
  expect(twin.body.candidates.map((candidate:{id:string})=>candidate.id)).not.toContain('twin-b');
  expect(twin.body).toMatchObject({truncated:false});
  expect(await f.post({action:'resolve-target',targetAlias:'plain-app'})).toMatchObject({status:200,body:{resolution:{projectId:'plain-project'}}});
  // The runtime inventory voice resolves against has no target there: no workroom starts on it either.
  const start=await f.post({action:'start-workroom-session',portId:'twin-a',agent:'codex',requestId:'twin_start_12345',foreground:false});
  expect(start.body.success).toBe(false);
},30_000);
