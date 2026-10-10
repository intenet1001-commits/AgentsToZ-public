import React,{useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import {memorySaveFailureDescription,parseMemorySaveFailure} from './memorySaveFailure';
import {memorySaveRecoveryDescription} from './memorySaveRecovery';
type RecoveryReview={version:1;targetId:string;approvalId:string;reviewDigest:string;expiresAt:number;parentSaveId:string;parentAttemptId:string;sourceCount:number;inputBytes:number;additionalCalls:1;model:string;effort:string};
type ProviderRecoveryReview=Omit<RecoveryReview,'sourceCount'|'inputBytes'>&{binaryChanged:boolean};
type Status={version:1;targetId:string;supported:boolean;revision:number;enabled:boolean;excluded:boolean;scope:'project'|'all';inScope:boolean;
 provider:null|{model:string;effort:string;configurationId:string;preparedAt:number};
 last:null|{state:string;localSaved:boolean;backupPending?:boolean;hasMore?:boolean;failure?:unknown;recovery?:unknown;historicalReceipt?:boolean};
 maintenance?:null|{expiry:string;backup:string};
 recoveryProvider?:null|{state:'claimed'|'ready'|'failed'|'unknown'|'unavailable';completedAt:number|null};
 backup?:{pending:number;blocked:number;hasMore:boolean}};
const labels:Record<string,string>={saved:'선택한 완료 대화의 로컬 정리 완료',idle:'현재 조회 범위에 정리할 완료 대화 없음',
 'waiting-idle':'새 활동이 멈춘 뒤 정리 대기',pending:'추가 완료 대화 확인 대기','source-unavailable':'일부 원본 대화를 찾지 못해 보류',oversized:'긴 대화가 입력 한도를 넘어 보류',
 'budget-paused':'자동 정리 호출 상한에 도달하여 대기','recovery-required':'이전 저장의 복구 확인 필요','provider-changed':'계정·모델 연결을 다시 확인하세요',busy:'다른 작업 완료 후 재시도',unavailable:'저장 조건 확인 필요'};
/** Mounted only in the visible Workroom, behind explicit capability negotiation. */
export function MemoryAutomaticSettings({targetId}:{targetId:string}){
 const [value,setValue]=useState<Status|null>(null),[model,setModel]=useState(''),[effort,setEffort]=useState('low');
 const [scope,setScope]=useState<'project'|'all'>('project');
 const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [statusError,setStatusError]=useState('');
 const [review,setReview]=useState<RecoveryReview|null>(null),[recoveryConsent,setRecoveryConsent]=useState(false);
 const [providerReview,setProviderReview]=useState<ProviderRecoveryReview|null>(null),[providerConsent,setProviderConsent]=useState(false);
 const generation=useRef(0),active=useRef(false),reading=useRef(false),sequence=useRef(0);
 const hydrated=useRef(false),draftEdited=useRef(false);
 const read=async(extra:Record<string,unknown>,g:number)=>{
  const ticket=++sequence.current;
  const r=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/memory',{observationTargetId:targetId,...extra});
  if(g!==generation.current||ticket!==sequence.current)return;
  if(r?.version!==1||r.targetId!==targetId||typeof r.enabled!=='boolean'||!['project','all'].includes(r.scope)||typeof r.inScope!=='boolean'||!Number.isSafeInteger(r.revision))throw new Error('자동 정리 상태를 확인하지 못했습니다.');
  if(r.recoveryProvider!=null&&(!['claimed','ready','failed','unknown','unavailable'].includes(r.recoveryProvider.state)||(r.recoveryProvider.completedAt!==null&&(!Number.isSafeInteger(r.recoveryProvider.completedAt)||r.recoveryProvider.completedAt<0))))throw new Error('복구 연결 검사 상태를 확인하지 못했습니다.');
  setValue(r);setStatusError('');
  if(extra.automaticOperation==='review-recovery-provider'){
   const v=r.providerRecoveryReview;
   if(v?.version!==1||v.targetId!==targetId||typeof v.approvalId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(v.approvalId)||typeof v.reviewDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.reviewDigest)||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=Date.now()||v.expiresAt>Date.now()+300_000||v.additionalCalls!==1||typeof v.parentSaveId!=='string'||typeof v.parentAttemptId!=='string'||typeof v.model!=='string'||!/^claude-[a-z0-9][a-z0-9.-]{1,95}$/.test(v.model)||!['low','medium'].includes(v.effort)||typeof v.binaryChanged!=='boolean')throw new Error('CLI 연결 변경 검토 결과를 확인하지 못했습니다.');
   setProviderReview(v);setProviderConsent(false);
  }else if(extra.automaticOperation!=='status'||r.last?.state!=='recovery-required'){setProviderReview(null);setProviderConsent(false);}
  if(extra.automaticOperation==='review-recovery'){
   const v=r.recoveryReview;
   if(v?.version!==1||v.targetId!==targetId||typeof v.approvalId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(v.approvalId)||typeof v.reviewDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.reviewDigest)||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=Date.now()||v.expiresAt>Date.now()+300_000||v.additionalCalls!==1||!Number.isSafeInteger(v.sourceCount)||v.sourceCount<1||v.sourceCount>8||!Number.isSafeInteger(v.inputBytes)||v.inputBytes<1||v.inputBytes>48000||typeof v.parentAttemptId!=='string'||typeof v.model!=='string'||!['low','medium'].includes(v.effort))throw new Error('복구 검토 결과를 확인하지 못했습니다.');
   setReview(v);setRecoveryConsent(false);
  }else if(extra.automaticOperation!=='status'||r.last?.state!=='recovery-required'){setReview(null);setRecoveryConsent(false);}
  const preparing=extra.automaticOperation==='prepare-provider'||extra.automaticOperation==='revalidate-provider';
  // The first successful status may be a retry. Preserve any draft the user
  // typed while offline, and never treat a recovered read as a new consent.
  if(r.provider&&(preparing||extra.automaticOperation==='status'&&!hydrated.current&&!draftEdited.current)){
   setModel(r.provider.model);setEffort(r.provider.effort);setConsent(false);
  }
  hydrated.current=true;if(preparing)draftEdited.current=false;
 };
 useEffect(()=>{
  const g=++generation.current;setValue(null);setConsent(false);setScope('project');setError('');setStatusError('');setReview(null);setRecoveryConsent(false);setProviderReview(null);setProviderConsent(false);hydrated.current=false;draftEdited.current=false;
  const refresh=()=>{if(active.current||reading.current)return;reading.current=true;void read({automaticOperation:'status'},g).catch(()=>{if(g===generation.current)setStatusError('상태 확인에 실패했습니다. 다시 확인해 주세요.');}).finally(()=>{reading.current=false;});};
  refresh();const timer=setInterval(refresh,15_000);
  return()=>{generation.current++;clearInterval(timer);};
 },[targetId]);
 async function act(operation:string,extra:Record<string,unknown>={}){
  if(operation==='execute-recovery'&&(!review||review.targetId!==targetId||!recoveryConsent||Date.now()>=review.expiresAt)){setReview(null);setRecoveryConsent(false);setError('검토가 만료되었거나 프로젝트가 바뀌었습니다. 복구 조건을 다시 검사하세요.');return;}
  if(operation==='verify-recovery-provider'&&(!providerReview||providerReview.targetId!==targetId||!providerConsent||Date.now()>=providerReview.expiresAt)){setProviderReview(null);setProviderConsent(false);setError('연결 검토가 만료되었거나 프로젝트가 바뀌었습니다. CLI 연결 변경을 다시 검토하세요.');return;}
  if(active.current)return;active.current=true;setBusy(true);setError('');setStatusError('');const g=generation.current;
  if(operation!=='status'){setReview(null);setRecoveryConsent(false);setProviderReview(null);setProviderConsent(false);}
  try{await read({automaticOperation:operation,...extra},g);if(g===generation.current)setConsent(false);}
  catch(e){if(g===generation.current){const message=e instanceof Error?e.message:'설정을 완료하지 못했습니다.';if(operation==='status')setStatusError(message);else setError(message);}}
  // The one active request belongs to this component instance across target
  // changes. Release its UI slot when it settles, even if its old result is stale.
  finally{active.current=false;setBusy(false);}
 }
 const recoveryEvidence=value?.last?.state==='recovery-required'?memorySaveRecoveryDescription(statusError?'unavailable':value.last.recovery):null;
 return <details className="ai-terminal-memory-help" data-testid="memory-automatic-settings">
  <summary>완료 대화 자동 기억 정리 V2</summary>
  <p className="ai-terminal-hint" role="status">{value?value.enabled?(!value.inScope?'V2 켜짐 · 다른 프로젝트에서 시험 중':value.excluded?'V2 켜짐 · 이 프로젝트 제외':value.scope==='project'?'이 프로젝트만 V2 자동 기억 정리 켜짐':'이 Mac의 V2 자동 기억 정리 켜짐'):'V2 자동 기억 정리 꺼짐':'상태 확인 중…'}</p>
  <p className="ai-terminal-hint">선택한 범위의 초기화된 등록 프로젝트에서 동의 후 완료된 Claude·Codex 대화를 모아 Claude로 정리합니다. 새 활동이 2분간 멈추면 처리하며, 최근 24시간 8회·프로젝트당 30분에 1회로 제한합니다. V2가 켜진 동안 수동 정리도 이 한도를 따릅니다.</p>
  <p className="ai-terminal-hint">이 프로젝트만 선택하면 다른 프로젝트의 기존 체크포인트 설정은 유지합니다. 전체 프로젝트를 선택하면 기존 50·75·90% 체크포인트 방식을 끕니다. 선택한 입력은 이 Mac에 암호화하여 최대 7일 보관합니다. 키 접근이나 파일 문제가 있으면 정리·폐기 상태 확인이 필요할 수 있습니다.</p>
  {error&&<p role="alert" className="ai-terminal-error">{error}</p>}
  {statusError&&<p role="alert" className="ai-terminal-error">{statusError}</p>}
  {value?.last&&<p className="ai-terminal-hint">최근 결과: {labels[value.last.state]??'확인 필요'}{value.last.hasMore?' · 추가 또는 보류 대화 있음':''}{value.last.backupPending?' · 백업 대기':''}</p>}
  {value?.last&&(value.last.state==='recovery-required'||value.last.state!=='saved'&&!value.last.localSaved&&parseMemorySaveFailure(value.last.failure))&&<p className="ai-terminal-hint" data-testid="memory-automatic-failure">{value.last.localSaved
   ?'선택한 대화의 로컬 저장은 완료됐지만 세션 후처리 확인이 필요합니다. 기존 저장을 다시 실행하지 않고 남은 복구 계획을 확인하세요.'
   :value.last.historicalReceipt?'이전 저장의 완료 영수증은 있지만 현재 프로젝트와 복구 계획의 연결을 확인하지 못했습니다. 현재 저장 완료로 판단하지 않고 기존 기록을 확인하세요.'
   :memorySaveFailureDescription(value.last.failure)}</p>}
  {recoveryEvidence&&<div data-testid="memory-automatic-recovery-evidence">
   <p className="ai-terminal-hint">{recoveryEvidence}</p>
   <p className="ai-terminal-hint">복구 근거의 목록만 확인합니다. 키·원본 대화·기억 내용·모델 연결은 아직 검증하지 않았으며, 이 조회로 AI를 실행하거나 저장 상태를 변경하지 않습니다.</p>
  </div>}
  {value?.enabled&&value.inScope&&!value.excluded&&value.last?.state==='recovery-required'&&value.last.recovery==='no-retained-plan'&&!value.last.localSaved&&<div data-testid="memory-automatic-recovery-action">
   <div data-testid="memory-recovery-provider-transition">
    <p className="ai-terminal-hint">CLI를 업데이트했다면 먼저 연결 변경을 검토하세요. 원래 계정·모델·설치와 같은지 확인하며, 연결 검사와 기억 정리는 각각 별도로 승인합니다.</p>
    <button className="ai-terminal-btn" disabled={busy||!!statusError} onClick={()=>void act('review-recovery-provider')}>CLI 연결 변경 검토 · AI 호출 없음</button>
    {value.recoveryProvider&&<p className="ai-terminal-hint" role="status" data-testid="memory-recovery-provider-status">{value.recoveryProvider.state==='ready'
     ?'복구용 모델 연결 검사 완료 기록이 있습니다. 아래에서 현재 연결과 복구 조건을 검사하세요. 아직 기억을 저장하거나 기존 연결 설정을 바꾸지 않았습니다.'
     :value.recoveryProvider.state==='claimed'||value.recoveryProvider.state==='unknown'
      ?'이전 연결 검사 결과가 미확정입니다. 상태 다시 확인으로 결과를 확인하세요. 새 검토에서 다시 승인하면 호출 비용이 추가될 수 있습니다.'
      :value.recoveryProvider.state==='failed'?'이전 연결 검사가 완료되지 않았습니다. 원래 기억과 연결은 보존됩니다. 다시 검사하려면 새 검토와 별도 승인이 필요합니다.'
       :'연결 검사 기록을 확인하지 못했습니다. 상태를 다시 확인하세요.'}</p>}
    {providerReview&&<div data-testid="memory-recovery-provider-review">
     <p className="ai-terminal-hint">{providerReview.binaryChanged?'CLI 실행 파일의 변경을 확인했습니다.':'같은 CLI 연결을 다시 검사합니다.'} {providerReview.model} / {providerReview.effort} · 연결 검사 AI 1회 · 검토 유효시간 5분</p>
     <p className="ai-terminal-hint">이 검사는 기억을 정리하지 않습니다. 복구용 연결 검사는 최근 24시간 8회까지이며 미확정 호출도 포함합니다. 이후 실제 기억 정리에는 별도 AI 1회 승인과 기존 정리 한도가 적용됩니다.</p>
     <label className="ai-terminal-hint block my-2"><input type="checkbox" checked={providerConsent} disabled={busy} onChange={e=>setProviderConsent(e.target.checked)}/> 원래 계정·모델로 연결 검사 AI 1회를 실행하며, 이전 검사 비용이 중복될 수 있음을 확인했습니다.</label>
     <button className="ai-terminal-btn" disabled={busy||!providerConsent||Date.now()>=providerReview.expiresAt||!!statusError} onClick={()=>void act('verify-recovery-provider',{approvalId:providerReview.approvalId,reviewDigest:providerReview.reviewDigest,explicitConsent:true})}>복구용 모델 연결 검사 · AI 1회</button>
    </div>}
   </div>
   <p className="ai-terminal-hint">이전 응답이 남아 있지 않아 저장 여부를 확정할 수 없습니다. 먼저 원래 대화·기억·키·모델과 호출 한도를 검사합니다. 검사에서는 AI를 호출하지 않습니다.</p>
   <button className="ai-terminal-btn" disabled={busy||!!statusError} onClick={()=>void act('review-recovery')}>복구 조건 검사 · AI 호출 없음</button>
   {review&&<div data-testid="memory-automatic-recovery-review">
    <p className="ai-terminal-hint">검증한 완료 대화 {review.sourceCount}개 · 입력 {review.inputBytes.toLocaleString()} bytes · {review.model} / {review.effort}</p>
    <p className="ai-terminal-hint">이전 시도 {review.parentAttemptId.slice(0,8)}의 결과는 미확정으로 보존됩니다. 같은 대화를 새 시도에서 처리하며 AI 호출 1회가 추가됩니다. 이전 호출 비용이 중복될 수 있습니다. 검토는 5분간 유효하며 기억이나 입력이 바뀌면 다시 검사해야 합니다.</p>
    <label className="ai-terminal-hint block my-2"><input type="checkbox" checked={recoveryConsent} disabled={busy} onChange={e=>setRecoveryConsent(e.target.checked)}/> 이전 시도의 미확정 결과와 추가 AI 1회 호출을 확인하고 동의합니다.</label>
    <button className="ai-terminal-btn" disabled={busy||!recoveryConsent||Date.now()>=review.expiresAt||!!statusError} onClick={()=>void act('execute-recovery',{approvalId:review.approvalId,reviewDigest:review.reviewDigest,explicitConsent:true})}>검증한 대화 다시 정리 · AI 1회</button>
   </div>}
   <p className="ai-terminal-hint">실행 후 응답을 받지 못하면 상태 다시 확인을 누르세요. 같은 승인으로 AI를 반복 실행하지 않습니다.</p>
  </div>}
  {value?.maintenance?.expiry==='needs-attention'&&<p role="alert" className="ai-terminal-error">암호화 임시 입력을 폐기하지 못했습니다. 암호화 키와 디스크 상태를 확인하세요.</p>}
  {value?.backup&&<p className="ai-terminal-hint">백업 대기 {value.backup.pending}건 · 확인 필요 {value.backup.blocked}건{value.backup.hasMore?' · 추가 이력 있음':''}</p>}
  {value?.provider&&<p className="ai-terminal-hint">등록 모델: {value.provider.model} · 추론 {value.provider.effort}</p>}
  {!value?.enabled&&<>
   <label className="ai-terminal-hint block my-2">자동 정리 범위 <select className="max-w-full rounded border border-zinc-600 bg-transparent px-2 py-1" aria-label="자동 기억 정리 범위" value={scope} disabled={busy} onChange={e=>{setScope(e.target.value as 'project'|'all');setConsent(false);}}><option value="project">이 프로젝트만 시험</option><option value="all">이 Mac의 전체 등록 프로젝트</option></select></label>
   <label className="ai-terminal-hint block my-2">정확한 Claude 모델 ID <input className="w-full min-w-0 rounded border border-zinc-600 bg-transparent px-2 py-1" aria-label="자동 기억 정리 모델 ID" value={model} onChange={e=>{draftEdited.current=true;setModel(e.target.value);setConsent(false);}} maxLength={104} placeholder="CLI에서 사용하는 전체 모델 ID" disabled={busy}/></label>
   <label className="ai-terminal-hint block my-2">추론 수준 <select className="max-w-full rounded border border-zinc-600 bg-transparent px-2 py-1" aria-label="자동 기억 정리 추론 수준" value={effort} onChange={e=>{draftEdited.current=true;setEffort(e.target.value);setConsent(false);}} disabled={busy}><option value="low">low</option><option value="medium">medium</option></select></label>
   <p className="ai-terminal-hint">먼저 위의 암호화 키를 준비하세요. 연결 검사는 입력한 모델로 짧은 AI 호출 1회를 사용합니다. 로그인 계정이나 CLI가 바뀌면 다시 검사해야 합니다.</p>
   <button className="ai-terminal-btn" disabled={busy||!/^claude-[a-z0-9][a-z0-9.-]{1,95}$/.test(model)} onClick={()=>void act('prepare-provider',{model,effort})}>모델 연결 검사 · AI 1회</button>
   <label className="ai-terminal-hint block my-2"><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/> 추가 AI 호출, 호출 상한, 기존 방식 전환과 암호화 임시 입력 보관에 동의합니다.</label>
   <button className="ai-terminal-btn" disabled={busy||!consent||!value?.provider||model!==value.provider.model||effort!==value.provider.effort} onClick={()=>void act('enable',{expectedRevision:value!.revision,configurationId:value!.provider!.configurationId,consentVersion:1,scope})}>V2 자동 기억 정리 켜기</button>
  </>}
  {value?.enabled&&<>
   {value.inScope&&value.provider&&<>
    <p className="ai-terminal-hint">CLI 업데이트 후에는 같은 계정·모델로 연결을 다시 확인하세요. AI 호출 1회를 사용하며 기존 동의 시점, 미저장 대화와 호출 상한은 유지합니다. 계정이나 모델을 바꾸지는 않습니다.</p>
    {value.last?.state==='recovery-required'&&<p className="ai-terminal-hint">{value.last.recovery==='no-retained-plan'?'미확정 저장이 남아 있을 때는 위의 CLI 연결 변경 검토 절차를 사용하세요. 기존 연결을 바로 덮어쓰지 않습니다.':'남아 있는 저장 계획의 복구를 먼저 확인하세요. 미확정 저장이 있는 동안 기존 모델 연결을 바로 바꾸지 않습니다.'}</p>}
    <button className="ai-terminal-btn" disabled={busy||value.last?.state==='recovery-required'} onClick={()=>void act('revalidate-provider',{expectedRevision:value.revision,configurationId:value.provider!.configurationId})}>같은 모델 연결 다시 확인 · AI 1회</button>
   </>}
   <button className="ai-terminal-btn" disabled={busy} onClick={()=>void act('disable',{expectedRevision:value.revision})}>V2 자동 기억 정리 끄기</button>
   {value.inScope&&<button className="ai-terminal-btn" disabled={busy} onClick={()=>void act('exclude',{expectedRevision:value.revision,excluded:!value.excluded})}>{value.excluded?'이 프로젝트 다시 포함':'이 프로젝트 자동 정리 제외'}</button>}
  </>}
  <button className="ai-terminal-btn" disabled={busy} onClick={()=>void act('status')}>{busy?'요청 처리 중…':'상태 다시 확인'}</button>
 </details>;
}
