import {classifyWorkroomEffort,workroomEffortRank,type WorkroomEffortTier} from './workroomEffortPolicy';

export type DesktopSessionEffortMode = 'auto' | 'recommend' | 'off';
/** Only a trusted adapter's local final guard may assert that no native request was dispatched. */
export class DesktopEffortPreDispatchRefusal extends Error {}
export interface DesktopEffortBinding {
  adapter: string; adapterVersion: string; sessionId: string; generation: number;
  model: string; provider: string; accountId: string;
}
export interface DesktopEffortReading extends DesktopEffortBinding {
  revision: number; effort: string; supported: readonly string[];
  idle: boolean; nativePickerOpen: boolean;
  /** Native hashes/receipts; no credential contents or other conversations are retained. */
  globalSettingsFingerprint: string; otherSessionsFingerprint: string;
}
export interface DesktopSessionEffortAdapter {
  readonly binding: DesktopEffortBinding;
  /** All three promises are necessary. A native picker alone cannot prove wire-level effort. */
  readonly capabilities: {sessionOnly: boolean; compareAndSet: boolean; effectiveReadback: boolean};
  read(): Promise<DesktopEffortReading>;
  set(request: {sessionId: string; generation: number; expectedRevision: number; effort: WorkroomEffortTier; requestId: string;validUntil?:number;isAuthorized?:()=>boolean}): Promise<void>;
}
export interface DesktopEffortReceipt {requestId: string; state: 'recommended' | 'applied' | 'unchanged' | 'held' | 'unknown';
  reason: string; before?: string; requested?: string; after?: string}
const bindingKeys = ['adapter','adapterVersion','sessionId','generation','model','provider','accountId'] as const;
const same = (a: DesktopEffortBinding,b: DesktopEffortBinding) => bindingKeys.every(k=>a[k]===b[k]);
/** Auto chooses only up to `high`. A higher effective effort (xhigh, max, ultra) is a person's choice. */
const AUTO_CEILING = workroomEffortRank('high')!;
const rank = (level: string) => workroomEffortRank(level) ?? -1;
/**
 * Opt-in session controller, independent of the legacy desktop recommend/off preference.
 * No background timer, model invocation, transcript store, global config write or GUI input.
 * Production adapters must prove their native session contract before being registered.
 */
