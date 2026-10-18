import {afterEach,expect,test} from 'bun:test';
import {chmodSync,existsSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
 CORRECTION_OUTCOME_COVERAGE,CORRECTION_OUTCOME_PIPELINE_ENABLED,CORRECTION_OUTCOME_PROTOCOL,classifyCorrectionOutcome,
 correctionExposureUnitId,correctionOutcomeProtocolHash,evaluateCorrectionLearningTrack,parseCorrectionObservation,
 summarizeCorrectionOutcomes,type CorrectionExposureUnit,type CorrectionObservation,type CorrectionOutcome,
} from '../src/projectMemoryCorrectionOutcome';
import {correctionReportId,buildCorrectionTaskGuidance} from '../src/projectMemoryCorrectionContext';
import {CorrectionOutcomeStore,CORRECTION_OUTCOME_STORE_ROW_LIMIT,readCorrectionOutcomeReport} from '../src/correctionOutcomeStore';
import {CorrectionOutcomeObserver,CORRECTION_OUTCOME_UNRESOLVED_RETRY_TICKS} from '../src/correctionOutcomeObserver';
import {ProjectMemoryCorrectionReview} from '../src/projectMemoryCorrectionReview';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {initializeProjectMemory,prepareProjectMemoryCorrectionTask,readMemoryDocument,recordProjectMemoryFeedback,writeMemoryDocument} from '../project-memory-server';
import {parseProjectMemoryEntries} from '../src/projectMemoryRecall';
import {appendProjectMemoryFeedback,readProjectMemoryFeedback} from '../src/projectMemoryFeedback';
import type {StoredSubmission} from '../src/workroomSubmissions';
import {Database} from 'bun:sqlite';

