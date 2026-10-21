import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AiTerminalService} from '../src/aiTerminalService';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {createWorkroomEffortSetting} from '../src/workroomEffortSetting';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import type {EffortRuntimeControl} from '../src/workroomEffortRuntime';
const cleanup:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const c of cleanup.splice(0).reverse())await c();});
function fixture(runtime?: (c: EffortRuntimeControl) => Promise<'applied' | 'unsupported'>){
 const root=mkdtempSync(join(tmpdir(),'effort-modes-service-')),store=new WorkroomConversationJournal(root),setting=createWorkroomEffortSetting(root);
 const writes:string[]=[],controls:string[]=[],launches:string[][]=[];let bindingCwd=root,active=true,fail=false,frame:(s:string)=>void=()=>{};
 const service=new AiTerminalService({submissions:()=>store,effortAuto:setting,resolveTarget:async()=>({cwd:bindingCwd}),executable:()=>'/fixture/codex',codexEffortModel:()=>({ok:true,model:'gpt-6.1-sol',allowed:['low','medium','high']}),activitySampler:false,
 effortRuntimeSupport:()=>({claudeSessionPicker:true,codexDefaultKeys:true}),effortRuntime:async(c:EffortRuntimeControl)=>{controls.push(c.level);if(runtime)return runtime(c);if(fail)throw Error('확인하지 못했습니다');if(!c.active())throw Error('revoked');await c.write('native-effort:'+c.level);return 'applied';},
 spawn:(args,options:any)=>{launches.push(args);let exit!:(n:number)=>void;const exited=new Promise<number>(r=>{exit=r;});frame=s=>options.terminal.data(null,new TextEncoder().encode(s));queueMicrotask(()=>frame('\x1b[2J\x1b[Hmodel: gpt-6.1-sol medium\r\n› '));return {pid:700001,exited,kill:()=>exit(143),terminal:{write:(text:string)=>{writes.push(text);if(text.startsWith('native-effort:'))frame('\x1b[2J\x1b[Hmodel: gpt-6.1-sol '+text.split(':')[1]+'\r\n› ');return Buffer.byteLength(text);},resize(){},close(){exit(0);}}} as any;}});
 cleanup.push(async()=>{await service.shutdown();store.close();rmSync(root,{recursive:true,force:true});});
 const start=async()=>{const r=await service.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'project-effort-001',agent:'codex',prompt:'일반 작업을 진행해 주세요',cols:100,rows:28});await new Promise(r=>setTimeout(r,10));return r.session!;};
 const send=(sessionId:string,text:string,id=crypto.randomUUID())=>submitWorkroomDraft({id,sessionId,text:text+'\r',prepared:()=>{},request:r=>service.perform({...r,requestId:crypto.randomUUID()})});
 return {service,setting,writes,controls,launches,start,send,fail:()=>{fail=true;},moveBinding:()=>{bindingCwd=join(root,'private-project-missing');},revoke:()=>{active=false;},active:()=>active};
}
test('global auto changes a live Codex Workroom before the next whole request and keeps its receipt idempotent',async()=>{
 const f=fixture(),s=await f.start(),id=crypto.randomUUID();
 expect((await f.send(s.id,'권한 격리 설계를 검토해 주세요',id)).state).toBe('written');
 expect(f.controls).toEqual(['high']);expect(f.writes.indexOf('native-effort:high')).toBeLessThan(f.writes.findIndex(t=>t.includes('권한 격리')));
 await f.send(s.id,'권한 격리 설계를 검토해 주세요',id);expect(f.controls).toEqual(['high']);
 expect(f.service.workspaceEffort({targetId:s.targetId,sessionId:s.id,effortModes:true}).session).toMatchObject({mode:'auto',origin:'runtime',level:'high',seen:'high',manual:false,runtimeStatus:'applied'});
 await f.send(s.id,'오타를 고쳐줘');expect(f.controls).toEqual(['high','low']);
});
test('recommendations never pass a launch flag or a runtime control and off clears the guidance',async()=>{
 const f=fixture();f.setting.setMode!('recommend');const s=await f.start();expect(f.launches[0]!.some(x=>x.includes('model_reasoning_effort'))).toBe(false);
 await f.send(s.id,'보안 설계를 검토해줘');expect(f.controls).toEqual([]);expect(f.service.workspaceEffort({targetId:s.targetId,sessionId:s.id,effortModes:true}).session).toMatchObject({mode:'recommend',advice:{tier:'high'}});
 f.setting.setMode!('off');await f.send(s.id,'데드락을 분석해줘');expect(f.controls).toEqual([]);expect(f.service.workspaceEffort({targetId:s.targetId,sessionId:s.id,effortModes:true}).session!.advice).toBeUndefined();
});
test('an unconfirmed effort change does not send, lose or replay the user request',async()=>{
 const f=fixture(),s=await f.start();f.fail();await expect(f.send(s.id,'보안 검토')).rejects.toThrow('확인하지 못');expect(f.writes.some(t=>t.includes('보안 검토'))).toBe(false);expect(f.service.workspaceEffort({targetId:s.targetId,sessionId:s.id,effortModes:true}).session!.runtimeStatus).toBe('unconfirmed');
});
test('auto resumes on the next request after a native manual selection',async()=>{
 const f=fixture(),s=await f.start();await f.service.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:s.id,data:'/model\r'});await f.send(s.id,'보안 검토');expect(f.controls).toEqual(['high']);expect(f.service.workspaceEffort({targetId:s.targetId,sessionId:s.id,effortModes:true}).session!.manual).toBe(false);f.setting.setMode!('off');await f.send(s.id,'오타 수정');expect(f.controls).toEqual(['high']);
});
test('task-thread and voice-style host submissions use the same live effort decision',async()=>{
 const f=fixture(),s=await f.start();const r=await f.service.submitHostInstruction({id:crypto.randomUUID(),sessionId:s.id,data:'동시성 레이스 컨디션을 분석해줘\r',receiptOwner:'local-thread',skipCorrections:true});expect(r.state).toBe('written');expect(f.controls).toEqual(['high']);
});

