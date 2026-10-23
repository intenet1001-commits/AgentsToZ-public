import {useEffect,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {HELPDESK_PATH} from './helpdeskKnowledge';
import {PLATFORM_CLI_PATH,type PlatformCliAccount} from './platformCliProtocol';
import {googleSetupConsoleUrl} from './googleWorkspaceSetupSteps';
import {openPreferredBrowser} from './openPreferredBrowser';

interface GoogleLoginView {
  projectRef:string;accountEmail:string;googleConfigured:boolean;nativeReturnConfigured:boolean;
  callbackUrl:string;nativeReturnUrl:string;providerUrl:string;emailLimitPerHour:number|null;
  pendingAttempts:{requestId:string;at:number}[];
  reviewId?:string;changes?:string[];requiresApply?:boolean;state?:'configured'|'unconfirmed';
}
export function HelpdeskGoogleLoginSetup({accounts}:{accounts:PlatformCliAccount[]}){
  const eligible=accounts.filter(a=>a.provider==='supabase'&&a.state==='ready'&&a.verifiedEmail&&a.source!=='default');
  const [accountId,setAccountId]=useState(eligible.length===1?eligible[0]!.id:''),[view,setView]=useState<GoogleLoginView|null>(null);
  const [projectId,setProjectId]=useState(''),[busy,setBusy]=useState(false),[consent,setConsent]=useState(false),[error,setError]=useState('');
  const [fileName,setFileName]=useState('');
  const clientJson=useRef<string|undefined>(undefined),lock=useRef(false),generation=useRef(0);
  useEffect(()=>{
    let active=true;
    void terminalLocalRequest(PLATFORM_CLI_PATH,{operation:'google-client-status'}).then(r=>{if(active&&typeof r.googleClient?.projectId==='string')setProjectId(r.googleClient.projectId);}).catch(()=>{});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{
    const ticket=++generation.current;setView(null);setConsent(false);setError('');clientJson.current=undefined;setFileName('');
    if(!accountId)return;
    setBusy(true);
    void terminalLocalRequest(HELPDESK_PATH,{operation:'google-login-status',accountId}).then(r=>{if(ticket===generation.current)setView(r.googleLogin);}).catch(e=>{if(ticket===generation.current)setError(e instanceof Error?e.message:'설정을 확인하지 못했습니다.');}).finally(()=>{if(ticket===generation.current)setBusy(false);});
    return()=>{generation.current++;};
  },[accountId]);
  async function run(operation:'google-login-status'|'google-login-review'|'google-login-apply'|'google-login-check',requestId?:string){
    if(lock.current||busy||!accountId)return;lock.current=true;setBusy(true);setError('');const ticket=generation.current;
    const body=operation==='google-login-review'?{operation,accountId,...(clientJson.current===undefined?{}:{clientJson:clientJson.current})}
      :operation==='google-login-apply'?{operation,accountId,reviewId:view?.reviewId,requestId:crypto.randomUUID(),consent}
      :{operation,accountId,...(requestId?{requestId}:{})};
    try{
      const result=await terminalLocalRequest(HELPDESK_PATH,body);
      if(ticket===generation.current){setView(result.googleLogin);setConsent(false);if(operation==='google-login-review'){clientJson.current=undefined;setFileName('');}}
    }catch(e){
      if(ticket===generation.current){setError(e instanceof Error?e.message:'설정 결과를 확인하지 못했습니다.');
        // The server's durable fence survives a lost apply response or app restart.
        // Status only reads configuration; it never resends a provider mutation.
        if(operation==='google-login-apply')try{const r=await terminalLocalRequest(HELPDESK_PATH,{operation:'google-login-status',accountId});if(ticket===generation.current)setView(r.googleLogin);}catch{if(ticket===generation.current)setView(null);}
      }
    }finally{lock.current=false;if(ticket===generation.current)setBusy(false);}
  }
  async function attach(file:File|undefined){
    if(!file||busy)return;
    setConsent(false);setView(v=>v?{...v,reviewId:undefined,changes:undefined,requiresApply:undefined}:v);clientJson.current=undefined;setFileName('');
    if(file.size>8000||!file.name.toLowerCase().endsWith('.json')){setError('Google에서 받은 웹 애플리케이션 JSON 파일(8KB 이하)을 첨부하세요.');return;}
    const ticket=generation.current;
    try{const text=await file.text();if(ticket!==generation.current)return;if(new TextEncoder().encode(text).length>8000)throw Error();clientJson.current=text;setFileName(file.name);setError('');}
    catch{if(ticket===generation.current)setError('파일을 읽지 못했습니다. 다시 첨부하세요.');}
  }
  const link=(url:string,label:string)=><a className="helpdesk-button" href={url} target="_blank" rel="noreferrer" onClick={e=>{e.preventDefault();void openPreferredBrowser(url).catch(()=>setError('공식 설정 화면을 열지 못했습니다.'));}}>{label}</a>;
  const consoleUrl=googleSetupConsoleUrl('/auth/clients',projectId)??googleSetupConsoleUrl('/auth/clients','')!;
  return <section className="helpdesk-bubble space-y-3" aria-label="모바일 Google 로그인 설정">
    <h4>이 Mac의 저장소에 Google 로그인 준비</h4>
    <p>Workspace에 등록한 Google 프로젝트를 재사용할 수 있습니다. 로그인용 웹 클라이언트는 별도로 준비하며 기존 데스크톱 JSON과 계정은 그대로 둡니다.</p>
    <label className="block">Supabase 설정을 관리할 계정<select className="min-h-11 w-full" value={accountId} disabled={busy} onChange={e=>setAccountId(e.target.value)}><option value="">인증한 관리 계정 선택</option>{eligible.map(a=><option key={a.id} value={a.id}>{a.verifiedEmail}</option>)}</select></label>
    {!eligible.length&&<p>먼저 위의 「Supabase CLI 연결 돕기」에서 본인 계정을 인증하세요.</p>}
    {accountId&&!view&&<button type="button" className="helpdesk-button" disabled={busy} onClick={()=>void run('google-login-status')}>현재 등록 상태 다시 읽기</button>}
    {view&&<>
      <p>대상 Supabase: <strong>{view.projectRef}</strong> · {view.accountEmail}</p>
      <p role="status">Google 설정 {view.googleConfigured?'등록됨':'준비 필요'} · iPhone 복귀 주소 {view.nativeReturnConfigured?'등록됨':'추가 필요'}{view.emailLimitPerHour!==null?` · 현재 이메일 발송 한도 ${view.emailLimitPerHour}회/시간`:''}</p>
      {view.pendingAttempts.length>0?<><p>이전 적용 결과를 먼저 확인하세요. 설정을 다시 전송하지 않습니다.</p>{view.pendingAttempts.map(a=><button type="button" className="helpdesk-button" disabled={busy} key={a.requestId} onClick={()=>void run('google-login-check',a.requestId)}>이전 적용 결과만 확인</button>)}</>:<>
        {view.googleConfigured&&<p>기존 Google 로그인을 그대로 사용할 수 있습니다. 아래에서 변경 내용을 검토하세요{view.nativeReturnConfigured?' · iPhone 복귀 주소도 준비되어 있습니다.':' · 필요한 iPhone 복귀 주소만 추가합니다.'}</p>}
        {!view.googleConfigured&&<ol className="helpdesk-checklist">
          <li>Google Console에서 {projectId?<strong>{projectId}</strong>:'사용할 프로젝트'} 확인 → Clients → 클라이언트 만들기 → 「웹 애플리케이션」을 선택하세요. 이미 같은 로그인 클라이언트가 있다면 재사용하세요. {link(consoleUrl,'Google 웹 클라이언트 열기')}</li>
          <li>「승인된 리디렉션 URI」에 아래 주소를 그대로 추가하세요.<input className="block w-full min-h-11" aria-label="Google에 등록할 Supabase callback" readOnly value={view.callbackUrl} onFocus={e=>e.currentTarget.select()}/></li>
          <li>새 클라이언트라면 JSON을 내려받아 아래에 첨부하세요. 기존 Provider가 준비되어 있으면 첨부 없이 검토할 수 있습니다. Branding·Audience·테스트 사용자도 실제 로그인할 이메일로 확인하세요.</li>
        </ol>}
        {!view.googleConfigured&&<label className="block min-h-11 border rounded p-3" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void attach(e.dataTransfer.files[0]);}}>웹 애플리케이션 JSON · 필요할 때만 직접 첨부<input type="file" accept=".json,application/json" disabled={busy} onChange={e=>{void attach(e.target.files?.[0]);e.target.value='';}}/>{fileName&&<span>{fileName} · 검토할 준비가 됐습니다</span>}</label>}
        <button type="button" className="helpdesk-button" disabled={busy} onClick={()=>void run('google-login-review')}>이 프로젝트의 변경 내용 검토</button>
        {view.reviewId&&<section aria-label="Google 로그인 변경 검토"><h5>적용할 내용</h5>{view.changes?.length?<ul>{view.changes.map(c=><li key={c}>{c}</li>)}</ul>:<p>필요한 설정이 이미 등록되어 있습니다. iPhone에서 실제 로그인을 확인하세요.</p>}
          <p>{view.googleConfigured?'기존 Google 로그인 클라이언트를 유지합니다.':'첨부한 JSON의 Client Secret은 이 Mac에서 Supabase 설정으로 직접 전달하며 AI 상담이나 지원 기록에 넣지 않습니다.'} 이메일·회원·DB 설정을 변경하지 않습니다.</p>
          {view.requiresApply&&<><p>검토·적용 중에는 다른 기기나 Supabase 화면에서 같은 로그인 설정을 동시에 바꾸지 마세요.</p><label className="block min-h-11"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/> {view.projectRef}의 위 설정 적용에 동의합니다.</label><button type="button" className="helpdesk-button helpdesk-primary" disabled={busy||!consent} onClick={()=>void run('google-login-apply')}>검토한 Google 로그인 설정 적용</button></>}
        </section>}
      </>}
      {view.state==='configured'&&<p role="status">Supabase 설정을 다시 읽어 등록을 확인했습니다. iPhone 앱에서 「Google로 로그인」으로 복귀하고 프로젝트가 조회되는지 확인하세요. 설정 확인만으로 휴대폰 로그인 완료를 표시하지 않습니다.</p>}
      {view.state==='unconfirmed'&&<p role="status">아직 설정 결과를 확정하지 못했습니다. 공식 설정 화면을 확인하세요. 자동 재적용은 하지 않았습니다.</p>}
      <div className="helpdesk-actions">{link(view.providerUrl,'Supabase Google 설정 직접 확인')}<button type="button" className="helpdesk-button" disabled={busy} onClick={()=>void run('google-login-status')}>현재 등록 상태 다시 읽기</button></div>
    </>}
    {busy&&<p role="status">설정 확인 중…</p>}{error&&<p role="alert">{error}</p>}
  </section>;
}