const HOUR=3_600_000,WINDOW=CORRECTION_OUTCOME_PROTOCOL.windowMs,T0=Date.parse('2026-10-15T00:00:00.000Z');
const iso=(ms:number)=>new Date(ms).toISOString();
const dirs:string[]=[],closers:{close():void}[]=[];
afterEach(()=>{for(const c of closers.splice(0))c.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const related={queryTerms:4,matchedTerms:3,evidenceMatchedTerms:2};
function unit(over:Partial<CorrectionExposureUnit>={}):CorrectionExposureUnit{
 const base={memoryId:'memory-a',entryKey:'e'.repeat(24),contentVersionHash:'a'.repeat(32),reportIds:['r'.repeat(64)],targetId:'target-a',sessionId:'session-a',
  writtenAt:iso(T0),state:'written' as const,sourceWithheld:false,relatedness:related,...over};
 return {unitId:over.unitId??correctionExposureUnitId('key-'+(over.sessionId??'a')+(over.writtenAt??''),base.entryKey,base.contentVersionHash),...base};
}
const recorrection=(u:CorrectionExposureUnit,at:number,reportId='z'.repeat(64)):CorrectionObservation=>({source:'re-correction',memoryId:u.memoryId,entryKey:u.entryKey,contentVersionHash:u.contentVersionHash,reportId,at:iso(at),localOrigin:true});

// ---- S4-01: the pre-registered protocol and the pure classifier ----
test('the pipeline is on (user approval 2026-10-15) and the protocol is the confirmed version 2',()=>{
 // Flipped in its own commit so it can be reverted alone; AGENTSTOZ_CORRECTION_OUTCOMES=off still turns it off per process.
 expect(CORRECTION_OUTCOME_PIPELINE_ENABLED).toBe(true);
 // Confirmed by the user on 2026-10-15 (72h window, relatedness 2/1, minimum 30 finalized + 5 distinct corrections).
 // Confirming changed status, which required a new version and therefore a new protocol hash.
 expect(CORRECTION_OUTCOME_PROTOCOL.status).toBe('confirmed');
 expect(CORRECTION_OUTCOME_PROTOCOL.version).toBe(2);
 expect(CORRECTION_OUTCOME_PROTOCOL.relatedness).toEqual({minMatchedTerms:2,minEvidenceTerms:1});
 expect([CORRECTION_OUTCOME_PROTOCOL.minFinalizedUnitsForRate,CORRECTION_OUTCOME_PROTOCOL.minDistinctCorrectionsForRate]).toEqual([30,5]);
 expect(correctionOutcomeProtocolHash()).not.toBe(correctionOutcomeProtocolHash({...CORRECTION_OUTCOME_PROTOCOL,version:1,status:'proposed'}));
 expect(CORRECTION_OUTCOME_PROTOCOL.windowMs).toBe(72*HOUR);
 expect(Object.isFrozen(CORRECTION_OUTCOME_PROTOCOL)).toBe(true);
});
test('an open window stays pending and a closed window without independent evidence is unknown, never avoided',()=>{
 const u=unit();
 expect(classifyCorrectionOutcome(u,[],T0+HOUR).status).toBe('pending');
 const closed=classifyCorrectionOutcome(u,[],T0+WINDOW+1);
 expect(closed).toMatchObject({status:'unknown',reason:'no-independent-evidence'});
 expect(closed.protocolHash).toBe(correctionOutcomeProtocolHash());
 // A re-correction outside the window is not evidence for this unit.
 expect(classifyCorrectionOutcome(u,[recorrection(u,T0+WINDOW+5)],T0+WINDOW+10).status).toBe('unknown');
 expect(classifyCorrectionOutcome(u,[recorrection(u,T0+HOUR)],T0+WINDOW+1)).toMatchObject({status:'repeated',sources:['re-correction']});
});
test('delivery counts, checkedAt, pending zero and agent applied/confirmed feedback cannot produce avoided',()=>{
 for(const value of [
  {source:'delivery',unitId:'u',delivered:3},{source:'checkedAt',unitId:'u',at:iso(T0)},{source:'pending0',unitId:'u'},
  {source:'agent-feedback',kind:'applied',unitId:'u',at:iso(T0)},{source:'agent-feedback',kind:'confirmed',unitId:'u',at:iso(T0)},
  {source:'self-report',unitId:'u',verdict:'avoided',at:iso(T0)},{source:'transcript',unitId:'u',verdict:'avoided',at:iso(T0)},
  {source:'human-attestation',unitId:'u',verdict:'avoided',at:iso(T0),extra:true},
  {source:'human-attestation',unitId:'u',verdict:'fixed',at:iso(T0)},
  {source:'re-correction',memoryId:'m',entryKey:'e'.repeat(24),contentVersionHash:'a'.repeat(32),reportId:'x',at:iso(T0),localOrigin:true,verdict:'avoided'},
 ])expect(()=>parseCorrectionObservation(value)).toThrow();
 expect(parseCorrectionObservation({source:'human-attestation',unitId:'u',verdict:'avoided',at:iso(T0)})).toMatchObject({verdict:'avoided'});
 // The classifier itself re-parses: an object smuggled past the type system is not evidence.
 const u=unit();
 expect(classifyCorrectionOutcome(u,[{source:'self-report',unitId:u.unitId,verdict:'avoided',at:iso(T0+HOUR)} as any],T0+WINDOW+1).status).toBe('unknown');
 // A re-correction can only ever mean 'repeated'; nothing an agent records reads as avoided.
 expect(classifyCorrectionOutcome(u,[recorrection(u,T0+HOUR)],T0+WINDOW+1).status).not.toBe('avoided');
});
test('conflicting independent verdicts resolve to unknown with a conflict reason',()=>{
 const u=unit();
 const outcome=classifyCorrectionOutcome(u,[recorrection(u,T0+HOUR),{source:'human-attestation',unitId:u.unitId,verdict:'avoided',at:iso(T0+2*HOUR)}],T0+WINDOW+1);
 expect(outcome).toMatchObject({status:'unknown',reason:'conflict'});
 expect(outcome.evidenceRefs).toHaveLength(2);
 expect(classifyCorrectionOutcome(u,[{source:'human-attestation',unitId:u.unitId,verdict:'avoided',at:iso(T0+2*HOUR)}],T0+WINDOW+1).status).toBe('avoided');
 // A re-correction of a report this unit already carried is the same report, not a repeat.
 expect(classifyCorrectionOutcome(u,[recorrection(u,T0+HOUR,u.reportIds[0])],T0+WINDOW+1).status).toBe('unknown');
 // An observation about another unit or scope is ignored.
 expect(classifyCorrectionOutcome(u,[{...recorrection(u,T0+HOUR),entryKey:'f'.repeat(24)} as CorrectionObservation],T0+WINDOW+1).status).toBe('unknown');
 expect(classifyCorrectionOutcome(u,[{...recorrection(u,T0+HOUR),localOrigin:false} as CorrectionObservation],T0+WINDOW+1).status).toBe('unknown');
});
test('unknown delivery, withheld, pre-protocol and below-relatedness units are disclosed as excluded, never silently dropped',()=>{
 const cases:[Partial<CorrectionExposureUnit>,string][]=[
  [{state:'unknown',writtenAt:null},'delivery-uncertain'],[{state:'write_started',writtenAt:null},'delivery-uncertain'],
  [{sourceWithheld:true},'withheld'],[{writtenAt:null},'pre-protocol'],[{relatedness:null},'pre-protocol'],
  [{relatedness:{queryTerms:4,matchedTerms:1,evidenceMatchedTerms:1}},'unrelated'],[{relatedness:{queryTerms:4,matchedTerms:3,evidenceMatchedTerms:0}},'unrelated'],
 ];
 const units=cases.map(([over],i)=>unit({...over,sessionId:'s'+i}));
 cases.forEach(([,reason],i)=>expect(classifyCorrectionOutcome(units[i]!,[],T0+WINDOW+1)).toMatchObject({status:'excluded',reason}));
 // Written before the store was activated: pre-protocol even with every field present.
 expect(classifyCorrectionOutcome(unit(),[],T0+WINDOW+1,CORRECTION_OUTCOME_PROTOCOL,{activatedAt:iso(T0+1)})).toMatchObject({status:'excluded',reason:'pre-protocol'});
 const summary=summarizeCorrectionOutcomes([...units,unit({sessionId:'eligible'})],[],T0+HOUR);
 expect(summary.exposuresObserved).toBe(8);
 expect(summary.excluded).toEqual({'delivery-uncertain':2,withheld:1,'pre-protocol':2,unrelated:2,'target-unresolved':0});
 expect(summary.eligible).toBe(1);expect(summary.pending).toBe(1);
});
test('the repeat rate is null below the pre-registered sample and always keeps unknown in its denominator',()=>{
 const make=(n:number,reports:number)=>{
  const units:CorrectionExposureUnit[]=[],outcomes:CorrectionOutcome[]=[];
  for(let i=0;i<n;i++){
   const u=unit({sessionId:'s'+i,reportIds:[String(i%reports).padStart(64,'0')],writtenAt:iso(T0+i*1000)});units.push(u);
   outcomes.push({unitId:u.unitId,...classifyCorrectionOutcome(u,i%3===0?[recorrection(u,T0+i*1000+HOUR)]:[],T0+WINDOW+n*1000+1)});
  }
  return summarizeCorrectionOutcomes(units,outcomes,T0+WINDOW+n*1000+1);
 };
 const small=make(29,10);
 expect(small.secondary.repeatRate).toBeNull();expect(small.secondary.repeatRateReason).toBe('insufficient-sample');
 const fewCorrections=make(40,4);
 expect(fewCorrections.secondary.repeatRate).toBeNull();
 const enough=make(40,10);
 expect(enough.finalized).toEqual({avoided:0,repeated:14,unknown:26});
 expect(enough.secondary.repeatRate).toEqual({repeated:14,denominator:40});
 expect(enough.efficacyVerified).toBe(false);
});
test('the distinct-correction gate counts only reports carried by finalized units, never pending ones',()=>{
 const units:CorrectionExposureUnit[]=[],outcomes:CorrectionOutcome[]=[];
 const now=T0+WINDOW+HOUR;
 for(let i=0;i<30;i++){
  const u=unit({sessionId:'f'+i,reportIds:['0'.repeat(64)],writtenAt:iso(T0+i*1000)});units.push(u);
  outcomes.push({unitId:u.unitId,...classifyCorrectionOutcome(u,[],now)});
 }
 // Four still-open units each carry a different report: they make five distinct reports overall, but none is finalized.
 for(let i=1;i<=4;i++)units.push(unit({sessionId:'p'+i,reportIds:[String(i).padStart(64,'0')],writtenAt:iso(now-HOUR)}));
 const summary=summarizeCorrectionOutcomes(units,outcomes,now);
 expect(summary.secondary.finalized).toEqual({avoided:0,repeated:0,unknown:30});
 expect(summary.pending).toBe(4);
 expect(summary.secondary.repeatRate).toBeNull();expect(summary.secondary.repeatRateReason).toBe('insufficient-sample');
 expect(summary.primary.repeatRate).toBeNull();expect(summary.primary.repeatRateReason).toBe('insufficient-sample');
});
test('the protocol hash is stable for identical constants and changes when any window or threshold changes',()=>{
 const same={...CORRECTION_OUTCOME_PROTOCOL,relatedness:{...CORRECTION_OUTCOME_PROTOCOL.relatedness}};
 expect(correctionOutcomeProtocolHash(same)).toBe(correctionOutcomeProtocolHash());
 expect(correctionOutcomeProtocolHash()).toMatch(/^[a-f0-9]{64}$/);
 for(const changed of [
  {...same,windowMs:48*HOUR},{...same,relatedness:{...same.relatedness,minMatchedTerms:3}},{...same,relatedness:{...same.relatedness,minEvidenceTerms:2}},
  {...same,minFinalizedUnitsForRate:31},{...same,minDistinctCorrectionsForRate:6},{...same,version:same.version+1},{...same,status:"proposed" as const},
 ])expect(correctionOutcomeProtocolHash(changed)).not.toBe(correctionOutcomeProtocolHash());
 expect(()=>correctionOutcomeProtocolHash({...same,windowMs:HOUR-1})).toThrow();
});
test('the primary metric counts only the first eligible exposure after each correction report',()=>{
 const report='1'.repeat(64);
 const first=unit({sessionId:'first',reportIds:[report],writtenAt:iso(T0)}),second=unit({sessionId:'second',reportIds:[report],writtenAt:iso(T0+HOUR)});
 const ignoredEarlier=unit({sessionId:'early-excluded',reportIds:[report],writtenAt:iso(T0-HOUR),sourceWithheld:true});
 const now=T0+WINDOW+2*HOUR;
 const outcomes=[first,second,ignoredEarlier].map(u=>({unitId:u.unitId,...classifyCorrectionOutcome(u,u===second?[recorrection(u,T0+2*HOUR)]:[],now)}));
 const summary=summarizeCorrectionOutcomes([first,second,ignoredEarlier],outcomes,now);
 expect(summary.primary.units).toBe(1);expect(summary.primary.finalized).toEqual({avoided:0,repeated:0,unknown:1});
 expect(summary.finalized).toEqual({avoided:0,repeated:1,unknown:1});
 expect(summary.distinctCorrections).toBe(1);
});
test('correctionReportId matches the reportIds recorded by buildCorrectionTaskGuidance',()=>{
 const guidance=buildCorrectionTaskGuidance({memoryId:'m',corrections:[{entryKey:'e'.repeat(24),contentVersionHash:'a'.repeat(32),title:'Rule',
  reports:[{eventId:'event-1',kind:'corrected',evidence:'Failure: x. Next: y.',recordedAt:iso(T0)},{eventId:'event-2',kind:'corrected',evidence:'Failure: z.',recordedAt:iso(T0)}]}]});
 expect(guidance!.exposure.entries[0]!.reportIds).toEqual([correctionReportId('event-1'),correctionReportId('event-2')]);
});
// ---- S4-10: coverage bias disclosure ----
test('every outcome summary discloses which submission paths can carry corrections',()=>{
 expect(CORRECTION_OUTCOME_COVERAGE).toEqual({exposedPaths:['composer-submission','reviewed-voice','@-route-submission'],notExposed:['mcp-instruction','new-session-first-prompt','@-route-raw','legacy-lan']});
 // A composer submission with images goes through the same submission write and receives corrections
 // (tests/workroom-submission-attachments.test.ts), so images are not an unexposed path.
 expect(CORRECTION_OUTCOME_COVERAGE.notExposed as readonly string[]).not.toContain('image');
 expect(summarizeCorrectionOutcomes([],[],T0).coverage).toEqual(CORRECTION_OUTCOME_COVERAGE);
 expect(summarizeCorrectionOutcomes([unit()],[],T0).coverage).toEqual(CORRECTION_OUTCOME_COVERAGE);
});
// ---- S4-07: the benchmark learning track never becomes PASS from counts ----
test('learning remains NOT_RUN/BLOCKED without a pre-registered baseline even with finalized outcomes',()=>{
 expect(evaluateCorrectionLearningTrack(null)).toEqual({status:'NOT_RUN',reason:'no-outcome-store'});
 expect(evaluateCorrectionLearningTrack(summarizeCorrectionOutcomes([],[],T0))).toEqual({status:'NOT_RUN',reason:'no-finalized-outcomes'});
 const u=unit(),outcome={unitId:u.unitId,...classifyCorrectionOutcome(u,[recorrection(u,T0+HOUR)],T0+WINDOW+1)};
 expect(evaluateCorrectionLearningTrack(summarizeCorrectionOutcomes([u],[outcome],T0+WINDOW+1))).toEqual({status:'BLOCKED',reason:'baseline-missing'});
});

// ---- S4-03 / S4-04: the store, the observer and the existing hourly tick ----
const entryKey='e'.repeat(24);
function memoryFixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'agentstoz-outcome-memory-')));dirs.push(root);
 const status=initializeProjectMemory({folderPath:root,projectName:'Outcome fixture'});
 const path=join(root,status.config!.sourcePath);
 const write=(text:string)=>writeMemoryDocument(root,path,`# Project Core Memory\n\n## Key Decisions\n\n### JSON shell input\n<!-- memory-entry-id:${entryKey} -->\n${text}\n`);
 write('Use JSON serialization for shell input.');
 const entry=()=>parseProjectMemoryEntries(readMemoryDocument(root,path))[0]!;
 return {root,write,entry,memoryId:status.config!.memoryId};
}
function appData(){const dir=mkdtempSync(join(tmpdir(),'agentstoz-outcome-data-'));chmodSync(dir,0o700);dirs.push(dir);return dir;}
function harness(options:{targets?:Record<string,string>;excluded?:string[];unresolved?:Set<string>;deviceId?:string|null;ledgerFails?:boolean}={}){
 const dir=appData();let clock=Date.now()-600_000;
 const journal=new WorkroomConversationJournal(dir,()=>iso(clock));closers.push(journal);
 let store:CorrectionOutcomeStore|null=null;let ledgerReads=0;
 const observer=new CorrectionOutcomeObserver({
  store:()=>{if(!store){store=new CorrectionOutcomeStore(dir,()=>iso(clock));closers.push(store);}return store;},
  journal:()=>journal,
  excluded:async target=>options.unresolved?.has(target)?'unresolved':(options.excluded??[]).includes(target),
  ledger:async target=>{ledgerReads++;if(options.ledgerFails)return null;const root=options.targets?.[target];if(!root)return null;return readProjectMemoryFeedback(root);},
  deviceId:()=>options.deviceId??null,
  now:()=>clock,
 });
 let n=0;
 const expose=(target:string,guidance:{exposure:any},session='session-'+target)=>{
  const key='submission-key-'+(n++);
  journal.prepareSubmission({owner:'o'.repeat(64),sessionId:session,targetId:target,binding:'b'.repeat(64),revision:0,key,id:'submission-'+n,fingerprint:'f'.repeat(64),intentHash:'i'.repeat(64),epoch:'epoch-'+n,bootId:journal.bootId,state:'prepared'} as StoredSubmission);
  journal.transitionSubmission(key,'prepared','write_started',guidance.exposure);journal.transitionSubmission(key,'write_started','written');
  return key;
 };
 return {dir,journal,observer,expose,store:()=>store,advance:(ms:number)=>{clock+=ms;},at:()=>clock,setClock:(ms:number)=>{clock=ms;},ledgerReads:()=>ledgerReads};
}
function correctedMemory(){
 const m=memoryFixture();
 recordProjectMemoryFeedback({folderPath:m.root,entryKey,contentVersionHash:m.entry().contentVersionHash,kind:'corrected',evidence:'Failure: command substitution executed. Next time use shell quoting and verify literal bytes.'});
 const guidance=prepareProjectMemoryCorrectionTask(m.root,'Avoid shell command substitution')!;
 return {...m,guidance};
}
test('a distinct user correction on the same entry version inside the window marks the latest unique exposure repeated',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root}});
 await h.observer.observe();h.advance(1000);
 h.expose('target-a',m.guidance,'session-a');h.advance(1000);
 const later=h.expose('target-a',m.guidance,'session-a');h.advance(60_000);
 recordProjectMemoryFeedback({folderPath:m.root,entryKey,contentVersionHash:m.entry().contentVersionHash,kind:'corrected',evidence:'Failure: substitution ran again. Next: quote every argument.'});
 h.advance(WINDOW+HOUR);await h.observer.observe();
 const summary=h.observer.summary(m.memoryId)!;
 expect(summary.exposuresObserved).toBe(2);
 expect(summary.finalized).toEqual({avoided:0,repeated:1,unknown:1});
 expect(summary.bySource['re-correction']).toBe(1);
 const units=h.store()!.units();
 const repeated=units.find(u=>h.store()!.outcome(u.unitId)?.status==='repeated')!;
 expect(repeated.unitId).toBe(correctionExposureUnitId(later,entryKey,m.entry().contentVersionHash));
 expect(summary.efficacyVerified).toBe(false);
});
test('a correction on a changed body version, outside the window, from another device, or identical to a delivered report is not a repeat',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root},deviceId:'this-device'});
 await h.observer.observe();h.advance(1000);
 h.expose('target-a',m.guidance);const version=m.entry().contentVersionHash;
 // Identical retry of the delivered report: the same event id, so the same report.
 recordProjectMemoryFeedback({folderPath:m.root,entryKey,contentVersionHash:version,kind:'corrected',evidence:'Failure: command substitution executed. Next time use shell quoting and verify literal bytes.'});
 appendProjectMemoryFeedback(m.root,{memoryId:m.memoryId,entryKey,contentVersionHash:version,kind:'corrected',evidence:'Failure: from another Mac.',deviceId:'other-device'});
 appendProjectMemoryFeedback(m.root,{memoryId:m.memoryId,entryKey,contentVersionHash:version,kind:'corrected',evidence:'Failure: long after.',recordedAt:iso(h.at()+WINDOW+HOUR)});
 appendProjectMemoryFeedback(m.root,{memoryId:m.memoryId,entryKey,contentVersionHash:version,kind:'applied',evidence:'Agent says it applied the rule.'});
 m.write('A changed shell rule body.');
 recordProjectMemoryFeedback({folderPath:m.root,entryKey,contentVersionHash:m.entry().contentVersionHash,kind:'corrected',evidence:'Failure on the new body.'});
 h.advance(WINDOW+2*HOUR);await h.observer.observe();
 expect(h.observer.summary(m.memoryId)!.finalized).toEqual({avoided:0,repeated:0,unknown:1});
});
test('a correction inside two sessions\' open windows is ambiguous and leaves both unknown',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root}});
 await h.observer.observe();h.advance(1000);
 h.expose('target-a',m.guidance,'session-one');h.advance(1000);h.expose('target-a',m.guidance,'session-two');h.advance(1000);
 recordProjectMemoryFeedback({folderPath:m.root,entryKey,contentVersionHash:m.entry().contentVersionHash,kind:'corrected',evidence:'Failure: happened again somewhere.'});
 h.advance(WINDOW+HOUR);await h.observer.observe();
 const summary=h.observer.summary(m.memoryId)!;
 expect(summary.finalized).toEqual({avoided:0,repeated:0,unknown:2});
 expect(h.observer.overview().ambiguous).toBe(1);
});
test('an unreadable ledger yields no observation and the unit stays pending, never avoided',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root},ledgerFails:true});
 await h.observer.observe();h.advance(1000);h.expose('target-a',m.guidance);
 h.advance(WINDOW+HOUR);await h.observer.observe();
 const summary=h.observer.summary(m.memoryId)!;
 expect(summary.finalized).toEqual({avoided:0,repeated:0,unknown:0});
 expect(summary.pending).toBe(1);
 expect(h.observer.overview()).toMatchObject({backlog:1});
});
test('the observer ingests new exposures by journal rowid cursor and re-reads only non-final units',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root}});
 await h.observer.observe();h.advance(1000);
 h.expose('target-a',m.guidance);
 // A submission that is still writing: ingested as non-final, re-read on the next pass.
 const key='still-writing';
 h.journal.prepareSubmission({owner:'o'.repeat(64),sessionId:'s',targetId:'target-a',binding:'b'.repeat(64),revision:0,key,id:'submission-writing',fingerprint:'f'.repeat(64),intentHash:'i'.repeat(64),epoch:'epoch-w',bootId:h.journal.bootId,state:'prepared'} as StoredSubmission);
 h.journal.transitionSubmission(key,'prepared','write_started',m.guidance.exposure);
 await h.observer.observe();
 expect(h.store()!.units().map(u=>u.state).sort()).toEqual(['write_started','written']);
 h.advance(1000);h.journal.transitionSubmission(key,'write_started','written');
 const reads:string[]=[];const original=h.journal.submission.bind(h.journal);
 (h.journal as any).submission=(k:string)=>{reads.push(k);return original(k);};
 await h.observer.observe();
 expect(reads).toEqual([key]);
 expect(h.store()!.units().map(u=>u.state)).toEqual(['written','written']);
 expect(h.store()!.units().every(u=>!!u.writtenAt)).toBe(true);
 // Nothing new: the cursor does not rescan old rows.
 reads.length=0;await h.observer.observe();expect(reads).toEqual([]);
});
test('finalized outcomes are append-only and a later protocol version never re-scores them',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root}});
 await h.observer.observe();h.advance(1000);h.expose('target-a',m.guidance);
 h.advance(WINDOW+HOUR);await h.observer.observe();
 const store=h.store()!,[u]=store.units();
 const first=store.outcome(u!.unitId)!;expect(first.status).toBe('unknown');
 expect(store.addOutcome(u!.unitId,{...first,status:'avoided'})).toBe('exists');
 expect(store.outcome(u!.unitId)).toEqual(first);
 // A late observation is stored but never re-scores the finalized unit.
 expect(store.addObservation(u!.unitId,{source:'human-attestation',unitId:u!.unitId,verdict:'avoided',at:iso(h.at())})).toBe('inserted');
 const db=new Database(join(h.dir,'correction-outcomes-v1','outcomes.sqlite'));
 try{
  expect(()=>db.exec("UPDATE correction_outcomes SET status='avoided'")).toThrow();
  expect(()=>db.exec('DELETE FROM correction_outcomes')).toThrow();
  expect(()=>db.exec('DELETE FROM correction_observations')).toThrow();
 }finally{db.close();}
 const next=new CorrectionOutcomeObserver({store:()=>store,journal:()=>h.journal,excluded:async()=>false,ledger:async()=>readProjectMemoryFeedback(m.root),deviceId:()=>null,now:()=>h.at(),
  protocol:{...CORRECTION_OUTCOME_PROTOCOL,version:CORRECTION_OUTCOME_PROTOCOL.version+1}});
 await next.observe();
 expect(store.outcome(u!.unitId)).toEqual(first);
 expect(next.summary(m.memoryId)!.otherProtocol).toBe(1);
});
test('the outcome store refuses appends at its cap without deleting finalized or pending evidence',()=>{
 const dir=appData(),store=new CorrectionOutcomeStore(dir,()=>iso(T0),{rowLimit:3});closers.push(store);
 const units=[0,1,2,3].map(i=>unit({sessionId:'cap'+i}));
 expect(units.slice(0,3).map(u=>store.putUnit(u,'key-'+u.sessionId))).toEqual(['inserted','inserted','inserted']);
 expect(store.putUnit(units[3]!,'key-cap3')).toBe('full');
 expect(store.units()).toHaveLength(3);
 const outcome={...classifyCorrectionOutcome(units[0]!,[],T0+WINDOW+1)};
 expect(store.addOutcome(units[0]!.unitId,outcome)).toBe('inserted');
 expect(CORRECTION_OUTCOME_STORE_ROW_LIMIT).toBe(20_000);
});
test('outcome observation runs inside the existing 60s tick and does not raise the 8-target attempt budget',async()=>{
 let now=0,observed=0;const calls:string[]=[],targets=Array.from({length:12},(_,i)=>'t'+i);
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>targets,
  review:async target=>{calls.push(target);return {pendingEntries:0,changedVersionEntries:0,unboundReports:0};},
  observeOutcomes:async()=>{observed++;throw Error('store unavailable');},outcomeOverview:()=>({pending:2,backlog:1,overdue:0})});
 await review.tick();expect(calls).toHaveLength(8);expect(observed).toBe(1);
 await review.tick();expect(observed).toBe(1);
 now=60_000;await review.tick();expect(calls).toHaveLength(12);expect(observed).toBe(2);
 expect(review.overview()).toMatchObject({outcomes:{pending:2,backlog:1,overdue:0},efficacyVerified:false});
 // Without the optional dependency the overview has no outcome counts at all.
 const plain=new ProjectMemoryCorrectionReview({enabled:()=>true,targets:async()=>[],review:async()=>null});
 expect(plain.overview().outcomes).toBeNull();
});
test('a submission prepared earlier but committed after a later one is still ingested',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root}});
 await h.observer.observe();h.advance(1000);
 const prepare=(key:string,session:string)=>h.journal.prepareSubmission({owner:'o'.repeat(64),sessionId:session,targetId:'target-a',binding:'b'.repeat(64),revision:0,key,id:'id-'+key,fingerprint:'f'.repeat(64),intentHash:'i'.repeat(64),epoch:'epoch-'+key,bootId:h.journal.bootId,state:'prepared'} as StoredSubmission);
 const commit=(key:string)=>{h.journal.transitionSubmission(key,'prepared','write_started',m.guidance.exposure);h.journal.transitionSubmission(key,'write_started','written');};
 // R1 is still assembling chunks (a phone relay) while R2 commits and the review tick runs in between.
 prepare('slow-r1','session-one');prepare('fast-r2','session-two');
 commit('fast-r2');await h.observer.observe();
 h.advance(1000);commit('slow-r1');await h.observer.observe();
 const version=m.entry().contentVersionHash;
 expect(h.store()!.units().map(u=>u.unitId).sort()).toEqual([correctionExposureUnitId('slow-r1',entryKey,version),correctionExposureUnitId('fast-r2',entryKey,version)].sort());
 expect(h.observer.summary(m.memoryId)!.exposuresObserved).toBe(2);
});
test('a target that cannot be resolved is retried, not dropped, and is disclosed as excluded if it stays unresolved',async()=>{
 const m=correctedMemory(),unresolved=new Set(['target-a']),h=harness({targets:{'target-a':m.root},unresolved});
 await h.observer.observe();h.advance(1000);
 h.expose('target-a',m.guidance);
 // A transient failure (registry unreadable at startup): nothing ingested, and the row is read again next tick.
 await h.observer.observe();
 expect(h.store()!.units()).toHaveLength(0);
 unresolved.clear();await h.observer.observe();
 expect(h.store()!.units()).toHaveLength(1);
 expect(h.observer.summary(m.memoryId)!.excluded['target-unresolved']).toBe(0);

 // A target that never resolves: after the bounded retries it is counted, never silently skipped.
 const m2=correctedMemory(),stuck=new Set(['target-b']),h2=harness({targets:{'target-b':m2.root},unresolved:stuck});
 await h2.observer.observe();h2.advance(1000);
 h2.expose('target-b',m2.guidance);
 for(let i=0;i<CORRECTION_OUTCOME_UNRESOLVED_RETRY_TICKS;i++)await h2.observer.observe();
 const summary=h2.observer.summary(m2.memoryId)!;
 expect(summary.exposuresObserved).toBe(1);
 expect(summary.excluded['target-unresolved']).toBe(1);
 expect(summary.eligible).toBe(0);
});
test('OPS and shared-root exposures are never ingested',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root,'ops-target':m.root},excluded:['ops-target']});
 await h.observer.observe();h.advance(1000);
 h.expose('ops-target',m.guidance);h.expose('target-a',m.guidance);
 await h.observer.observe();
 expect(h.store()!.units().map(u=>u.targetId)).toEqual(['target-a']);
});
test('a different journal store instance stops ingestion instead of mixing lineages',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root}});
 await h.observer.observe();h.advance(1000);h.expose('target-a',m.guidance);await h.observer.observe();
 const other=new WorkroomConversationJournal(appData(),()=>iso(h.at()));closers.push(other);
 const store=h.store()!;
 const mixed=new CorrectionOutcomeObserver({store:()=>store,journal:()=>other,excluded:async()=>false,ledger:async()=>[],deviceId:()=>null,now:()=>h.at()});
 await mixed.observe();
 expect(mixed.overview().state).toBe('unavailable');
 expect(store.units()).toHaveLength(1);
});
test('quality reports pending/avoided/repeated/unknown while efficacyVerified stays false',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root}});
 await h.observer.observe();h.advance(1000);h.expose('target-a',m.guidance);await h.observer.observe();
 const summary=h.observer.summary(m.memoryId)!;
 expect(summary).toMatchObject({pending:1,finalized:{avoided:0,repeated:0,unknown:0},efficacyVerified:false,protocolStatus:'confirmed'});
 expect(h.observer.summary('another-memory')!.exposuresObserved).toBe(0);
 // The API wiring is gated: disabled means the store is never opened.
 const source=readFileSync(join(import.meta.dir,'..','api-server.ts'),'utf8');
 expect(source).toContain('CORRECTION_OUTCOMES_ACTIVE?new CorrectionOutcomeObserver(');
 expect(source).toContain('CORRECTION_OUTCOMES_ACTIVE=correctionOutcomePipelineActive(process.env)');
 expect(source).toContain('correctionOutcomes=correctionOutcomeObserver?.summary(result.memoryId)??null');
 expect(source).toContain('...result,correctionTasks,correctionOutcomes,');
});
test('nothing is created on disk while the pipeline has not observed anything',async()=>{
 const dir=appData();
 expect(readCorrectionOutcomeReport(dir)).toMatchObject({learning:{status:'NOT_RUN'},summary:null});
 expect(existsSync(join(dir,'correction-outcomes-v1'))).toBe(false);
});