test('Esc cancels a pending automatic change while preserving the prepared whole request', async () => {
 let entered!: () => void, release!: () => void;
 const pending = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
 const f = fixture(async c => { entered(); await gate; if (!c.active()) throw Error('input changed'); await c.write('native-effort:high'); return 'applied'; });
 const s = await f.start();
 const sent = f.send(s.id, '보안 검토').then(() => null, error => error);
 await pending;
 try { await f.service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: s.id, data: '\x1b'}); }
 finally { release(); }
 expect(await sent).toBeInstanceOf(Error);
 expect(f.writes).toContain('\x1b'); expect(f.writes.some(t => t.includes('보안 검토') || t.startsWith('native-effort:'))).toBe(false);
});

test('a project grant revoked during runtime preparation fences every native key and the request body', async () => {
 let permitted = true;
 const f = fixture(async c => { permitted = false; await c.write('native-effort:high'); return 'applied'; });
 const s = await f.start();
 await expect(f.service.submitHostInstruction({id: crypto.randomUUID(), sessionId: s.id, data: '보안 검토\r', receiptOwner: 'local-thread', active: () => true,
   validateTarget: () => { if (!permitted) throw Error('project grant revoked'); },
 })).rejects.toThrow('워크룸 입력이 변경되었습니다');
 expect(f.writes.some(t => t.includes('보안 검토') || t.startsWith('native-effort:'))).toBe(false);
});


test('runtime checkout failure preserves the request without exposing paths or filesystem errors', async () => {
 const f=fixture(async c => { f.moveBinding(); await c.write('native-effort:high'); return 'applied'; });
 const s=await f.start();let message='';
 try{await f.send(s.id,'보안 검토');}catch(error){message=(error as Error).message;}
 expect(message).toContain('작성한 요청은 유지');
 for(const privateText of ['private-project-missing','ENOENT',tmpdir()])expect(message).not.toContain(privateText);
 expect(f.writes.some(t=>t.includes('보안 검토')||t.startsWith('native-effort:'))).toBe(false);
});
