import type {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {checkAutomaticMemoryRecoveryAdmission,reserveAutomaticMemoryRecoveryAdmission,refreshAutomaticMemoryProvider} from './memorySaveAutomaticPolicy';
import {checkedRecoveryProviderTransition} from './memorySaveProviderTransitionStore';
import {MemorySaveError,MEMORY_SAVE_RECOVERY_REVIEW_TTL,canonicalMemorySaveRecoveryBinding,canonicalSaveSource,memorySaveSourceKey,saveDigest,saveHash,saveInteger,saveToken,
 type MemorySaveAttemptIntent,type MemorySaveJob,type MemorySaveRecoveryAdmission,type MemorySaveRecoveryApproval,type MemorySaveRecoveryBinding,type MemorySaveRecoveryCandidate,type MemorySaveRecoveryDecision} from './memorySaveContract';

const jobProjection='sequence,saveId,memoryId,policyEpoch,coverageDigest,phase,attemptId';
type SourceRow={sequence:number;sourceKey:string;payload:string|null;saveId:string|null};

/** Schema fencing is intentional: an older writer must not ignore a replaced
 * active job. Source ownership and historical attempts/receipts are untouched. */
export function migrateMemorySaveRecovery(db:Database):void {
 db.run("DROP INDEX jobs_open_root");
 db.run("CREATE UNIQUE INDEX jobs_open_root ON save_jobs(memoryId) WHERE phase NOT IN ('local-saved','superseded-unknown')");
 db.run(`CREATE TABLE save_recovery_approvals (parentSaveId TEXT PRIMARY KEY,approvalId TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=4096),consumedAt INTEGER)`);
 db.run(`CREATE TABLE save_recovery_decisions (parentSaveId TEXT PRIMARY KEY,successorSaveId TEXT NOT NULL UNIQUE,approvalId TEXT NOT NULL UNIQUE,payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=4096))`);
 db.run("CREATE TRIGGER recovery_decision_no_update BEFORE UPDATE ON save_recovery_decisions BEGIN SELECT RAISE(ABORT,'immutable recovery decision'); END");
 db.run("CREATE TRIGGER recovery_decision_no_delete BEFORE DELETE ON save_recovery_decisions BEGIN SELECT RAISE(ABORT,'immutable recovery decision'); END");
 db.run("CREATE TRIGGER recovery_approval_consumed_no_update BEFORE UPDATE ON save_recovery_approvals WHEN OLD.consumedAt IS NOT NULL BEGIN SELECT RAISE(ABORT,'consumed recovery approval'); END");
 db.run("CREATE TRIGGER recovery_approval_consumed_no_delete BEFORE DELETE ON save_recovery_approvals WHEN OLD.consumedAt IS NOT NULL BEGIN SELECT RAISE(ABORT,'consumed recovery approval'); END");
}
function intent(raw:string|null):MemorySaveAttemptIntent {
 if(!raw)throw new MemorySaveError('RECOVERY_REQUIRED');
 const p=JSON.parse(raw);
 if(!p||![p.inputDigest,p.beforeHash,p.providerBindingDigest].every(saveHash))throw new MemorySaveError('STORAGE_UNAVAILABLE');
 return {inputDigest:p.inputDigest,beforeHash:p.beforeHash,providerBindingDigest:p.providerBindingDigest};
}
function sourceRows(db:Database,parent:MemorySaveJob):SourceRow[] {
 const rows=db.query(`SELECT s.sequence,s.sourceKey,s.saveId,CASE WHEN length(CAST(s.payload AS BLOB))<=4096 THEN s.payload END AS payload
 FROM save_job_sources j JOIN save_sources s ON s.sourceKey=j.sourceKey WHERE j.saveId=? ORDER BY s.sourceKey LIMIT 9`).all(parent.saveId) as SourceRow[];
 if(!rows.length||rows.length>8||rows.some(r=>!r.payload||r.saveId!==parent.saveId||!saveInteger(r.sequence)||!saveHash(r.sourceKey)))throw new MemorySaveError('SOURCES_INELIGIBLE');
 const owned=(db.query('SELECT sourceKey FROM save_sources WHERE memoryId=? AND policyEpoch=? AND saveId=? ORDER BY sequence LIMIT 9').all(parent.memoryId,parent.policyEpoch,parent.saveId) as {sourceKey:string}[]).sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey));
 if(owned.length!==rows.length||owned.some((r,i)=>r.sourceKey!==rows[i]!.sourceKey))throw new MemorySaveError('SOURCE_CONFLICT');
 const sources=rows.map(r=>canonicalSaveSource(JSON.parse(r.payload!)));
 if(sources.some((s,i)=>s.memoryId!==parent.memoryId||s.policyEpoch!==parent.policyEpoch||s.coverageKind!=='complete-turn'||memorySaveSourceKey(s)!==rows[i]!.sourceKey)
  ||saveDigest(rows.map((r,i)=>[r.sourceKey,sources[i]!.sourceDigest]))!==parent.coverageDigest)throw new MemorySaveError('SOURCE_CONFLICT');
 return rows;
}
export function readMemorySaveRecoveryCandidate(db:Database,parentSaveId:string,version:number):MemorySaveRecoveryCandidate|null {
 if(!saveToken(parentSaveId))throw new MemorySaveError('INVALID_INPUT');
 const job=db.query(`SELECT ${jobProjection},CASE WHEN length(CAST(intent AS BLOB))<=1024 THEN intent END AS intent,receipt IS NOT NULL AS hasReceipt FROM save_jobs WHERE saveId=?`).get(parentSaveId) as (MemorySaveJob&{intent:string|null;hasReceipt:number})|null;
 if(!job)return null;
 if(!saveToken(job.memoryId)||!saveInteger(job.sequence)||!saveInteger(job.policyEpoch)||!saveHash(job.coverageDigest)||!saveToken(job.attemptId))throw new MemorySaveError('STORAGE_UNAVAILABLE');
 if(job.phase!=='recovery-required'||job.hasReceipt||db.query('SELECT 1 FROM save_host_sessions WHERE saveId=?').get(parentSaveId))throw new MemorySaveError('RECOVERY_REQUIRED');
 if(version>=9&&db.query('SELECT 1 FROM save_recovery_decisions WHERE parentSaveId=? OR successorSaveId=? LIMIT 1').get(parentSaveId,parentSaveId))throw new MemorySaveError('RECOVERY_REQUIRED');
 const attempt=db.query('SELECT attemptId,memoryId FROM save_auto_attempts WHERE saveId=?').get(parentSaveId) as {attemptId:string;memoryId:string}|null;
 if(!attempt||attempt.attemptId!==job.attemptId||attempt.memoryId!==job.memoryId)throw new MemorySaveError('RECOVERY_REQUIRED');
 const original=intent(job.intent),rows=sourceRows(db,job);
 const {intent:_intent,hasReceipt:_hasReceipt,...publicJob}=job;
 return {job:publicJob,intent:original,sources:rows.map(row=>({sourceKey:row.sourceKey,source:canonicalSaveSource(JSON.parse(row.payload!))}))};
}
function checkedCandidate(db:Database,b:MemorySaveRecoveryBinding,now:number):MemorySaveRecoveryCandidate {
 // scopeTargetId schedules a project family; exact review registration and the
 // memoryId policy, not that hint, authorize its registered worktree target.
 const c=readMemorySaveRecoveryCandidate(db,b.parentSaveId,9);
 if(!c||c.job.attemptId!==b.parentAttemptId||c.job.memoryId!==b.memoryId||c.job.policyEpoch!==b.policyEpoch||c.job.coverageDigest!==b.coverageDigest
  ||saveDigest(c.intent)!==b.originalIntentDigest||c.intent.beforeHash!==b.beforeHash||c.intent.providerBindingDigest!==(b.originalProviderBindingDigest??b.providerBindingDigest))throw new MemorySaveError('REVISION_CONFLICT');
 checkedRecoveryProviderTransition(db,b,now);
 checkAutomaticMemoryRecoveryAdmission(db,c.job,b.policyRevision,{...b,providerBindingDigest:b.originalProviderBindingDigest??b.providerBindingDigest},sourceRows(db,c.job) as {sequence:number;payload:string}[],now);
 return c;
}
function approvalDigest(a:Omit<MemorySaveRecoveryApproval,'reviewDigest'>):string{return saveDigest({version:a.version,approvalId:a.approvalId,reviewedAt:a.reviewedAt,expiresAt:a.expiresAt,binding:a.binding});}
function parseApproval(payload:string|null):MemorySaveRecoveryApproval {
 if(!payload)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 const p=JSON.parse(payload),b=canonicalMemorySaveRecoveryBinding(p.binding);
 if(p.version!==1||!saveToken(p.approvalId)||!saveHash(p.reviewDigest)||!saveInteger(p.reviewedAt)||!saveInteger(p.expiresAt)
  ||p.expiresAt-p.reviewedAt!==MEMORY_SAVE_RECOVERY_REVIEW_TTL)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 const a:MemorySaveRecoveryApproval={version:1,approvalId:p.approvalId,reviewDigest:p.reviewDigest,reviewedAt:p.reviewedAt,expiresAt:p.expiresAt,binding:b};
 if(approvalDigest(a)!==a.reviewDigest)throw new MemorySaveError('STORAGE_UNAVAILABLE');return a;
}
export function readMemorySaveRecoveryApproval(db:Database,approvalId:string):MemorySaveRecoveryApproval|null {
 if(!saveToken(approvalId))throw new MemorySaveError('INVALID_INPUT');
 const row=db.query('SELECT parentSaveId,CASE WHEN length(CAST(payload AS BLOB))<=4096 THEN payload END AS payload FROM save_recovery_approvals WHERE approvalId=?').get(approvalId) as {parentSaveId:string;payload:string|null}|null;
 if(!row)return null;
 const a=parseApproval(row.payload);if(a.approvalId!==approvalId||a.binding.parentSaveId!==row.parentSaveId)throw new MemorySaveError('STORAGE_UNAVAILABLE');return a;
}
/** Called only for an explicit review action after host preflight. Re-review
 * replaces at most one unconsumed row; it never accumulates pending approvals. */
