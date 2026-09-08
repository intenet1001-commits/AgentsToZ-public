import React,{useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
type Status={version:1;targetId:string;supported:boolean;revision:number;enabled:boolean;excluded:boolean;scope:'project'|'all';inScope:boolean;
 provider:null|{model:string;effort:string;configurationId:string;preparedAt:number};
 last:null|{state:string;localSaved:boolean;backupPending?:boolean;hasMore?:boolean};
 maintenance?:null|{expiry:string;backup:string};
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
 const generation=useRef(0),active=useRef(false),reading=useRef(false),sequence=useRef(0);
 const hydrated=useRef(false),draftEdited=useRef(false);
 const read=async(extra:Record<string,unknown>,g:number)=>{
  const ticket=++sequence.current;
  const r=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/memory',{observationTargetId:targetId,...extra});
  if(g!==generation.current||ticket!==sequence.current)return;
  if(r?.version!==1||r.targetId!==targetId||typeof r.enabled!=='boolean'||!['project','all'].includes(r.scope)||typeof r.inScope!=='boolean'||!Number.isSafeInteger(r.revision))throw new Error('자동 정리 상태를 확인하지 못했습니다.');
  setValue(r);setStatusError('');
  const preparing=extra.automaticOperation==='prepare-provider';
  // The first successful status may be a retry. Preserve any draft the user
  // typed while offline, and never treat a recovered read as a new consent.
  if(r.provider&&(preparing||extra.automaticOperation==='status'&&!hydrated.current&&!draftEdited.current)){
   setModel(r.provider.model);setEffort(r.provider.effort);setConsent(false);
  }
  hydrated.current=true;if(preparing)draftEdited.current=false;
 };
 useEffect(()=>{
  const g=++generation.current;setValue(null);setConsent(false);setScope('project');setError('');setStatusError('');hydrated.current=false;draftEdited.current=false;
  const refresh=()=>{if(active.current||reading.current)return;reading.current=true;void read({automaticOperation:'status'},g).catch(()=>{if(g===generation.current)setStatusError('상태 확인에 실패했습니다. 다시 확인해 주세요.');}).finally(()=>{reading.current=false;});};
  refresh();const timer=setInterval(refresh,15_000);
  return()=>{generation.current++;clearInterval(timer);};
 },[targetId]);
 async function act(operation:string,extra:Record<string,unknown>={}){
  if(active.current)return;active.current=true;setBusy(true);setError('');setStatusError('');const g=generation.current;
  try{await read({automaticOperation:operation,...extra},g);if(g===generation.current)setConsent(false);}
  catch(e){if(g===generation.current){const message=e instanceof Error?e.message:'설정을 완료하지 못했습니다.';if(operation==='status')setStatusError(message);else setError(message);}}
  finally{active.current=false;if(g===generation.current)setBusy(false);}
 }
 return <details className="ai-terminal-memory-help" data-testid="memory-automatic-settings">
  <summary>완료 대화 자동 기억 정리 V2</summary>
  <p className="ai-terminal-hint" role="status">{value?value.enabled?(!value.inScope?'V2 켜짐 · 다른 프로젝트에서 시험 중':value.excluded?'V2 켜짐 · 이 프로젝트 제외':value.scope==='project'?'이 프로젝트만 V2 자동 기억 정리 켜짐':'이 Mac의 V2 자동 기억 정리 켜짐'):'V2 자동 기억 정리 꺼짐':'상태 확인 중…'}</p>
  <p className="ai-terminal-hint">선택한 범위의 초기화된 등록 프로젝트에서 동의 후 완료된 Claude·Codex 대화를 모아 Claude로 정리합니다. 새 활동이 2분간 멈추면 처리하며, 최근 24시간 8회·프로젝트당 30분에 1회로 제한합니다. V2가 켜진 동안 수동 정리도 이 한도를 따릅니다.</p>
  <p className="ai-terminal-hint">이 프로젝트만 선택하면 다른 프로젝트의 기존 체크포인트 설정은 유지합니다. 전체 프로젝트를 선택하면 기존 50·75·90% 체크포인트 방식을 끕니다. 선택한 입력은 이 Mac에 암호화하여 최대 7일 보관합니다. 키 접근이나 파일 문제가 있으면 정리·폐기 상태 확인이 필요할 수 있습니다.</p>
  {error&&<p role="alert" className="ai-terminal-error">{error}</p>}
  {statusError&&<p role="alert" className="ai-terminal-error">{statusError}</p>}
  {value?.last&&<p className="ai-terminal-hint">최근 결과: {labels[value.last.state]??'확인 필요'}{value.last.hasMore?' · 추가 또는 보류 대화 있음':''}{value.last.backupPending?' · 백업 대기':''}</p>}
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
   <button className="ai-terminal-btn" disabled={busy} onClick={()=>void act('disable',{expectedRevision:value.revision})}>V2 자동 기억 정리 끄기</button>
   {value.inScope&&<button className="ai-terminal-btn" disabled={busy} onClick={()=>void act('exclude',{expectedRevision:value.revision,excluded:!value.excluded})}>{value.excluded?'이 프로젝트 다시 포함':'이 프로젝트 자동 정리 제외'}</button>}
  </>}
  <button className="ai-terminal-btn" disabled={busy} onClick={()=>void act('status')}>{busy?'요청 처리 중…':'상태 다시 확인'}</button>
 </details>;
}
