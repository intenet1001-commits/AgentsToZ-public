import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {AiTerminalService} from '../src/aiTerminalService';
import type {AiTerminalSummary} from '../src/aiTerminalProtocol';
import {deliverWorkroomRoute} from '../src/workroomRouteDelivery';
import type {PendingWorkroomSubmission} from '../src/workroomSubmissionClient';
import {CORRECTION_OUTCOME_COVERAGE,summarizeCorrectionOutcomes} from '../src/projectMemoryCorrectionOutcome';
import {CorrectionOutcomeLine} from '../src/ProjectMemoryCorrections';

/**
 * The outcome coverage note describes which paths carry a correction into a task. Since an @ handoff into a receiver
 * that takes whole-request submissions rides the same submission write as the composer (2026-10-15), it receives the
 * related correction and records an exposure; one typed in raw parts does not. The disclosure must say exactly that.
 */
const cleanups:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const c of cleanups.splice(0).reverse())await c();});
const CORRECTION='Failure: handoff skipped the migration. Next: run it first.';
const MEMORY_ID='route-correction-memory';
function fixture(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'route-correction-')));chmodSync(dir,0o700);
 const store=new WorkroomConversationJournal(dir);
 const lookups:string[]=[],writes:string[]=[];
 let finish!:(code:number)=>void;let exit:()=>void=()=>{};let output:(data:Uint8Array)=>void=()=>{};
 const service=new AiTerminalService({submissions:()=>store,
  corrections:async(_cwd,_targetId,text)=>{lookups.push(text);return {text:CORRECTION,validate:()=>{},
   exposure:{memoryId:MEMORY_ID,contextHash:'c'.repeat(64),sourceWithheld:false,entries:[{entryKey:'e'.repeat(24),contentVersionHash:'a'.repeat(32),reportIds:['route-report']}]}};},
  resolveTarget:async()=>({cwd:dir}),executable:()=>'/fixture/harmless',signalGroup:()=>{exit();finish(0);},
  spawn:(_args,options)=>{const t=options.terminal as {exit():void;data(pty:unknown,data:Uint8Array):void};exit=t.exit;output=data=>t.data(null,data);
   return {pid:999999999,exited:new Promise<number>(resolve=>{finish=resolve;}),kill:()=>{},terminal:{write:(text:string)=>{writes.push(text);return Buffer.byteLength(text);},resize:()=>{},close:()=>{exit();finish(0);}}};}});
 cleanups.push(()=>rmSync(dir,{recursive:true,force:true}),()=>store.close(),()=>service.shutdown());
 const remembered=new Map<string,PendingWorkroomSubmission|null>();
 const deliver=async(supported:boolean)=>{
  const receiver=(await service.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'project-p',agent:'hermes',cols:80,rows:24})).session!;
  // The CLI turns on bracketed paste, as Claude Code and Codex do.
  output(new TextEncoder().encode('\x1b[?2004hready\r\n'));await Bun.sleep(50);
  const source:AiTerminalSummary={...receiver,id:'source-session',targetId:'other-project'};
  return deliverWorkroomRoute({sessions:[source,receiver],source,sourceLabel:'Other',target:{targetId:'project-p',label:'P'},agent:'hermes',
   task:'please handle the handoff',references:[],transport:'local',bypassPermissions:false,sessionLabel:()=>undefined,
   // The receiving screen is idle; every other request goes to the real host.
   request:r=>r.operation==='read'?Promise.resolve({chunks:[{seq:1,text:'idle'}],hasMore:false} as never):service.perform({...r,requestId:crypto.randomUUID()}),
   confirm:()=>true,render:async()=>['> ',''],
   submission:{supported,pending:id=>remembered.get(id)??null,remember:(id,record)=>{remembered.set(id,record);}}});
 };
 return {store,lookups,writes,deliver};
}

test('an @ handoff typed as one submission receives the related correction, records the exposure, and the coverage says so',async()=>{
 const f=fixture();
 const result=await f.deliver(true);
 expect(result.status).toBe('delivered');
 expect(f.lookups).toHaveLength(1);
 expect(f.writes.join('')).toContain(CORRECTION);
 expect(f.store.correctionExposureUnits(0,256).map(unit=>unit.targetId)).toEqual(['project-p']);
 expect(f.store.correctionTaskSummary('project-p',MEMORY_ID)).toMatchObject({delivered:1});
 expect(CORRECTION_OUTCOME_COVERAGE.exposedPaths as readonly string[]).toContain('@-route-submission');
 expect(CORRECTION_OUTCOME_COVERAGE.notExposed as readonly string[]).not.toContain('@-route');
 const html=renderToStaticMarkup(createElement(CorrectionOutcomeLine,{summary:summarizeCorrectionOutcomes([],[],0)}));
 // Not 「every @ handoff is unexposed」: only one typed in raw parts is.
 expect(html).not.toContain('첫 요청·@ 전달은 교정을 받지 않습니다');
 expect(html).toContain('요청 전체로 입력된 @ 전달만 반영합니다');
 expect(html).toContain('나눠 입력된 @ 전달은 교정을 받지 않습니다');
});

test('an @ handoff typed in raw parts gets no correction and no exposure, and the coverage lists it as not exposed',async()=>{
 const f=fixture();
 const result=await f.deliver(false);
 expect(result.status).toBe('delivered');
 expect(f.lookups).toEqual([]);
 expect(f.writes.join('')).not.toContain(CORRECTION);
 expect(f.store.correctionExposureUnits(0,256)).toEqual([]);
 expect(CORRECTION_OUTCOME_COVERAGE.notExposed as readonly string[]).toContain('@-route-raw');
});