export function prepareMemorySaveRecoveryApproval(db:Database,raw:MemorySaveRecoveryBinding,now:number):MemorySaveRecoveryApproval {
 const binding=canonicalMemorySaveRecoveryBinding(raw);
 if(!saveInteger(now)||!saveInteger(now+MEMORY_SAVE_RECOVERY_REVIEW_TTL))throw new MemorySaveError('INVALID_INPUT');
 checkedCandidate(db,binding,now);
 const base={version:1 as const,approvalId:randomUUID(),reviewedAt:now,expiresAt:now+MEMORY_SAVE_RECOVERY_REVIEW_TTL,binding};
 const approval={...base,reviewDigest:approvalDigest(base)};
 db.query(`INSERT INTO save_recovery_approvals(parentSaveId,approvalId,payload) VALUES (?,?,?) ON CONFLICT(parentSaveId) DO UPDATE SET approvalId=excluded.approvalId,payload=excluded.payload WHERE consumedAt IS NULL`).run(binding.parentSaveId,approval.approvalId,JSON.stringify(approval));
 return approval;
}
function readDecision(db:Database,approvalId:string):MemorySaveRecoveryDecision|null {
 const row=db.query('SELECT parentSaveId,successorSaveId,CASE WHEN length(CAST(payload AS BLOB))<=4096 THEN payload END AS payload FROM save_recovery_decisions WHERE approvalId=?').get(approvalId) as {parentSaveId:string;successorSaveId:string;payload:string|null}|null;
 if(!row)return null;if(!row.payload)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 const p=JSON.parse(row.payload),binding=canonicalMemorySaveRecoveryBinding(p.binding);
 if(p.version!==1||p.reason!=='response-unconfirmed'||p.approvalId!==approvalId||!saveHash(p.reviewDigest)||!saveInteger(p.consumedAt)
  ||![p.parentSaveId,p.parentAttemptId,p.successorSaveId,p.successorAttemptId,p.coverageOwnerSaveId].every(saveToken)
  ||p.parentSaveId!==row.parentSaveId||p.successorSaveId!==row.successorSaveId||p.parentSaveId!==binding.parentSaveId||p.parentAttemptId!==binding.parentAttemptId||p.coverageOwnerSaveId!==p.parentSaveId)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 return {version:1,reason:'response-unconfirmed',approvalId,reviewDigest:p.reviewDigest,parentSaveId:p.parentSaveId,parentAttemptId:p.parentAttemptId,successorSaveId:p.successorSaveId,
  successorAttemptId:p.successorAttemptId,coverageOwnerSaveId:p.coverageOwnerSaveId,consumedAt:p.consumedAt,binding};
}
/** The caller owns an IMMEDIATE transaction. No provider or filesystem effect
 * occurs here. Only created:true from this exact call authorizes one dispatch. */
