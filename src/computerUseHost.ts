import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {COMPUTER_USE_LIMITS as L, COMPUTER_USE_WORKER_PROTOCOL, COMPUTER_REFUSAL_REASONS, parseComputerAgentRequest, parseComputerTarget, sameComputerCaller,
  type ComputerActionState, type ComputerCaller, type ComputerTarget, type ComputerObservation, type ComputerReceipt, type ComputerRefusalReason} from './computerUseProtocol';
import {isAuthenticatedComputerCaller, computerCallerGeneration, isLiveComputerCallerGeneration, type AuthenticatedComputerCaller} from './computerUseCaller';
import type {ComputerApprovalVerifier} from './computerUseApproval';
import type {ComputerUseRecoveryStore} from './computerUseRecovery';

/**
 * The trusted host supplies a versioned native adapter. Agents cannot select an executable. In production this is a
 * session on the separately signed sibling Control app (HELPER-DESIGN.md); the child-process transport in
 * computerUseWorker.ts is for labs and tests only.
 */
export interface ComputerWorker {
  request(body: Record<string, unknown>): Promise<Record<string, any>>;
  close(): void;
  /**
   * False when this worker cannot take capture/click: a bound Control that predates them (computerUseNative.ts), or the
   * lab worker, which has no screen-image consent or capture binding (computerUseWorker.ts).
   */
  supports?(operation: 'capture' | 'click'): boolean;
  /** The lab and test child-process worker (computerUseWorker.ts), never the signed Control. */
  readonly lab?: true;
}
/**
 * What one grant's worker is for: the verified approval, its caller credential and the exact target. AgentsToZ
 * Control's `open-grant` needs all of it (native/computer-use/CONTRACT.md); the lab worker ignores it.
 */
export interface ComputerWorkerContext {
  approvalId: string;
  caller: ComputerCaller;
  generation: string;
  target: ComputerTarget;
}
/** Why a grant stopped taking input. Shown to the person; never a reason to retry automatically. */
export type ComputerHaltReason = 'agent-request' | 'human-takeover' | 'outcome-unknown' | 'worker-halted' | 'worker-unavailable';
/** `generation`: the caller credential the grant belongs to. Another credential for the same session ID never matches. */
type Grant = {id: string; secret: string; epoch: number; expires: number; target: ComputerTarget; caller: ComputerCaller;
  generation: string; label: string; worker: ComputerWorker; busy: boolean; halted: boolean; haltReason?: ComputerHaltReason;
  timer?: ReturnType<typeof setTimeout>;
  observation?: {id: string; snapshotId: string; expires: number; elements: Set<string>; capture?: {width:number; height:number}};
  receipts: Map<string, {fingerprint: string; receipt: ComputerReceipt}>};
/** A grant being prepared (worker start and bind) for one approved caller; `ended` once its session ends meanwhile. */
type Preparing = {approvalId: string; sessionId: string; generation: string; ended: boolean};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const refusal = (code: unknown): ComputerRefusalReason =>
  (COMPUTER_REFUSAL_REASONS as readonly unknown[]).includes(code) ? code as ComputerRefusalReason : 'worker-refused';