// ---- S4-07: the read-only export ----
test('export contains counts and the protocol hash only, no evidence, titles or task text',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root}});
 await h.observer.observe();h.advance(1000);h.expose('target-a',m.guidance);
 recordProjectMemoryFeedback({folderPath:m.root,entryKey,contentVersionHash:m.entry().contentVersionHash,kind:'corrected',evidence:'PRIVATE_EVIDENCE_TEXT happened again.'});
 h.advance(WINDOW+HOUR);await h.observer.observe();
 const before=readFileSync(join(h.dir,'correction-outcomes-v1','outcomes.sqlite'));
 const report=readCorrectionOutcomeReport(h.dir,h.at());
 const text=JSON.stringify(report);
 for(const secret of ['PRIVATE_EVIDENCE_TEXT','JSON shell input','command substitution',m.memoryId,'target-a','session-target-a',entryKey,...h.store()!.units().flatMap(u=>[u.unitId,...u.reportIds])])
  expect(text).not.toContain(secret);
 expect(report).toMatchObject({protocolVersion:CORRECTION_OUTCOME_PROTOCOL.version,protocolHash:correctionOutcomeProtocolHash(),productGoalVerified:false,efficacyVerified:false,learning:{status:'BLOCKED',reason:'baseline-missing'}});
 expect(report.summary!.finalized).toEqual({avoided:0,repeated:1,unknown:0});
 expect(report.summary!.coverage).toEqual(CORRECTION_OUTCOME_COVERAGE);
 expect(readFileSync(join(h.dir,'correction-outcomes-v1','outcomes.sqlite')).equals(before)).toBe(true);
 const cli=Bun.spawnSync(['bun',join(import.meta.dir,'..','report-correction-outcomes.ts'),'--app-data-dir',h.dir],{stdout:'pipe',stderr:'pipe'});
 const printed=JSON.parse(cli.stdout.toString());
 expect(printed.learning).toEqual({status:'BLOCKED',reason:'baseline-missing'});expect(cli.exitCode).toBe(2);
 expect(cli.stdout.toString()).not.toContain('PRIVATE_EVIDENCE_TEXT');
});
test('export of an empty store reports zero exposures as NOT_RUN, not PASS',async()=>{
 const h=harness();await h.observer.observe();
 const report=readCorrectionOutcomeReport(h.dir);
 expect(report.summary!.exposuresObserved).toBe(0);expect(report.learning.status).toBe('NOT_RUN');
 const cli=Bun.spawnSync(['bun',join(import.meta.dir,'..','report-correction-outcomes.ts'),'--app-data-dir',h.dir],{stdout:'pipe',stderr:'pipe'});
 expect(JSON.parse(cli.stdout.toString()).learning.status).toBe('NOT_RUN');expect(cli.exitCode).toBe(3);
});

