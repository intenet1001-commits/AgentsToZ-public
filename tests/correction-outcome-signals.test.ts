import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {
 CORRECTION_OUTCOME_PROTOCOL,classifyCorrectionOutcome,correctionExposureUnitId,type CorrectionExposureUnit,
} from '../src/projectMemoryCorrectionOutcome';
import {CorrectionOutcomeStore} from '../src/correctionOutcomeStore';
import {CorrectionOutcomeObserver} from '../src/correctionOutcomeObserver';
import {
 CORRECTION_OUTCOMES_PATH,CORRECTION_OUTCOME_LIST_LIMIT,CorrectionOutcomeManagement,normalizeCorrectionOutcomeRequest,
 type CorrectionOutcomeManagementDeps,
} from '../src/correctionOutcomeManagement';
import {
 CORRECTION_TESTER_HISTORY_MAX_BYTES,correctionTesterObservationsFor,readTesterHistoryTail,readTesterManifestChecks,testerCheckObservations,
 type TesterHistoryRow,
} from '../src/correctionTesterObservations';

/**
 * S4-05 (human attestation through the Mac management route) and S4-06 (tester-check outcomes for a correction bound by
 * a human to manifest checks). Real SQLite stores and synthetic tester files in temp dirs; no tester run, no model.
 */
