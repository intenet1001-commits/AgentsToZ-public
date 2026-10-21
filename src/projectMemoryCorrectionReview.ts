import type { ProjectMemoryFeedbackEvent } from './projectMemoryFeedback';
import { isProjectMemoryCorrection } from './projectMemoryFeedback';
import type { ProjectMemoryEntry } from './projectMemoryRecall';
import {AGENT_RUNTIME_TARGET_LIST_LIMIT} from './agentRuntimeApiContract';

export function correctionReview(entries: ProjectMemoryEntry[], events: ProjectMemoryFeedbackEvent[], memoryId: string) {
  const current = new Map(entries.map(entry => [entry.entryKey, entry.contentVersionHash]));
  const pending = new Set<string>(), changed = new Set<string>();
  let unboundReports = 0;
  for (const event of events) {
    if (event.memoryId !== memoryId || !isProjectMemoryCorrection(event.kind)) continue;
    if (!event.contentVersionHash) { unboundReports++; continue; }
    if (current.get(event.entryKey) === event.contentVersionHash) pending.add(event.entryKey);
    else changed.add(event.entryKey);
  }
  return { pendingEntries: pending.size, changedVersionEntries: changed.size, unboundReports };
}

export type CorrectionReview = ReturnType<typeof correctionReview>;
/** The target has no long-term memory, so nothing to review: not a failure to report. */
export const CORRECTION_REVIEW_NOT_APPLICABLE = {state:'not-applicable'} as const;
export type CorrectionReviewNotApplicable = typeof CORRECTION_REVIEW_NOT_APPLICABLE;
/** The OPS/shared root is never reviewed here, whether or not it has memory; kept apart from 'no memory'. */
export const CORRECTION_REVIEW_EXCLUDED = {state:'excluded'} as const;
export type CorrectionReviewExcluded = typeof CORRECTION_REVIEW_EXCLUDED;
type Reviewed = { checkedAt: number; result: CorrectionReview };
type Schedule={firstSeenAt:number;checkedAt:number|null;attemptedAt:number|null;last:'ok'|'failed'|'unavailable'|'not-applicable'|'excluded'|'waiting'};
const HOUR=3_600_000;