// ---- S4-10 UI: the counts are shown with the coverage note, never task text ----
test('the correction panel shows outcome counts with the coverage note and still says efficacy is unverified',async()=>{
 const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
 const {CorrectionOutcomeLine}=await import('../src/ProjectMemoryCorrections');
 const u=unit(),summary=summarizeCorrectionOutcomes([u,unit({sessionId:'w',sourceWithheld:true})],[{unitId:u.unitId,...classifyCorrectionOutcome(u,[recorrection(u,T0+HOUR)],T0+WINDOW+1)}],T0+WINDOW+1);
 const html=renderToStaticMarkup(createElement(CorrectionOutcomeLine,{summary}));
 expect(html).toContain('반복 1');expect(html).toContain('피함 0');expect(html).toContain('알 수 없음 0');expect(html).toContain('대기 0');expect(html).toContain('제외 1');
 expect(html).toContain('작성칸·음성 요청과 요청 전체로 입력된 @ 전달만');expect(html).not.toContain('이미지');expect(html).toContain('반복 실패 감소 효과는 별도 결과 확인이 필요합니다');
 expect(html).toContain('data-testid="project-memory-correction-outcomes"');
 expect(html).toContain('사전 등록 기준 v2');expect(html).not.toContain('제안된 기준');
 expect(renderToStaticMarkup(createElement(CorrectionOutcomeLine,{summary:null}))).toBe('');
});

