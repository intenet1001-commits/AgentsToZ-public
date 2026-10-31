import type {DesktopEffortBinding,DesktopEffortReading,DesktopSessionEffortAdapter} from './desktopSessionEffort';
import {DesktopEffortPreDispatchRefusal} from './desktopSessionEffort';
import type {WorkroomEffortTier} from './workroomEffortPolicy';
/** A connector must obtain this witness from the native app, not from an AI-supplied body or an AX title. */
export interface NativeDesktopEffortSnapshot extends DesktopEffortReading {
  executionGeneration:number;
  view:{sessionId:string;generation:number;inputRevision:number;composerEmpty:boolean;pickerOpen:boolean;validUntil:number};
}
export interface HermesDesktopEffortPort {
  /** Read-only: effective wire policy, native view witness, and unchanged-default/session fingerprints. */
  capture():Promise<NativeDesktopEffortSnapshot>;
  /**
   * Required port contract, not an implemented or verified vendor API: one reasoning change scoped to this
   * session, fenced by the expected revision and execution generation, answering with the applied revision.
   * No AgentsToZ connector implements it. Hermes 0.17.0's gateway `config.set` key `reasoning` is not a
   * substitute: it has no compare-and-set, and a session_id it cannot match writes the global default
   * (`tui_gateway/server.py`). Neither is a CLI `/effort` command.
   * The trusted connector must check isAuthorized immediately before its actual native dispatch,
   * with no await between that check and dispatch; only a proven pre-dispatch refusal may throw
   * DesktopEffortPreDispatchRefusal. An IPC connector must independently propagate revocation to
   * the native dispatch owner and prove the same final guard there; a local callback alone is not
   * evidence of that contract. Until supported, no production connector may be registered.
   */
  mutate(params:{session_id:string;request_id:string;expected_revision:number;expected_generation:number;operation:'reasoning';payload:{effort:WorkroomEffortTier}},view:NativeDesktopEffortSnapshot['view'],isAuthorized:()=>boolean):Promise<{session_id:string;request_id:string;status:string;revision:number;execution_generation:number;effort:string}>;
}
const bindingKeys=['adapter','adapterVersion','sessionId','generation','model','provider','accountId'] as const;
const same=(a:DesktopEffortBinding,b:DesktopEffortBinding)=>bindingKeys.every(k=>a[k]===b[k]);
/**
 * Adapter for that required port plus an independently bound native-view witness. Gateway CAS alone cannot prove
 * that a person's desktop composer/picker is empty. A connector lacking either half is never exposed as Auto-capable;
 * no production connector provides either half yet, so nothing registers this adapter outside tests.
 */
