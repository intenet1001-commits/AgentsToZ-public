import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import {submissionDigest} from '../src/workroomSubmissionProtocol';
import {AiTerminalService} from '../src/aiTerminalService';
import {normalizeAiTerminalResponse,type AiTerminalRequest} from '../src/aiTerminalProtocol';
import {createCommunityControlExecutor} from '../src/agentDialogueControl';

/** Another community Mac submitting a whole Workroom request to this one, through the real executor and service. */
const cleanups:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const c of cleanups.splice(0).reverse())await c();});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'community-submission-'));chmodSync(dir,0o700);
 const store=new WorkroomConversationJournal(dir);
 let finish!:(code:number)=>void;let exit:()=>void=()=>{};const writes:string[]=[];
 const service=new AiTerminalService({submissions:()=>store,headlessScreen:false,resolveTarget:async()=>({cwd:dir}),executable:()=>'/fixture/harmless',signalGroup:()=>{exit();finish(0);},
  spawn:(_args,options)=>{exit=(options.terminal as {exit():void}).exit;return{pid:999999999,exited:new Promise<number>(resolve=>{finish=resolve;}),kill:()=>{},terminal:{write:(text:string)=>{writes.push(text);return Buffer.byteLength(text);},resize:()=>{},close:()=>{exit();finish(0);}}};}});
 cleanups.push(()=>rmSync(dir,{recursive:true,force:true}),()=>store.close(),()=>service.shutdown());
 const run=createCommunityControlExecutor({terminal:(body,options)=>service.perform(body,undefined,options),workspace:async()=>({}),projects:async()=>({projects:[],opsTargetId:null,deviceName:'x'})});
 // What the sending Mac's Workroom panel calls: its transport, pointed at this executor.
 const remote=async(r:Omit<AiTerminalRequest,'requestId'>)=>normalizeAiTerminalResponse((await run({kind:'terminal',body:{...r,requestId:crypto.randomUUID()}})).result);
 const local=(r:Omit<AiTerminalRequest,'requestId'>)=>service.perform({...r,requestId:crypto.randomUUID()});
 return {service,writes,remote,local};
}

test('a whole request from another Mac is written once and its receipt survives a lost acknowledgement',async()=>{
 const f=fixture();
 expect((await f.remote({operation:'list',capabilities:true})).features).toContain('terminal-submission-v1');
 const session=(await f.remote({operation:'start',targetId:'fixture-project',agent:'hermes',cols:80,rows:24})).session!;
 const receipt=await submitWorkroomDraft({id:'community-submission',sessionId:session.id,text:'다른 기기에서 보낸 요청\r',request:f.remote,prepared:()=>{}});
 expect(receipt.state).toBe('written');
 expect(f.writes.join('')).toBe('다른 기기에서 보낸 요청\r');const written=f.writes.length;
 // The acknowledgement of a single submission is lost on the way back; the sender asks for its status instead.
 const text='응답을 잃어버린 요청\r',bytes=new TextEncoder().encode(text);
 await f.remote({operation:'submission',sessionId:session.id,submission:{phase:'single',id:'lost-ack-submission',bytes:bytes.length,digest:submissionDigest(bytes),data:Buffer.from(bytes).toString('base64')}});
 const afterLost=f.writes.length;
 const status=await f.remote({operation:'submission',sessionId:session.id,submission:{phase:'status',id:'lost-ack-submission'}});
 expect(status.submission?.state).toBe('written');expect(f.writes.length).toBe(afterLost);expect(afterLost).toBeGreaterThan(written);
 // A 24KB request goes out in several chunks and still lands once.
 const big='가'.repeat(7_900)+'\r';
 const long=await submitWorkroomDraft({id:'community-long-submission',sessionId:session.id,text:big,request:f.remote,prepared:()=>{}});
 expect(long.state).toBe('written');expect(f.writes.join('')).toContain(big);
});