// ---- follow-up #31: the api-server exclusion wiring, extracted so its mapping is tested directly ----
test('target exclusion maps OPS and shared roots to excluded and any resolution failure to unresolved',async()=>{
 const {correctionOutcomeTargetExclusion}=await import('../src/correctionOutcomeObserver');
 const deps=(over:Partial<Parameters<typeof correctionOutcomeTargetExclusion>[1]>={})=>({
  opsProjectId:()=>'ops-target',resolveCwd:async(id:string)=>'/projects/'+id,protectsSharedRoot:(cwd:string)=>cwd==='/projects/shared',...over});
 expect(await correctionOutcomeTargetExclusion('ops-target',deps())).toBe(true);
 expect(await correctionOutcomeTargetExclusion('shared',deps())).toBe(true);
 expect(await correctionOutcomeTargetExclusion('plain',deps())).toBe(false);
 // A registry that cannot be read right now: unresolved, retried by the observer, never silently ingested.
 expect(await correctionOutcomeTargetExclusion('plain',deps({resolveCwd:async()=>{throw Error('registry unreadable');}}))).toBe('unresolved');
 expect(await correctionOutcomeTargetExclusion('plain',deps({protectsSharedRoot:()=>{throw Error('profile unreadable');}}))).toBe('unresolved');
 // Without a readable OPS binding the target cannot be shown not to be OPS.
 expect(await correctionOutcomeTargetExclusion('plain',deps({opsProjectId:()=>{throw Error('profile unreadable');}}))).toBe('unresolved');
 const source=readFileSync(join(import.meta.dir,'..','api-server.ts'),'utf8');
 expect(source).toContain('excluded:targetId=>correctionOutcomeTargetExclusion(targetId,');
});

