import type {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {MemorySaveError,saveDigest,saveHash,saveInteger,saveToken,type MemorySaveRecoveryBinding} from './memorySaveContract';
import {readAutomaticMemoryPolicy} from './memorySaveAutomaticPolicy';
import {readMemorySaveRecoveryCandidate} from './memorySaveRecoveryStore';
import {assertSameMemoryProviderIdentity,type MemoryProviderBinding} from './memorySaveProviderContract';
import {canonicalMemoryProviderRecoveryBinding,canonicalRecoveryProviderBinding,strictRecoveryObject,
 MEMORY_PROVIDER_RECOVERY_DAILY_LIMIT,MEMORY_PROVIDER_RECOVERY_PAYLOAD_LIMIT,MEMORY_PROVIDER_RECOVERY_REVIEW_TTL,
 type MemoryProviderRecoveryApproval,type MemoryProviderRecoveryBinding,type MemoryProviderRecoveryClaim,
 type MemoryProviderRecoveryCompletion,type MemoryProviderRecoveryProbe} from './memorySaveProviderTransitionContract';

const payloadProjection=`CASE WHEN length(CAST(payload AS BLOB))<=${MEMORY_PROVIDER_RECOVERY_PAYLOAD_LIMIT} THEN payload END AS payload`;
const day=24*60*60*1000;
export function migrateMemoryProviderRecovery(db:Database):void {
 db.run(`CREATE TABLE save_provider_recovery_reviews (parentSaveId TEXT PRIMARY KEY,approvalId TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=${MEMORY_PROVIDER_RECOVERY_PAYLOAD_LIMIT}))`);
 db.run(`CREATE TABLE save_provider_recovery_probes (sequence INTEGER PRIMARY KEY AUTOINCREMENT,transitionId TEXT NOT NULL UNIQUE,approvalId TEXT NOT NULL UNIQUE,parentSaveId TEXT NOT NULL,startedAt INTEGER NOT NULL,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=${MEMORY_PROVIDER_RECOVERY_PAYLOAD_LIMIT}))`);
 db.run('CREATE INDEX provider_recovery_probe_parent ON save_provider_recovery_probes(parentSaveId,sequence)');
 db.run('CREATE INDEX provider_recovery_probe_time ON save_provider_recovery_probes(startedAt)');
 db.run(`CREATE TABLE save_provider_recovery_results (transitionId TEXT PRIMARY KEY,parentSaveId TEXT NOT NULL,probeSequence INTEGER NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('ready','failed','unknown')),payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=${MEMORY_PROVIDER_RECOVERY_PAYLOAD_LIMIT}))`);
 db.run('CREATE INDEX provider_recovery_ready_parent ON save_provider_recovery_results(parentSaveId,state,probeSequence)');
 db.run('CREATE TABLE save_provider_recovery_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1),lastClock INTEGER NOT NULL)');
 db.run('INSERT INTO save_provider_recovery_clock VALUES (1,0)');
 for(const table of ['save_provider_recovery_probes','save_provider_recovery_results'])for(const operation of ['UPDATE','DELETE']){
  db.run(`CREATE TRIGGER ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable provider recovery evidence'); END`);
 }
}
function checkedTime(db:Database,now:number,advance=false){
 const row=db.query('SELECT lastClock FROM save_provider_recovery_clock WHERE singleton=1').get() as {lastClock:number}|null;
 if(!saveInteger(now)||!row||!saveInteger(row.lastClock))throw new MemorySaveError('STORAGE_UNAVAILABLE');
 if(now<row.lastClock)throw new MemorySaveError('CLOCK_ROLLBACK');
 if(advance)db.query('UPDATE save_provider_recovery_clock SET lastClock=? WHERE singleton=1').run(now);
}
function currentBinding(db:Database):MemoryProviderBinding {
 const row=db.query('SELECT CASE WHEN length(CAST(payload AS BLOB))<=4096 THEN payload END AS payload FROM save_provider_binding WHERE singleton=1').get() as {payload:string|null}|null;
 if(!row?.payload)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 return canonicalRecoveryProviderBinding(JSON.parse(row.payload));
}
/** Original ownership, intent, policy and provider stay fixed during probing. */
function checkedContext(db:Database,b:MemoryProviderRecoveryBinding){
 const candidate=readMemorySaveRecoveryCandidate(db,b.parentSaveId,10),policy=readAutomaticMemoryPolicy(db);
 if(!candidate||candidate.job.attemptId!==b.parentAttemptId||candidate.job.memoryId!==b.memoryId||candidate.job.coverageDigest!==b.coverageDigest
  ||saveDigest(candidate.intent)!==b.originalIntentDigest||candidate.intent.beforeHash!==b.beforeHash
  ||candidate.intent.providerBindingDigest!==saveDigest(b.priorBinding))throw new MemorySaveError('REVISION_CONFLICT');
 if(!policy.enabled||policy.revision!==b.policyRevision||policy.providerBindingDigest!==saveDigest(b.priorBinding)
  ||saveDigest(currentBinding(db))!==saveDigest(b.priorBinding)||policy.excludedMemoryIds.includes(b.memoryId)
  ||policy.scopeMemoryId!==null&&policy.scopeMemoryId!==b.memoryId)throw new MemorySaveError('POLICY_CHANGED');
 if(db.query("SELECT 1 FROM save_jobs WHERE saveId<>? AND phase NOT IN ('local-saved','superseded-unknown') LIMIT 1").get(b.parentSaveId))throw new MemorySaveError('EXECUTION_BUSY');
 return candidate;
}
function approvalDigest(a:Omit<MemoryProviderRecoveryApproval,'reviewDigest'>){return saveDigest({version:1,purpose:'provider-recovery',approvalId:a.approvalId,reviewedAt:a.reviewedAt,expiresAt:a.expiresAt,binding:a.binding});}
function parseApproval(payload:string|null):MemoryProviderRecoveryApproval {
 if(!payload)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 const a=JSON.parse(payload);strictRecoveryObject(a,['version','approvalId','reviewDigest','reviewedAt','expiresAt','binding']);
 const b=canonicalMemoryProviderRecoveryBinding(a.binding as MemoryProviderRecoveryBinding);
 if(a.version!==1||!saveToken(a.approvalId)||!saveHash(a.reviewDigest)||!saveInteger(a.reviewedAt)||!saveInteger(a.expiresAt)
  ||a.expiresAt-a.reviewedAt!==MEMORY_PROVIDER_RECOVERY_REVIEW_TTL||b.observedBinding.preparedAt>a.reviewedAt)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 const result:MemoryProviderRecoveryApproval={version:1,approvalId:a.approvalId,reviewDigest:a.reviewDigest,reviewedAt:a.reviewedAt,expiresAt:a.expiresAt,binding:b};
 if(approvalDigest(result)!==result.reviewDigest)throw new MemorySaveError('STORAGE_UNAVAILABLE');return result;
}
export function readRecoveryProviderApproval(db:Database,approvalId:string):MemoryProviderRecoveryApproval|null {
 if(!saveToken(approvalId))throw new MemorySaveError('INVALID_INPUT');
 const row=db.query(`SELECT parentSaveId,${payloadProjection} FROM save_provider_recovery_reviews WHERE approvalId=?`).get(approvalId) as {parentSaveId:string;payload:string|null}|null;
 if(!row)return null;const a=parseApproval(row.payload);
 if(a.approvalId!==approvalId||a.binding.parentSaveId!==row.parentSaveId)throw new MemorySaveError('STORAGE_UNAVAILABLE');return a;
}
export function prepareRecoveryProviderApproval(db:Database,raw:MemoryProviderRecoveryBinding,now:number):MemoryProviderRecoveryApproval {
 const binding=canonicalMemoryProviderRecoveryBinding(raw);checkedTime(db,now);
 if(binding.observedBinding.preparedAt>now)throw new MemorySaveError('POLICY_CHANGED');
 if(!saveInteger(now+MEMORY_PROVIDER_RECOVERY_REVIEW_TTL))throw new MemorySaveError('INVALID_INPUT');
 checkedContext(db,binding);
 const base={version:1 as const,approvalId:randomUUID(),reviewedAt:now,expiresAt:now+MEMORY_PROVIDER_RECOVERY_REVIEW_TTL,binding};
 const approval={...base,reviewDigest:approvalDigest(base)};
 db.query('INSERT INTO save_provider_recovery_reviews VALUES (?,?,?) ON CONFLICT(parentSaveId) DO UPDATE SET approvalId=excluded.approvalId,payload=excluded.payload').run(binding.parentSaveId,approval.approvalId,JSON.stringify(approval));
 checkedTime(db,now,true);return approval;
}
function resultProof(probe:MemoryProviderRecoveryProbe){return saveDigest({version:1,purpose:'provider-recovery-proof',transitionId:probe.transitionId,approvalId:probe.approvalId,
 reviewDigest:probe.reviewDigest,startedAt:probe.startedAt,completedAt:probe.completedAt,binding:probe.binding,readyBinding:probe.readyBinding});}
function parseProbe(db:Database,row:{transitionId:string;approvalId:string;parentSaveId:string;startedAt:number;payload:string|null}):MemoryProviderRecoveryProbe {
 if(!saveToken(row.transitionId)||!saveToken(row.approvalId)||!saveToken(row.parentSaveId)||!saveInteger(row.startedAt))throw new MemorySaveError('STORAGE_UNAVAILABLE');
 const approval=parseApproval(row.payload);
 if(approval.approvalId!==row.approvalId||approval.binding.parentSaveId!==row.parentSaveId||row.startedAt<approval.reviewedAt||row.startedAt>=approval.expiresAt)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 const base:MemoryProviderRecoveryProbe={version:1,transitionId:row.transitionId,approvalId:row.approvalId,reviewDigest:approval.reviewDigest,startedAt:row.startedAt,
  completedAt:null,state:'claimed',binding:approval.binding,readyBinding:null,proofDigest:null};
 const result=db.query(`SELECT parentSaveId,probeSequence,state,${payloadProjection} FROM save_provider_recovery_results WHERE transitionId=?`).get(row.transitionId) as {parentSaveId:string;probeSequence:number;state:string;payload:string|null}|null;
 if(!result)return base;
 const sequence=db.query('SELECT sequence FROM save_provider_recovery_probes WHERE transitionId=?').get(row.transitionId) as {sequence:number};
 if(result.parentSaveId!==row.parentSaveId||!saveInteger(result.probeSequence)||result.probeSequence!==sequence.sequence)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 if(!result.payload)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 const r=JSON.parse(result.payload);strictRecoveryObject(r,['completedAt','binding','proofDigest']);
 if(!saveInteger(r.completedAt)||r.completedAt<base.startedAt||!['ready','failed','unknown'].includes(result.state))throw new MemorySaveError('STORAGE_UNAVAILABLE');
 if(result.state!=='ready'){
  if(r.binding!==null||r.proofDigest!==null)throw new MemorySaveError('STORAGE_UNAVAILABLE');
  return {...base,state:result.state as 'failed'|'unknown',completedAt:r.completedAt};
 }
 const readyBinding=canonicalRecoveryProviderBinding(r.binding as MemoryProviderBinding);
 assertSameMemoryProviderIdentity(base.binding.observedBinding,readyBinding);
 if(readyBinding.binaryFingerprint!==base.binding.observedBinding.binaryFingerprint||readyBinding.preparedAt>r.completedAt||!saveHash(r.proofDigest))throw new MemorySaveError('STORAGE_UNAVAILABLE');
 const verified:MemoryProviderRecoveryProbe={...base,state:'ready',completedAt:r.completedAt,readyBinding,proofDigest:r.proofDigest};
 if(resultProof(verified)!==verified.proofDigest)throw new MemorySaveError('STORAGE_UNAVAILABLE');return verified;
}
export function readRecoveryProviderTransition(db:Database,transitionId:string):MemoryProviderRecoveryProbe|null {
 if(!saveToken(transitionId))throw new MemorySaveError('INVALID_INPUT');
 const row=db.query(`SELECT transitionId,approvalId,parentSaveId,startedAt,${payloadProjection} FROM save_provider_recovery_probes WHERE transitionId=?`).get(transitionId) as Parameters<typeof parseProbe>[1]|null;
 return row?parseProbe(db,row):null;
}
export function readRecoveryProviderProbeForApproval(db:Database,approvalId:string):MemoryProviderRecoveryProbe|null {
 if(!saveToken(approvalId))throw new MemorySaveError('INVALID_INPUT');
 const row=db.query('SELECT transitionId FROM save_provider_recovery_probes WHERE approvalId=?').get(approvalId) as {transitionId:string}|null;
 return row?readRecoveryProviderTransition(db,row.transitionId):null;
}
export function readLatestRecoveryProviderTransition(db:Database,parentSaveId:string,readyOnly=false):MemoryProviderRecoveryProbe|null {
 if(!saveToken(parentSaveId))throw new MemorySaveError('INVALID_INPUT');
 const row=db.query(`SELECT p.transitionId,p.approvalId,p.parentSaveId,p.startedAt,CASE WHEN length(CAST(p.payload AS BLOB))<=${MEMORY_PROVIDER_RECOVERY_PAYLOAD_LIMIT} THEN p.payload END AS payload
 FROM ${readyOnly?"save_provider_recovery_results r JOIN save_provider_recovery_probes p ON p.transitionId=r.transitionId":"save_provider_recovery_probes p"}
 WHERE ${readyOnly?"r.parentSaveId=? AND r.state='ready'":"p.parentSaveId=?"} ORDER BY ${readyOnly?'r.probeSequence':'p.sequence'} DESC LIMIT 1`).get(parentSaveId) as Parameters<typeof parseProbe>[1]|null;
 if(row&&row.parentSaveId!==parentSaveId)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 return row?parseProbe(db,row):null;
}
export function claimRecoveryProviderProbe(db:Database,raw:MemoryProviderRecoveryClaim,now:number):{created:boolean;probe:MemoryProviderRecoveryProbe} {
 strictRecoveryObject(raw,['approvalId','reviewDigest','explicitConsent','binding']);
 if(!saveToken(raw.approvalId)||!saveHash(raw.reviewDigest)||raw.explicitConsent!==true)throw new MemorySaveError('INVALID_INPUT');
 const binding=canonicalMemoryProviderRecoveryBinding(raw.binding);
 const prior=db.query('SELECT transitionId FROM save_provider_recovery_probes WHERE approvalId=?').get(raw.approvalId) as {transitionId:string}|null;
 if(prior){const probe=readRecoveryProviderTransition(db,prior.transitionId)!;
  if(probe.reviewDigest!==raw.reviewDigest||saveDigest(probe.binding)!==saveDigest(binding))throw new MemorySaveError('REVISION_CONFLICT');
  return {created:false,probe};}
 const approval=readRecoveryProviderApproval(db,raw.approvalId);
 if(!approval||approval.reviewDigest!==raw.reviewDigest||saveDigest(approval.binding)!==saveDigest(binding))throw new MemorySaveError('REVISION_CONFLICT');
 checkedTime(db,now);if(now<approval.reviewedAt||now>=approval.expiresAt)throw new MemorySaveError('POLICY_CHANGED');
 checkedContext(db,binding);
 if(db.query('SELECT startedAt FROM save_provider_recovery_probes WHERE startedAt>? ORDER BY startedAt DESC LIMIT 8').all(now-day).length>=MEMORY_PROVIDER_RECOVERY_DAILY_LIMIT)throw new MemorySaveError('BUDGET_PAUSED');
 const transitionId=randomUUID();
 db.query('INSERT INTO save_provider_recovery_probes(transitionId,approvalId,parentSaveId,startedAt,payload) VALUES (?,?,?,?,?)').run(transitionId,approval.approvalId,binding.parentSaveId,now,JSON.stringify(approval));
 checkedTime(db,now,true);
 return {created:true,probe:readRecoveryProviderTransition(db,transitionId)!};
}
export function finishRecoveryProviderProbe(db:Database,transitionId:string,raw:MemoryProviderRecoveryCompletion,now:number):MemoryProviderRecoveryProbe {
 strictRecoveryObject(raw,raw?.state==='ready'?['state','binding']:['state']);
 if(!['ready','failed','unknown'].includes(raw.state))throw new MemorySaveError('INVALID_INPUT');
 const probe=readRecoveryProviderTransition(db,transitionId);if(!probe)throw new MemorySaveError('REVISION_CONFLICT');
 const readyBinding=raw.state==='ready'?canonicalRecoveryProviderBinding(raw.binding):null;
 if(probe.state!=='claimed'){
  if(probe.state!==raw.state||saveDigest(probe.readyBinding)!==saveDigest(readyBinding))throw new MemorySaveError('REVISION_CONFLICT');
  return probe;
 }
 checkedTime(db,now);if(now<probe.startedAt)throw new MemorySaveError('CLOCK_ROLLBACK');
 if(readyBinding){
  checkedContext(db,probe.binding);assertSameMemoryProviderIdentity(probe.binding.observedBinding,readyBinding);
  if(readyBinding.binaryFingerprint!==probe.binding.observedBinding.binaryFingerprint||readyBinding.preparedAt>now)throw new MemorySaveError('POLICY_CHANGED');
 }
 const completed:MemoryProviderRecoveryProbe={...probe,state:raw.state,completedAt:now,readyBinding,proofDigest:null};
 if(readyBinding)completed.proofDigest=resultProof(completed);
 const sequence=db.query('SELECT sequence FROM save_provider_recovery_probes WHERE transitionId=?').get(transitionId) as {sequence:number};
 db.query('INSERT INTO save_provider_recovery_results VALUES (?,?,?,?,?)').run(transitionId,probe.binding.parentSaveId,sequence.sequence,raw.state,JSON.stringify({completedAt:now,binding:readyBinding,proofDigest:completed.proofDigest}));
 checkedTime(db,now,true);return completed;
}
/** A reviewed transition is the only narrow exception to the original binding
 * equality. It never changes the parent's immutable intent or source owner. */
export function checkedRecoveryProviderTransition(db:Database,b:MemorySaveRecoveryBinding,now:number):MemoryProviderRecoveryProbe|null {
 if(!b.transitionId)return null;
 checkedTime(db,now);
 const probe=readRecoveryProviderTransition(db,b.transitionId);
 if(!probe||probe.state!=='ready'||!probe.readyBinding||probe.proofDigest!==b.proofDigest)throw new MemorySaveError('REVISION_CONFLICT');
 const p=probe.binding;checkedContext(db,p);
 if(p.parentSaveId!==b.parentSaveId||p.parentAttemptId!==b.parentAttemptId||p.memoryId!==b.memoryId||p.coverageDigest!==b.coverageDigest
  ||p.originalIntentDigest!==b.originalIntentDigest||p.beforeHash!==b.beforeHash||p.targetId!==b.targetId||p.rootDigest!==b.rootDigest||p.registrationDigest!==b.registrationDigest
  ||p.policyRevision!==b.policyRevision||saveDigest(p.priorBinding)!==b.originalProviderBindingDigest||saveDigest(probe.readyBinding)!==b.providerBindingDigest)throw new MemorySaveError('REVISION_CONFLICT');
 return probe;
}
