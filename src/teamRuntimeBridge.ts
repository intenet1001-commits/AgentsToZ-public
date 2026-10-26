import type {AiTerminalAgent} from './aiTerminalProtocol';
import type {TeamExternalRuntime as CoreRuntime,TeamExecutionRef,TeamDelivery,TeamExternalStarted,TeamExternalObserved,TeamExternalSurface} from './teamLaunchPlan';
import type {TeamExternalJournal,TeamExternalReceipt,TeamExternalRuntime,TeamExternalScope} from './teamExternalRuntime';

const RUNTIME='agentstoz-team-external-v1';
type CoreRef=Extract<TeamExecutionRef,{kind:'external'}>;
export interface TeamRuntimeBinding {targetId:string;cwd:string;agent:AiTerminalAgent;surface:TeamExternalSurface;generation:number;active:boolean}
export interface TeamRuntimeBridgeOptions {
  journal:TeamExternalJournal;runtime:TeamExternalRuntime;hostInstanceId:string;
  binding(teamId:string,memberId:string):TeamRuntimeBinding|null;
}
const delivery=(receipt:TeamExternalReceipt):TeamDelivery=>receipt.instruction.status==='written'?'verified'
  :receipt.instruction.status==='unknown'||receipt.instruction.status==='sending'?'unknown':'not-sent';
const coreState=(receipt:TeamExternalReceipt):TeamExternalStarted['state']=>
  ['working','awaiting-connection','awaiting-manual-join','awaiting-ack'].includes(receipt.state)?receipt.state as TeamExternalStarted['state']:'unknown';
const projection=(receipt:TeamExternalReceipt):CoreRef=>({kind:'external',surface:receipt.executionRef.surface,runtime:RUNTIME,
  // This is a durable journal key. Native handles and host/private identity never leave the runtime journal.
  handle:receipt.executionRef.executionId,owned:receipt.executionRef.native?.owned===true,
  evidence:{send:receipt.capabilities.submit,read:receipt.capabilities.read}});

/** The same core adapter is used by local team UI actions and every MCP team tool. It never guesses native handles. */
export function createTeamRuntimeBridge(options:TeamRuntimeBridgeOptions):CoreRuntime&{
  isCurrent(scope:TeamExternalScope):boolean;
  read(ref:CoreRef,input:{cursor?:string;limit?:number}):Promise<{text:string;cursor?:string;agentVerified:boolean|null;outcome:'read'|'unavailable'|'unconfirmed';reason:string|null}>;
  reveal(ref:CoreRef,operationId:string):Promise<{outcome:'requested'|'refused'|'unconfirmed'}>;
} {
  function isCurrent(scope:TeamExternalScope):boolean {
    const b=options.binding(scope.teamId,scope.memberId);
    return !!b&&b.active&&scope.hostInstanceId===options.hostInstanceId&&scope.targetId===b.targetId&&scope.cwd===b.cwd
      &&scope.agent===b.agent&&scope.surface===b.surface&&scope.generation===b.generation;
  }
  async function receipt(ref:CoreRef):Promise<TeamExternalReceipt> {
    if(ref.runtime!==RUNTIME)throw Error('팀 실행 연결을 확인하지 못했습니다.');
    const record=await options.journal.read(ref.handle);
    if(!record||record.receipt.executionRef.surface!==ref.surface||projection(record.receipt).owned!==ref.owned)throw Error('팀 실행 기록이 일치하지 않습니다.');
    return record.receipt;
  }
  return {
    isCurrent,
    async start(input) {
      const b=options.binding(input.teamId,input.memberId);
      if(!b||!b.active||!input.targetId||b.targetId!==input.targetId||b.cwd!==input.cwd||b.agent!==input.agent||b.surface!==input.plan.surface)throw Error('팀원 실행 대상이 바뀌어 시작하지 않았습니다.');
      const result=await options.runtime.launch({executionId:`${input.teamId}:${input.memberId}`,hostInstanceId:options.hostInstanceId,
        teamId:input.teamId,memberId:input.memberId,targetId:b.targetId,cwd:b.cwd,generation:b.generation,agent:b.agent,surface:b.surface,
        operationId:input.requestId,title:input.memberName,prompt:input.prompt,
        requested:{...(input.model?{model:input.model}:{}),...(input.provider?{provider:input.provider}:{}),...(input.accountId?{accountId:input.accountId}:{}),
          ...(input.bypassPermissions!==undefined?{bypassPermissions:input.bypassPermissions}:{}),...('pinned' in input.effort?{effort:input.effort.pinned as 'low'|'medium'|'high'}:{}),
          ...(input.plan.options?{launchOptions:input.plan.options}:{})}});
      const scope=result.executionRef;
      if(scope.executionId!==`${input.teamId}:${input.memberId}`||scope.teamId!==input.teamId||scope.memberId!==input.memberId
        ||scope.targetId!==b.targetId||scope.cwd!==b.cwd||scope.agent!==b.agent||scope.surface!==b.surface||scope.generation!==b.generation||scope.hostInstanceId!==options.hostInstanceId)throw Error('팀원 실행 영수증의 대상이 일치하지 않습니다. 작업 폴더를 보존했습니다.');
      return {ref:projection(result),state:coreState(result),delivery:delivery(result)};
    },
    async observe(ref):Promise<TeamExternalObserved> {
      const saved=await receipt(ref),result=await options.runtime.probe(saved.executionRef);
      const state=result.state==='closed'?'exited':result.state==='exited'?'exited':coreState(result);
      return {state,delivery:delivery(result)};
    },
    async send(ref,text,requestId) {
      const saved=await receipt(ref),result=await options.runtime.submit(saved.executionRef,{operationId:requestId,text});
      // A refused new instruction may return the earlier receipt. That earlier success is never this request's success.
      return result.instruction.operationId===requestId?{delivery:delivery(result)}:{delivery:'not-sent',note:'이 지시는 새로 보내지 않았습니다. 이전 전달 기록과 현재 실행 상태를 확인하세요.'};
    },
    async close(ref) {
      const saved=await receipt(ref),result=await options.runtime.closeOwned(saved.executionRef,`close:${ref.handle}`);
      return {closed:result.state==='closed'&&!result.retainWorktree?'closed':'unknown'};
    },
    async read(ref,input) {const saved=await receipt(ref),result=await options.runtime.read(saved.executionRef,input);return {text:result.text,...(result.cursor!==undefined?{cursor:result.cursor}:{}),agentVerified:result.receipt.agentVerified,outcome:result.outcome,reason:result.receipt.reason};},
    async reveal(ref,operationId) {
      const saved=await receipt(ref);
      if(!saved.capabilities.reveal||!isCurrent(saved.executionRef))return {outcome:'refused'};
      const result=await options.runtime.reveal(saved.executionRef,operationId),record=await options.journal.read(ref.handle);
      const operation=record?.operations.find(item=>item.id===operationId&&item.kind==='reveal');
      return {outcome:!operation?'refused':operation.status==='settled'&&operation.outcome==='performed'&&isCurrent(result.executionRef)?'requested':'unconfirmed'};
    },
  };
}
