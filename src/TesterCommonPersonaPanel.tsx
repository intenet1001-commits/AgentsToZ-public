import React,{useEffect,useRef,useState} from 'react';
import type {TesterPersonaEvolution,TesterRequest,TesterResult,TesterTarget} from './testerAgentContract';

type Edit={goal:string;situation:string;journey:string;criteria:string;checkIds:string[]};
const lines=(text:string)=>text.split('\n').map(v=>v.trim()).filter(Boolean);
const validLines=(text:string)=>{const values=lines(text);return values.length>=1&&values.length<=16&&values.every(v=>v.length<=300);};

/** The shared pack offers perspectives; only reviewed project journeys activate real checks. */
export function TesterCommonPersonaPanel({data,target,transport,busy,run,onRefresh,onChanged}:{
  data:TesterPersonaEvolution;target:TesterTarget;transport:(request:TesterRequest)=>Promise<TesterResult>;busy:boolean;
  run:(action:()=>Promise<void>)=>Promise<void>;onRefresh:()=>Promise<void>;onChanged:()=>void;
}){
  const [selected,setSelected]=useState(''),[edits,setEdits]=useState<Record<string,Edit>>({}),[notice,setNotice]=useState('');
  const [uncertain,setUncertain]=useState(false);const pending=useRef<TesterRequest|null>(null);
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const pack=data.commonPersonas;if(!pack)return null;
  const template=pack.templates.find(p=>p.id===selected);
  const edit=template?(edits[selected]??{goal:'',situation:template.situation,journey:template.journey.join('\n'),criteria:template.successCriteria.join('\n'),checkIds:[]}):null;
  const change=(patch:Partial<Edit>)=>{if(edit)setEdits(old=>({...old,[selected]:{...edit,...patch}}));};
  const create=async()=>{
    if(!template||!edit)return;
    const request=pending.current??{...target,operation:'persona-create' as const,templateId:template.id,revision:data.context.revision,
      goal:edit.goal,situation:edit.situation,journey:lines(edit.journey),successCriteria:lines(edit.criteria),checkIds:edit.checkIds};
    pending.current=request;setUncertain(true);setNotice('');
    const result=await transport(request);
    if(!result.personaAccepted?.accepted)throw Error('프로젝트 페르소나 등록을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.');
    if(!alive.current)return;
    pending.current=null;setUncertain(false);
    setNotice(result.personaAccepted.catalogCurrent===false?'이 요청은 앞서 반영됐으며 이후 프로젝트 설정이 바뀌었습니다. 현재 역할을 확인하세요.':'프로젝트 페르소나를 등록했습니다. 실제 검사를 실행하면 결과를 확인할 수 있습니다.');
    await onRefresh();if(alive.current)onChanged();
  };
  return <div data-testid="tester-common-personas" style={{borderTop:'1px solid var(--line)',paddingTop:10,display:'grid',gap:8}}>
    <strong>공통 페르소나와 프로젝트별 여정</strong>
    <p>공통 관점을 선택하고 이 프로젝트의 목표·시작 상황·여정·성공 기준을 작성하세요. 공통 업데이트는 프로젝트별 내용을 보존합니다.</p>
    <p>공통 팩 {pack.installedVersion?`v${pack.installedVersion}`:'준비 전'} · 프로젝트 설정 {data.projectRevision?`r${data.projectRevision.slice(0,8)}`:'구성 전'}</p>
    {pack.state==='modified'&&<p role="status">공통 관점에 로컬 수정이 있습니다. 자동 업데이트에서 보존됩니다.</p>}
    {['absent','partial','needs-update'].includes(pack.state)&&<p>공통 테스터를 업데이트하면 기본 관점을 준비할 수 있습니다.</p>}
    <div>{pack.templates.map(item=><button type="button" key={item.id} aria-pressed={selected===item.id} disabled={busy||uncertain} onClick={()=>{setSelected(item.id);setNotice('');}}>
      <strong>{item.title}</strong><span style={{display:'block'}}>{item.perspective}</span>
    </button>)}</div>
    {template&&edit&&<fieldset disabled={busy||uncertain} style={{display:'grid',gap:8}}>
      <legend>{template.title} · 프로젝트별 확장</legend>
      <label>프로젝트 사용자 목표<textarea aria-label="프로젝트 사용자 목표" maxLength={500} value={edit.goal} onChange={e=>change({goal:e.target.value})}/></label>
      <label>시작 상황<textarea aria-label="페르소나 시작 상황" maxLength={500} value={edit.situation} onChange={e=>change({situation:e.target.value})}/></label>
      <label>사용자 여정 · 한 줄에 한 단계<textarea aria-label="페르소나 사용자 여정" value={edit.journey} maxLength={5000} onChange={e=>change({journey:e.target.value})}/></label>
      <label>성공 기준 · 한 줄에 하나<textarea aria-label="페르소나 성공 기준" value={edit.criteria} maxLength={5000} onChange={e=>change({criteria:e.target.value})}/></label>
      <div>프로젝트의 실제 검사{data.context.checks.map(check=><label key={check.id} style={{display:'block'}}><input type="checkbox" checked={edit.checkIds.includes(check.id)} onChange={e=>change({checkIds:e.target.checked?[...edit.checkIds,check.id]:edit.checkIds.filter(id=>id!==check.id)})}/>{check.id} · {check.kind==='screen'?'화면 검사':'계약 검사'}</label>)}</div>
      {!data.context.checks.length&&<p>프로젝트에 실행 가능한 검사를 먼저 구성하세요.</p>}
      {(!validLines(edit.journey)||!validLines(edit.criteria)||edit.checkIds.length>32)&&<p role="alert">여정·성공 기준은 각각 1~16개, 한 줄 300자까지이며 검사는 32개까지 연결할 수 있습니다.</p>}
      <button type="button" disabled={!edit.goal.trim()||!edit.situation.trim()||!edit.checkIds.length||edit.checkIds.length>32||!validLines(edit.journey)||!validLines(edit.criteria)} onClick={()=>void run(create)}>프로젝트 페르소나 만들기</button>
    </fieldset>}
    {uncertain&&!busy&&<div><p>등록 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하거나 현재 역할을 읽고 검토를 다시 시작하세요.</p><button type="button" onClick={()=>void run(create)}>같은 등록 요청 다시 확인</button><button type="button" onClick={()=>void run(async()=>{await onRefresh();pending.current=null;setUncertain(false);})}>현재 역할 확인·검토 다시 시작</button></div>}
    {notice&&<p role="status">{notice}</p>}
  </div>;
}