export class HermesDesktopEffortAdapter implements DesktopSessionEffortAdapter {
  readonly capabilities={sessionOnly:true,compareAndSet:true,effectiveReadback:true};
  readonly binding:DesktopEffortBinding;
  private snapshot?:NativeDesktopEffortSnapshot;
  private stopped=false;
  constructor(binding:DesktopEffortBinding,private port:HermesDesktopEffortPort,private now=Date.now){
    if(binding.adapter!=='hermes-desktop'||!binding.adapterVersion||!binding.sessionId||!Number.isSafeInteger(binding.generation)||binding.generation<0||!binding.model||!binding.provider||!binding.accountId)throw Error('Hermes 세션 결속을 확인하세요.');
    this.binding=Object.freeze({...binding});
  }
  private verify(s:NativeDesktopEffortSnapshot){
    if(this.stopped||!same(s,this.binding)||!Number.isSafeInteger(s.revision)||s.revision<0||!Number.isSafeInteger(s.executionGeneration)||s.executionGeneration<0
      ||typeof s.idle!=='boolean'||typeof s.nativePickerOpen!=='boolean'
      ||!s.view||s.view.sessionId!==this.binding.sessionId||s.view.generation!==this.binding.generation||!Number.isSafeInteger(s.view.inputRevision)||s.view.inputRevision<0
      ||typeof s.view.composerEmpty!=='boolean'||typeof s.view.pickerOpen!=='boolean'||!Number.isSafeInteger(s.view.validUntil)
      ||s.view.validUntil<=this.now()||s.view.validUntil>this.now()+15000||typeof s.effort!=='string'
      ||typeof s.globalSettingsFingerprint!=='string'||!s.globalSettingsFingerprint||typeof s.otherSessionsFingerprint!=='string'||!s.otherSessionsFingerprint
      ||!Array.isArray(s.supported)||!s.supported.length||!s.supported.every(v=>typeof v==='string'))throw Error('네이티브 앱의 현재 세션·입력 상태를 확인하지 못했습니다.');
    return s;
  }
  async read(){
    const s=this.verify(await this.port.capture());this.snapshot=structuredClone(s);
    return {...s,idle:s.idle&&s.view.composerEmpty&&!s.view.pickerOpen,nativePickerOpen:s.nativePickerOpen||s.view.pickerOpen};
  }
  async set(request:{sessionId:string;generation:number;expectedRevision:number;effort:WorkroomEffortTier;requestId:string;validUntil?:number;isAuthorized?:()=>boolean}){
    const before=this.snapshot;if(!before)throw new DesktopEffortPreDispatchRefusal('현재 상태를 먼저 확인하세요.');
    let current:NativeDesktopEffortSnapshot;
    try{current=this.verify(await this.port.capture());}catch{throw new DesktopEffortPreDispatchRefusal('현재 세션 상태를 확인하지 못해 변경을 보내지 않았습니다.');}
    if(request.sessionId!==this.binding.sessionId||request.generation!==this.binding.generation||request.expectedRevision!==before.revision
      ||current.revision!==before.revision||current.executionGeneration!==before.executionGeneration||current.view.inputRevision!==before.view.inputRevision
      ||!current.idle||!current.view.composerEmpty||current.view.pickerOpen||current.nativePickerOpen||!current.supported.includes(request.effort)
      ||current.globalSettingsFingerprint!==before.globalSettingsFingerprint||current.otherSessionsFingerprint!==before.otherSessionsFingerprint
      ||request.validUntil!==undefined&&request.validUntil<=this.now()||request.isAuthorized?.()===false)throw new DesktopEffortPreDispatchRefusal('사람 입력 또는 세션 상태가 바뀌어 자동 변경을 보류했습니다.');
    // Mark before dispatch. A lost native response cannot be retried with this or a replacement ID.
    this.stopped=true;
    const result=await this.port.mutate({session_id:this.binding.sessionId,request_id:request.requestId,expected_revision:before.revision,
      expected_generation:before.executionGeneration,operation:'reasoning',payload:{effort:request.effort}},
      {...current.view,validUntil:Math.min(current.view.validUntil,request.validUntil??current.view.validUntil)},
      ()=>(request.isAuthorized?.()??true)&&(request.validUntil===undefined||request.validUntil>this.now())&&current.view.validUntil>this.now());
    if(result.session_id!==this.binding.sessionId||result.request_id!==request.requestId||!['applied','committed'].includes(result.status)
      ||result.revision<=before.revision||result.execution_generation<before.executionGeneration||result.effort!==request.effort)throw Error('Hermes의 변경 결과를 확인하지 못했습니다.');
    // The app may advance its execution generation on a policy edit; this adapter's view generation stays bound.
    const after=await this.port.capture();this.stopped=false;
    try{this.verify(after);if(after.revision!==result.revision||after.executionGeneration!==result.execution_generation||after.effort!==request.effort||after.view.inputRevision!==before.view.inputRevision
      ||after.globalSettingsFingerprint!==before.globalSettingsFingerprint||after.otherSessionsFingerprint!==before.otherSessionsFingerprint)throw Error('native-proof-mismatch');this.snapshot=structuredClone(after);}
    catch(e){this.stopped=true;throw e;}
  }
}
/**
 * What AgentsToZ itself still lacks per app, and what the person can do meanwhile. These are statements about this
 * build's connectors, not observations of an installed app, and none of them is a permanent product limit.
 */
export const DESKTOP_EFFORT_ADAPTER_STATUS=[
  {id:'hermes-desktop',label:'Hermes',available:false,reason:'대화 하나에만 비교 후 변경하고 적용값을 다시 읽는 Hermes 연결과, 입력칸·선택창 상태를 함께 확인하는 연결이 아직 없습니다. 전역 설정으로 넘어갈 수 있는 설정 변경으로 대신하지 않습니다. 필요하면 Hermes 앱의 effort 선택에서 직접 바꾸세요.'},
  {id:'codex-desktop',label:'Codex',available:false,reason:'Codex 대화 하나를 정확히 묶어 그 대화의 effort만 바꾸고 적용을 확인하는 연결이 아직 없습니다. 필요하면 Codex 앱의 effort 선택에서 직접 바꾸세요.'},
  {id:'claude-desktop',label:'Claude',available:false,reason:'Claude 대화 하나에만 적용되는 변경과 적용 확인을 갖춘 연결이 아직 없습니다. CLI의 /effort 입력이나 전역 기본값 변경으로 대신하지 않습니다. 필요하면 Claude 앱의 effort 선택에서 직접 바꾸세요.'},
  {id:'agy-desktop',label:'Antigravity',available:false,reason:'모델 선택을 유지한 채 대화 하나의 effort만 바꾸는 연결이 아직 없습니다. 필요하면 Antigravity 앱의 effort 선택에서 직접 바꾸세요.'},
] as const;