// ---- ENABLE: turning the pipeline on adds no startup IO and stays bounded ----
test('constructing the observer and the management route opens nothing until a tick or a request',async()=>{
 const {CorrectionOutcomeManagement}=await import('../src/correctionOutcomeManagement');
 let opened=0;const store=()=>{opened++;throw Error('opened');};
 new CorrectionOutcomeObserver({store,journal:()=>null,excluded:async()=>false,ledger:async()=>[],deviceId:()=>null});
 new CorrectionOutcomeManagement({active:()=>true,store,memory:async()=>null,excluded:async()=>false,conversationTitle:()=>null,checks:async()=>null});
 expect(opened).toBe(0);
});
test('one tick ingests at most 256 journal rows and finalizes at most 32 units',async()=>{
 const m=correctedMemory(),h=harness({targets:{'target-a':m.root}});
 await h.observer.observe();h.advance(1000);
 for(let i=0;i<300;i++)h.expose('target-a',m.guidance,'session-'+i);
 await h.observer.observe();
 expect(h.store()!.units()).toHaveLength(256);
 await h.observer.observe();
 expect(h.store()!.units()).toHaveLength(300);
 h.advance(WINDOW+HOUR);
 await h.observer.observe();
 expect(h.store()!.outcomes()).toHaveLength(32);
});
test('the outcome store refuses writes once its file reaches the byte cap, in every table',async()=>{
 const {CORRECTION_OUTCOME_STORE_MAX_BYTES}=await import('../src/correctionOutcomeStore');
 expect(CORRECTION_OUTCOME_STORE_MAX_BYTES).toBe(64*1024*1024);
 const dir=appData(),cap=96*1024,store=new CorrectionOutcomeStore(dir,()=>iso(T0),{maxBytes:cap});closers.push(store);
 const path=join(dir,'correction-outcomes-v1','outcomes.sqlite');
 let i=0,last:string='inserted';
 while(last==='inserted'&&i<10_000){last=store.putUnit(unit({sessionId:'b'+i,reportIds:Array.from({length:40},(_,n)=>String(i*100+n).padStart(64,'0'))}),'key-b'+i);i++;}
 expect(last).toBe('full');
 // The check runs before each insert, so the file can pass the cap by at most one row's pages.
 expect(Bun.file(path).size).toBeLessThanOrEqual(cap+64*1024);
 const u=store.units()[0]!;
 expect(store.addObservation(u.unitId,{source:'human-attestation',unitId:u.unitId,verdict:'avoided',at:iso(T0+HOUR)})).toBe('full');
 expect(store.addOutcome(u.unitId,classifyCorrectionOutcome(u,[],T0+WINDOW+1))).toBe('full');
 expect(store.recordManagement('request-1234','f'.repeat(64),{ok:true},{binding:{memoryId:'m',entryKey:'e'.repeat(24),contentVersionHash:'a'.repeat(32),checks:[{id:'c',digest:'d'}],boundAt:iso(T0),requestId:'request-1234'}}).state).toBe('full');
 // Nothing finalized or recorded is deleted to make room.
 expect(store.units().length).toBe(i-1);
});
