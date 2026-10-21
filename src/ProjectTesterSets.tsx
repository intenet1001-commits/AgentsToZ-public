import React,{useEffect,useRef,useState} from 'react';
import type {TesterSets,TesterTarget} from './testerAgentContract';
import {testerSetsCache,type TesterSetsSnapshot} from './testerSetsCache';
import './ProjectTesterSets.css';

export function ProjectTesterSets({portId,workspaceTargetId,compact=false,onOpen}:{portId:string;workspaceTargetId?:string;compact?:boolean;onOpen?:()=>void}){
  const ref=useRef<HTMLDivElement>(null);const [visible,setVisible]=useState(false),[reloadKey,setReloadKey]=useState(0),[snapshot,setSnapshot]=useState<TesterSetsSnapshot>({loading:true});
  useEffect(()=>{
    const element=ref.current;if(!element)return;let intersects=false;
    const update=()=>setVisible(intersects&&document.visibilityState!=='hidden');
    const observer=new IntersectionObserver(entries=>{intersects=entries.some(e=>e.isIntersecting);update();},{rootMargin:'60px'});
    observer.observe(element);document.addEventListener('visibilitychange',update);
    return ()=>{observer.disconnect();document.removeEventListener('visibilitychange',update);};
  },[]);
  useEffect(()=>{setSnapshot({loading:true});if(!visible)return;return testerSetsCache.watch({portId,...(workspaceTargetId?{workspaceTargetId}:{})},setSnapshot);},[portId,workspaceTargetId,visible,reloadKey]);
  const target:TesterTarget={portId,...(workspaceTargetId?{workspaceTargetId}:{})};const data=snapshot.data;
  const refresh=()=>{testerSetsCache.refresh(target);setReloadKey(v=>v+1);};
  const label=(state:string,count:number,unit:string)=>state==='none'?'구성 전':state==='invalid'?'설정 확인':`${count}${unit}`;
  if(compact)return <div ref={ref} className="tester-sets-compact" data-testid="project-tester-sets-summary" onClick={e=>e.stopPropagation()}>
    <button type="button" onClick={onOpen??refresh} title="일반 테스트·프로젝트 페르소나 구성 보기">
      {data?`일반 ${label(data.general.state,data.general.count,'개')} · 페르소나 ${label(data.personas.state,data.personas.count,'역할')}${data.personas.candidates?` · 후보 ${data.personas.candidates}`:''}`:snapshot.error?'테스트 구성 확인 필요':'일반 · 페르소나 구성 확인 중…'}
    </button>
  </div>;
  return <div ref={ref} className="tester-sets" data-testid="project-tester-sets" onClick={e=>e.stopPropagation()}>
    <div className="tester-sets-heading"><strong>이 프로젝트의 테스트 세트</strong><button type="button" disabled={snapshot.loading} onClick={refresh}>구성 새로고침</button></div>
    {snapshot.error&&<p role="alert">{snapshot.error}</p>}
    {!data&&!snapshot.error&&<p role="status">일반 테스트와 페르소나 구성을 확인하고 있습니다.</p>}
    {data&&<>
      <div className="tester-sets-grid">
        <div data-testid="tester-general-set"><strong>일반 테스트 세트</strong><b>{label(data.general.state,data.general.count,'개 검사')}</b><span>공통 시나리오 {data.general.commonCount}개 · {data.general.commonVersion?`v${data.general.commonVersion}`:'연결 전'}</span><span>프로젝트 검사 {data.general.count}개 · 범위 {data.general.profiles.length}개 · 추가 시나리오 {data.general.projectScenarioCount}개</span>{!!data.general.unconfigured&&<span className="tester-sets-gap">실행 설정 필요 {data.general.unconfigured}개</span>}{!!data.general.commonModified&&<span>공통 파일 수정 {data.general.commonModified}개</span>}</div>
        <div data-testid="tester-persona-set"><strong>페르소나 세트</strong><b>{label(data.personas.state,data.personas.count,'개 역할')}</b><span>공통 관점 {data.personas.templates.length}종 · {data.personas.commonVersion?`v${data.personas.commonVersion}`:'연결 전'}</span><span>프로젝트 역할 {data.personas.count}개 · 검토 후보 {data.personas.candidates}개</span>{!!data.personas.needsChecks&&<span className="tester-sets-gap">검사 구현 필요 {data.personas.needsChecks}개</span>}{!!data.personas.commonModified&&<span>공통 관점 수정 {data.personas.commonModified}개</span>}</div>
      </div>
      {(data.general.problem||data.personas.problem)&&<p role="alert">{data.general.problem??data.personas.problem}</p>}
      <p className="tester-sets-policy">{data.instructionVersion>=2&&data.agents.every(a=>a.instructionsProvided)?'개발 변경 검증 시 두 세트를 사용하는 프로젝트 지침 제공됨':'에이전트 공통 지침 연결·업데이트 필요'} · {data.agents.map(a=>`${a.label} ${a.instructionsProvided?'지침 있음':'지침 필요'}`).join(' · ')}</p>
      <details data-testid="tester-sets-details"><summary>일반 검사·역할·시나리오 구성 보기</summary><TesterSetComposition data={data}/></details>
      {onOpen&&<button type="button" onClick={onOpen}>검사 실행·페르소나 관리 열기</button>}
    </>}
  </div>;
}
function TesterSetComposition({data}:{data:TesterSets}){
  return <div className="tester-set-composition">
    <p>공통 러너 {data.runnerVersion?`v${data.runnerVersion}`:'연결 전'} · 프로젝트 구성 r{data.revision.slice(0,8)}. 구성 정보이며 실행 결과는 별도입니다.</p>
    <strong>일반 테스트 · 공통 시나리오와 프로젝트 검사</strong>
    <p>{data.general.commonItems.map(c=>c.title).join(' · ')||'공통 시나리오 연결 전'}</p>
    {data.general.state==='none'&&<p>프로젝트의 실제 검사를 구성하면 여기에 표시됩니다.</p>}
    <div className="tester-set-scopes">{data.general.profiles.map(p=><details key={p.id}><summary>{p.id} · {p.checks.length}개</summary><p>{p.checks.join(' · ')}</p></details>)}</div>
    <ul>{data.general.checks.map(c=><li key={c.id}><strong>{c.id}</strong> · {c.configured?'실행 설정 있음':'실행 설정 필요'}{c.covers.length>0&&<p>{c.covers.join(' · ')}</p>}</li>)}</ul>
    <strong>페르소나 · 공통 관점과 프로젝트 역할</strong>
    <p>{data.personas.templates.map(t=>t.title).join(' · ')||'공통 관점 연결 전'}. 프로젝트 역할은 사용자·직원·운영자·감독기관 등 맥락에 맞게 확장합니다.</p>
    {data.personas.state==='none'&&<p>등록된 역할이 없습니다. 후보에 실제 검사를 연결해 구성하세요.</p>}
    <ul>{data.personas.items.map(p=><li key={p.id} data-testid="tester-set-role"><strong>{p.role}</strong><p>{p.goal}</p>{p.reason&&<p>필요 이유 · {p.reason}</p>}{p.situation&&<p>상황 · {p.situation}</p>}{!!p.journey.length&&<ol>{p.journey.map((step,i)=><li key={i}>{step}</li>)}</ol>}{!!p.successCriteria.length&&<p>성공 기준 · {p.successCriteria.join(' · ')}</p>}<p>연결 검사 · {p.checks.join(' · ')}{p.embeddedTests?` · 개별 검사 ${p.embeddedTests}개`:''}{p.templateId?` · 공통 관점 ${data.personas.templates.find(t=>t.id===p.templateId)?.title??p.templateId}`:''}</p></li>)}</ul>
    {data.personas.truncated&&<p>역할은 처음 64개를 표시합니다. 전체 카탈로그는 프로젝트 Git에서 관리합니다.</p>}
    {!!data.personas.candidates&&<p>검토 후보 · {data.personas.candidateRoles.join(' · ')}. 검사 연결이 없는 후보는 ‘검사 구현 필요’ 상태이며 판정이 없습니다.</p>}
  </div>;
}
