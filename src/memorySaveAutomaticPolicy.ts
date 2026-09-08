import type {Database} from 'bun:sqlite';
import {MemorySaveError,canonicalSaveSource,saveHash,saveInteger,saveToken,type MemorySaveJob,type MemorySaveAttemptIntent} from './memorySaveContract';
export const AUTOMATIC_MEMORY_CONSENT_VERSION=1;
export const AUTOMATIC_MEMORY_DAILY_LIMIT=8;
const DAY=24*60*60*1000,PROJECT_INTERVAL=30*60*1000;
export interface AutomaticMemoryPolicy {
  revision:number;enabled:boolean;enabledAt:number|null;providerBindingDigest:string|null;excludedMemoryIds:string[];scopeMemoryId:string|null;scopeTargetId:string|null;
}
export interface AutomaticMemoryPolicyInput {enabled:boolean;consentVersion?:number;providerBindingDigest?:string;excludedMemoryIds?:string[];scopeMemoryId?:string|null;scopeTargetId?:string|null}
interface StoredPolicy extends AutomaticMemoryPolicy {lastClock:number;afterSequence:number}
export function migrateAutomaticMemoryPolicy(db:Database):void {
  db.run('CREATE TABLE save_auto_policy (singleton INTEGER PRIMARY KEY CHECK(singleton=1), payload TEXT NOT NULL)');
  db.query('INSERT INTO save_auto_policy VALUES (1,?)').run(JSON.stringify({revision:0,enabled:false,enabledAt:null,providerBindingDigest:null,excludedMemoryIds:[],scopeMemoryId:null,scopeTargetId:null,lastClock:0,afterSequence:0}));
  db.run('CREATE TABLE save_auto_attempts (saveId TEXT PRIMARY KEY, attemptId TEXT NOT NULL UNIQUE, memoryId TEXT NOT NULL, policyRevision INTEGER NOT NULL, startedAt INTEGER NOT NULL)');
  db.run('CREATE INDEX auto_attempts_time ON save_auto_attempts(startedAt)');
  db.run('CREATE INDEX auto_attempts_project_time ON save_auto_attempts(memoryId,startedAt)');
  db.run("CREATE INDEX jobs_active_attempt ON save_jobs(phase) WHERE phase IN ('summarizing','recovery-required')");
}
function read(db:Database):StoredPolicy {
  const row=db.query('SELECT payload FROM save_auto_policy WHERE singleton=1').get() as {payload:string}|null;
  if(!row||row.payload.length>150000)throw new MemorySaveError('STORAGE_UNAVAILABLE');
  const p=JSON.parse(row.payload) as StoredPolicy;
  if(!p||!saveInteger(p.revision)||typeof p.enabled!=='boolean'||!saveInteger(p.lastClock)||!saveInteger(p.afterSequence)
    ||(p.enabledAt!==null&&!saveInteger(p.enabledAt))||(p.providerBindingDigest!==null&&!saveHash(p.providerBindingDigest))
    ||(p.enabled&&(p.enabledAt===null||p.providerBindingDigest===null))
    ||(p.scopeMemoryId!==null&&!saveToken(p.scopeMemoryId))
    ||(p.scopeTargetId!==null&&(!saveToken(p.scopeTargetId)||p.scopeMemoryId===null))
    ||!Array.isArray(p.excludedMemoryIds)||p.excludedMemoryIds.length>1024||!p.excludedMemoryIds.every(saveToken))throw new MemorySaveError('STORAGE_UNAVAILABLE');
  return p;
}
function write(db:Database,p:StoredPolicy){db.query('UPDATE save_auto_policy SET payload=? WHERE singleton=1').run(JSON.stringify(p));}
function publicPolicy(p:StoredPolicy):AutomaticMemoryPolicy{return {revision:p.revision,enabled:p.enabled,enabledAt:p.enabledAt,providerBindingDigest:p.providerBindingDigest,excludedMemoryIds:[...p.excludedMemoryIds],scopeMemoryId:p.scopeMemoryId,scopeTargetId:p.scopeTargetId};}
export function readAutomaticMemoryPolicy(db:Database):AutomaticMemoryPolicy{return publicPolicy(read(db));}
/** Host-only observation boundary. Never expose sequence as caller authority. */
export function automaticMemoryObservationBoundary(db:Database,revision:number):{afterSequence:number;enabledAt:number} {
 const p=read(db);
 if(!p.enabled||p.enabledAt===null)throw new MemorySaveError('POLICY_DISABLED');
 if(p.revision!==revision)throw new MemorySaveError('POLICY_CHANGED');
 return {afterSequence:p.afterSequence,enabledAt:p.enabledAt};
}
/** Internal host operation only; a future authenticated settings route must obtain
 * explicit consent. No existing checkpoint setting is consumed here. */
