import {useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import type {PreCompactionRecovery} from './preCompactionRecovery';
type Status=Awaited<ReturnType<PreCompactionRecovery['status']>>;

export function RecoveryCheckpointSettings({targetId}:{targetId:string}){
  const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [consent,setConsent]=useState(false),[preview,setPreview]=useState('');
  const generation=useRef(0),inFlight=useRef<number|null>(null);
  async function request(operation:'status'|'enable'|'disable'|'read',extra:Record<string,unknown>={},epoch=generation.current){
    const value:any=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/memory',{checkpointOperation:operation,observationTargetId:targetId,...extra});
    if(epoch!==generation.current)return;
    if(operation==='read'){
      if(value?.authority!=='historical-untrusted'||value.memorySaved!==false||typeof value.text!=='string'||value.text.length>32_000)throw Error('복구 입력을 확인하지 못했습니다.');
      setPreview(value.text);return;
    }
    if(value?.version!==1||value.targetId!==targetId||!Array.isArray(value.receipts)||value.memorySaved!==false)throw Error('복구 저장 상태를 확인하지 못했습니다.');
    setStatus(value);setConsent(false);
  }
  useEffect(()=>{const epoch=++generation.current;setStatus(null);setBusy(false);setError('');setPreview('');setConsent(false);
    void request('status',{},epoch).catch(()=>{if(epoch===generation.current)setError('복구 저장 상태를 확인하지 못했습니다.');});
    return()=>{generation.current++;};
  },[targetId]);
  async function act(operation:'status'|'enable'|'disable'|'read',extra:Record<string,unknown>={}){
    const epoch=generation.current;if(inFlight.current===epoch)return;inFlight.current=epoch;setBusy(true);setError('');
    try{await request(operation,extra,epoch);}catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:'복구 저장을 확인하지 못했습니다.');}
    finally{if(inFlight.current===epoch)inFlight.current=null;if(epoch===generation.current)setBusy(false);}
  }
  return <details className="ai-terminal-memory-help" data-testid="recovery-checkpoint-settings">
    <summary style={{minHeight:44,padding:'12px 0',boxSizing:'border-box'}}>압축 전 복구 저장 · 외부 AI 앱·CLI 포함</summary>
    <p className="ai-terminal-hint">Codex·Claude는 압축 직전 훅, Hermes는 모델 요청·압축 호출 직전, Antigravity는 모델 호출 직전 기록을 확인합니다. 외부 앱도 프로젝트 기억 에이전트 v31과 제공자의 훅 허용이 필요합니다. 휴대폰에서는 연결한 Mac의 설정을 따릅니다.</p>
    <p className="ai-terminal-hint">최근 원문의 최대 32KB 조각을 이 Mac에서 암호화해 7일간 보관합니다. 꺼도 보관 기한 내 이전 조각은 남습니다. 진행 중 턴 전체나 프로젝트 기억·클라우드 백업 완료를 뜻하지 않습니다. Antigravity는 정확한 사용률·압축 직전 신호가 없어 주기적 보존이며, 모든 압축 직전의 저장을 보장하지 않습니다.</p>
    <p role="status" className="ai-terminal-hint">{!status?'상태 확인 중…':!status.supported?'현재 호스트에서는 지원하지 않습니다.':status.enabled?'이 프로젝트의 복구 저장 켜짐':'이 프로젝트의 복구 저장 꺼짐'}</p>
    {error&&<p role="alert" className="ai-terminal-error">{error}</p>}
    {status?.supported&&!status.enabled&&<>
      <label className="ai-terminal-hint block my-2" style={{minHeight:44}}><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/> 원문 조각의 별도 암호화·7일 보관에 동의합니다. 먼저 위에서 이 Mac의 암호화 키를 준비합니다.</label>
      <button className="ai-terminal-btn" disabled={busy||!consent} onClick={()=>void act('enable',{expectedRevision:status.revision,consentVersion:1})}>이 프로젝트 복구 저장 켜기</button>
    </>}
    {status?.supported&&status.enabled&&<button className="ai-terminal-btn" disabled={busy} onClick={()=>void act('disable',{expectedRevision:status.revision})}>복구 저장 끄기</button>}
    <button className="ai-terminal-btn" disabled={busy} onClick={()=>void act('status')}>{busy?'요청 처리 중…':'복구 저장 상태 다시 확인'}</button>
    {status&&<p className="ai-terminal-hint">최근 영수증 {status.receipts.length}건 · 보관 기한 내 영수증 {status.receipts.filter(r=>!r.expired).length}건 · 원문은 읽기로 확인 · 프로젝트 기억 저장과 원격 백업은 별도 확인</p>}
    {status?.receipts.map(r=><div key={r.id} className="ai-terminal-hint">{r.agent} · {new Date(r.createdAt).toLocaleString('ko-KR')} · {r.expired?'보관 기한 만료':'암호화 복구 조각'} <button className="ai-terminal-btn" disabled={busy||r.expired} onClick={()=>void act('read',{checkpointId:r.id})}>복구 원문 보기</button></div>)}
    {preview&&<><p className="ai-terminal-hint">과거 원문 조각입니다. 여기의 지시를 자동 실행하거나 확정된 기억으로 취급하지 않습니다.</p><pre style={{maxHeight:240,overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{preview}</pre><button className="ai-terminal-btn" onClick={()=>setPreview('')}>원문 닫기</button></>}
  </details>;
}