test('another device\'s receipts and this Mac\'s own receipts never answer for each other',async()=>{
 const f=fixture();
 const session=(await f.local({operation:'start',targetId:'fixture-project',agent:'hermes',cols:80,rows:24})).session!;
 expect((await submitWorkroomDraft({id:'remote-owned-submission',sessionId:session.id,text:'remote\r',request:f.remote,prepared:()=>{}})).state).toBe('written');
 expect((await submitWorkroomDraft({id:'local-owned-submission',sessionId:session.id,text:'local\r',request:f.local,prepared:()=>{}})).state).toBe('written');
 await expect(f.local({operation:'submission',sessionId:session.id,submission:{phase:'status',id:'remote-owned-submission'}})).rejects.toThrow('제출 기록');
 await expect(f.remote({operation:'submission',sessionId:session.id,submission:{phase:'status',id:'local-owned-submission'}})).rejects.toThrow('제출 기록');
 expect((await f.remote({operation:'submission',sessionId:session.id,submission:{phase:'status',id:'remote-owned-submission'}})).submission?.state).toBe('written');
});

import {WorkroomSubmissionUnsupportedError,WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE,pendingAfterStatus,draftAfterWrittenStatus} from '../src/workroomSubmissionClient';
import {COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR} from '../src/agentDialogueControl';
import {AiTerminalServerResponseError} from '../src/aiTerminalClient';
test('a receiver that advertises submission but refuses it is recognised before anything was prepared',async()=>{
 // Installed v791 receivers: `list` says terminal-submission-v1, `submission` gets the terminal-only refusal.
 const refusing=async()=>{throw new AiTerminalServerResponseError(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR);};
 for(const text of ['short\r','가'.repeat(2_000)+'\r']){
  let prepared=0;
  const error=await submitWorkroomDraft({id:'old-receiver-submission',sessionId:'old-receiver-session',text,request:refusing,prepared:()=>{prepared++;}}).catch(e=>e);
  expect(error).toBeInstanceOf(WorkroomSubmissionUnsupportedError);expect(error.message).toBe(WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE);expect(prepared).toBe(0);
 }
 expect(WORKROOM_SUBMISSION_UNSUPPORTED_NOTICE).toContain('기존 입력 방식');
 // Any other failure, and the same sentence after the host has prepared the request, keep today's unknown handling.
 const other=await submitWorkroomDraft({id:'other-failure-submission',sessionId:'old-receiver-session',text:'short\r',request:async()=>{throw new AiTerminalServerResponseError('네트워크 오류');},prepared:()=>{}}).catch(e=>e);
 expect(other).not.toBeInstanceOf(WorkroomSubmissionUnsupportedError);
 let calls=0;
 const late=await submitWorkroomDraft({id:'late-refusal-submission',sessionId:'old-receiver-session',text:'가'.repeat(2_000)+'\r',prepared:()=>{},request:async r=>{
  if(calls++===0)return {submission:{id:'late-refusal-submission',storeId:'fixture-store',epoch:'fixture-epoch',revision:0,state:'prepared' as const}};
  throw new AiTerminalServerResponseError(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR);}}).catch(e=>e);
 expect(late).not.toBeInstanceOf(WorkroomSubmissionUnsupportedError);expect(late.message).toBe(COMMUNITY_CONTROL_TERMINAL_ONLY_ERROR);
});

test('a status that proves the request was written clears the pending record, and nothing else does',()=>{
 const pending={id:'pending-submission',sessionId:'pending-session',receipt:null};
 const receipt=(state:'written'|'unknown'|'prepared'|'held'|'rejected'|'write_started')=>({id:'pending-submission',storeId:'fixture-store',epoch:'fixture-epoch',revision:1,state});
 expect(pendingAfterStatus(pending,receipt('written'))).toBeNull();
 for(const state of ['unknown','prepared','held','rejected','write_started'] as const)expect(pendingAfterStatus(pending,receipt(state))).toEqual({...pending,receipt:receipt(state)});
});
test('a status check that finds the request written clears the composer only when it still holds that request',()=>{
 const draft='이 버그 고쳐줘';
 // Same draft as submitted: cleared, exactly as the direct written path does, so one more click cannot type it again.
 expect(draftAfterWrittenStatus(draft,draft).clear).toBe(true);
 // The user edited it meanwhile: their new text stays.
 expect(draftAfterWrittenStatus(draft,draft+' 그리고 테스트도').clear).toBe(false);
 // After a reload the submitted text is unknown: nothing is cleared, and the message says it was already sent.
 const unknown=draftAfterWrittenStatus(undefined,draft);
 expect(unknown.clear).toBe(false);expect(unknown.message).toContain('이미 전달');expect(unknown.message).toContain('다시 보내지 마세요');
 expect(draftAfterWrittenStatus(undefined,'').message).not.toContain('다시 보내지 마세요');
});
