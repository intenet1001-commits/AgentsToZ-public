import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {AiTerminalService} from '../src/aiTerminalService';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {claudeInputChangesConversation,normalizeContextCommandRequest,runContextSessionCommand} from '../src/contextSessionCommand';
import {acknowledgeContextCommand,contextCommandAttempts} from '../src/contextSessionCommandClient';
import {WORKROOM_CONTEXT_SAVE_REFUSALS,type WorkroomSavedPurpose} from '../src/workroomSavedReceipt';
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const c of cleanup.splice(0).reverse())await c();});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'context-command-')),journal=new WorkroomConversationJournal(root),writes:string[]=[];
  let now=1000,frame:(s:string)=>void=()=>{},saved=true,synced=true,afterSync=()=>{},end=()=>{},saveStartedAt:number|null=null;
  const purposes:(WorkroomSavedPurpose|undefined)[]=[];
  const service=new AiTerminalService({submissions:()=>journal,resolveTarget:async()=>({cwd:root}),executable:()=>'/fixture/claude',activityClock:()=>now,activitySampler:false,
    verifySavedBeforeClose:async(_s,_id,_owner,purpose)=>{purposes.push(purpose);if(!saved)throw Error('save missing');return {startedAt:saveStartedAt??now};},verifyContextSync:async()=>{afterSync();if(!synced)throw Error('sync missing');},signalGroup:()=>end(),
    spawn:(_args,options:any)=>{let exit!:(n:number)=>void;const exited=new Promise<number>(resolve=>{exit=resolve;});end=()=>{options.terminal.exit?.();exit(0);};frame=s=>options.terminal.data(null,new TextEncoder().encode(s));queueMicrotask(()=>frame('\x1b[2J\x1b[H❯ '));return {pid:90000999,exited,kill:()=>exit(0),terminal:{write:(data:string)=>{writes.push(data);return Buffer.byteLength(data);},resize(){},close:()=>exit(0)}};}});
  cleanup.push(async()=>{await service.shutdown();journal.close();rmSync(root,{recursive:true,force:true});});
  const s=(await service.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'fixture-project-001',agent:'claude',cols:80,rows:24})).session!;
  await Bun.sleep(10);now=10000;await service.sampleActivity();await service.sampleActivity();
  const request={operation:'context.execute' as const,sessionId:s.id,providerSessionId:s.id,command:'compact' as 'compact'|'clear',requestId:crypto.randomUUID(),saveRequestId:crypto.randomUUID(),inputRevision:0};
  return {service,writes,s,request,frame,purposes,missingSave:()=>{saved=false;},missingSync:()=>{synced=false;},changeWhileSync:()=>{afterSync=()=>{saved=false;};},
    /** The save this command relies on started before the conversation's latest turn. */ savedBeforeActivity:()=>{saveStartedAt=1;}};
}
test('native /compact is fixed, exactly bound, saved and synced, with an idempotent receipt',async()=>{
  const f=await fixture();expect(f.service.contextCommandBindings()[0]?.providerSessionId).toBe(f.s.id);
  expect(await f.service.performContextCommand(f.request)).toEqual({state:'written'});expect(f.writes).toEqual(['/compact','\r']);
  expect(await f.service.performContextCommand(f.request)).toEqual({state:'written'});expect(f.writes).toHaveLength(2);
  expect(await f.service.performContextCommand({operation:'context.receipt',sessionId:f.s.id,requestId:f.request.requestId})).toEqual({state:'written',sessionOpen:true});
});
for(const failure of ['save','sync','changed-save','draft','binding','revision','activity-after-save'] as const)test(`native command refuses ${failure} without a PTY write`,async()=>{
  const f=await fixture();
  if(failure==='save')f.missingSave();if(failure==='sync')f.missingSync();if(failure==='changed-save')f.changeWhileSync();if(failure==='activity-after-save')f.savedBeforeActivity();
  if(failure==='draft'){f.frame('\x1b[2J\x1b[H❯ unfinished');await Bun.sleep(5);}
  if(failure==='binding')f.request.providerSessionId=crypto.randomUUID();if(failure==='revision')f.request.inputRevision=10;
  const outcome=await f.service.performContextCommand(f.request).catch(()=>({state:'refused'}));
  expect(outcome.state).not.toBe('written');
  expect(f.writes).toEqual([]);
});
test('the context command checks only this conversation; closing still checks the whole project',async()=>{
  const f=await fixture();
  expect(await f.service.performContextCommand(f.request)).toEqual({state:'written'});
  expect(f.purposes).toEqual(['context','context']);
  // This conversation's own turn after the save started still refuses, in the context command's words.
  const g=await fixture();g.savedBeforeActivity();
  await expect(g.service.performContextCommand(g.request)).rejects.toThrow(WORKROOM_CONTEXT_SAVE_REFUSALS.changed);
  expect(g.writes).toEqual([]);
  await f.service.perform({operation:'close',requestId:crypto.randomUUID(),sessionId:f.s.id,memoryPolicy:'saved',saveRequestId:crypto.randomUUID()} as any);
  expect(f.purposes.at(-1)).toBe('close');
});
test('/clear starts a new conversation and invalidates the old context binding; replay does not clear twice',async()=>{
  const f=await fixture();f.request.command='clear';expect(await f.service.performContextCommand(f.request)).toEqual({state:'written'});
  expect(f.writes).toEqual(['/clear','\r']);expect(f.service.contextCommandBindings()).toEqual([]);
  expect(await f.service.performContextCommand(f.request)).toEqual({state:'written'});expect(f.writes).toHaveLength(2);
});
test('manually switching conversations also retires the old launch binding',async()=>{
  const f=await fixture();await f.service.perform({operation:'input',requestId:crypto.randomUUID(),sessionId:f.s.id,data:'/clear\r'});
  expect(f.service.contextCommandBindings()).toEqual([]);
  expect(claudeInputChangesConversation('\r',{rows:['❯ /resume'],cursorRow:0})).toBe(true);
  expect(claudeInputChangesConversation('/compact\r')).toBe(false);
  expect(claudeInputChangesConversation('explain /clear\r')).toBe(false);
});
test('a closed Workroom refuses a new command, keeps an earlier answer, and reports that it is closed',async()=>{
  const f=await fixture();
  expect(await f.service.performContextCommand(f.request)).toEqual({state:'written'});
  expect(await f.service.performContextCommand({operation:'context.receipt',sessionId:f.s.id,requestId:f.request.requestId})).toEqual({state:'written',sessionOpen:true});
  await f.service.perform({operation:'close',requestId:crypto.randomUUID(),sessionId:f.s.id,memoryPolicy:'skip'} as any);
  await Bun.sleep(20);
  const receipt=await f.service.performContextCommand({operation:'context.receipt',sessionId:f.s.id,requestId:crypto.randomUUID()});
  expect(receipt).toMatchObject({state:'not-found',sessionOpen:false});
  const late=await f.service.performContextCommand({...f.request,requestId:crypto.randomUUID()});
  expect(late.state).toBe('rejected');expect(f.writes).toHaveLength(2);
});
test('a person releases an unconfirmed Workroom command only after that Workroom is closed',async()=>{
  const f=await fixture(),storage=new Map<string,string>(),realFetch=globalThis.fetch,realStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,writable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>void storage.set(k,String(v)),removeItem:(k:string)=>void storage.delete(k)}});
  globalThis.fetch=(async(_path:string,init:RequestInit)=>Response.json(await f.service.performContextCommand(JSON.parse(String(init.body))))) as unknown as typeof fetch;
  cleanup.push(async()=>{globalThis.fetch=realFetch;if(realStorage)Object.defineProperty(globalThis,'localStorage',realStorage);else delete (globalThis as {localStorage?:unknown}).localStorage;});
  // A lost reply left this request's outcome unknown on the dock.
  const attempt={requestId:crypto.randomUUID(),sessionId:f.s.id,providerSessionId:f.s.id,command:'compact' as const};
  storage.set('agentstoz:context-command:pending:v1',JSON.stringify([attempt]));
  await expect(acknowledgeContextCommand(attempt)).rejects.toThrow('아직 열려 있어');
  expect(contextCommandAttempts()).toHaveLength(1);
  await f.service.perform({operation:'close',requestId:crypto.randomUUID(),sessionId:f.s.id,memoryPolicy:'skip'} as any);
  expect(await acknowledgeContextCommand(attempt)).toBe('closed');
  expect(contextCommandAttempts()).toHaveLength(0);
  expect(f.writes).toHaveLength(0);
});
test('wire requests cannot select arbitrary text, paths or commands',()=>{
  expect(()=>normalizeContextCommandRequest({operation:'context.execute',command:'clear; rm -rf'})).toThrow();
  expect(()=>normalizeContextCommandRequest({operation:'context.status',cwd:'/private'})).toThrow();
});
for(const fail of ['save','sync','execute'] as const)test(`combined action stops at ${fail} and never replays`,async()=>{
  const calls:string[]=[];
  await expect(runContextSessionCommand({binding:{providerSessionId:'provider-1',sessionId:'workroom-1',targetId:'project-1',inputRevision:0},command:'clear',requestId:'request-1'}, {
    save:async()=>{calls.push('save');return {state:fail==='save'?'unconfirmed':'saved',localSaved:fail!=='save'};},status:async()=>{throw Error('unexpected poll');},
    sync:async()=>{calls.push('sync');return {ok:fail!=='sync'};},execute:async()=>{calls.push('execute');return {state:'unknown'};},progress:()=>{},
  })).rejects.toThrow();
  expect(calls).toEqual(fail==='save'?['save']:fail==='sync'?['save','sync']:['save','sync','execute']);
});
