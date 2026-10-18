import React,{useEffect,useRef,useState} from 'react';
import type {TesterRequest,TesterResult,TesterTarget,TesterPersonaEvolution} from './testerAgentContract';
import './TesterPersonaEvolutionPanel.css';
import {TesterCommonPersonaPanel} from './TesterCommonPersonaPanel';
import {personaOverflowNotice} from './testerPersonaNotices';

/** Candidate metadata and deterministic checks stay separate from test verdicts. */
export function TesterPersonaEvolutionPanel({target,transport,onChanged,onPrepareAI}:{target:TesterTarget;transport:(request:TesterRequest)=>Promise<TesterResult>;onChanged:()=>void;onPrepareAI?:(prompt:string)=>void}){
  const [data,setData]=useState<TesterPersonaEvolution>(),[selected,setSelected]=useState(''),[edits,setEdits]=useState<Record<string,{goal:string;checkIds:string[]}>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');const running=useRef(false);
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const run=async(action:()=>Promise<void>)=>{if(running.current)return;running.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(e){setError(e instanceof Error?e.message:'페르소나 검토 상태를 확인하세요.');}finally{running.current=false;setBusy(false);}};
  const load=async(discover=false)=>{const result=await transport({...target,operation:discover?'persona-discover':'persona-review'});if(!result.personaEvolution)throw Error('이 호스트의 맥락별 페르소나 검토를 확인하지 못했습니다.');if(alive.current)setData(result.personaEvolution);};
  const candidate=data?.candidates.find(c=>c.id===selected),edit=candidate?(edits[candidate.id]??{goal:candidate.goal,checkIds:candidate.checkIds}):null;
  const stale=!!candidate&&candidate.contextRevision!==data?.context.revision;
  const change=(patch:Partial<NonNullable<typeof edit>>)=>{if(candidate&&edit)setEdits(old=>({...old,[candidate.id]:{...edit,...patch}}));};
  const accept=async(reject=false)=>{
    if(!candidate||!data||!edit)return;
    const result=await transport({...target,operation:reject?'persona-reject':'persona-accept',candidateId:candidate.id,revision:data.context.revision,...(!reject?{goal:edit.goal,checkIds:edit.checkIds}:{})});
    if(!result.personaAccepted)throw Error('검토 결과가 확인되지 않았습니다. 같은 내용으로 다시 확인하세요.');
    if(!alive.current)return;await load();if(!alive.current)return;onChanged();
    setNotice(reject?'후보를 제외했습니다. 기존 역할과 검사는 유지됩니다.':result.personaAccepted.catalogCurrent===false?'이 검토는 앞서 반영됐으며 이후 카탈로그가 바뀌었습니다. 현재 역할을 확인하세요.':result.personaAccepted.mode==='extended'?'같은 목표의 기존 페르소나에 검사 연결을 추가했습니다. 검사 결과는 아직 없습니다.':'페르소나를 등록했습니다. 실제 페르소나 검사를 실행해야 결과를 확인할 수 있습니다.');
  };
  return <details data-testid="tester-persona-evolution" onToggle={event=>{if(event.currentTarget.open&&!data)void run(()=>load());}}>
    <summary>개발 맥락에 맞는 페르소나 확장</summary><div style={{display:'grid',gap:10,paddingTop:10}}>
      <p>변경된 기능·검사 범위로 후보를 모으고, 현재 에이전트가 프로젝트 문맥에서 사용자·직원·운영자·감독기관 등의 역할과 시나리오를 확장합니다. 후보는 검토 자료이며 통과 결과가 아닙니다.</p>
      {data?.context.changesTruncated&&<p>이번 검토는 변경 경로 128개까지 읽었습니다. 큰 변경은 기능별로 나눠 검토하세요.</p>}
      {personaOverflowNotice(data)&&<p>{personaOverflowNotice(data)}</p>}
      <div><button type="button" disabled={busy} onClick={()=>void run(()=>load(true))}>맥락에서 후보 제안</button>{onPrepareAI&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{const r=await transport({...target,operation:'handoff',mode:'persona-context'});if(!r.handoff)throw Error('맥락 분석 초안을 확인하세요.');if(alive.current)onPrepareAI(r.handoff);})}>AI로 맥락 검토 준비</button>}</div>
      {busy&&<p role="status">페르소나 검토 준비 중…</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
      {data&&<>
        <TesterCommonPersonaPanel data={data} target={target} transport={transport} busy={busy} run={run} onRefresh={()=>load()} onChanged={onChanged}/>
        <p>기존 역할 {data.existing.length}개 · 검토 후보 {data.candidates.length}개 · 변경 파일 {data.context.changedPaths.length}개 · 실패 검사 {data.context.failedChecks.length}개</p>
        <details><summary>현재 맥락과 기존 역할</summary><ul>{data.context.memoryTitles.map((title,index)=><li key={index}>장기기억 주제 · {title}</li>)}</ul><ul>{data.existing.map(persona=><li key={persona.id}>{'role' in persona?`${persona.role} · `:''}{persona.goal}</li>)}</ul></details>
        {!data.candidates.length&&<p>아직 검토할 후보가 없습니다. 새 기능의 사용자 목표와 실제 검사를 프로젝트 검사 설정에 연결하거나 AI와 검토하세요.</p>}
        <div style={{maxHeight:240,overflow:'auto'}}>{data.candidates.map(item=><button type="button" key={item.id} aria-pressed={selected===item.id} onClick={()=>setSelected(item.id)}>{item.profile?`${item.profile.role} · `:''}{item.goal}{!item.checkIds.length?' · 검사 구현 필요':''}</button>)}</div>
        {candidate&&edit&&<fieldset disabled={busy} style={{display:'grid',gap:8}}>
          <legend>후보 검토 · 활성화 전</legend>
          <p>근거 검사: {candidate.evidence.check??'검사 구현 필요'}{candidate.evidence.failed?' · 최근 실패':''} · 관련 변경: {candidate.evidence.changedPaths.join(', ')||'검사 설정의 사용자 목표'}</p>
          {candidate.profile&&<div data-testid="tester-contextual-candidate"><strong>역할 · {candidate.profile.role}</strong><p>필요 이유 · {candidate.profile.reason}</p><p>상황 · {candidate.profile.situation}</p><ol>{candidate.profile.journey.map((step,i)=><li key={i}>{step}</li>)}</ol><p>성공 기준 · {candidate.profile.successCriteria.join(' · ')}</p></div>}
          {!edit.checkIds.length&&<p role="status">검사 구현 필요 · 역할만으로는 통과하지 않습니다. 이 시나리오를 확인할 실제 검사를 구현한 뒤 연결하세요.</p>}
          <label>페르소나의 사용자 목표<textarea aria-label="페르소나의 사용자 목표" maxLength={500} value={edit.goal} onChange={e=>change({goal:e.target.value})}/></label>
          <div>연결할 실제 검사{data.context.checks.map(check=><label key={check.id} style={{display:'block'}}><input type="checkbox" checked={edit.checkIds.includes(check.id)} onChange={e=>change({checkIds:e.target.checked?[...edit.checkIds,check.id]:edit.checkIds.filter(id=>id!==check.id)})}/>{check.id} · {check.kind==='screen'?'화면 검사':'계약 검사'}</label>)}</div>
          {edit.checkIds.length>32&&<p role="alert">한 역할에 검사를 32개까지 연결할 수 있습니다. 같은 사용자 목표에 필요한 검사를 선택하세요.</p>}
          {stale&&<p role="alert">개발 맥락이 바뀌었습니다. 후보를 다시 제안해 최신 근거를 검토하거나 더 이상 필요 없는 후보를 제외하세요. 작성한 목표는 보존됩니다.</p>}
          <div><button type="button" disabled={stale||!edit.goal.trim()||!edit.checkIds.length||edit.checkIds.length>32} onClick={()=>void run(()=>accept())}>검토한 목표·검사 연결 적용</button><button type="button" onClick={()=>void run(()=>accept(true))}>이 후보 제외</button></div>
        </fieldset>}
      </>}
    </div>
  </details>;
}