export function admitMemorySaveRecoverySuccessor(db:Database,raw:MemorySaveRecoveryAdmission,now:number):{job:MemorySaveJob;attemptId:string;created:boolean;decision:MemorySaveRecoveryDecision;executionPolicyRevision:number} {
 if(!raw||raw.explicitConsent!==true||!saveToken(raw.approvalId)||!saveHash(raw.reviewDigest)||!saveInteger(now))throw new MemorySaveError('INVALID_INPUT');
 const b=canonicalMemorySaveRecoveryBinding(raw.binding),a=readMemorySaveRecoveryApproval(db,raw.approvalId);
 if(!a||a.reviewDigest!==raw.reviewDigest||saveDigest(a.binding)!==saveDigest(b))throw new MemorySaveError('REVISION_CONFLICT');
 const existing=readDecision(db,raw.approvalId);
 if(existing){
  if(existing.reviewDigest!==raw.reviewDigest||saveDigest(existing.binding)!==saveDigest(b))throw new MemorySaveError('REVISION_CONFLICT');
  const job=db.query(`SELECT ${jobProjection} FROM save_jobs WHERE saveId=?`).get(existing.successorSaveId) as MemorySaveJob|null;
  if(!job||job.attemptId!==existing.successorAttemptId||job.memoryId!==b.memoryId||job.coverageDigest!==b.coverageDigest)throw new MemorySaveError('STORAGE_UNAVAILABLE');
  const attempt=db.query('SELECT policyRevision FROM save_auto_attempts WHERE saveId=? AND attemptId=?').get(job.saveId,existing.successorAttemptId) as {policyRevision:number}|null;
  if(!attempt||!saveInteger(attempt.policyRevision))throw new MemorySaveError('STORAGE_UNAVAILABLE');
  return {job,attemptId:existing.successorAttemptId,created:false,decision:existing,executionPolicyRevision:attempt.policyRevision};
 }
 if(now<a.reviewedAt||now>=a.expiresAt)throw new MemorySaveError('POLICY_CHANGED');
 const candidate=checkedCandidate(db,b,now),parent=candidate.job;
 const transition=checkedRecoveryProviderTransition(db,b,now);
 let executionPolicyRevision=b.policyRevision;
 if(transition){
  executionPolicyRevision=refreshAutomaticMemoryProvider(db,b.policyRevision,b.originalProviderBindingDigest!,b.providerBindingDigest,now).revision;
  if(db.query('UPDATE save_provider_binding SET payload=? WHERE singleton=1').run(JSON.stringify(transition.readyBinding!)).changes!==1)throw new MemorySaveError('STORAGE_UNAVAILABLE');
 }
 const successorSaveId=randomUUID(),attemptId=randomUUID();
 reserveAutomaticMemoryRecoveryAdmission(db,parent,successorSaveId,executionPolicyRevision,b,attemptId,sourceRows(db,parent) as {sequence:number;payload:string}[],now);
 if(db.query("UPDATE save_jobs SET phase='superseded-unknown' WHERE saveId=? AND attemptId=? AND phase='recovery-required' AND receipt IS NULL").run(parent.saveId,parent.attemptId).changes!==1)throw new MemorySaveError('REVISION_CONFLICT');
 const nextIntent={inputDigest:b.inputDigest,beforeHash:b.beforeHash,providerBindingDigest:b.providerBindingDigest};
 db.query("INSERT INTO save_jobs(saveId,memoryId,policyEpoch,coverageDigest,phase,attemptId,intent) VALUES (?,?,?,?,'summarizing',?,?)").run(successorSaveId,b.memoryId,b.policyEpoch,b.coverageDigest,attemptId,JSON.stringify(nextIntent));
 const inputBinding={saveId:successorSaveId,memoryId:b.memoryId,policyEpoch:b.policyEpoch,coverageDigest:b.coverageDigest,...nextIntent};
 db.query('INSERT INTO save_input_bindings(saveId,payload,createdAt) VALUES (?,?,?)').run(successorSaveId,JSON.stringify(inputBinding),now);
 if(db.query('UPDATE save_recovery_approvals SET consumedAt=? WHERE approvalId=? AND consumedAt IS NULL').run(now,raw.approvalId).changes!==1)throw new MemorySaveError('REVISION_CONFLICT');
 const decision:MemorySaveRecoveryDecision={version:1,reason:'response-unconfirmed',approvalId:raw.approvalId,reviewDigest:raw.reviewDigest,parentSaveId:parent.saveId,parentAttemptId:parent.attemptId!,
  successorSaveId,successorAttemptId:attemptId,coverageOwnerSaveId:parent.saveId,consumedAt:now,binding:b};
 db.query('INSERT INTO save_recovery_decisions VALUES (?,?,?,?)').run(parent.saveId,successorSaveId,raw.approvalId,JSON.stringify(decision));
 const job=db.query(`SELECT ${jobProjection} FROM save_jobs WHERE saveId=?`).get(successorSaveId) as MemorySaveJob;
 return {job,attemptId,created:true,decision,executionPolicyRevision};
}
