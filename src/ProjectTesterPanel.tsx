import {useEffect,useRef,useState} from 'react';
import {testerRequest} from './testerAgentClient';
import {testerActive,testerRequestId,TESTER_PERSONA_PROFILE,type TesterStatus,type TesterRun,type TesterRequest,type TesterResult} from './testerAgentContract';
import {useDocumentVisible} from './useDocumentVisible';
type Agent='codex'|'claude'|'hermes'|'agy';
const button={minHeight:44,padding:'8px 12px',border:'1px solid var(--line)',borderRadius:8,background:'var(--bg-card)',color:'var(--text-primary)',cursor:'pointer',font:'inherit'};
const installationLabel:Record<string,string>={ready:'최신',absent:'미설치','needs-update':'업데이트 가능',partial:'설정·연결 필요',conflict:'직접 수정되어 검토 필요',unsupported:'AgentsToZ 앱 업데이트 필요',unavailable:'환경 확인 필요'};
const stateLabel:Record<string,string>={queued:'검사 대기',starting:'검사 준비',running:'검사 중',canceling:'취소 확인 중',passed:'선택한 검사 통과',failed:'검사 실패',blocked:'실행 조건 확인 필요',interrupted:'검사 중단','recovery-required':'이전 검사 결과 확인 필요'};
const verdictLabel:Record<string,string>={PASS:'통과',FAIL:'실패',BLOCKED:'확인 필요'};
// Older projects can expose the same persona catalog through a Python wrapper profile.
// The built-in `personas` run records per-persona verdicts, so offer that one path when both exist.
function selectableProfiles(status:TesterStatus):TesterStatus['profiles']{
  if(status.personas?.state!=='ready'||status.profiles.some(p=>p.id===TESTER_PERSONA_PROFILE))return status.profiles;
  return status.profiles.filter(p=>!(p.id==='persona'&&p.checks.length===1&&p.checks[0]==='persona-experience'));
}
/**
 * `onDraft`는 워크룸 입력칸에 **초안만** 넣는다(전송하지 않는다). 페르소나 탐색 브리프는 이 길로만 나간다 —
 * `onSend`(첫 요청으로 바로 보냄)로는 절대 보내지 않는다. 탐색은 판정이 아니고, 사람이 읽고 보내야 한다.
 */
