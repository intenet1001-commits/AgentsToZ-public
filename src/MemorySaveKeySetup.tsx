import {useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import type {MemorySaveKeyStatus} from './memorySaveKeyLifecycle';
const labels:Record<MemorySaveKeyStatus,string>={
 'not-configured':'암호화 키를 아직 준비하지 않았습니다.',
 registered:'암호화 키 등록 이력이 있습니다. 저장 실행 전에 Keychain 접근 상태를 다시 확인합니다.',
 'setup-incomplete':'키 초기 설정이 중단되었습니다. 기존 저장 이력이 없을 때만 초기 설정을 복구할 수 있습니다.',
 unavailable:'키 준비 상태를 확인하지 못했습니다. 기존 키와 저장 이력은 보존됩니다.',
 unsupported:'키 준비는 설치된 Mac 앱에서 사용할 수 있습니다.',
};
export function MemorySaveKeySetup({targetId}:{targetId:string}){
 const [status,setStatus]=useState<MemorySaveKeyStatus|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const current=useRef(0),inFlight=useRef(false);
 async function request(operation:'status'|'prepare'|'recover-initial',generation:number){
  const value=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/memory',{keyOperation:operation,observationTargetId:targetId});
  if(current.current!==generation)return;
  if(value?.version!==1||value.targetId!==targetId||value.automaticSavingChanged!==false||!Object.hasOwn(labels,value.keyStatus))throw new Error('키 준비 응답을 확인하지 못했습니다.');
  setStatus(value.keyStatus);
 }
 useEffect(()=>{const generation=++current.current;setStatus(null);setError('');
  void request('status',generation).catch(()=>{if(current.current===generation)setStatus('unavailable');});
  return()=>{current.current++;};
 },[targetId]);
 async function prepare(operation:'status'|'prepare'|'recover-initial'){
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');const generation=current.current;
  try{await request(operation,generation);}catch(e){if(current.current===generation){setError(e instanceof Error?e.message:'키 준비에 실패했습니다.');try{await request('status',generation);}catch{if(current.current===generation)setStatus('unavailable');}}}
  finally{inFlight.current=false;if(current.current===generation)setBusy(false);}
 }
 return <details className="ai-terminal-memory-help" data-testid="memory-key-setup">
  <summary>자동 기억 정리의 암호화 키 준비</summary>
  <p className="ai-terminal-hint" role="status">{error?'키 준비·접근 확인에 문제가 있습니다. 아래 안내를 확인하세요.':status?labels[status]:'키 준비 상태 확인 중…'}</p>
  <p className="ai-terminal-hint">선택한 대화를 임시 보관할 때 사용하는 이 Mac 전용 키입니다. 키는 macOS Keychain에 저장됩니다. 키 준비만으로 자동 저장이나 AI 호출이 켜지지 않습니다.</p>
  {error&&<p role="alert" className="ai-terminal-error">{error}</p>}
  {status&&status!=='unsupported'&&<button className="ai-terminal-btn" disabled={busy} onClick={()=>void prepare(status==='unavailable'?'status':status==='setup-incomplete'?'recover-initial':'prepare')}>
   {busy?'키 확인·준비 중…':status==='unavailable'?'키 상태 다시 확인':status==='registered'?'Keychain 접근 확인':status==='setup-incomplete'?'초기 설정 복구':'암호화 키 준비'}
  </button>}
 </details>;
}