export class DesktopSessionEffort {
  private mode:DesktopSessionEffortMode='recommend';
  private consent?:DesktopEffortBinding;
  private fixed?:string;
  private minimum?:string;
  /** The effective effort read at consent, kept because it was above Auto's range and lowering was not allowed. */
  private preserved?:string;
  private last?:string;
  private stopped=false;
  private busy=false;
  private changeEpoch=0;
  /** A dispatched change with an unconfirmed outcome cannot be retried through this connection. */
  private uncertain=false;
  private receipts=new Map<string,DesktopEffortReceipt>();
  constructor(private adapter:DesktopSessionEffortAdapter) {}
  /**
   * Auto reads this session's effective effort once, at consent, and fails without changing anything if it cannot.
   * An effort above Auto's range (a person's Max or xhigh) is kept: Auto never lowers it unless this consent says
   * `allowLowering: true`. The read value is also the baseline, so a person's later change stops Auto.
   */
  async configure(mode:DesktopSessionEffortMode,options:{consent?:DesktopEffortBinding;fixed?:string;minimum?:string;allowLowering?:boolean}={}) {
    if(!['auto','recommend','off'].includes(mode))throw Error('에포트 모드를 확인하세요.');
    if(options.fixed!==undefined&&workroomEffortRank(options.fixed)===null
      ||options.minimum!==undefined&&workroomEffortRank(options.minimum)===null)throw Error('고정 강도를 확인하세요.');
    if(options.allowLowering!==undefined&&typeof options.allowLowering!=='boolean')throw Error('낮춤 허용 여부를 확인하세요.');
    if(mode!=='auto')return this.setSafeMode(mode,options);
    if(this.busy)throw Error('현재 에포트 변경이 끝난 뒤 설정하세요.');
    if(this.uncertain)throw Error('이전 변경 결과를 확인하지 못했습니다. 외부 앱 세션을 다시 연결하세요.');
    const epoch=this.changeEpoch;
    let baseline:string|undefined;
    if(mode==='auto') {
      if(!options.consent||!same(options.consent,this.adapter.binding))throw Error('이 앱 세션의 자동 변경에 동의해야 합니다.');
      this.busy=true;
      try {
        const current=await this.adapter.read().catch(()=>undefined);
        if(!current||!same(current,options.consent)||workroomEffortRank(current.effort)===null)
          throw Error('이 세션의 현재 에포트를 확인하지 못해 자동 변경을 켜지 않았습니다.');
        if(epoch!==this.changeEpoch)throw Error('설정 중 외부 앱 세션이나 동의 상태가 바뀌었습니다.');
        baseline=current.effort;
      } finally {this.busy=false;}
    }
    this.mode=mode;this.consent=options.consent?{...options.consent}:undefined;
    this.fixed=options.fixed;this.minimum=options.minimum;
    this.preserved=baseline!==undefined&&rank(baseline)>AUTO_CEILING&&options.allowLowering!==true?baseline:undefined;
    this.last=baseline;this.stopped=false;
    return {mode,...(baseline!==undefined?{baseline}:{}),...(this.preserved?{preserved:this.preserved}:{})};
  }
  /** Revocation must be synchronous even while an earlier native read or dispatch is pending. */
  setSafeMode(mode:'off'|'recommend',options:{fixed?:string;minimum?:string}={}) {
    if(options.fixed!==undefined&&workroomEffortRank(options.fixed)===null
      ||options.minimum!==undefined&&workroomEffortRank(options.minimum)===null)throw Error('고정 강도를 확인하세요.');
    this.changeEpoch++;this.mode=mode;this.consent=undefined;this.fixed=options.fixed;this.minimum=options.minimum;
    this.preserved=undefined;this.last=undefined;this.stopped=false;return {mode};
  }
  manualChange() {this.changeEpoch++;this.stopped=true;}
  receipt(id:string) {const r=this.receipts.get(id);return r?{...r}:null;}
  /** Called at an existing request/phase boundary, never from polling or another model call. */
  async transition(input:{requestId:string;text:string;phase:'planning'|'implementation'|'verification'|'handoff'}) {
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId))throw Error('에포트 요청 ID를 확인하세요.');
    const prior=this.receipts.get(input.requestId);if(prior)return {...prior};
    if(this.busy)throw Error('이 세션의 에포트 변경이 진행 중입니다.');
    if(this.receipts.size>=64)throw Error('이 세션의 변경 기록 한도입니다.');
    const done=(state:DesktopEffortReceipt['state'],reason:string,values:Partial<DesktopEffortReceipt>={})=>{
      const r:DesktopEffortReceipt={requestId:input.requestId,state,reason,...values};this.receipts.set(input.requestId,r);return {...r};
    };
    if(this.mode==='off'||this.fixed||this.stopped)return done('held',this.fixed?'user-fixed':this.stopped?'manual-or-unknown':'off');
    const decision=classifyWorkroomEffort(input.text);
    if(!decision)return done('held','no-decision');
    // Verification without a new demanding concern may use the same table. Phase is evidence,
    // not permission to silently raise or lower a pinned user's effort.
    const desired=decision.tier;
    if(this.minimum&&(workroomEffortRank(desired)??-1)<(workroomEffortRank(this.minimum)??99))return done('held','user-minimum');
    // A person's Max or xhigh read at consent is never lowered by Auto without their explicit allowance.
    if(this.preserved&&rank(desired)<rank(this.preserved))return done('held','preserved-current',{requested:desired});
    const c=this.adapter.capabilities;
    if(this.mode!=='auto'||!c.sessionOnly||!c.compareAndSet||!c.effectiveReadback)
      return done('recommended','adapter-not-proven',{requested:desired});
    if(!this.consent||!same(this.consent,this.adapter.binding))return done('held','consent-binding-changed');
    if(this.uncertain)return done('held','native-result-unconfirmed');
    const epoch=this.changeEpoch;
    this.busy=true;
    try {
      const before=await this.adapter.read();
      if(epoch!==this.changeEpoch||this.mode!=='auto'||this.stopped||!this.consent)return done('held','consent-revoked');
      if(!same(before,this.consent)||!Number.isSafeInteger(before.revision)||before.revision<0
        ||!before.idle||before.nativePickerOpen||!before.supported.includes(desired)
        ||workroomEffortRank(before.effort)===null||!before.globalSettingsFingerprint||!before.otherSessionsFingerprint)
        return done('held','native-session-not-ready');
      if(this.last!==undefined&&before.effort!==this.last){this.stopped=true;return done('held','manual-change',{before:before.effort});}
      if(before.effort===desired){this.last=before.effort;return done('unchanged',decision.reason,{before:before.effort,after:before.effort});}
      // Persist unknown in memory *before* native dispatch. A lost reply is never replayed.
      done('unknown','native-result-unconfirmed',{before:before.effort,requested:desired});
      try {
        await this.adapter.set({sessionId:before.sessionId,generation:before.generation,
          expectedRevision:before.revision,effort:desired,requestId:input.requestId});
        const after=await this.adapter.read();
        if(epoch!==this.changeEpoch)throw Error('consent-changed-before-readback');
        if(!same(before,after)||after.effort!==desired||after.revision<=before.revision
          ||after.globalSettingsFingerprint!==before.globalSettingsFingerprint
          ||after.otherSessionsFingerprint!==before.otherSessionsFingerprint)throw Error('native-proof-mismatch');
        this.last=after.effort;
        return done('applied',decision.reason,{before:before.effort,requested:desired,after:after.effort});
      } catch(error) {
        if(epoch===this.changeEpoch)this.stopped=true;
        if(error instanceof DesktopEffortPreDispatchRefusal)return done('held','native-pre-dispatch-refused',{before:before.effort,requested:desired});
        this.uncertain=true;return this.receipt(input.requestId)!;
      }
    } catch {if(epoch===this.changeEpoch)this.stopped=true;return done('held','native-read-unavailable');}
    finally {this.busy=false;}
  }
}