const DENIED = '사람이 허용한 컴퓨터 제어 연결이 필요합니다.';
const CONTROL_UPDATE = 'AgentsToZ Control을 최신 버전으로 업데이트해야 화면 확인(capture)과 좌표 선택(click)을 쓸 수 있습니다: control-update-required. 관찰·누르기·입력은 그대로 쓸 수 있습니다.';
const LAB_SCREEN = '실험용 컴퓨터 제어 실행기는 화면 확인(capture)과 좌표 선택(click)을 지원하지 않습니다: lab-worker-unsupported. 관찰·누르기·입력은 그대로 쓸 수 있습니다.';
const WORKER_ENDED = '컴퓨터 제어 실행기가 끝났습니다. 사람이 대상을 다시 허용해야 합니다.';
const REVIEW_FIRST = '이 앱에 결과를 확인하지 못한 작업이 있습니다. 사람이 먼저 확인해야 다시 허용하거나 보낼 수 있습니다.';
const SESSION_ENDED = '작업 세션이 끝나 제어 허용을 만들지 않았습니다. 새 세션에서 다시 승인받아야 합니다.';
/** No queued input: a team member must observe again after another member mutates the same window. */
export class ComputerUseHost {
  private grants = new Map<string, Grant>();
  private windows = new Set<string>();
  private disposed = false;
  private preparing = new Set<Preparing>();
  /** Ledger rows of actions this host is sending right now: in flight, not yet abandoned. */
  private inflight = new Set<string>();
  /**
   * `recovery` is the durable unknown-action ledger (computerUseRecovery.ts) and `approvals` the helper-signed
   * human approval (computerUseApproval.ts); there is no mode without either.
   */
  constructor(private readonly deps: {createWorker: (context: ComputerWorkerContext) => Promise<ComputerWorker>; recovery: ComputerUseRecoveryStore;
    approvals: Pick<ComputerApprovalVerifier, 'request' | 'verify' | 'redeem' | 'cancel' | 'cancelSession'>; now?: () => number}) {}
  /**
   * An app with an action whose result nobody will report (a lost answer, or any row left by an earlier process),
   * or a ledger that cannot be read, takes no new grant or action until a person reviews it.
   */
  private unresolved(t: ComputerTarget) {
    try {return this.deps.recovery.blockedByScope?.(t.bundleId)===true||this.deps.recovery.unresolved(t.bundleId).some(row => !this.inflight.has(row.id));} catch {return true;}
  }
  private now() {return (this.deps.now ?? Date.now)();}
  private key(t: ComputerTarget) {return `${t.pid}/${t.processStart}`;}
  /** Expired grants, and grants whose caller credential retired or expired, end with their worker. */
  private reap() {for (const g of this.grants.values()) if (g.expires <= this.now() || !isLiveComputerCallerGeneration(g.generation)) this.remove(g);}
  private remove(g: Grant) {g.halted = true; g.observation = undefined; if(g.timer)clearTimeout(g.timer);g.worker.close(); this.grants.delete(g.id);}
  /** Host and worker agree: once either side stops, the grant shows as stopped and its worker closes. */
  private halt(g: Grant, reason: ComputerHaltReason) {
    if (!g.halted) {g.halted = true; g.haltReason = reason; g.epoch++;}
    g.observation = undefined; g.worker.close();
  }
  private sync(g: Grant, answer: Record<string, any>) {if (answer?.halted === true) this.halt(g, 'worker-halted');}
  private active(g: Grant) {
    const gone = this.disposed || g.expires <= this.now() || !isLiveComputerCallerGeneration(g.generation);
    if (gone || !this.grants.has(g.id) || g.halted) {
      if (this.grants.has(g.id) && gone) this.remove(g);
      throw Error('제어 허용이 끝났습니다. 사람이 대상을 다시 허용해야 합니다.');
    }
  }
  /** After every await while a grant is prepared: an ended session or a retired credential creates nothing. */
  private fence(p: Preparing) {if (this.disposed || p.ended || !isLiveComputerCallerGeneration(p.generation)) throw Error(SESSION_ENDED);}
  list() {this.reap(); return [...this.grants.values()].map(g => ({id:g.id, label:g.label,
    target:{...g.target}, caller:{...g.caller}, epoch:g.epoch, expiresAt:g.expires, halted:g.halted,
    ...(g.haltReason ? {haltReason:g.haltReason} : {}), busy:g.busy}));}
  /**
   * Opens one approval for the signed helper to show (the person or the agent may ask; only the person decides).
   * Refused targets and apps with an action awaiting review are never offered.
   */
  requestApproval(caller: AuthenticatedComputerCaller, target: unknown, label: string) {
    this.reap();
    if (!isAuthenticatedComputerCaller(caller)) throw Error('인증된 작업 세션이 필요합니다.');
    if (this.disposed || this.grants.size + this.preparing.size >= L.grants) throw Error('제어 허용 한도입니다.');
    const t = parseComputerTarget(target);
    if (this.unresolved(t)) throw Error(REVIEW_FIRST);
    return this.deps.approvals.request(caller, t, label);
  }
  /**
   * UI/helper management only; never an agent tool. Turns one helper-signed human approval into a grant for the
   * caller credential it was requested by. A boolean or any unsigned value is refused by the verifier, and a session
   * that ends at any point before the grant exists (while signing, starting the worker or binding) gets nothing.
   */
  async grant(approval: unknown) {
    this.reap();
    if (this.disposed || this.grants.size + this.preparing.size >= L.grants) throw Error('제어 허용 한도입니다.');
    const {approvalId, target: t, caller, label, generation} = this.deps.approvals.verify(approval);
    if (this.unresolved(t)) throw Error(REVIEW_FIRST);
    if ([...this.preparing].some(p => p.approvalId === approvalId)) throw Error('이 승인의 연결 준비가 진행 중입니다.');
    const preparing: Preparing = {approvalId, sessionId: caller.sessionId, generation, ended: false};
    this.fence(preparing); this.preparing.add(preparing);
    let worker:ComputerWorker|undefined;
    try {
      worker=await this.deps.createWorker({approvalId, caller:{...caller}, generation, target:{...t}});
      this.fence(preparing);
      if (this.grants.size >= L.grants) throw Error('제어 허용 한도입니다.');
      const result = await worker.request({operation:'bind', target:t});
      this.fence(preparing);
      if (result.success !== true || result.bound !== true) {
        if (result.notDispatched === true && result.code === 'native-busy') throw Object.assign(Error('제어 연결이 사용 중입니다. 승인 대기 상태를 다시 확인하세요.'), {notDispatched:true});
        throw Error('대상 창 또는 접근성 권한을 확인하세요.');
      }
      if (result.protocolVersion !== COMPUTER_USE_WORKER_PROTOCOL) throw Error('컴퓨터 제어 실행기 버전이 맞지 않습니다.');
      // Spend only after the native one-use bind succeeded. A known refusal before dispatch leaves the signed
      // approval pending; a lost/uncertain bind is cancelled, never replayed. This final check also catches expiry
      // or cancellation during the await; closing the worker then revokes the native grant.
      this.deps.approvals.redeem(approval);
      const g: Grant = {id:randomUUID(), secret:randomBytes(32).toString('hex'), epoch:1,
        target:t, caller:{sessionId:caller.sessionId, lane:caller.lane}, generation, label, expires:this.now()+L.lifetimeMs,
        worker, busy:false, halted:false, receipts:new Map()};
      this.grants.set(g.id,g);
      g.timer=setTimeout(()=>this.remove(g),L.lifetimeMs);g.timer.unref?.();
      return {success:true, id:g.id, grant:g.secret, epoch:g.epoch, expiresAt:g.expires};
    } catch (e) {
      worker?.close();
      if ((e as {notDispatched?:boolean})?.notDispatched !== true) this.deps.approvals.cancel(approvalId);
      throw e;
    } finally {this.preparing.delete(preparing);}
  }
  revoke(id: string) {const g=this.grants.get(id); if(g)this.remove(g); return {success:true};}
  /**
   * A Workroom session that ended takes its grants (and their workers), its open approval requests and any grant
   * still being prepared with it. Retire its caller credentials in the registry as well.
   */
  endSession(sessionId: string) {
    for (const g of [...this.grants.values()]) if (g.caller.sessionId === sessionId) this.remove(g);
    for (const p of this.preparing) if (p.sessionId === sessionId) p.ended = true;
    this.deps.approvals.cancelSession(sessionId);
    return {success:true};
  }
  /** `caller` comes from the authenticated transport, never from `value`. */
  async agent(caller: AuthenticatedComputerCaller, value: unknown): Promise<Record<string, any>> {
    const generation = computerCallerGeneration(caller);
    if (!generation) throw Error('인증된 작업 세션이 필요합니다.');
    const r = parseComputerAgentRequest(value); this.reap();
    // Fixed-size secrets never appear in errors, catalog rows, receipts or durable state.
    const g = [...this.grants.values()].find(g => hash(g.secret) === hash(r.grant));
    // Another session, lane or credential holding a leaked secret learns nothing and changes nothing.
    if(!g||g.generation!==generation||!sameComputerCaller(g.caller,caller))throw Error(DENIED);
    if(r.operation==='receipt') {
      const record=g.receipts.get(r.requestId);
      if(!record)throw Error('이 요청의 실행 영수증이 없습니다.');
      return {success:true, receipt:{...record.receipt}};
    }
    this.active(g);
    if(r.epoch!==g.epoch)throw Error('새 관찰이 필요합니다.');
    if(r.operation==='request-human') {this.halt(g,'agent-request');return {success:true, owner:'human'};}
    const key=this.key(g.target);
    if(g.busy||this.windows.has(key))throw Error('이 창의 다른 작업이 진행 중입니다. 끝난 뒤 새로 관찰하세요.');
    if(r.operation==='observe') {
      g.busy=true; this.windows.add(key); g.observation=undefined;
      try {
        let answer:Record<string,any>;
        try {answer=await g.worker.request({operation:'observe'});}
        catch {this.halt(g,'worker-unavailable');throw Error(WORKER_ENDED);}
        this.sync(g,answer); this.active(g);
        // Reading never moves anything: a person who moved or switched focus meanwhile voids only this observation.
        if(answer.success!==true&&answer.code==='observation-discarded')
          throw Error('관찰하는 동안 사람이 화면을 사용해 이번 관찰만 버렸습니다. 잠시 뒤 다시 관찰하세요.');
        if(answer.success!==true||typeof answer.snapshotId!=='string'||!Array.isArray(answer.elements)
          ||answer.elements.length>L.elements||answer.elements.some((e:any)=>!e||typeof e.id!=='string'
            ||typeof e.label!=='string'||e.label.length>240||typeof e.value!=='string'||e.value.length>1000))
          throw Error('이 창을 안전하게 관찰하지 못했습니다.');
        const observation:ComputerObservation={snapshotId:answer.snapshotId,elements:answer.elements,truncated:answer.truncated===true};
        const id=randomUUID();g.observation={id,snapshotId:answer.snapshotId,expires:this.now()+L.observationMs,
          elements:new Set(observation.elements.map(e=>e.id))};
        return {success:true, epoch:g.epoch, observationId:id, observation};
      } catch(e) {g.observation=undefined;throw e;}
      finally {g.busy=false;this.windows.delete(key);}
    }
    // Up front, before any lane, ledger row or receipt: a Control too old for these, or the lab worker, cannot run them.
    if((r.operation==='capture'||r.operation==='click')&&g.worker.supports?.(r.operation)===false)throw Error(g.worker.lab===true?LAB_SCREEN:CONTROL_UPDATE);
    if(r.operation==='capture') {
      const obs=g.observation;
      if(!obs||obs.id!==r.observationId||obs.expires<=this.now())throw Error('대상 창을 새로 관찰하세요.');
      g.busy=true;this.windows.add(key);obs.capture=undefined;
      try {
        let answer:Record<string,any>;
        try {answer=await g.worker.request({operation:'capture',snapshotId:obs.snapshotId});}
        catch {this.halt(g,'worker-unavailable');throw Error(WORKER_ENDED);}
        this.sync(g,answer);this.active(g);
        if(g.observation!==obs||obs.expires<=this.now())throw Error('화면이 바뀌어 다시 관찰해야 합니다.');
        if(answer.success!==true)throw Error(`화면을 읽지 못했습니다: ${typeof answer.code==='string' && /^[a-z-]{1,60}$/.test(answer.code)?answer.code:'capture-failed'}`);
        if(answer.mediaType!=='image/jpeg'||typeof answer.data!=='string'||answer.data.length>320000
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(answer.data)
          || !Number.isSafeInteger(answer.width)||!Number.isSafeInteger(answer.height)||answer.width<1||answer.height<1
          || answer.width>1280||answer.height>1280||typeof answer.windowWidth!=='number'||typeof answer.windowHeight!=='number'
          || !Number.isFinite(answer.windowWidth)||!Number.isFinite(answer.windowHeight)||answer.windowWidth<=0||answer.windowHeight<=0)
          throw Error('화면 응답을 확인하지 못했습니다.');
        obs.capture={width:answer.windowWidth,height:answer.windowHeight};
        return {success:true,observationId:obs.id,image:{mediaType:answer.mediaType,data:answer.data,width:answer.width,height:answer.height,
          windowWidth:answer.windowWidth,windowHeight:answer.windowHeight}};
      } finally {g.busy=false;this.windows.delete(key);}
    }
    const fingerprint=hash(JSON.stringify(r));
    const prior=g.receipts.get(r.requestId);
    if(prior) {
      if(prior.fingerprint!==fingerprint)throw Error('같은 요청 ID의 내용이 달라졌습니다.');
      return {success:true,receipt:{...prior.receipt}};
    }
    if(g.receipts.size>=L.receipts)throw Error('이 연결의 작업 한도입니다. 새 제어 허용이 필요합니다.');
    const obs=g.observation;
    if(!obs||obs.id!==r.observationId||obs.expires<=this.now()
      || (r.operation==='click' ? !obs.capture||r.x>=obs.capture.width||r.y>=obs.capture.height : !obs.elements.has(r.element)))
      throw Error('대상 창을 새로 관찰하고 화면을 확인하세요.');
    if(this.unresolved(g.target))throw Error(REVIEW_FIRST);
    // Durable before dispatch: a crash or restart from here on leaves an unknown row for a person to review.
    let recoveryId:string;
    try {recoveryId=this.deps.recovery.begin({bundleId:g.target.bundleId,windowId:g.target.windowId,operation:r.operation,
      requestId:r.requestId,sessionId:g.caller.sessionId,lane:g.caller.lane},this.inflight);}
    catch(e) {
      // The ledger admits one action of unknown result per app, also across hosts that share it.
      if((e as {code?:unknown})?.code==='unresolved')
        throw Error('이 앱에 결과를 아직 모르는 다른 작업이 있어 보내지 않았습니다. 진행 중이면 끝난 뒤 다시 관찰하고, 남은 기록이면 사람이 먼저 확인해야 합니다.');
      throw Error('작업 기록을 남기지 못해 보내지 않았습니다. 사람이 컴퓨터 제어 기록을 확인해야 합니다.');
    }
    this.inflight.add(recoveryId);
    const receipt:ComputerReceipt={requestId:r.requestId,state:'unknown'};
    g.receipts.set(r.requestId,{fingerprint,receipt});g.observation=undefined;g.busy=true;this.windows.add(key);
    // A mutation invalidates every other grant's view of this exact process/window.
    for(const other of this.grants.values())if(this.key(other.target)===key)other.observation=undefined;
    let retryAfterMs:number|undefined;
    try {
      let answer:Record<string,any>;
      try {
        // `requestId` is this ledger row's: AgentsToZ Control keeps its own receipt under the same ID, never a replay.
        answer=await g.worker.request({operation:r.operation,requestId:r.requestId,snapshotId:obs.snapshotId,
          ...(r.operation==='click'?{x:r.x,y:r.y}:{element:r.element}),
          ...(r.operation==='set-value'?{value:r.value}:{})});
      } catch {this.halt(g,'worker-unavailable');return {success:true,receipt:{...receipt},owner:'human'};}
      // What happened to the action itself. Only an explicit "nothing was sent" is a refusal; any other failure
      // may have reached the app.
      let delivery:ComputerActionState='unknown',reason:ComputerRefusalReason|undefined;
      if(answer.success===true) {
        const state=answer.outcome?.state;
        delivery=state==='confirmed_change'||state==='confirmed_no_change'?'confirmed':
          state==='refused'?'refused':state==='dispatched_unverified'?'dispatched-unverified':'unknown';
        if(delivery==='refused')reason='native-refused';
      } else if(answer.notDispatched===true) {
        delivery='refused';reason=refusal(answer.code);
        if(reason==='human-active'&&Number.isSafeInteger(answer.retryAfterMs))retryAfterMs=Math.min(5000,Math.max(0,answer.retryAfterMs));
      }
      // A definite answer leaves nothing to review. An unknown one stays durable, also under a human takeover.
      if(delivery!=='unknown')try {this.deps.recovery.settle(recoveryId);} catch {/* Stays unknown: a person reviews it. */}
      if(answer.humanStatePreserved===false) {receipt.state='human-takeover';this.halt(g,'human-takeover');}
      else {
        receipt.state=delivery;if(delivery==='refused'&&reason)receipt.reason=reason;
        // Unknown/partial delivery blocks further mutations. Read/receipt is never an automatic replay.
        if(delivery==='unknown')this.halt(g,'outcome-unknown');
      }
      // Last, so the specific reason above is the one the person sees when the worker also reports a stop.
      this.sync(g,answer);
      return {success:true,receipt:{...receipt},...(retryAfterMs!==undefined?{retryAfterMs}:{}),...(g.halted?{owner:'human'}:{})};
    } finally {g.busy=false;this.windows.delete(key);this.inflight.delete(recoveryId);}
  }
  dispose() {this.disposed=true;for(const g of this.grants.values())this.remove(g);}
}