const HOUR=3_600_000,WINDOW=CORRECTION_OUTCOME_PROTOCOL.windowMs,T0=Date.parse('2026-10-15T00:00:00.000Z');
const iso=(ms:number)=>new Date(ms).toISOString();
const dirs:string[]=[],closers:{close():void}[]=[];
afterEach(()=>{for(const c of closers.splice(0))c.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const temp=(prefix:string)=>{const dir=realpathSync(mkdtempSync(join(tmpdir(),prefix)));chmodSync(dir,0o700);dirs.push(dir);return dir;};
const ENTRY='e'.repeat(24),VERSION='a'.repeat(32),related={queryTerms:4,matchedTerms:3,evidenceMatchedTerms:2};
const request=(over:Record<string,unknown>)=>({requestId:crypto.randomUUID(),...over});

function setup(options:{excluded?:Record<string,boolean|'unresolved'>;roots?:Record<string,string>;active?:boolean;
 /** Runs while the route awaits a dependency — where an observer tick or the clock can move in a real sidecar. */
 during?:(dep:'excluded'|'checks')=>void|Promise<void>;
 /** What the route sees as its store (the test helper `store()` stays the real one). */
 wrapStore?:(store:CorrectionOutcomeStore)=>CorrectionOutcomeStore}={}){
 const dir=temp('agentstoz-signal-data-');let clock=T0;let storeOpened=0;
 let store:CorrectionOutcomeStore|null=null;
 const open=()=>{storeOpened++;if(!store){store=new CorrectionOutcomeStore(dir,()=>iso(clock));closers.push(store);}return store;};
 open();storeOpened=0;clock+=1000;
 const deps:CorrectionOutcomeManagementDeps={
  active:()=>options.active??true,store:()=>options.wrapStore?options.wrapStore(open()):open(),now:()=>clock,
  memory:async folder=>folder==='/projects/a'?{memoryId:'memory-a',entries:[{entryKey:ENTRY,contentVersionHash:VERSION,title:'JSON shell input'}]}:null,
  excluded:async target=>{await options.during?.('excluded');return options.excluded?.[target]??false;},
  conversationTitle:session=>session==='session-a'?'셸 입력 수정':null,
  checks:async target=>{await options.during?.('checks');const root=options.roots?.[target];return root?readTesterManifestChecks(root):null;},
 };
 const management=new CorrectionOutcomeManagement(deps);
 let n=0;
 const put=(over:Partial<CorrectionExposureUnit>={})=>{
  const key='submission-'+(n++);
  const unit:CorrectionExposureUnit={unitId:correctionExposureUnitId(key,over.entryKey??ENTRY,over.contentVersionHash??VERSION),memoryId:'memory-a',entryKey:ENTRY,
   contentVersionHash:VERSION,reportIds:['r'.repeat(64)],targetId:'target-a',sessionId:'session-a',writtenAt:iso(clock),state:'written',sourceWithheld:false,relatedness:related,...over};
  expect(open().putUnit(unit,key)).toBe('inserted');return unit;
 };
 const observer=(testerRoots:Record<string,string>={})=>new CorrectionOutcomeObserver({
  store:open,journal:()=>({storeInstanceId:'journal-fixture',correctionExposureUnits:()=>[],submission:()=>null}),
  excluded:async()=>false,ledger:async()=>[],deviceId:()=>null,now:()=>clock,
  testerObservations:async(unit,outcomeStore,tick)=>{const root=testerRoots[unit.targetId];if(!root)return [];
   const binding=outcomeStore.binding(unit.memoryId,unit.entryKey,unit.contentVersionHash,iso(Date.parse(unit.writtenAt!)+WINDOW));
   return binding?correctionTesterObservationsFor(root,unit,binding,tick):[];},
 });
 return {dir,management,put,store:open,observer,opened:()=>storeOpened,advance:(ms:number)=>{clock+=ms;},at:()=>clock};
}

// ---- S4-05: human attestation ----
test('the management request is strict: exact keys per operation, a 64-hex unit id and a known verdict',()=>{
 const unitId='b'.repeat(64);
 expect(normalizeCorrectionOutcomeRequest({operation:'attest',unitId,verdict:'avoided',requestId:'request-1234'})).toMatchObject({verdict:'avoided'});
 for(const value of [
  {operation:'attest',unitId,verdict:'fixed',requestId:'request-1234'},
  {operation:'attest',unitId,verdict:'avoided',requestId:'request-1234',at:iso(T0)},
  {operation:'attest',unitId:'short',verdict:'avoided',requestId:'request-1234'},
  {operation:'attest',unitId,verdict:'avoided'},
  {operation:'list',folderPath:'relative/path',requestId:'request-1234'},
  {operation:'list',folderPath:'/projects/a',requestId:'request-1234',evidence:'x'},
  {operation:'bind',unitId,checkIds:[],requestId:'request-1234'},
  {operation:'bind',unitId,checkIds:['a','b','c','d','e'],requestId:'request-1234'},
  {operation:'bind',unitId,checkIds:['a','a'],requestId:'request-1234'},
  {operation:'delete',unitId,requestId:'request-1234'},
  [],null,'attest',
 ])expect(()=>normalizeCorrectionOutcomeRequest(value)).toThrow();
 expect(CORRECTION_OUTCOMES_PATH).toBe('/api/agent-runtime/correction-outcomes');
});
test('only the local management authority can attest; remote, phone and MCP authorities are refused and nothing is stored',async()=>{
 const s=setup(),u=s.put();
 for(const authority of ['remote','mcp','phone'] as const){
  await expect(s.management.perform(request({operation:'attest',unitId:u.unitId,verdict:'avoided'}),authority as any)).rejects.toMatchObject({code:'CORRECTION_OUTCOME_LOCAL_ONLY'});
 }
 expect(s.store().observations(u.unitId)).toEqual([]);
 // No agentstoz_use tool can reach the route or attest.
 const mcp=readFileSync(join(import.meta.dir,'..','agentstoz-use-mcp-server.ts'),'utf8');
 for(const word of ['correction-outcomes','correctionOutcome','attest'])expect(mcp).not.toContain(word);
 const use=readFileSync(join(import.meta.dir,'..','src','agentstozUseControl.ts'),'utf8');
 expect(use).not.toContain('correction-outcomes');
});
test('switched off, the route refuses without opening the outcome store',async()=>{
 const s=setup({active:false});
 await expect(s.management.perform(request({operation:'list',folderPath:'/projects/a'}),'local-management')).rejects.toMatchObject({code:'CORRECTION_OUTCOMES_DISABLED'});
 expect(s.opened()).toBe(0);
});
test('attestation requires an eligible written exposure inside the window and refuses OPS/shared targets',async()=>{
 const s=setup({excluded:{'ops-target':true,'lost-target':'unresolved'}});
 const attest=(unitId:string,verdict='avoided')=>s.management.perform(request({operation:'attest',unitId,verdict}),'local-management');
 const preProtocol=s.put({writtenAt:iso(T0-HOUR)});
 const withheld=s.put({sourceWithheld:true}),unrelated=s.put({relatedness:{queryTerms:4,matchedTerms:1,evidenceMatchedTerms:0}});
 const unknown=s.put({state:'unknown',writtenAt:null}),ops=s.put({targetId:'ops-target'}),lost=s.put({targetId:'lost-target'});
 const ok=s.put();
 await expect(attest('c'.repeat(64))).rejects.toMatchObject({code:'CORRECTION_OUTCOME_UNIT_NOT_FOUND'});
 for(const u of [preProtocol,withheld,unrelated,unknown])await expect(attest(u.unitId)).rejects.toMatchObject({code:'CORRECTION_OUTCOME_UNIT_INELIGIBLE'});
 for(const u of [ops,lost])await expect(attest(u.unitId)).rejects.toMatchObject({code:'CORRECTION_OUTCOME_TARGET_EXCLUDED'});
 expect(await attest(ok.unitId)).toMatchObject({ok:true,operation:'attest',unitId:ok.unitId,verdict:'avoided',recorded:'inserted',conflict:false});
 expect(s.store().observations(ok.unitId)).toEqual([{source:'human-attestation',unitId:ok.unitId,verdict:'avoided',at:iso(s.at())}]);
 s.advance(WINDOW+1);
 await expect(attest(ok.unitId,'repeated')).rejects.toMatchObject({code:'CORRECTION_OUTCOME_WINDOW_CLOSED'});
 for(const u of [preProtocol,withheld,unrelated,unknown,ops,lost])expect(s.store().observations(u.unitId)).toEqual([]);
});
test('attestation is idempotent by requestId and a second different verdict makes the unit unknown with a conflict reason',async()=>{
 const s=setup(),u=s.put();
 const first=request({operation:'attest',unitId:u.unitId,verdict:'avoided'});
 expect(await s.management.perform(first,'local-management')).toMatchObject({recorded:'inserted'});
 s.advance(1000);
 // The same request retried after a lost reply: one observation, the original answer.
 expect(await s.management.perform(first,'local-management')).toMatchObject({recorded:'exists',verdict:'avoided'});
 expect(s.store().observations(u.unitId)).toHaveLength(1);
 await expect(s.management.perform({...first,verdict:'repeated'},'local-management')).rejects.toMatchObject({code:'CORRECTION_OUTCOME_REQUEST_ID_CONFLICT'});
 const second=await s.management.perform(request({operation:'attest',unitId:u.unitId,verdict:'repeated'}),'local-management');
 expect(second).toMatchObject({recorded:'inserted',conflict:true});
 expect(s.store().observations(u.unitId)).toHaveLength(2);
 // A retry after the window closed still returns the stored answer instead of refusing.
 s.advance(WINDOW+HOUR);
 expect(await s.management.perform(first,'local-management')).toMatchObject({recorded:'exists'});
 await s.observer().observe();
 expect(s.store().outcome(u.unitId)).toMatchObject({status:'unknown',reason:'conflict',sources:['human-attestation']});
});
// Review S4-05 (low, 2026-10-16): the window was checked with a clock read before the route awaited the target check,
// and the observation was inserted later without looking at finality again (the route awaits between its checks and the
// write — `#writable` itself, and for bind the manifest read). An outcome finalized meanwhile still got the attestation
// stored as 'inserted', and the screen said 「결과를 남겼습니다」 for a result that never counted.
/** The route's store, finalizing `unitId` right after the route's own finality check passes (an observer tick in between). */
function finalizedRightAfterCheck(unit:CorrectionExposureUnit,at:()=>number){
 let armed=true;
 return (store:CorrectionOutcomeStore)=>new Proxy(store,{get(target,key){
  if(key==='outcome')return (unitId:string)=>{const before=target.outcome(unitId);
   if(armed&&!before&&unitId===unit.unitId){armed=false;expect(target.addOutcome(unit.unitId,classifyCorrectionOutcome(unit,[],at()+WINDOW+1))).toBe('inserted');}
   return before;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
test('an attestation finalized right after its checks passed is refused as too late and stores nothing',async()=>{
 let wrap:((store:CorrectionOutcomeStore)=>CorrectionOutcomeStore)|null=null;
 const s=setup({wrapStore:store=>wrap?wrap(store):store}),u=s.put();wrap=finalizedRightAfterCheck(u,()=>s.at());
 const first=request({operation:'attest',unitId:u.unitId,verdict:'avoided'});
 await expect(s.management.perform(first,'local-management')).rejects.toMatchObject({code:'CORRECTION_OUTCOME_FINALIZED_MEANWHILE'});
 expect(s.store().observations(u.unitId)).toEqual([]);
 // Nothing was recorded under that requestId either: a retry is refused as final, not replayed as a success.
 await expect(s.management.perform(first,'local-management')).rejects.toMatchObject({code:'CORRECTION_OUTCOME_ALREADY_FINAL'});
 expect(s.store().observations(u.unitId)).toEqual([]);
});
test('an attestation whose window closes while the route waits is refused, not stamped with the earlier time',async()=>{
 let hook:(()=>void)|null=null;
 const s=setup({during:dep=>{if(dep==='excluded'&&hook){const run=hook;hook=null;run();}}}),u=s.put();
 hook=()=>s.advance(WINDOW+1);
 await expect(s.management.perform(request({operation:'attest',unitId:u.unitId,verdict:'repeated'}),'local-management'))
  .rejects.toMatchObject({code:'CORRECTION_OUTCOME_WINDOW_CLOSED'});
 expect(s.store().observations(u.unitId)).toEqual([]);
});
test('a binding racing finalization of its unit is refused as too late and binds nothing',async()=>{
 const tester=testerRoot();let hook:(()=>void)|null=null;
 const s=setup({roots:{'target-a':tester.root},during:dep=>{if(dep==='checks'&&hook){const run=hook;hook=null;run();}}}),u=s.put();
 hook=()=>{expect(s.store().addOutcome(u.unitId,classifyCorrectionOutcome(u,[],s.at()+WINDOW+1))).toBe('inserted');};
 await expect(s.management.perform(request({operation:'bind',unitId:u.unitId,checkIds:['shell-input']}),'local-management'))
  .rejects.toMatchObject({code:'CORRECTION_OUTCOME_FINALIZED_MEANWHILE'});
 expect(s.store().binding(u.memoryId,u.entryKey,u.contentVersionHash)).toBeNull();
});
test('a single attestation finalizes as that verdict once the window closes; unsure stays unknown',async()=>{
 const s=setup(),avoided=s.put(),unsure=s.put({sessionId:'session-b'});
 await s.management.perform(request({operation:'attest',unitId:avoided.unitId,verdict:'avoided'}),'local-management');
 await s.management.perform(request({operation:'attest',unitId:unsure.unitId,verdict:'unsure'}),'local-management');
 s.advance(WINDOW+HOUR);await s.observer().observe();
 expect(s.store().outcome(avoided.unitId)).toMatchObject({status:'avoided',sources:['human-attestation']});
 expect(s.store().outcome(unsure.unitId)).toMatchObject({status:'unknown',reason:'attested-unsure'});
});
test('list returns at most 20 recent eligible units with titles only, never task or evidence text',async()=>{
 const s=setup({excluded:{'ops-target':true}});
 const units:CorrectionExposureUnit[]=[];
 for(let i=0;i<CORRECTION_OUTCOME_LIST_LIMIT+5;i++){units.push(s.put({sessionId:i===0?'session-a':'session-'+i}));s.advance(1000);}
 s.put({sourceWithheld:true});s.put({memoryId:'memory-b'});const ops=s.put({targetId:'ops-target'});
 const result=await s.management.perform(request({operation:'list',folderPath:'/projects/a'}),'local-management') as any;
 expect(result.units).toHaveLength(CORRECTION_OUTCOME_LIST_LIMIT);expect(result.truncated).toBe(true);
 // Newest first; the excluded-target unit is listed but cannot be attested.
 expect(result.units[0].unitId).toBe(ops.unitId);expect(result.units[0].attestable).toBe(false);
 expect(result.units[1]).toMatchObject({unitId:units.at(-1)!.unitId,entryTitle:'JSON shell input',entryCurrent:true,windowOpen:true,attestable:true,outcome:null,attestations:[],boundChecks:[]});
 for(const row of result.units)expect(Object.keys(row).sort()).toEqual(['attestable','attestations','availableChecks','boundChecks','conversationTitle','entryCurrent','entryTitle','outcome','unitId','windowClosesAt','windowOpen','writtenAt']);
 const oldest=await s.management.perform(request({operation:'list',folderPath:'/projects/a'}),'local-management') as any;
 expect(oldest.units.map((r:any)=>r.unitId)).not.toContain(units[0]!.unitId);
 const text=JSON.stringify(result);
 for(const secret of ['memory-a','target-a','session-a','r'.repeat(64),VERSION,ENTRY])expect(text).not.toContain(secret);
 await expect(s.management.perform(request({operation:'list',folderPath:'/projects/none'}),'local-management')).rejects.toMatchObject({code:'CORRECTION_OUTCOME_MEMORY_NOT_FOUND'});
});

// ---- S4-06: tester-check signal ----
function testerRoot(checks:unknown[]=[{id:'shell-input',argv:['bun','test','tests/shell.test.ts']},{id:'other',argv:['bun','test']}]){
 const root=temp('agentstoz-tester-root-');
 mkdirSync(join(root,'.agentstoz','maintainer'),{recursive:true});
 writeFileSync(join(root,'.agentstoz','maintainer.json'),JSON.stringify({schemaVersion:1,profiles:{},checks}));
 const history=(rows:Partial<TesterHistoryRow>[])=>writeFileSync(join(root,'.agentstoz','maintainer','history-v1.jsonl'),
  rows.map(r=>JSON.stringify({at:iso(T0),runId:'run-'+Math.random().toString(16).slice(2),profile:'quick',id:'shell-input',state:'passed',reasonClass:null,seconds:1,
   fingerprint:'f1',sourceUnchanged:true,comparisonKey:'k1',...r})).join('\n')+'\n');
 return {root,history};
}
const row=(over:Partial<TesterHistoryRow>):TesterHistoryRow=>({at:iso(T0),runId:'run-x',profile:'quick',id:'shell-input',state:'passed',reasonClass:null,fingerprint:'f1',sourceUnchanged:true,comparisonKey:'k1',...over});

test('verdict rules: a failure after delivery is repeated; a pass after a source change with an unchanged comparison key is avoided',()=>{
 const unit={unitId:'u'.repeat(64),writtenAt:iso(T0)} as CorrectionExposureUnit;
 const binding={checks:[{id:'shell-input',digest:'d1'}],boundAt:iso(T0)};
 const current=new Map([['shell-input',{digest:'d1',quarantined:false}]]);
 const pre=row({at:iso(T0-HOUR),fingerprint:'f0',state:'failed'});
 expect(testerCheckObservations(unit,binding,[pre,row({at:iso(T0+HOUR),state:'failed',runId:'run-fail',fingerprint:'f2'})],current))
  .toEqual([{source:'tester-check',unitId:unit.unitId,checkId:'shell-input',verdict:'repeated',runId:'run-fail',at:iso(T0+HOUR)}]);
 expect(testerCheckObservations(unit,binding,[pre,row({at:iso(T0+HOUR),runId:'run-pass',fingerprint:'f2'})],current))
  .toEqual([{source:'tester-check',unitId:unit.unitId,checkId:'shell-input',verdict:'avoided',runId:'run-pass',at:iso(T0+HOUR)}]);
 const none=(rows:TesterHistoryRow[],cur=current,b=binding)=>expect(testerCheckObservations(unit,b,rows,cur)).toEqual([]);
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f0'})]); // unchanged source fingerprint
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f2',comparisonKey:'k2'})]); // changed comparison key
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f2',state:'failed',comparisonKey:'k2'})]);
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f2'})],new Map([['shell-input',{digest:'d2',quarantined:false}]])); // definition changed
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f2'})],new Map([['shell-input',{digest:'d1',quarantined:true}]])); // quarantined
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f2'})],new Map()); // check removed from the manifest
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f2',state:'failed',reasonClass:'budget-skipped'})]);
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f2',state:'failed',reasonClass:'not-applicable'})]);
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f2',state:'failed',sourceUnchanged:false})]);
 none([row({at:iso(T0+HOUR),fingerprint:'f2'})]); // no pre row: a pass proves nothing
 none([pre,row({at:iso(T0+WINDOW+1),fingerprint:'f2',state:'failed'})]); // outside the window
 // A run before the binding was made is not scored: no post-hoc pick of a check that already passed.
 none([pre,row({at:iso(T0+HOUR),fingerprint:'f2',state:'failed'})],current,{...binding,boundAt:iso(T0+2*HOUR)});
 // A failure takes precedence over a pass of the same check.
 expect(testerCheckObservations(unit,binding,[pre,row({at:iso(T0+HOUR),fingerprint:'f2'}),row({at:iso(T0+2*HOUR),state:'failed',fingerprint:'f3',runId:'late'})],current)[0]!.verdict).toBe('repeated');
});
test('history reads are byte-bounded, skip malformed lines and refuse a symlinked tester state directory',()=>{
 const {root}=testerRoot();
 const path=join(root,'.agentstoz','maintainer','history-v1.jsonl');
 const early=JSON.stringify(row({runId:'early-row'}));
 const filler='x'.repeat(1024);
 writeFileSync(path,[early,...Array.from({length:400},()=>filler),'{not json',JSON.stringify(row({runId:'late-row'}))].join('\n')+'\n');
 const rows=readTesterHistoryTail(root);
 expect(CORRECTION_TESTER_HISTORY_MAX_BYTES).toBe(256*1024);
 expect(rows.map(r=>r.runId)).toEqual(['late-row']);
 expect(readTesterHistoryTail(temp('agentstoz-tester-empty-'))).toEqual([]);
 const linked=temp('agentstoz-tester-link-');mkdirSync(join(linked,'.agentstoz'));
 symlinkSync(join(root,'.agentstoz','maintainer'),join(linked,'.agentstoz','maintainer'));
 expect(()=>readTesterHistoryTail(linked)).toThrow();
 const fileLink=temp('agentstoz-tester-file-link-');mkdirSync(join(fileLink,'.agentstoz','maintainer'),{recursive:true});
 symlinkSync(path,join(fileLink,'.agentstoz','maintainer','history-v1.jsonl'));
 expect(()=>readTesterHistoryTail(fileLink)).toThrow();
 const manifestLink=temp('agentstoz-tester-manifest-link-');mkdirSync(join(manifestLink,'.agentstoz'));
 symlinkSync(join(root,'.agentstoz','maintainer.json'),join(manifestLink,'.agentstoz','maintainer.json'));
 expect(()=>readTesterManifestChecks(manifestLink)).toThrow();
});
test('binding requires existing check ids, an open window and the management route',async()=>{
 const tester=testerRoot([{id:'shell-input',argv:['bun','test']},{id:'flaky',argv:['bun','test'],status:'quarantined'}]);
 const s=setup({roots:{'target-a':tester.root}}),u=s.put();
 const bind=(checkIds:string[],authority:any='local-management',unitId=u.unitId)=>s.management.perform(request({operation:'bind',unitId,checkIds}),authority);
 await expect(bind(['missing'])).rejects.toMatchObject({code:'CORRECTION_OUTCOME_CHECK_UNKNOWN'});
 await expect(bind(['flaky'])).rejects.toMatchObject({code:'CORRECTION_OUTCOME_CHECK_QUARANTINED'});
 await expect(bind(['shell-input'],'remote')).rejects.toMatchObject({code:'CORRECTION_OUTCOME_LOCAL_ONLY'});
 expect(await bind(['shell-input'])).toMatchObject({ok:true,operation:'bind',checkIds:['shell-input'],recorded:'inserted'});
 const listed=await s.management.perform(request({operation:'list',folderPath:'/projects/a'}),'local-management') as any;
 expect(listed.units[0]).toMatchObject({boundChecks:['shell-input'],availableChecks:['shell-input']});
 const noManifest=setup(),v=noManifest.put();
 await expect(noManifest.management.perform(request({operation:'bind',unitId:v.unitId,checkIds:['shell-input']}),'local-management')).rejects.toMatchObject({code:'CORRECTION_OUTCOME_CHECKS_UNAVAILABLE'});
 s.advance(WINDOW+1);
 await expect(bind(['shell-input'])).rejects.toMatchObject({code:'CORRECTION_OUTCOME_WINDOW_CLOSED'});
});
test('a bound check failing after delivery marks the unit repeated, labelled tester-check',async()=>{
 const tester=testerRoot(),s=setup({roots:{'target-a':tester.root}}),u=s.put();
 await s.management.perform(request({operation:'bind',unitId:u.unitId,checkIds:['shell-input']}),'local-management');
 tester.history([{at:iso(T0-HOUR),fingerprint:'f0'},{at:iso(s.at()+HOUR),state:'failed',fingerprint:'f2',runId:'run-after'}]);
 s.advance(WINDOW+HOUR);await s.observer({'target-a':tester.root}).observe();
 expect(s.store().outcome(u.unitId)).toMatchObject({status:'repeated',sources:['tester-check']});
});
test('passing with a changed source fingerprint and an unchanged comparison key marks avoided; a changed definition gives no signal',async()=>{
 const tester=testerRoot(),s=setup({roots:{'target-a':tester.root}}),u=s.put(),v=s.put({entryKey:'f'.repeat(24),sessionId:'session-b'});
 await s.management.perform(request({operation:'bind',unitId:u.unitId,checkIds:['shell-input']}),'local-management');
 tester.history([{at:iso(T0-HOUR),fingerprint:'f0'},{at:iso(s.at()+HOUR),fingerprint:'f2',runId:'run-pass'}]);
 s.advance(WINDOW+HOUR);await s.observer({'target-a':tester.root}).observe();
 expect(s.store().outcome(u.unitId)).toMatchObject({status:'avoided',sources:['tester-check']});
 // An unbound scope gets nothing from the same history.
 expect(s.store().outcome(v.unitId)).toMatchObject({status:'unknown',reason:'no-independent-evidence'});

 const t2=testerRoot(),s2=setup({roots:{'target-a':t2.root}}),w=s2.put();
 await s2.management.perform(request({operation:'bind',unitId:w.unitId,checkIds:['shell-input']}),'local-management');
 // The check was weakened after binding: its definition digest no longer matches, so its pass is not evidence.
 writeFileSync(join(t2.root,'.agentstoz','maintainer.json'),JSON.stringify({schemaVersion:1,profiles:{},checks:[{id:'shell-input',argv:['true']}]}));
 t2.history([{at:iso(T0-HOUR),fingerprint:'f0'},{at:iso(s2.at()+HOUR),fingerprint:'f2'}]);
 s2.advance(WINDOW+HOUR);await s2.observer({'target-a':t2.root}).observe();
 expect(s2.store().outcome(w.unitId)).toMatchObject({status:'unknown',reason:'no-independent-evidence'});
});
test('an unreadable tester history gives no signal and does not stop finalization',async()=>{
 const tester=testerRoot(),s=setup({roots:{'target-a':tester.root}}),u=s.put();
 await s.management.perform(request({operation:'bind',unitId:u.unitId,checkIds:['shell-input']}),'local-management');
 const path=join(tester.root,'.agentstoz','maintainer','history-v1.jsonl');
 writeFileSync(path+'.real','');symlinkSync(path+'.real',path);
 s.advance(WINDOW+HOUR);await s.observer({'target-a':tester.root}).observe();
 expect(s.store().outcome(u.unitId)).toMatchObject({status:'unknown',reason:'no-independent-evidence'});
 // classifyCorrectionOutcome stays the only judge: a tester observation about another unit is ignored.
 expect(classifyCorrectionOutcome(u,[{source:'tester-check',unitId:'z'.repeat(64),checkId:'shell-input',verdict:'avoided',runId:'r',at:iso(T0+HOUR)}],T0+WINDOW+HOUR).status).toBe('unknown');
});

// ---- Attribution: one tester run is one observation, like a re-correction ----
test('one tester run in a shared scope is credited once: to the latest unit of one session, to none across sessions',async()=>{
 // Three sessions received the same correction; one failing run follows all three deliveries.
 const tester=testerRoot(),s=setup({roots:{'target-a':tester.root}});
 const a=s.put({sessionId:'session-a'});s.advance(HOUR);const b=s.put({sessionId:'session-b'});s.advance(HOUR);const c=s.put({sessionId:'session-c'});
 await s.management.perform(request({operation:'bind',unitId:c.unitId,checkIds:['shell-input']}),'local-management');
 tester.history([{at:iso(T0-HOUR),fingerprint:'f0'},{at:iso(s.at()+HOUR),state:'failed',fingerprint:'f2',runId:'run-shared'}]);
 s.advance(WINDOW+HOUR);const observer=s.observer({'target-a':tester.root});await observer.observe();
 for(const u of [a,b,c])expect(s.store().outcome(u.unitId)).toMatchObject({status:'unknown',reason:'no-independent-evidence'});
 expect(observer.overview().ambiguous).toBe(1);

 // Two deliveries in one session: only the latest one before the run is credited — for a failure and for a pass.
 for(const [state,status] of [['failed','repeated'],['passed','avoided']] as const){
  const t=testerRoot(),s2=setup({roots:{'target-a':t.root}});
  const early=s2.put();s2.advance(HOUR);const late=s2.put();
  await s2.management.perform(request({operation:'bind',unitId:late.unitId,checkIds:['shell-input']}),'local-management');
  t.history([{at:iso(T0-HOUR),fingerprint:'f0'},{at:iso(s2.at()+HOUR),state,fingerprint:'f2',runId:'run-one'}]);
  s2.advance(WINDOW+2*HOUR);await s2.observer({'target-a':t.root}).observe();
  expect(s2.store().outcome(late.unitId)).toMatchObject({status,sources:['tester-check']});
  expect(s2.store().outcome(early.unitId)).toMatchObject({status:'unknown',reason:'no-independent-evidence'});
 }
});

// ---- The test file a check names is part of what the binding pins ----
test('editing the test file a bound check names after binding removes the signal; an untouched file keeps it',async()=>{
 for(const edit of [false,true]){
  const tester=testerRoot();
  mkdirSync(join(tester.root,'tests'),{recursive:true});
  const file=join(tester.root,'tests','shell.test.ts');
  writeFileSync(file,"test('shell input',()=>{expect(run()).toBe('ok');});\n");
  const s=setup({roots:{'target-a':tester.root}}),u=s.put();
  await s.management.perform(request({operation:'bind',unitId:u.unitId,checkIds:['shell-input']}),'local-management');
  // An agent weakening the test leaves maintainer.json untouched — only the file changes.
  if(edit)writeFileSync(file,"test('shell input',()=>{});\n");
  tester.history([{at:iso(T0-HOUR),fingerprint:'f0'},{at:iso(s.at()+HOUR),fingerprint:'f2',runId:'run-pass'}]);
  s.advance(WINDOW+HOUR);await s.observer({'target-a':tester.root}).observe();
  expect(s.store().outcome(u.unitId)).toMatchObject(edit?{status:'unknown',reason:'no-independent-evidence'}:{status:'avoided',sources:['tester-check']});
 }
});
test('a check digest reads only the files its argv names, inside the root, and never follows a symlink',()=>{
 const outside=temp('agentstoz-tester-outside-');writeFileSync(join(outside,'secret.txt'),'x');
 // A real relative path from the root to a file outside it: refused by the `..` rule, never read.
 const escape=relative(temp('agentstoz-tester-anchor-'),join(outside,'secret.txt'));
 const tester=testerRoot([{id:'named',argv:['bun','test','tests/shell.test.ts']},{id:'escape',argv:['cat',escape]},{id:'linked',argv:['bun','test','tests/link.test.ts']}]);
 expect(escape.startsWith('..')).toBe(true);
 mkdirSync(join(tester.root,'tests'));
 writeFileSync(join(tester.root,'tests','shell.test.ts'),'one');
 symlinkSync(join(outside,'secret.txt'),join(tester.root,'tests','link.test.ts'));
 const first=readTesterManifestChecks(tester.root);
 const digests=()=>Object.fromEntries([...readTesterManifestChecks(tester.root)].map(([id,c])=>[id,c.digest])) as Record<string,string>;
 const before=digests();
 expect(first.get('named')!.digest).toBe(before.named!);
 writeFileSync(join(tester.root,'tests','shell.test.ts'),'two');
 writeFileSync(join(outside,'secret.txt'),'y');
 const after=digests();
 expect(after.named).not.toBe(before.named);
 // A symlinked test file is not read through, so the target's content never reaches the digest.
 expect(after.linked).toBe(before.linked);
 expect(after.escape).toBe(before.escape);
});