export function ProjectTesterPanel({portId,projectName,onSend,onDraft,initialOpen=false,revealKey=0,mode='full',autoEnsure=false,transport=testerRequest}:{mode?:'full'|'upgrade'|'manage';initialOpen?:boolean;revealKey?:number;autoEnsure?:boolean;portId:string;projectName:string;onSend?:(agent:Agent,prompt:string,targetId?:string)=>Promise<unknown>;onDraft?:(prompt:string,targetId?:string)=>void;transport?:(r:TesterRequest)=>Promise<TesterResult>}){
  const [open,setOpen]=useState(initialOpen),[status,setStatus]=useState<TesterStatus|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const [plan,setPlan]=useState<TesterResult['plan']>(),[run,setRun]=useState<TesterRun|null>(null),[profile,setProfile]=useState(''),[target,setTarget]=useState('');
  const [handoff,setHandoff]=useState(''),[agent,setAgent]=useState<Agent>('codex'),[copied,setCopied]=useState(false);
  const [exploring,setExploring]=useState<string|null>(null);
  const epoch=useRef(0),actionEpoch=useRef(0),pending=useRef<TesterRequest|null>(null),ensureAttempt=useRef('');const visible=useDocumentVisible();
  const panelRef=useRef<HTMLElement>(null);
  useEffect(()=>{if(initialOpen)setOpen(true);},[initialOpen,revealKey,portId]);
  useEffect(()=>{ensureAttempt.current='';},[portId,target]);
  useEffect(()=>{if(mode!=='full'||!initialOpen||!open)return;const frame=requestAnimationFrame(()=>panelRef.current?.scrollIntoView({block:'start',behavior:'instant'}));return()=>cancelAnimationFrame(frame);},[initialOpen,revealKey,portId,open,status!==null,mode]);
  const ref={portId,...(target?{workspaceTargetId:target}:{})};
  async function action(label:string,fn:(current:()=>boolean)=>Promise<void>){const id=++actionEpoch.current;const current=()=>id===actionEpoch.current;setBusy(label);setError('');try{await fn(current);}catch(e){if(current())setError(e instanceof Error?e.message:String(e));}finally{if(current())setBusy('');}}
  async function refresh(){const generation=++epoch.current;let result=await transport({operation:'status',...ref});if(generation!==epoch.current)return;let s=result.status!;
    const ensureKey=`${portId}:${target}:${s.installation}:${s.installedVersion??''}:${s.availableVersion}`;
    if(autoEnsure&&s.environmentReady&&['absent','needs-update','partial'].includes(s.installation)&&ensureAttempt.current!==ensureKey){
      ensureAttempt.current=ensureKey;result=await transport({operation:'ensure',...ref});if(generation!==epoch.current)return;
      if(result.ensure?.outcome==='skipped'&&result.ensure.reason)setError(result.ensure.reason);
      s=result.status??(await transport({operation:'status',...ref})).status!;if(generation!==epoch.current)return;
    }
    const available=selectableProfiles(s);
    setStatus(s);setProfile(current=>available.some(p=>p.id===current)?current:available.find(p=>p.id===s.defaultProfile)?.id??available[0]?.id??'');const local=s.latest?{id:s.latest.runId,state:s.latest.state,profileId:s.latest.profile,createdAt:s.latest.startedAt,finishedAt:s.latest.finishedAt,report:s.latest,origin:'local-cli' as const}:null;setRun(s.active??(s.latestRun&&(!local||s.latestRun.id===local.id||Date.parse(s.latestRun.createdAt)>=Date.parse(local.createdAt))?s.latestRun:local));}
  useEffect(()=>{epoch.current++;actionEpoch.current++;setBusy('');setError('');pending.current=null;setStatus(null);setPlan(undefined);setRun(null);setHandoff('');setExploring(null);if(open||autoEnsure)void action(autoEnsure?'테스터 자동 준비':'상태 확인',refresh);return()=>{epoch.current++;actionEpoch.current++;};},[portId,target,open,revealKey,autoEnsure]);
  useEffect(()=>{if(mode==='upgrade'||!open||!visible||!run||!testerActive(run.state)||run.origin!=='app')return;let stopped=false;let timer:ReturnType<typeof setTimeout>;const generation=epoch.current;
    const poll=async()=>{try{const result=await transport({operation:'read',...ref,runId:run.id});if(stopped||generation!==epoch.current)return;setRun(result.run!);if(!testerActive(result.run!.state)){void refresh().catch(e=>setError(String(e)));return;}}catch(e){if(!stopped)setError(e instanceof Error?e.message:String(e));}if(!stopped)timer=setTimeout(poll,1000);};timer=setTimeout(poll,1000);return()=>{stopped=true;clearTimeout(timer);};
  },[open,visible,run?.id,run?.state,portId,target,mode]);
  const setup=()=>action('설정 확인',async current=>{const r=await transport({operation:'plan',...ref});if(current())setPlan(r.plan);});
  const apply=()=>action('테스터 준비',async current=>{await transport({operation:'apply',...ref,revision:plan!.revision});if(current()){setPlan(undefined);await refresh();}});
  const start=(profileId=profile)=>action('검사 요청',async current=>{const request=pending.current?.profileId===profileId?pending.current:{operation:'start' as const,...ref,profileId,revision:status!.configurationRevision,requestId:testerRequestId()};pending.current=request;try{const r=await transport(request);if(current()){setRun(r.run!);pending.current=null;}}catch(e:any){if(current()&&e.serverRejected)pending.current=null;throw e;}});
  const prepare=(mode:'configure'|'repair')=>action('AI 인계 준비',async current=>{const result=await transport({operation:'handoff',...ref,mode,...(run?{runId:run.id}:{})});if(current()){setHandoff(result.handoff!);setExploring(null);setCopied(false);}});
  const explore=(personaId:string)=>action('탐색 초안 준비',async current=>{const result=await transport({operation:'handoff',...ref,mode:'explore',personaId});if(current()){setHandoff(result.handoff!);setExploring(personaId);setCopied(false);}});
  const personas=status?.personas,personaRunnable=!!status&&!status.profiles.some(p=>p.id===TESTER_PERSONA_PROFILE)&&personas?.state==='ready';
  const profiles=status?selectableProfiles(status):[];
  const latestVerdict=(id:string)=>personas?.latest?.verdicts.find(v=>v.id===id)?.verdict;
  const configured=status?.profiles.find(p=>p.id===profile)?.configured;
  const active=!!run&&testerActive(run.state);
  const canSetup=!!status&&status.environmentReady&&['absent','needs-update','partial'].includes(status.installation);
  const managesVersion=mode!=='full',canRun=mode!=='upgrade';
  return <section ref={panelRef} data-testid="project-tester" style={{marginTop:8,border:'1px solid var(--line)',borderRadius:10,padding:10,fontSize:12}} onClick={e=>e.stopPropagation()}>
    <button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)} style={{...button,width:'100%',textAlign:'left'}}><strong>{managesVersion?'테스트 에이전트 버전·업그레이드':'테스터 에이전트'}</strong><span style={{marginLeft:12}}>{managesVersion?(status?installationLabel[status.installation]??'상태 확인 필요':'상태 확인'):run?stateLabel[run.state]??run.state:status?.installation==='ready'?'테스트 실행·결과':'테스트 설정·실행'} {open?'▴':'▾'}</span></button>
    {open&&<div style={{display:'grid',gap:10,paddingTop:10}}>
      <p style={{margin:0}}>{managesVersion?'이 앱에서 제공하는 공통 실행기와 AI 사용 지침을 적용합니다. 프로젝트별 검사 설정·추가 테스트·장기기억은 보존합니다.':'이 프로젝트의 테스트를 먼저 실행하고, 필요한 부분을 AI와 개선합니다.'}</p>
      {busy&&<div role="status">{busy} 중…</div>}{error&&<div role="alert" style={{color:'var(--warn)'}}>{error}</div>}
      {status&&<>
        {status.targets.length>1&&<label>검사할 작업 폴더 <select aria-label="검사할 작업 폴더" value={target} disabled={!!busy||!!run&&testerActive(run.state)} onChange={e=>{setTarget(e.target.value);pending.current=null;}} style={button}><option value="">{projectName}</option>{status.targets.filter(t=>t.id!==portId).map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label>}
        <div data-testid="tester-versions">공통 영역 {status.installedVersion?`v${status.installedVersion}`:status.installation==='absent'?'미설치':'확인 필요'} · 앱 제공 {status.availableVersion==='확인 필요'?'확인 필요':`v${status.availableVersion}`}{status.pythonVersion?` · Python ${status.pythonVersion}`:''}</div>
        <div data-testid="tester-project-revision">앱별 영역 {status.projectRevision?`r${status.projectRevision.slice(0,8)}`:'구성 전'} · 프로젝트 Git에서 별도 관리</div>
        <div data-testid="tester-installation-status">{installationLabel[status.installation]??'상태 확인 필요'}</div>
        {status.installation==='conflict'&&<p>프로젝트에서 실행기를 직접 수정했습니다. 변경 사항을 검토한 뒤 업데이트해야 합니다. 기존 파일은 덮어쓰지 않습니다.</p>}
        {status.installation==='unsupported'&&<p>이 프로젝트의 테스터를 지원하는 AgentsToZ 앱으로 업데이트한 뒤 다시 확인하세요.</p>}
        {active&&managesVersion&&<p>테스트 실행 중입니다. 실행이 끝난 뒤 상태를 다시 확인해 업그레이드하세요.</p>}
        {!status.environmentReady&&<><div role="alert">{status.problem}</div><button type="button" disabled={!!busy} onClick={()=>void prepare('configure')} style={button}>AI로 실행 환경 준비</button></>}
        {canSetup&&<button type="button" disabled={!!busy||active} onClick={()=>void setup()} style={button}>{status.installation==='absent'?'테스터 설정하기':managesVersion?'테스트 에이전트 업그레이드':'테스터 연결·업데이트'}</button>}
        {canRun&&status.installation==='ready'&&profiles.length>0&&<>
          <label>검사 범위 <select aria-label="검사 범위" value={profile} onChange={e=>{setProfile(e.target.value);pending.current=null;}} disabled={!!busy||!!run&&testerActive(run.state)} style={button}>{profiles.map(p=><option key={p.id} value={p.id}>{p.id==='quick'?'빠른 검사':p.id==='persona'?'사용자 페르소나 검사 · Python':p.id==='verify'||p.id==='full'?'전체 검사 · '+p.id:p.id}</option>)}</select></label>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            <button type="button" disabled={!!busy||!!run&&testerActive(run.state)||!profile} onClick={()=>void start(profile)} style={button}>{pending.current?'실행 결과 다시 확인':status.freshness==='source-changed'?'변경 후 테스트':'테스트 실행'}</button>
            <button type="button" disabled={!!busy} onClick={()=>void prepare(configured?'repair':'configure')} style={button}>{configured?'AI로 개선':'AI로 테스트 구성'}</button>
          </div>
          {!configured&&<div>테스트 명령이 아직 없는 항목이 있습니다. AI로 프로젝트에 맞는 검사를 구성하세요.</div>}
          <div>{status.instructionsConnected?'프로젝트 AI 지침 연결됨 · 실제 AI 호출은 별도 확인':'AI 사용 지침 연결 필요'} · {status.memoryLinked?'프로젝트 기억 참조 가능':'기억 연결 없이도 테스트 가능'}</div>
        </>}
        {canRun&&personas&&<div data-testid="tester-personas" data-state={personas.state} style={{borderTop:'1px solid var(--line)',paddingTop:10,display:'grid',gap:6}}>
          <strong>사용자 페르소나</strong>
          {personas.state==='none'&&<p data-testid="tester-personas-none" style={{margin:0}}>페르소나 카탈로그가 없습니다 — 통과도 실패도 아닙니다. 프로젝트의 <code>.agentstoz/personas.json</code>에 사용자 목표와 실제 테스트를 묶으면 여기서 검사합니다.</p>}
          {personas.state==='invalid'&&<p role="alert" style={{margin:0,color:'var(--warn)'}}>페르소나 카탈로그를 고쳐야 합니다: {personas.problem}</p>}
          {personas.state==='ready'&&<>
            <p style={{margin:0}}>판정은 결정적 테스트의 결과뿐입니다. AI 탐색은 워크룸 초안이며 통과·실패에 들어가지 않습니다.</p>
            <ul style={{margin:0,paddingLeft:16,display:'grid',gap:6}}>{(personas.personas??[]).map(p=>{const verdict=latestVerdict(p.id);return <li key={p.id} data-testid="tester-persona" data-persona={p.id}>
              <div><strong>{p.id}</strong> · {p.goal}</div>
              <div>계약 {p.contract} · 화면 {p.screen}{p.screen?'':' · 화면 근거 없음'}{verdict?` · 최근 ${verdictLabel[verdict]??verdict}`:''}{p.observations?` · 탐색 기록 ${p.observations}건(판정 아님)`:''}</div>
              <button type="button" data-testid="tester-persona-explore" disabled={!!busy} onClick={()=>void explore(p.id)} style={button}>AI 탐색 초안</button>
            </li>;})}</ul>
            {personaRunnable&&status.installation==='ready'&&<button type="button" data-testid="tester-personas-run" disabled={!!busy||!!run&&testerActive(run.state)} onClick={()=>void start(TESTER_PERSONA_PROFILE)} style={button}>페르소나 검사 실행</button>}
          </>}
        </div>}
      </>}
      {plan&&<div style={{border:'1px solid var(--line)',padding:12,borderRadius:8}}><strong>{plan.recovering?'중단된 테스터 설정 이어가기':'테스터 준비'}</strong><p>프로젝트별 테스트와 기존 사용자 지침을 보존합니다. 아래 파일을 이 프로젝트의 Git에서 관리하세요.</p><ul>{plan.files.map(file=><li key={file}>{file}</li>)}</ul><button type="button" onClick={()=>void apply()} disabled={!!busy||active||!canSetup} style={button}>설정 적용</button><button type="button" onClick={()=>setPlan(undefined)} style={button}>닫기</button></div>}
      {canRun&&run&&<div data-testid="tester-result" style={{borderTop:'1px solid var(--line)',paddingTop:10}}><strong>{stateLabel[run.state]??run.state}</strong><p>{run.profileId} · {new Date(run.createdAt).toLocaleString()} · {run.origin==='app'?'앱 실행':'로컬 보고서'}</p>{run.message&&<p>{run.message}</p>}{status?.freshness==='source-changed'&&<p>검사 이후 코드가 달라졌습니다. 현재 코드는 재검사해야 합니다.</p>}{run.report?.checks.map(c=><details key={c.id}><summary>{c.id} · {stateLabel[c.state]??c.state}{c.durationSeconds!==undefined?` · ${c.durationSeconds}초`:''}</summary><p>{c.reason} · {c.evidence||'명령 실행 결과'}</p>{c.output&&<pre style={{whiteSpace:'pre-wrap',maxHeight:200,overflow:'auto'}}>{c.output}</pre>}</details>)}<p>선택한 검사 범위의 결과입니다. 실제 계정·외부망·배포본 확인은 별도입니다.</p>{testerActive(run.state)&&run.origin==='app'&&<button type="button" disabled={!!busy} style={button} onClick={()=>void action('취소 요청',async current=>{const r=await transport({operation:'cancel',...ref,runId:run.id});if(current())setRun(r.run!);})}>검사 취소</button>}</div>}
      {handoff&&exploring&&<div data-testid="tester-explore-draft"><strong>페르소나 탐색 초안 · {exploring} · 판정 아님</strong><textarea readOnly aria-label="페르소나 탐색 초안" value={handoff} style={{width:'100%',minHeight:180,marginTop:8,background:'var(--bg-input)',color:'var(--text-primary)',border:'1px solid var(--line)',borderRadius:8,padding:8}}/><div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button type="button" style={button} onClick={()=>void action('복사',async current=>{await navigator.clipboard.writeText(handoff);if(current())setCopied(true);})}>{copied?'복사됨':'초안 복사'}</button>{onDraft&&<button type="button" data-testid="tester-explore-open-draft" disabled={!!busy} style={button} onClick={()=>onDraft(handoff,target||undefined)}>워크룸 초안으로 열기</button>}</div><p>워크룸 입력칸에 넣기만 합니다. 내용을 확인하고 직접 보내세요. 발견한 결함은 결정적 테스트로 바꿔 이 페르소나의 tests에 추가해야 판정에 들어갑니다.</p></div>}
      {handoff&&!exploring&&<div><strong>AI에게 전달할 작업</strong><textarea readOnly aria-label="테스터 AI 인계문" value={handoff} style={{width:'100%',minHeight:180,marginTop:8,background:'var(--bg-input)',color:'var(--text-primary)',border:'1px solid var(--line)',borderRadius:8,padding:8}}/><div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button type="button" style={button} onClick={()=>void action('복사',async current=>{await navigator.clipboard.writeText(handoff);if(current())setCopied(true);})}>{copied?'복사됨':'AI 인계문 복사'}</button>{onSend&&<><select aria-label="테스터 AI 선택" value={agent} onChange={e=>setAgent(e.target.value as Agent)} style={button}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="hermes">Hermes</option><option value="agy">Antigravity</option></select><button type="button" disabled={!!busy} style={button} onClick={()=>void action('워크룸 전달',async()=>{await onSend(agent,handoff,target||undefined);})}>{agent==='codex'||agent==='claude'?'워크룸으로 전달':'인계문 복사·워크룸 열기'}</button></>}</div><p>AI 작업 후 아래 버튼으로 실제 검사 결과를 다시 확인하세요.</p></div>}
      <button type="button" disabled={!!busy} onClick={()=>void action('상태 확인',refresh)} style={button}>상태 다시 확인</button>
    </div>}
  </section>;
}