/** Deterministic review of existing reports; never calls a model or edits source memory. */
export class ProjectMemoryCorrectionReview {
  private active = false;
  private cursor = 0;
  private nextTick = 0;
  private readonly reviewed = new Map<string, Reviewed>();
  private readonly schedule=new Map<string,Schedule>();
  private inventoryAvailable=false;
  private untracked=0;
  constructor(private readonly deps: {
    enabled(): boolean;
    targets(): Promise<string[]>;
    /** null = unavailable right now (retried after an hour); a throw = failed (retried next pass). */
    review(target: string): Promise<CorrectionReview | CorrectionReviewNotApplicable | CorrectionReviewExcluded | null>;
    now?: () => number;
    /**
     * Optional outcome observation (only wired when the outcome pipeline is enabled). Runs once per tick after the
     * target loop and does not use the 8-attempt budget; its own work is bounded inside the observer.
     */
    observeOutcomes?: () => Promise<void>;
    outcomeOverview?: () => {pending: number; backlog: number; overdue: number} | null;
  }) {}
  async tick() {
    const now = this.deps.now?.() ?? Date.now();
    if (this.active || !this.deps.enabled() || now < this.nextTick) return;
    this.active = true;
    this.nextTick = now + 60_000;
    try {
      let all:string[];
      try{all=[...new Set(await this.deps.targets())];this.inventoryAvailable=true;}catch(error){this.inventoryAvailable=false;throw error;}
      const targets = all.filter(key=>typeof key==='string'&&key.length<=8192).slice(0,AGENT_RUNTIME_TARGET_LIST_LIMIT);
      this.untracked=all.length-targets.length;
      const current = new Set(targets);
      for (const key of this.reviewed.keys()) if (!current.has(key)) this.reviewed.delete(key);
      for (const key of this.schedule.keys()) if (!current.has(key)) this.schedule.delete(key);
      for(const target of targets)if(!this.schedule.has(target))this.schedule.set(target,{firstSeenAt:now,checkedAt:null,attemptedAt:null,last:'waiting'});
      let attempts=0,lastAttemptCursor=this.cursor;
      for (let i = 0; i < targets.length && attempts<8; i++) {
        if (!this.deps.enabled()) break;
        this.cursor %= targets.length;
        const target = targets[this.cursor++]!;
        const schedule=this.schedule.get(target)!;
        if(schedule.checkedAt!==null&&now-schedule.checkedAt<HOUR)continue;
        // Memory-less and unavailable targets wait an hour too; otherwise they take the 8 attempts every minute.
        if((schedule.last==='unavailable'||schedule.last==='not-applicable'||schedule.last==='excluded')&&schedule.attemptedAt!==null&&now-schedule.attemptedAt<HOUR)continue;
        attempts++;lastAttemptCursor=this.cursor;schedule.attemptedAt=now;
        try {
          const result = await this.deps.review(target);
          if (!result){schedule.last='unavailable';continue;}
          if ('state' in result){schedule.last=result.state;this.reviewed.delete(target);continue;}
          schedule.checkedAt=now;schedule.last='ok';
          this.reviewed.delete(target);
          this.reviewed.set(target, { checkedAt: now, result });
          // Disposable summaries only; durable correction evidence is never pruned here.
          if (this.reviewed.size > 128) this.reviewed.delete(this.reviewed.keys().next().value!);
        } catch {schedule.last='failed'; /* One unavailable project cannot starve the next project's review. */ }
      }
      this.cursor=lastAttemptCursor;
      if(this.deps.observeOutcomes&&this.deps.enabled()){
        try{await this.deps.observeOutcomes();}catch{/* An unavailable outcome store never blocks the review. */}
      }
    } finally { this.active = false; }
  }
  status(target: string) { return this.reviewed.get(target) ?? null; }
  /**
   * The caller just read this target's long-term memory, so an earlier 'no memory' answer is stale (memory was started
   * since). Re-queue it now instead of showing 'not-applicable' for the rest of the hour. Excluded roots stay excluded.
   */
  noteMemoryPresent(target:string){
    const schedule=this.schedule.get(target);if(schedule?.last!=='not-applicable')return;
    schedule.last='waiting';schedule.attemptedAt=null;schedule.firstSeenAt=this.deps.now?.()??Date.now();
  }
  scheduleStatus(target:string){
    const schedule=this.schedule.get(target),now=this.deps.now?.()??Date.now();
    // A backed-off target is next tried an hour after its attempt, not an hour after it was last checked or first seen.
    const backedOff=schedule&&(schedule.last==='unavailable'||schedule.last==='not-applicable'||schedule.last==='excluded')&&schedule.attemptedAt!==null;
    const dueAt=schedule?(backedOff?schedule.attemptedAt!:schedule.checkedAt??schedule.firstSeenAt)+HOUR:null;
    const state=!this.deps.enabled()?'disabled':!this.inventoryAvailable?'unavailable':!schedule?'not-tracked':schedule.last==='failed'?'failed':schedule.last==='unavailable'?'unavailable':schedule.last==='not-applicable'?'not-applicable':schedule.last==='excluded'?'excluded':schedule.checkedAt!==null&&now<dueAt!?'current':now>dueAt!?'overdue':'due';
    return {state,checkedAt:schedule?.checkedAt??null,attemptedAt:schedule?.attemptedAt??null,dueAt,efficacyVerified:false as const};
  }
  overview(){
    let due=0,overdue=0,failed=0,unavailable=0,notApplicable=0,excluded=0;
    for(const key of this.schedule.keys()){const state=this.scheduleStatus(key).state;if(state==='due')due++;if(state==='overdue')overdue++;if(state==='failed')failed++;if(state==='unavailable')unavailable++;if(state==='not-applicable')notApplicable++;if(state==='excluded')excluded++;}
    let outcomes:{pending:number;backlog:number;overdue:number}|null=null;
    try{const o=this.deps.outcomeOverview?.();if(o)outcomes={pending:o.pending,backlog:o.backlog,overdue:o.overdue};}catch{/* display only */}
    return {tracked:this.schedule.size,untracked:this.untracked,due,overdue,failed,unavailable,notApplicable,excluded,inventoryAvailable:this.inventoryAvailable,active:this.active,summaryCount:this.reviewed.size,outcomes,efficacyVerified:false as const};
  }
}
