import {useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {HELPDESK_PATH} from './helpdeskKnowledge';
import type {CloudAccount,CloudOrganization,CloudView} from './onboardingCloudHost';
import type {PlatformCliAccount} from './platformCliProtocol';
import {openPreferredBrowser} from './openPreferredBrowser';
const button='helpdesk-button';
const steps=['전용 저장소 생성','데이터베이스 준비 대기','데이터 구조·보안 설정','실제 저장·조회 검사','이 Mac 연결','완료'];
const stages=['creating','waiting','schema','verifying','saving','ready'];

export function OnboardingCloudPanel({accounts,onReady,onOpenExisting}:{accounts:PlatformCliAccount[];onReady:()=>void;onOpenExisting:()=>void}){
  const eligible=accounts.filter(a=>a.provider==='supabase'&&a.state==='ready'&&a.verifiedEmail&&a.source!=='default');
  const [accountId,setAccountId]=useState(eligible.length===1?eligible[0]!.id:'');
  const [view,setView]=useState<CloudView|null>(null),[options,setOptions]=useState<{account:CloudAccount;organizations:CloudOrganization[]}|null>(null),[organizationId,setOrganizationId]=useState('');
  const [optionsRevision,setOptionsRevision]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),lock=useRef(false),notified=useRef<string|null>(null);
  const readyCallback=useRef(onReady);readyCallback.current=onReady;
  const read=async()=>{const r=await terminalLocalRequest(HELPDESK_PATH,{operation:'cloud-status'});return r.setup as CloudView;};
  useEffect(()=>{let current=true;void read().then(v=>{if(current)setView(v);}).catch(()=>{if(current)setError('이전 준비 결과를 읽지 못했습니다. 다시 확인하세요.');});return()=>{current=false;};},[]);
  useEffect(()=>{const ticket=++generation.current;setOptions(null);setOrganizationId('');setError('');if(!accountId)return;void terminalLocalRequest(HELPDESK_PATH,{operation:'cloud-options',accountId}).then(r=>{if(ticket!==generation.current)return;setOptions(r.setup);const free=r.setup.organizations.filter((o:CloudOrganization)=>o.plan==='free');if(free.length===1)setOrganizationId(free[0].id);}).catch(()=>{if(ticket===generation.current)setError('인증한 계정의 조직 목록을 확인하지 못했습니다. 계정 권한과 네트워크를 확인하세요.');});return()=>{generation.current++;};},[accountId,optionsRevision]);
  useEffect(()=>{if(!view?.job?.active)return;let current=true;const timer=setInterval(()=>{if(!document.hidden)void read().then(v=>{if(current)setView(v);}).catch(()=>{if(current)setError('준비 결과를 읽지 못했습니다. 같은 결과를 확인하세요.');});},2000);return()=>{current=false;clearInterval(timer);};},[view?.job?.active]);
  useEffect(()=>{if(!view?.connected){notified.current=null;return;}if(view.job?.stage==='ready'&&!view.job.active&&notified.current!==view.job.id){notified.current=view.job.id;readyCallback.current();}},[view?.connected,view?.job?.stage,view?.job?.active,view?.job?.id]);
  async function act(start=false){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{
      if(!view)return;
      const body=start?{operation:'cloud-start',accountId,organizationId,requestId:crypto.randomUUID(),expectedRevision:view.revision,consent:true}:view.job?{operation:'cloud-continue',requestId:view.job.id,expectedRevision:view.revision}:null;
      if(body){const r=await terminalLocalRequest(HELPDESK_PATH,body);setView(r.setup);}else setView(await read());
    }catch{setError('준비 결과를 확인하지 못했습니다. 새로 만들지 말고 같은 준비 결과부터 확인하세요.');try{setView(await read());}catch{setView(null);}}
    finally{lock.current=false;setBusy(false);}
  }
  const job=view?.job,stageIndex=job?stages.indexOf(job.stage):-1;
  return <section aria-label="아젠투지 클라우드 자동 준비" className="helpdesk-bubble">
    <strong>아젠투지 저장소 자동 준비</strong><p>프로젝트 목록·설정·장기기억을 담을 전용 데이터 구조와 보안 정책을 앱이 준비합니다. 비밀번호와 키를 복사하거나 SQL을 입력할 필요가 없습니다.</p>
    {!job&&view?.configured?<><p>이 Mac에는 저장소 설정이 있습니다. 기존 연결을 유지하고 추가 기기·연결 상태를 확인하세요.</p><button className={button} type="button" onClick={onOpenExisting}>기존 저장소 연결 확인</button></>:!job&&<>
      <label className="block text-sm">저장소를 만들 계정<select className="min-h-11 w-full bg-[var(--bg-input)] p-2" aria-label="클라우드 준비 계정" value={accountId} disabled={busy} onChange={e=>setAccountId(e.target.value)}><option value="">인증한 본인 계정 선택</option>{eligible.map(a=><option value={a.id} key={a.id}>{a.verifiedEmail}</option>)}</select></label>
      {options&&<label className="block text-sm">Supabase 무료 조직<select className="min-h-11 w-full bg-[var(--bg-input)] p-2" aria-label="Supabase 무료 조직" value={organizationId} disabled={busy} onChange={e=>setOrganizationId(e.target.value)}><option value="">무료 조직 선택</option>{options.organizations.filter(o=>o.plan==='free').map(o=><option value={o.id} key={o.id}>{o.name} · Free</option>)}</select></label>}
      {options&&!options.organizations.some(o=>o.plan==='free')&&<><p>공식 Supabase 화면에서 무료 조직 준비를 마친 뒤 돌아오세요. 유료 전환과 기존 저장소 변경은 자동으로 하지 않습니다.</p><a className={button} href="https://supabase.com/dashboard/organizations" onClick={e=>{e.preventDefault();void openPreferredBrowser(e.currentTarget.href).catch(()=>setError('공식 화면을 열지 못했습니다.'));}}>Supabase 무료 조직 준비</a></>}
      <button type="button" className={button} disabled={busy||!accountId} onClick={()=>setOptionsRevision(v=>v+1)}>인증 계정·무료 조직 다시 확인</button>
      <p>선택한 본인 계정의 무료 조직에 새 아젠투지 전용 저장소를 만듭니다. 일본 리전에 생성하며 무료 한도를 초과하면 중단하고 안내합니다.</p>
      <button type="button" className={button+' helpdesk-primary'} disabled={busy||!view||!options||!organizationId} onClick={()=>void act(true)}>이 계정에 무료 전용 저장소 만들기</button>
    </>}
    {job&&<><p>{job.account.email} · {job.organization.name} · {job.name}</p><ol aria-label="클라우드 준비 진행상황" className="space-y-2 py-3">{steps.map((step,i)=><li key={step} aria-current={i===stageIndex?'step':undefined}>{i<stageIndex||job.stage==='ready'?'✓':i===stageIndex?'●':'○'} {step}{i===stageIndex&&job.active?' · 진행 중':''}</li>)}</ol><p role="status">{job.message}</p>{!job.active&&job.stage!=='ready'&&<button type="button" className={button} disabled={busy} onClick={()=>void act()}>같은 저장소 준비 이어가기</button>}</>}
    <button type="button" className={button} disabled={busy} onClick={()=>{setError('');void read().then(setView).catch(()=>setError('같은 결과를 아직 읽지 못했습니다.'));}}>같은 준비 결과 확인</button>
    {error&&<p role="alert">{error}</p>}
  </section>;
}
