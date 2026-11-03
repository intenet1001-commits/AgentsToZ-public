import {desktopOperativeBaselineBlocked} from './testerDesktopOperative';
import React,{useEffect,useRef,useState} from 'react';
import type {TesterClickSweepSet,TesterSets,TesterTarget} from './testerAgentContract';
import {testerSetsCache,type TesterSetsSnapshot} from './testerSetsCache';
import {testerRequest} from './testerAgentClient';
import {desktopSweepCompletionIsConsistent} from './testerClickSweepScope';
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
      {data?`일반 ${label(data.general.state,data.general.count,'개')} · 페르소나 ${label(data.personas.state,data.personas.count,'역할')}${data.personas.candidates?` · 후보 ${data.personas.candidates}`:''}${data.clickSweep?.state==='configured'?` · 전수 클릭 ${data.clickSweep.surfaces.length}대상`:''}`:snapshot.error?'테스트 구성 확인 필요':'일반 · 페르소나 구성 확인 중…'}
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
        <ClickSweepCard set={data.clickSweep} portId={portId} workspaceTargetId={workspaceTargetId}/>
      </div>
      {(data.general.problem||data.personas.problem)&&<p role="alert">{data.general.problem??data.personas.problem}</p>}
      <p className="tester-sets-policy">{data.instructionVersion>=2&&data.agents.every(a=>a.instructionsProvided)?'개발 변경 검증 시 두 세트를 사용하는 프로젝트 지침 제공됨':'에이전트 공통 지침 연결·업데이트 필요'} · {data.agents.map(a=>`${a.label} ${a.instructionsProvided?'지침 있음':'지침 필요'}`).join(' · ')}</p>
      <details data-testid="tester-sets-details"><summary>일반 검사·역할·시나리오 구성 보기</summary><TesterSetComposition data={data}/></details>
      {onOpen&&<button type="button" onClick={onOpen}>검사 실행·페르소나 관리 열기</button>}
    </>}
  </div>;
}
const sweepTime=(at:string)=>{const d=new Date(at);return Number.isNaN(d.getTime())?'':d.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});};
/** Web and desktop harnesses keep independent results. A missing web port says nothing about desktop eligibility. */
function ClickSweepCard({set,portId,workspaceTargetId}:{set?:TesterClickSweepSet;portId:string;workspaceTargetId?:string}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const running=set?.job?.state==='running';
  const onChanged=()=>testerSetsCache.refresh({portId,...(workspaceTargetId?{workspaceTargetId}:{})});
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>testerSetsCache.refresh({portId,...(workspaceTargetId?{workspaceTargetId}:{})}),4000);return ()=>clearInterval(timer);},[running,portId,workspaceTargetId]);
  if(!set)return null;
  const act=async(operation:'sweep-enable'|'sweep-baseline')=>{
    setBusy(true);setError('');
    try{await testerRequest({portId,...(workspaceTargetId?{workspaceTargetId}:{}),operation});onChanged();}catch(e){setError(e instanceof Error?e.message:'요청을 처리하지 못했습니다.');}finally{setBusy(false);}
  };
  const surfaces=set.surfaces,missing=surfaces.filter(s=>!s.baselinePresent).length,operativeBlocked=desktopOperativeBaselineBlocked(set);
  return <div data-testid="tester-click-sweep-set"><strong>전수 클릭 세트</strong>
    <b>{set.state==='none'?'구성 전':set.state==='invalid'?'설정 확인':`${surfaces.length}개 대상`}</b>
    {set.state==='none'&&<span>웹 화면과 프로젝트의 데스크톱 앱을 대상별 하네스로 구성합니다</span>}
    {set.operative&&<div data-testid="tester-desktop-operative" className="tester-sets-gap">
      <strong>실제 데스크톱 앱 검사 · {set.operative.state==='invalid'?'기록 확인 필요':set.operative.state==='unknown'?'미확정 동작 확인 필요':set.operative.state==='observed'?'수동 관찰 기록':'CUA 실행 어댑터 미연결'}</strong>
      {set.operative.bundleId&&<p>대상 앱 · {set.operative.bundleId}{set.operative.device?` · ${set.operative.device}`:''}{set.operative.appCommit?` · 소스 ${set.operative.appCommit.slice(0,8)}`:''}</p>}
      {set.operative.mode&&<p>범위 · {set.operative.mode==='isolated'?'격리 앱 데이터':'명시한 운영 범위'}</p>}
      {set.operative.inventory!==undefined&&<p>관찰 목록 {set.operative.inventory}개 · 동작 {set.operative.clicked}건 · 효과 관찰 {set.operative.effects}건</p>}
      <p>브라우저·모의 검사와 별도입니다. 현재 연결된 CUA 호스트의 실행 어댑터는 제공되지 않으며, 수동 기록도 실제 앱 자동 PASS로 바꾸지 않습니다.</p>
      <p>프로젝트 하네스 준비·기록 계약: bun scripts/desktop-operative.ts contract. 앱·소스·기기와 격리 데이터 또는 명시한 운영 범위를 먼저 정하세요.</p>
    </div>}

    {set.state==='none'&&set.enableUrl===null&&<span>웹 주소가 등록되지 않았습니다. 데스크톱 앱은 포트 없이 프로젝트 command 하네스로 구성할 수 있습니다.</span>}
    {set.state==='none'&&typeof set.enableUrl==='string'&&<button type="button" data-testid="tester-click-sweep-enable" disabled={busy} onClick={()=>void act('sweep-enable')}>{busy?'켜는 중…':`웹 켜기 · ${set.enableUrl.replace(/^https?:\/\//,'').replace(/\/$/,'')}`}</button>}
    {set.state==='configured'&&<span>기준선 파일 {surfaces.length-missing}/{surfaces.length} · 대상별 결과는 아래에 표시합니다</span>}
    {surfaces.length>0&&<ul className="tester-sweep-surfaces">{surfaces.map(surface=>{
      const target=surface.target??(surface.kind==='url'?'web':'legacy'),environment=surface.environment??(target==='web'?'browser':'unknown');
      const category=target==='web'?'웹':target==='desktop'?'데스크톱':'범위 미지정';
      const execution=environment==='native'?'native · 프로젝트 하네스 보고':environment==='fixture'?'모의 환경 · 실제 앱 미검증':environment==='browser'?'브라우저':'이전 하네스 · 실행 범위 확인 필요';
      const last=surface.last,invalid=target==='desktop'&&!!last&&!desktopSweepCompletionIsConsistent(last),state=invalid?'unverified':last?.state??(last?.passed?'passed':'failed');
      const outcome=target==='legacy'?(last?.passed?'종료코드 통과 · 대상 범위 미지정':'이전 하네스 실패 · 대상 범위 미지정')
        :state==='unverified'?'기록 확인 필요 · 미검증':state==='unavailable'?'실행 불가 · 통과 아님':state==='unconfigured'?'구성 필요':target==='desktop'&&!last?.completed?'하네스 실패 · 완료 보고 없음'
        :last?.passed?(last.updated?'기준선 갱신':environment==='fixture'?'모의 하네스 통과':target==='desktop'?'하네스 보고 통과':'웹 통과'):'실패';
      return <li key={surface.id} data-testid="tester-click-sweep-surface" data-target={target}>
        <strong>{category} · {surface.label}</strong>
        <span>실행 환경 · {execution}{surface.platform?` · ${surface.platform}`:''} · {surface.kind==='command'?'프로젝트 command':'loopback URL'}</span>
        <span>기준선 파일 {surface.baselinePresent?'있음':'필요'}</span>
        {last?<span>{outcome}{(target!=='desktop'||last.completed&&!invalid)&&` · 대상 ${last.elements}개 · 클릭 ${last.clicked}회`}{sweepTime(last.at)?` · ${sweepTime(last.at)}`:''}</span>:<span>해당 대상·환경의 실행 기록이 없습니다</span>}
      </li>;
    })}</ul>}
    {!surfaces.some(s=>s.target==='desktop')&&<span className="tester-sets-gap">데스크톱 앱 하네스 미구성 · 프로젝트의 실제 데스크톱 검사 command를 별도로 연결하세요</span>}
    <details data-testid="tester-click-sweep-desktop-guide"><summary>데스크톱 하네스 구성 안내</summary>
      <p>.agentstoz/click-sweep.json의 schemaVersion 2에 target: desktop, environment: native 또는 fixture, platform: darwin·win32·linux와 프로젝트 소유 command를 지정합니다.</p>
      <p>실제 앱의 검사 도구·권한·클릭 절차는 프로젝트 하네스가 제공합니다. 공통 테스터는 네이티브 입력 드라이버를 설치하거나 권한을 추가하지 않습니다.</p>
      <p>하네스는 현재 실행 ID와 대상·환경이 일치하는 완료 결과 및 별도 기준선을 남깁니다. 공통 러너 1.9.0 이상의 계약 읽기: python3 scripts/agentstoz-maintainer.py sweep contract --root . --json. 데스크톱 결과는 프로젝트 하네스의 범위 선언과 완료 보고입니다.</p>
      {set.scopeVersion!==2&&<p>대상별 계약을 사용하려면 테스터 공통 러너를 업데이트하세요.</p>}
    </details>
    {!!missing&&!running&&<span className="tester-sets-gap">기준선 필요 {missing}개{surfaces.some(s=>!s.baselinePresent&&s.kind==='url')?' — 웹 개발 서버를 켜 둔 채 만드세요':''}</span>}
    {operativeBlocked&&<span className="tester-sets-gap">실제 앱 실행 어댑터를 연결한 뒤 해당 기준선을 만드세요. 기존 웹 기준선은 유지합니다.</span>}
    {set.state==='configured'&&!!missing&&!operativeBlocked&&<button type="button" data-testid="tester-click-sweep-baseline" disabled={busy||running} onClick={()=>void act('sweep-baseline')}>{running?'기준선 만드는 중…':'기준선 만들기'}</button>}
    {set.job&&<span role="status" className={set.job.state==='failed'||set.job.state==='unavailable'?'tester-sets-gap':undefined}>{set.job.message}</span>}
    {set.problem&&<span className="tester-sets-gap">{set.problem}</span>}
    {error&&<span role="alert" className="tester-sets-gap">{error}</span>}
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
