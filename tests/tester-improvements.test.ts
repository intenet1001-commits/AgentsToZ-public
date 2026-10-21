import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {recordTesterImprovement,readTesterImprovements} from '../src/testerImprovementJournal';
import {parseTesterImprovement,type TesterImprovementInput} from '../src/testerImprovements';
import {TesterAgentHost} from '../src/testerAgentHost';
const roots:string[]=[],hosts:TesterAgentHost[]=[];
afterEach(async()=>{for(const h of hosts.splice(0)){await h.shutdown();h.store.close();}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const root=()=>{const path=mkdtempSync(join(tmpdir(),'tester-improvement-'));roots.push(path);return path;};
const event=(patch:Partial<TesterImprovementInput>={}):TesterImprovementInput=>({requestId:randomUUID(),expectedRevision:0,persona:'처음 쓰는 사용자',scenario:'빈 업무에서 새 업무 시작',expected:'작성기를 열고 전송할 수 있다',note:'처음 조회 중 버튼을 눌렀다',stage:'observed',surface:'iphone13',lane:'native-fixture',version:'source-fixture',...patch});

test('empty observations are unconfigured evidence, never a pass; repeated observations share one scenario',async()=>{
 const path=root();expect(await readTesterImprovements(path)).toMatchObject({items:[],class:'exploratory/observed',verdict:null});
 let r=await recordTesterImprovement(path,event());const first=r.items[0]!;
 r=await recordTesterImprovement(path,event({expectedRevision:1,note:'Mac에서도 같은 흐름을 확인했다',surface:'mac'}));
 expect(r.items).toHaveLength(1);expect(r.items[0]).toMatchObject({revision:2,observations:2,changes:0,rechecks:0,firstSeenAt:first.firstSeenAt});expect(r.verdict).toBeNull();
});
test('a lost acknowledgement is replayed once, changed payload and stale revisions never mutate the record',async()=>{
 const path=root(),input=event();let r=await recordTesterImprovement(path,input);r=await recordTesterImprovement(path,input);expect(r.items[0]!.observations).toBe(1);
 await expect(recordTesterImprovement(path,{...input,note:'내용 교체'})).rejects.toThrow('같은 기록 요청');
 await expect(recordTesterImprovement(path,event())).rejects.toThrow('변경되었습니다');expect((await readTesterImprovements(path)).items[0]!.revision).toBe(1);
});
test('observed changed and rechecked accumulate without erasing original counts or certifying a test pass',async()=>{
 const path=root();await recordTesterImprovement(path,event());
 await recordTesterImprovement(path,event({expectedRevision:1,stage:'changed',note:'작성기 전환을 추가했다'}));
 let r=await recordTesterImprovement(path,event({expectedRevision:2,stage:'rechecked',outcome:'clear',note:'첫 전송을 한 번 확인했다'}));
 expect(r.items[0]).toMatchObject({stage:'rechecked',outcome:'clear',observations:1,changes:1,rechecks:1});expect(r.verdict).toBeNull();
 r=await recordTesterImprovement(path,event({expectedRevision:3,note:'다른 환경에서 다시 혼동을 관측했다'}));expect(r.items[0]!.outcome).toBeUndefined();
 for(let n=4;n<22;n++)await recordTesterImprovement(path,event({expectedRevision:n}));
 const last=(await readTesterImprovements(path)).items[0]!;expect(last.events).toHaveLength(6);expect(last.observations).toBe(20);expect(last.receipts).toHaveLength(16);
});
test('an expired retry receipt is still fenced by its original revision',async()=>{
 const path=root(),first=event();await recordTesterImprovement(path,first);
 for(let n=1;n<=17;n++)await recordTesterImprovement(path,event({expectedRevision:n}));
 await expect(recordTesterImprovement(path,first)).rejects.toThrow('변경되었습니다');expect((await readTesterImprovements(path)).items[0]!.observations).toBe(18);
});
test('invalid paths, verdict injection and a missing first observation are refused',async()=>{
 for(const patch of [{verdict:'PASS'},{evidence:'../../secret'},{evidence:'/private/data'},{expectedRevision:-1},{stage:'rechecked'},{stage:'observed',outcome:'clear'}])expect(()=>parseTesterImprovement({...event(),...patch})).toThrow();
 await expect(recordTesterImprovement(root(),event({stage:'changed'}))).rejects.toThrow('첫 관측');
});
test('damaged records and symlinked state folders preserve the existing bytes',async()=>{
 const path=root();await recordTesterImprovement(path,event());const file=join(path,'.agentstoz/maintainer/improvements.json');writeFileSync(file,'broken');
 await expect(recordTesterImprovement(path,event())).rejects.toThrow();expect(readFileSync(file,'utf8')).toBe('broken');
 const other=root(),outside=root();mkdirSync(join(other,'.agentstoz'));symlinkSync(outside,join(other,'.agentstoz/maintainer'));
 await expect(recordTesterImprovement(other,event())).rejects.toThrow('폴더');
});
test('desktop host records under the workspace lease with redaction and denies remote mutation',async()=>{
 const path=root();let held=false,leases=0;
 const host=new TesterAgentHost({directory:join(path,'host'),runner:'unused',python:()=>null,resolve:async()=>({root:path,label:'검증',targets:[]}),lease:async()=>{expect(held).toBe(false);held=true;leases++;return {async release(){await Bun.sleep(5);held=false;}};}});hosts.push(host);
 const input=event({note:'access_token=secretvalue someone@example.com '+path});
 const request={operation:'improvement-record',portId:'project',improvement:input};
 const r=await host.perform(request);expect(leases).toBe(1);expect(held).toBe(false);expect(JSON.stringify(r)).not.toContain('secretvalue');expect(JSON.stringify(r)).not.toContain('someone@example.com');expect(JSON.stringify(r)).not.toContain(path);
 await expect(host.perform(request,{owner:'phone',authorize:async()=>{},executionAllowed:()=>true})).rejects.toThrow('모바일에서는');
 expect((await host.perform({operation:'improvements',portId:'project'})).improvements!.items).toHaveLength(1);
});

test('equivalent whitespace and Unicode form retain a readable scenario identity',async()=>{
 const path=root();await recordTesterImprovement(path,event({persona:'  처음   쓰는 사용자 ',scenario:'새 업무'}));
 await recordTesterImprovement(path,event({expectedRevision:1,scenario:'새  업무',note:'다시 관측'}));
 const result=await readTesterImprovements(path);expect(result.items).toHaveLength(1);expect(result.items[0]!.revision).toBe(2);
});
test('scenario capacity refuses new data without discarding earlier observations',async()=>{
 const path=root();for(let n=0;n<256;n++)await recordTesterImprovement(path,event({scenario:'상황 '+n}));
 const file=join(path,'.agentstoz/maintainer/improvements.json'),before=readFileSync(file,'utf8');
 await expect(recordTesterImprovement(path,event({scenario:'한도 밖 상황'}))).rejects.toThrow('한도');expect(readFileSync(file,'utf8')).toBe(before);
});
