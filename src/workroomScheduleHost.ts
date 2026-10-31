import {createHash,randomUUID} from 'node:crypto';
import {parseWorkroomScheduleRequest,scheduleId,type WorkroomSchedule,type WorkroomScheduleBinding,type WorkroomScheduleRun} from './workroomScheduleProtocol';
import {WorkroomScheduleStore} from './workroomScheduleStore';
export interface ScheduleSnapshot {binding:WorkroomScheduleBinding; inputRevision:number; outputCursor:number; ready:boolean; reason:string; canStartNew:boolean; canRestore?:boolean}
export type ScheduleWriteGate=<T>(effect:()=>T)=>T;
export interface WorkroomScheduleAdapter {
  inspect(sessionId:string):Promise<ScheduleSnapshot>;
  /** Null only means the bound terminal is absent; ambiguous or unsafe evidence must throw. */
  inspectBound?(schedule:WorkroomSchedule,sessionId:string):Promise<ScheduleSnapshot|null>;
  /** Pin this schedule's original completed-turn evidence while recording its explicit consent. */
  captureRestore?(schedule:WorkroomSchedule,snapshot:ScheduleSnapshot):Promise<{commit():void;cancel():void}>;
  /** Read-only evidence; no new terminal or input may be produced by this method. */
  inspectRestore?(schedule:WorkroomSchedule):Promise<{proof:string}|null>;
  /** Called at most once for a claimed run, never when reconciling a prior unknown outcome. */
  restore?(schedule:WorkroomSchedule,run:WorkroomScheduleRun,proof:{proof:string},active:()=>boolean,gate:ScheduleWriteGate):Promise<ScheduleSnapshot>;
  dispatch(schedule:WorkroomSchedule,run:WorkroomScheduleRun,snapshot:ScheduleSnapshot,active:()=>boolean,gate:ScheduleWriteGate):Promise<{state:'submitted'|'unknown';sessionId:string;inputRevision:number}>;
  reconcile(run:WorkroomScheduleRun):Promise<'completed'|'submitted'|'unknown'|'failed'>;
}
/** The existing host maintenance tick drives this deterministic scheduler. No prompt is sent by management reads. */
export class WorkroomScheduleHost {
  private ticking=false;
  private closed=false;
  private readonly ownerId=randomUUID();
  private observationCursor=0;
  constructor(private store:WorkroomScheduleStore,private adapter:WorkroomScheduleAdapter,private options:{enabled():boolean;now?:()=>number}){}
  private now(){return (this.options.now??Date.now)();}
  private async holdUnknown(id:string){
    const s=await this.store.get(id);if(s&&['active','finished'].includes(s.state))await this.defer(s,'결과가 불명인 실행이 있습니다. 실제 결과를 확인한 뒤 예약을 다시 켜세요.',true);
  }
  private async defer(s:WorkroomSchedule,reason:string,human=false){
    await this.store.change(s.id,s.revision,current=>{current.reason=reason.slice(0,500);current.retryAt=this.now()+60_000;if(human){current.state='needs-human';current.consentRevision++;}});
  }
  private verifySnapshot(s:WorkroomSchedule,snapshot:ScheduleSnapshot){
    const actual=snapshot.binding,expected=s.binding;
    if(!scheduleId(actual.sessionId)||actual.identity!==expected.identity||actual.targetId!==expected.targetId
      ||actual.agent!==expected.agent||actual.model!==expected.model||actual.accountId!==expected.accountId||actual.bypass!==expected.bypass)
      throw Error('프로젝트·계정·모델·대화가 변경되어 예약을 멈췄습니다.');
  }
  private async inspectBound(s:WorkroomSchedule){
    const id=s.currentSessionId??s.binding.sessionId;
    return this.adapter.inspectBound?this.adapter.inspectBound(s,id):this.adapter.inspect(id);
  }
  async manage(value:unknown){
    const raw=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
    const previous=raw?.operation==='create'&&scheduleId(raw.id)?await this.store.get(raw.id):null;
    const request=parseWorkroomScheduleRequest(value,previous?.createdAt??this.now());
    if(request.operation==='list'){
      let snapshot:ScheduleSnapshot|null=null,problem='';
      try{snapshot=await this.adapter.inspect(request.sessionId);}catch(e){problem=e instanceof Error?e.message:'워크룸 상태를 확인할 수 없습니다.';}
      const schedules=await this.store.list(request.sessionId),ids=new Set(schedules.map(s=>s.id));
      return {success:true,enabled:this.options.enabled()&&!this.closed,snapshot,problem,schedules,runs:(await this.store.runs()).filter(r=>ids.has(r.scheduleId)).slice(0,100)};
    }
    if(request.operation==='review'){
      const run=(await this.store.runs()).find(r=>r.id===request.runId);if(!run||run.state!=='unknown')throw Error('확인이 필요한 실행 기록을 다시 선택하세요.');
      await this.store.settle(run.id,'reviewed','사용자가 실제 결과를 확인했습니다. 이 실행은 다시 보내지 않습니다.',this.now());
      return {success:true};
    }
    if(request.operation==='create'){
      const intent=[request.id,request.sessionId,request.title,request.prompt,request.mode,request.nextAt,request.intervalMs,request.expiresAt,request.maxRuns];
      if(request.autoRestore)intent.push('auto-restore-consented');
      const intentHash=createHash('sha256').update(JSON.stringify(intent)).digest('hex');
      if(previous){if(previous.intentHash!==intentHash)throw Error('같은 예약 번호에 다른 작업을 저장할 수 없습니다.');return {success:true,schedule:previous};}
      if(!this.options.enabled()||this.closed)throw Error('예약 실행은 설치된 AgentsToZ 호스트에서 지원합니다.');
      const snapshot=await this.adapter.inspect(request.sessionId);
      if(!snapshot.binding.model)throw Error('현재 모델을 증명할 수 없어 예약을 켜지 않았습니다. 모델 표시가 있는 워크룸에서 다시 확인하세요.');
      if(request.mode==='new-conversation'&&!snapshot.canStartNew)throw Error('이 세션은 같은 모델·계정으로 새 대화를 시작하는 경로를 증명하지 못했습니다.');
      if(request.autoRestore&&(!snapshot.canRestore||!snapshot.ready||!this.adapter.inspectBound||!this.adapter.captureRestore||!this.adapter.inspectRestore||!this.adapter.restore))throw Error('원래 대화·계정·모델과 완료 상태를 증명하지 못해 자동 복원을 켤 수 없습니다.');
      const now=this.now();
      const schedule:WorkroomSchedule={id:request.id,title:request.title.trim(),prompt:request.prompt,mode:request.mode,binding:snapshot.binding,intentHash,
        ...(request.autoRestore?{autoRestore:true as const}:{}),state:'active',revision:1,consentRevision:1,createdAt:now,expiresAt:request.expiresAt,nextAt:request.nextAt,intervalMs:request.intervalMs,maxRuns:request.maxRuns,runCount:0,retryAt:0,reason:'사용자가 지정한 실행 시각을 기다립니다.'};
      const captured=request.autoRestore?await this.adapter.captureRestore!(schedule,snapshot):undefined;
      try{const stored=await this.store.create(schedule);if(!stored)throw Error('예약을 저장하지 못했습니다.');captured?.commit();return {success:true,schedule:stored};}
      catch(error){captured?.cancel();throw error;}
    }
    const s=await this.store.get(request.id);if(!s)throw Error('예약을 찾을 수 없습니다.');
    if(request.operation==='run-now'){
      const id='schedule_run_'+createHash('sha256').update(s.id+'\0'+request.requestId).digest('hex').slice(0,48);
      const prior=(await this.store.runs(s.id)).find(r=>r.id===id);if(prior)return {success:true,run:prior};
      if(s.revision!==request.expectedRevision)throw Error('예약이 변경되었습니다. 다시 확인하세요.');
      return {success:true,run:await this.execute(s,request.requestId)};
    }
    if(request.operation==='resume'){
      if(!this.options.enabled()||this.closed)throw Error('실행 호스트가 꺼져 있습니다.');
      const current=await this.inspectBound(s);
      if(!current)throw Error('원래 워크룸이 없습니다. 복원 상태를 먼저 확인하세요.');
      this.verifySnapshot(s,current);
      if(s.expiresAt<=this.now()||s.runCount>=s.maxRuns)throw Error('종료 시각 또는 실행 횟수 한도에 도달했습니다. 새 예약을 만드세요.');
      if((await this.store.runs()).some(r=>r.leaseKey===createHash('sha256').update(s.binding.sessionId).digest('hex')&&r.state==='unknown'))throw Error('결과가 불명인 실행을 먼저 확인하세요.');
    }
    return {success:true,schedule:await this.store.change(s.id,request.expectedRevision,current=>{
      current.state=request.operation==='pause'?'paused':request.operation==='stop'?'stopped':'active';current.consentRevision++;current.retryAt=0;
      current.reason=request.operation==='pause'?'다음 실행을 일시정지했습니다. 진행 중인 AI 작업은 취소하지 않습니다.':request.operation==='stop'?'예약을 종료했습니다. 실행 기록은 보존합니다.':'사용자가 예약 실행을 다시 허용했습니다.';
    })};
  }
  private async execute(s:WorkroomSchedule,manualId?:string){
    if(this.closed||!this.options.enabled())return null;
    if(s.state!=='active')throw Error('켜진 예약만 실행할 수 있습니다.');
    if(s.expiresAt<=this.now()){await this.store.change(s.id,s.revision,r=>{r.state='expired';r.reason='예약 실행의 종료 시각에 도달했습니다.';r.consentRevision++;});return null;}
    let snapshot:ScheduleSnapshot|null,proof:{proof:string}|null=null;
    try{snapshot=await this.inspectBound(s);}catch(e){await this.defer(s,e instanceof Error?e.message:'원래 워크룸 상태를 확인하세요.',true);return null;}
    if(snapshot){
      try{this.verifySnapshot(s,snapshot);}catch(e){await this.defer(s,e instanceof Error?e.message:'예약 대상을 확인하세요.',true);return null;}
      if(!snapshot.ready){await this.defer(s,snapshot.reason||'현재 작업·입력·승인 화면이 끝난 뒤 다시 확인합니다.');return null;}
    }else{
      if(s.mode!=='continue'||!s.autoRestore||!this.adapter.inspectRestore||!this.adapter.restore){await this.defer(s,'원래 워크룸을 안전하게 복원할 수 없어 예약을 멈췄습니다.',true);return null;}
      try{proof=await this.adapter.inspectRestore(s);}catch(e){await this.defer(s,e instanceof Error?e.message:'원래 대화 복원 증거를 확인하세요.',true);return null;}
      if(!proof||typeof proof.proof!=='string'||!proof.proof||proof.proof.length>1024){await this.defer(s,'원래 대화·계정·모델·완료 상태를 확인하지 못했습니다.',true);return null;}
    }
    const claimed=await this.store.claim(s,this.now(),manualId,this.ownerId);if(!claimed){try{await this.defer(s,'다른 예약 실행이 이 대화를 사용 중입니다. 결과 확인 뒤 다시 확인합니다.');}catch{/* Another host changed the schedule. */}return null;}if(!claimed.claimed)return claimed.run;
    const run=claimed.run,active=()=>!this.closed&&this.options.enabled()&&this.store.authorized(run,this.now()),gate:ScheduleWriteGate=effect=>{
      if(this.closed||!this.options.enabled())throw Error('예약 실행 호스트가 종료되었습니다.');
      return this.store.withAuthorized(run,this.now(),effect);
    };
    try{
      if(!snapshot){
        if(!proof||!this.adapter.restore||!active())throw Error('예약 실행 권한이 종료되었습니다.');
        snapshot=await this.adapter.restore(s,run,proof,active,gate);
        this.verifySnapshot(s,snapshot);
        if(!snapshot.ready||!active())throw Error('복원한 대화가 입력 대기 상태인지 확인하지 못했습니다.');
        if(!await this.store.bindRestored(run,snapshot.binding.sessionId,this.now())||!active())throw Error('복원한 대화를 예약 실행에 연결하지 못했습니다.');
      }
      const result=await this.adapter.dispatch(s,run,snapshot,active,gate);
      const settled=await this.store.settle(run.id,result.state,result.state==='submitted'?'요청 전송을 확인했습니다. 실제 AI 결과를 기다립니다.':'전송 결과를 확인해야 합니다. 자동으로 다시 보내지 않습니다.',this.now(),result.sessionId,result.inputRevision,this.ownerId);
      if(result.state==='unknown')await this.holdUnknown(s.id);return settled;
    }catch{
      const settled=await this.store.settle(run.id,'unknown','실행 또는 전송 결과를 확인해야 합니다. 같은 작업은 자동으로 다시 보내지 않습니다.',this.now(),undefined,undefined,this.ownerId);await this.holdUnknown(s.id);return settled;
    }
  }
  async tick(){
    if(this.ticking||this.closed||!this.options.enabled())return;this.ticking=true;
    try{
      // Only the host that owns a live observation lease may inspect a submitted PTY.
      // A foreign or legacy run is left alone until the lease/grace expires, then atomically becomes unknown.
      await this.store.renewOwned(this.ownerId,this.now());
      const pending=(await this.store.runs()).filter(r=>r.state==='dispatching'||r.state==='submitted');
      const start=pending.length?this.observationCursor%pending.length:0,count=Math.min(8,pending.length);
      const batch=Array.from({length:count},(_,index)=>pending[(start+index)%pending.length]!);
      this.observationCursor=pending.length?(start+count)%pending.length:0;
      for(const run of batch){
        try{const owner=await this.store.observationOwner(run.id,this.ownerId,this.now());if(owner?.kind==='orphaned'){await this.holdUnknown(run.scheduleId);continue;}
          if(owner?.kind!=='owned'||run.state!=='submitted')continue;
          const state=await this.adapter.reconcile(run);if(state!==run.state){const settled=await this.store.settle(run.id,state,state==='completed'?'이 실행의 실제 AI 응답 완료를 확인했습니다.':state==='failed'?'실행이 종료됐습니다. 작업 결과를 확인하세요.':'원래 전송의 결과를 확인해야 합니다. 자동 재실행하지 않습니다.',this.now(),undefined,undefined,this.ownerId);if(settled?.state==='unknown')await this.holdUnknown(run.scheduleId);}}catch{/* The original receipt remains; no new execution is admitted. */}
      }
      const s=(await this.store.list()).find(s=>s.state==='active'&&s.nextAt<=this.now()&&s.retryAt<=this.now());
      if(s)try{await this.execute(s);}catch(e){try{await this.defer(s,e instanceof Error?e.message:'예약 실행 상태를 확인하세요.',true);}catch{/* Another host won the revision. */}}
    }finally{this.ticking=false;}
  }
  dispose(){this.closed=true;this.store.dispose();}
}
