import {afterEach,expect,test} from 'bun:test';
import {CORRECTION_OUTCOME_PROTOCOL} from '../src/projectMemoryCorrectionOutcome';
import {mkdtempSync,rmSync,realpathSync,existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeProjectMemory,recallProjectMemory,recordProjectMemoryFeedback,writeMemoryDocument,readMemoryDocument,prepareProjectMemoryCorrectionTask,reviewProjectMemoryCorrections,detectProjectMemoryForRecall} from '../project-memory-server';
import {parseProjectMemoryEntries,correctionRelatedness} from '../src/projectMemoryRecall';
import {appendProjectMemoryFeedback,readProjectMemoryFeedback} from '../src/projectMemoryFeedback';
import {ProjectMemoryCorrectionReview, correctionReview, CORRECTION_REVIEW_EXCLUDED} from '../src/projectMemoryCorrectionReview';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const entryKey='e'.repeat(24);
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'agentstoz-corrections-')));roots.push(root);
 const status=initializeProjectMemory({folderPath:root,projectName:'Correction fixture'});
 const path=join(root,status.config!.sourcePath);
 const write=(text:string)=>writeMemoryDocument(root,path,`# Project Core Memory\n\n## Key Decisions\n\n### JSON shell input\n<!-- memory-entry-id:${entryKey} -->\n${text}\n`);
 write('Use JSON serialization for shell input.');
 const entry=parseProjectMemoryEntries(readMemoryDocument(root,path))[0]!;
 return {root,path,write,entry,memoryId:status.config!.memoryId,input:{folderPath:root,entryKey,contentVersionHash:entry.contentVersionHash,kind:'corrected' as const,evidence:'Failure: command substitution executed. Next time use shell quoting and verify literal bytes.'}};
}
test('a reported correction withdraws the old claim from the next task context and supplies its cause',()=>{
 const f=fixture(),before=readMemoryDocument(f.root,f.path);
 recordProjectMemoryFeedback(f.input);
 const recalled=recallProjectMemory({folderPath:f.root,query:'shell input',includeCommon:false});
 expect(recalled.hits).toEqual([]);expect(recalled.corrections[0]).toMatchObject({entryKey,status:'needs-review',source:'reported-correction'});
 expect(recalled.corrections[0]?.reports[0]?.evidence).toContain('command substitution');
 expect(readMemoryDocument(f.root,f.path)).toBe(before);
 expect(recallProjectMemory({folderPath:f.root,query:'unrelated topic',includeCommon:false}).corrections).toEqual([]);
});
test('identical correction retries and a page reload keep one durable event, even after the body changes',()=>{
 const f=fixture(),first=recordProjectMemoryFeedback(f.input);
 const retry=recordProjectMemoryFeedback(f.input);f.write('Quote shell arguments safely.');
 const later=recordProjectMemoryFeedback(f.input);
 expect(first.appended).toBe(true);expect(retry.appended).toBe(false);expect(later.appended).toBe(false);
 expect(later.event).toEqual(first.event);expect(readProjectMemoryFeedback(f.root)).toHaveLength(1);
 expect(recallProjectMemory({folderPath:f.root,query:'shell input',includeCommon:false}).hits).toHaveLength(1);
 expect(recallProjectMemory({folderPath:f.root,query:'shell input',includeCommon:false}).corrections).toEqual([]);
});
test('a new correction cannot attach to a changed body or reuse another payload receipt',()=>{
 const f=fixture();recordProjectMemoryFeedback({...f.input,eventId:'fixed-id'});
 expect(()=>recordProjectMemoryFeedback({...f.input,eventId:'fixed-id',evidence:'different'})).toThrow('내용이 다릅니다');
 f.write('Changed rule.');expect(()=>recordProjectMemoryFeedback({...f.input,evidence:'New evidence'})).toThrow('본문 버전');
});
test('empty reports are rejected; legacy feedback and agent confirmations cannot promote or withdraw current facts',()=>{
 const f=fixture();expect(()=>recordProjectMemoryFeedback({...f.input,evidence:' '})).toThrow('실패 원인');
 for(let i=0;i<4;i++)appendProjectMemoryFeedback(f.root,{memoryId:f.memoryId,entryKey,contentVersionHash:f.entry.contentVersionHash,kind:i%2?'confirmed':'applied',id:'positive-'+i});
 appendProjectMemoryFeedback(f.root,{memoryId:f.memoryId,entryKey,kind:'corrected',id:'legacy'});
 const recalled=recallProjectMemory({folderPath:f.root,query:'shell input',includeCommon:false});
 expect(recalled.hits[0]?.promotionState).toBe('candidate');expect(recalled.hits[0]?.feedbackBoost).toBe(0);expect(recalled.corrections).toEqual([]);
});
test('corrections in one memory do not change an identical entry in a different project',()=>{
 const a=fixture(),b=fixture();recordProjectMemoryFeedback(a.input);
 expect(recallProjectMemory({folderPath:b.root,query:'shell input',includeCommon:false}).hits).toHaveLength(1);
 expect(readProjectMemoryFeedback(b.root)).toEqual([]);
});
test('the next task can find a failure cause even when it is absent from the old claim',()=>{
 const f=fixture();recordProjectMemoryFeedback(f.input);
 const result=recallProjectMemory({folderPath:f.root,query:'command substitution',limit:1,includeCommon:false});
 expect(result.hits).toEqual([]);expect(result.corrections[0]?.entryKey).toBe(entryKey);
});
test('the hourly review distinguishes a current warning from changed or unbound versions without claiming a fix',()=>{
 const f=fixture();recordProjectMemoryFeedback(f.input);
 const events=readProjectMemoryFeedback(f.root);
 expect(correctionReview([f.entry],events,f.memoryId)).toMatchObject({pendingEntries:1,changedVersionEntries:0});
 f.write('A changed body needs outcome verification.');
 expect(correctionReview(parseProjectMemoryEntries(readMemoryDocument(f.root,f.path)),events,f.memoryId)).toMatchObject({pendingEntries:0,changedVersionEntries:1});
});
test('hourly review skips unchanged intervals, rotates bounded batches, and does not starve after a failure',async()=>{
 let now=0;const calls:string[]=[],targets=Array.from({length:10},(_,i)=>String(i));
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>targets,review:async target=>{
  calls.push(target);if(target==='0')throw Error('unavailable');return {pendingEntries:1,changedVersionEntries:0,unboundReports:0};
 }});
 await review.tick();expect(calls).toHaveLength(8);expect(review.status('1')?.result.pendingEntries).toBe(1);
 await review.tick();expect(calls).toHaveLength(8);
 now=60_000;await review.tick();expect(calls.slice(8)).toEqual(['8','9','0']);
 now=3_600_000;await review.tick();expect(calls).toContain('6');expect(calls.filter(target=>target==='6')).toHaveLength(2);
});
test('review coalesces concurrent ticks and stops when disabled, without deleting evidence',async()=>{
 let enabled=true,release!:()=>void;let calls=0;
 const wait=new Promise<void>(resolve=>{release=resolve;});
 const review=new ProjectMemoryCorrectionReview({enabled:()=>enabled,targets:async()=>['a','b'],review:async()=>{
  calls++;await wait;enabled=false;return {pendingEntries:0,changedVersionEntries:0,unboundReports:0};
 }});
 const first=review.tick();await Promise.resolve();await review.tick();release();await first;
 expect(calls).toBe(1);expect(review.status('a')).not.toBeNull();expect(review.status('b')).toBeNull();
});
test('a changed target binding is reviewed immediately instead of reusing another checkout timestamp',async()=>{
 let now=0,key=JSON.stringify(['target','checkout-a']);let calls=0;
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>[key],review:async()=>{
  calls++;return {pendingEntries:1,changedVersionEntries:0,unboundReports:0};
 }});
 await review.tick();key=JSON.stringify(['target','checkout-b']);now=60_000;await review.tick();
 expect(calls).toBe(2);expect(review.status(JSON.stringify(['target','checkout-a']))).toBeNull();
});
test('summary eviction never makes more than 128 projects repeat before their hourly due time',async()=>{
 let now=0;const counts=new Map<string,number>(),targets=Array.from({length:200},(_,i)=>'target-'+i);
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>targets,review:async target=>{counts.set(target,(counts.get(target)??0)+1);return{pendingEntries:0,changedVersionEntries:0,unboundReports:0};}});
 for(let minute=0;minute<40;minute++){now=minute*60_000;await review.tick();}
 expect(counts.size).toBe(200);expect(Math.max(...counts.values())).toBe(1);expect(review.scheduleStatus('target-0').checkedAt).toBe(0);
});
test('hourly status exposes overdue, unavailable and inventory failure without calling them learning gains',async()=>{
 let now=0,inventoryFails=false;
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>{if(inventoryFails)throw Error('offline');return Array.from({length:1000},(_,i)=>'target-'+i);},review:async target=>target==='target-0'?null:{pendingEntries:0,changedVersionEntries:0,unboundReports:0}});
 await review.tick();expect(review.scheduleStatus('target-0').state).toBe('unavailable');now=3_600_001;expect(review.scheduleStatus('target-999').state).toBe('overdue');expect(review.overview().overdue).toBeGreaterThan(900);expect(review.overview().efficacyVerified).toBe(false);inventoryFails=true;await expect(review.tick()).rejects.toThrow('offline');expect(review.overview().inventoryAvailable).toBe(false);
});
test('the next reviewed task receives reported failure causes with exact body provenance and revalidates before writing',()=>{
 const f=fixture();recordProjectMemoryFeedback(f.input);const before=readMemoryDocument(f.root,f.path);
 const guidance=prepareProjectMemoryCorrectionTask(f.root,'Avoid shell command substitution');expect(guidance?.text).toContain('command substitution');expect(guidance?.text).not.toContain('Trust shell interpolation');expect(guidance?.exposure.entries[0]).toMatchObject({entryKey,contentVersionHash:f.entry.contentVersionHash});expect(guidance?.exposure.entries[0]?.reportIds).toHaveLength(1);expect(()=>guidance!.validate()).not.toThrow();expect(readMemoryDocument(f.root,f.path)).toBe(before);
 f.write('The old body changed.');expect(()=>guidance!.validate()).toThrow('변경');expect(prepareProjectMemoryCorrectionTask(f.root,'Avoid shell command substitution')).toBeNull();
});
test('automatic correction context withholds credentials and never promotes a positive agent assessment',()=>{
 const f=fixture();recordProjectMemoryFeedback({...f.input,evidence:'Failure contained API_KEY=sk-fixture-secret-12345678901234567890. Next: keep secrets local.'});
 const guidance=prepareProjectMemoryCorrectionTask(f.root,'shell input');expect(guidance?.exposure.sourceWithheld).toBe(true);expect(guidance?.text).not.toContain('sk-fixture');expect(guidance?.text).toContain('보류');
});
test('targets without long-term memory are not-applicable and do not consume attempts again within the hour',async()=>{
 let now=0;const calls:string[]=[],targets=Array.from({length:10},(_,i)=>'t'+i);
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>targets,review:async target=>{
  calls.push(target);return Number(target.slice(1))<6?{state:'not-applicable'} as const:{pendingEntries:0,changedVersionEntries:0,unboundReports:0};
 }});
 await review.tick();expect(calls).toHaveLength(8);
 expect(review.scheduleStatus('t0').state).toBe('not-applicable');
 expect(review.overview()).toMatchObject({notApplicable:6,unavailable:0});
 // Minute two: only the two never-attempted targets run; the six memory-less ones are not retried.
 now=60_000;await review.tick();expect(calls.slice(8)).toEqual(['t8','t9']);
 for(let minute=2;minute<60;minute++){now=minute*60_000;await review.tick();}
 expect(calls).toHaveLength(10);
 now=3_600_000;await review.tick();expect(calls.slice(10)).toEqual(['t0','t1','t2','t3','t4','t5','t6','t7']);
});
test('unavailable targets back off for an hour but are retried after it',async()=>{
 let now=0,calls=0;
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>['gone'],review:async()=>{calls++;return null;}});
 await review.tick();expect(calls).toBe(1);expect(review.scheduleStatus('gone').state).toBe('unavailable');
 for(let minute=1;minute<60;minute++){now=minute*60_000;await review.tick();}
 expect(calls).toBe(1);
 now=3_600_000;await review.tick();expect(calls).toBe(2);expect(review.overview().unavailable).toBe(1);
});
test('memory started after a not-applicable review is due again at once, not hidden for an hour',async()=>{
 let now=0,hasMemory=false,calls=0;
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>['p'],review:async()=>{calls++;return hasMemory?{pendingEntries:0,changedVersionEntries:0,unboundReports:0}:{state:'not-applicable'} as const;}});
 await review.tick();expect(review.scheduleStatus('p').state).toBe('not-applicable');
 // The quality panel only renders once inspectProjectMemory found memory; it tells the coordinator so.
 hasMemory=true;now=5*60_000;review.noteMemoryPresent('p');
 expect(review.scheduleStatus('p').state).toBe('due');expect(review.overview().notApplicable).toBe(0);
 now=6*60_000;await review.tick();expect(calls).toBe(2);expect(review.scheduleStatus('p').state).toBe('current');
});
test('the OPS/shared root is excluded, not labelled memory-less, and memory presence does not re-queue it',async()=>{
 let now=0,calls=0;
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>['ops'],review:async()=>{calls++;return CORRECTION_REVIEW_EXCLUDED;}});
 await review.tick();expect(review.scheduleStatus('ops').state).toBe('excluded');
 expect(review.overview()).toMatchObject({excluded:1,notApplicable:0,unavailable:0});
 review.noteMemoryPresent('ops');expect(review.scheduleStatus('ops').state).toBe('excluded');
 now=60_000;await review.tick();expect(calls).toBe(1);
});
test('a backed-off target reports its real retry time as dueAt',async()=>{
 let now=0;const targets=Array.from({length:9},(_,i)=>'t'+i);
 const review=new ProjectMemoryCorrectionReview({enabled:()=>true,now:()=>now,targets:async()=>targets,review:async target=>target==='t8'?null:target==='t7'?{state:'not-applicable'} as const:{pendingEntries:0,changedVersionEntries:0,unboundReports:0}});
 await review.tick();now=60_000;await review.tick();
 // t8 was first seen at 0 but attempted at 60s; it is retried an hour after the attempt.
 expect(review.scheduleStatus('t8')).toMatchObject({state:'unavailable',attemptedAt:60_000,dueAt:3_660_000});
 expect(review.scheduleStatus('t7')).toMatchObject({state:'not-applicable',attemptedAt:0,dueAt:3_600_000});
});
test('the quality endpoint clears a stale not-applicable and the shared root review is excluded',()=>{
 const source=readFileSync(join(import.meta.dir,'..','api-server.ts'),'utf8');
 const quality=source.slice(source.indexOf('url.pathname === "/api/project-memory/quality"'));
 expect(quality.indexOf('projectCorrectionReview.noteMemoryPresent(')).toBeGreaterThan(-1);
 expect(quality.indexOf('projectCorrectionReview.noteMemoryPresent(')).toBeLessThan(quality.indexOf('projectCorrectionReview.scheduleStatus('));
 expect(source).toContain('protectsSharedRoot(target.cwd))return CORRECTION_REVIEW_EXCLUDED');
});
test('a folder without long-term memory is reported as not-applicable, not unavailable',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'agentstoz-corrections-none-')));roots.push(root);
 expect(reviewProjectMemoryCorrections(root)).toEqual({state:'not-applicable'});
 const f=fixture();expect(reviewProjectMemoryCorrections(f.root)).toMatchObject({pendingEntries:0,changedVersionEntries:0,unboundReports:0});
});
test('validate before the write reads only the identity status and never builds the journal index',()=>{
 const f=fixture();recordProjectMemoryFeedback(f.input);
 const cache=join(tmpdir(),'agentstoz-project-memory-recall','project-memory-recall',createHash('sha256').update(`${f.root}\n${f.memoryId}`,'utf8').digest('hex')+'.sqlite');
 rmSync(cache,{force:true});
 let reads=0;const detect=(folderPath:string)=>{reads++;return detectProjectMemoryForRecall(folderPath);};
 const guidance=prepareProjectMemoryCorrectionTask(f.root,'Avoid shell command substitution',{detect});
 expect(reads).toBe(1);guidance!.validate();expect(reads).toBe(2);
 expect(existsSync(cache)).toBe(false);
 f.write('The old body changed.');expect(()=>guidance!.validate()).toThrow('변경');expect(reads).toBe(3);
});
test('relatedness counts terms but stores none of them',()=>{
 const f=fixture();recordProjectMemoryFeedback(f.input);
 const guidance=prepareProjectMemoryCorrectionTask(f.root,'Avoid shell command substitution today')!;
 const entry=guidance.exposure.entries[0]!;
 // The exposure is stamped with the protocol version in force when it was delivered.
 expect(guidance.exposure.protocolVersion).toBe(CORRECTION_OUTCOME_PROTOCOL.version);
 // query terms: avoid, shell, command, substitution, today; entry+evidence: shell, command, substitution; evidence: same three.
 expect(entry.relatedness).toEqual({queryTerms:5,matchedTerms:3,evidenceMatchedTerms:3});
 const stored=JSON.stringify(guidance.exposure);
 for(const term of ['avoid','shell','command','substitution','today'])expect(stored.toLowerCase()).not.toContain(term);
 expect(correctionRelatedness('totally unrelated words',{title:'JSON shell input',section:'Key Decisions',body:'Use JSON.'},['Failure: x']))
  .toEqual({queryTerms:3,matchedTerms:0,evidenceMatchedTerms:0});
 // The public recall DTO is unchanged: no relatedness on corrections.
 expect('relatedness' in recallProjectMemory({folderPath:f.root,query:'shell command',includeCommon:false}).corrections[0]!).toBe(false);
 // The validated context hash does not depend on the counts.
 expect(()=>guidance.validate()).not.toThrow();
});