export function changeAutomaticMemoryPolicy(db:Database,expectedRevision:number,input:AutomaticMemoryPolicyInput,now:number):AutomaticMemoryPolicy {
  if(!saveInteger(expectedRevision)||!saveInteger(now)||!input||typeof input.enabled!=='boolean'
    ||(input.enabled&&(input.consentVersion!==AUTOMATIC_MEMORY_CONSENT_VERSION||!saveHash(input.providerBindingDigest)))
    ||(input.excludedMemoryIds!==undefined&&(!Array.isArray(input.excludedMemoryIds)||input.excludedMemoryIds.length>1024||!input.excludedMemoryIds.every(saveToken))))throw new MemorySaveError('INVALID_INPUT');
  const prior=read(db);
  if(input.scopeMemoryId!==undefined&&input.scopeMemoryId!==null&&!saveToken(input.scopeMemoryId))throw new MemorySaveError('INVALID_INPUT');
  if(input.scopeTargetId!==undefined&&input.scopeTargetId!==null&&!saveToken(input.scopeTargetId))throw new MemorySaveError('INVALID_INPUT');
  if(prior.enabled&&input.enabled&&input.scopeTargetId!==undefined&&input.scopeTargetId!==prior.scopeTargetId)throw new MemorySaveError('POLICY_CHANGED');
  if(prior.enabled&&input.enabled&&input.scopeMemoryId!==undefined&&input.scopeMemoryId!==prior.scopeMemoryId)throw new MemorySaveError('POLICY_CHANGED');
  if(prior.revision!==expectedRevision||!saveInteger(prior.revision+1))throw new MemorySaveError('POLICY_CHANGED');
  // Opt-out remains possible after clock rollback, but cannot reset the high-water clock.
  if(input.enabled&&now<prior.lastClock)throw new MemorySaveError('CLOCK_ROLLBACK');
  const next:StoredPolicy={revision:prior.revision+1,enabled:input.enabled,
    enabledAt:input.enabled?(prior.enabled?prior.enabledAt:now):null,
    providerBindingDigest:input.enabled?input.providerBindingDigest!:null,
    scopeMemoryId:input.scopeMemoryId===undefined?prior.scopeMemoryId:input.scopeMemoryId,
    scopeTargetId:input.scopeTargetId===undefined?prior.scopeTargetId:input.scopeTargetId,
    excludedMemoryIds:[...new Set(input.excludedMemoryIds??prior.excludedMemoryIds)].sort(),lastClock:Math.max(now,prior.lastClock),
    afterSequence:input.enabled&&!prior.enabled?((db.query('SELECT sequence FROM save_sources ORDER BY sequence DESC LIMIT 1').get() as {sequence:number}|null)?.sequence??0):prior.afterSequence};
  if(next.scopeMemoryId===null)next.scopeTargetId=null;
  write(db,next);return publicPolicy(next);
}
/** Exclusions pause V2; they do not silently restore legacy automatic calls. */
export function automaticMemoryOwns(p:AutomaticMemoryPolicy,memoryId:string):boolean {
  return p.enabled&&(p.scopeMemoryId===null||p.scopeMemoryId===memoryId);
}
export function assertLegacyAttemptAllowed(db:Database,memoryId:string):void {
  if(automaticMemoryOwns(read(db),memoryId)||db.query("SELECT 1 FROM save_auto_attempts a JOIN save_jobs j ON j.saveId=a.saveId WHERE j.phase IN ('summarizing','recovery-required') LIMIT 1").get())throw new MemorySaveError('AUTOMATIC_ONLY');
}
/** Called inside the same immediate transaction as the durable attempt intent.
 * This is a conservative reservation, never proof that a provider actually ran.
 * No automatic refund or crash-based unlock is permitted. */
export function checkAutomaticMemoryAdmission(db:Database,job:Pick<MemorySaveJob,'memoryId'|'policyEpoch'>,expectedRevision:number,intent:Pick<MemorySaveAttemptIntent,'providerBindingDigest'>,sources:readonly {sequence:number;payload:string}[],now:number):void {
  if(!saveInteger(now)||!saveInteger(expectedRevision))throw new MemorySaveError('INVALID_INPUT');
  const p=read(db);
  if(!p.enabled)throw new MemorySaveError('POLICY_DISABLED');
  if(p.revision!==expectedRevision||p.providerBindingDigest!==intent.providerBindingDigest)throw new MemorySaveError('POLICY_CHANGED');
  if(!automaticMemoryOwns(p,job.memoryId)||p.excludedMemoryIds.includes(job.memoryId))throw new MemorySaveError('POLICY_DISABLED');
  if(now<p.lastClock)throw new MemorySaveError('CLOCK_ROLLBACK');
  if(db.query("SELECT 1 FROM save_jobs WHERE phase IN ('summarizing','recovery-required') LIMIT 1").get())throw new MemorySaveError('EXECUTION_BUSY');
  if(!sources.length||sources.length>128||sources.some(row=>{
    const s=canonicalSaveSource(JSON.parse(row.payload));
    return row.sequence<=p.afterSequence||s.coverageKind!=='complete-turn'||s.memoryId!==job.memoryId||s.policyEpoch!==job.policyEpoch||s.completedAt<=p.enabledAt!||s.completedAt>now;
  }))throw new MemorySaveError('SOURCES_INELIGIBLE');
  const recent=db.query('SELECT startedAt FROM save_auto_attempts WHERE startedAt>? ORDER BY startedAt LIMIT 8').all(now-DAY);
  const last=db.query('SELECT startedAt FROM save_auto_attempts WHERE memoryId=? ORDER BY startedAt DESC LIMIT 1').get(job.memoryId) as {startedAt:number}|null;
  if(recent.length>=AUTOMATIC_MEMORY_DAILY_LIMIT||(last&&now-last.startedAt<PROJECT_INTERVAL))throw new MemorySaveError('BUDGET_PAUSED');
}
export function reserveAutomaticMemoryAdmission(db:Database,job:MemorySaveJob,expectedRevision:number,intent:MemorySaveAttemptIntent,attemptId:string,now:number):void {
  const sources=db.query('SELECT s.sequence,s.payload FROM save_job_sources j JOIN save_sources s ON s.sourceKey=j.sourceKey WHERE j.saveId=? LIMIT 129').all(job.saveId) as {sequence:number;payload:string}[];
  checkAutomaticMemoryAdmission(db,job,expectedRevision,intent,sources,now);
  const p=read(db);
  db.query('INSERT INTO save_auto_attempts VALUES (?,?,?,?,?)').run(job.saveId,attemptId,job.memoryId,p.revision,now);
  write(db,{...p,lastClock:now});
}
