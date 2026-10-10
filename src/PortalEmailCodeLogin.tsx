import React,{useId,useRef,useState} from 'react';
import './PortalEmailCodeLogin.css';
import {requestPortalEmailCode,verifyPortalEmailCode,type PortalEmailCodeClient} from './portalEmailCodeAuth';

/** Email one-time-code sign-in. Success surfaces through the Supabase auth listener, which runs the DB allowlist check. */
export function PortalEmailCodeLogin({client,disabled=false}:{client:PortalEmailCodeClient;disabled?:boolean}) {
 const [email,setEmail]=useState('');const [sentTo,setSentTo]=useState<string|null>(null);
 const [code,setCode]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const inFlight=useRef(false);const emailId=useId();const codeId=useId();
 const run=async(task:()=>Promise<void>)=>{
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');
  try{await task();}catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{inFlight.current=false;setBusy(false);}
 };
 const off=disabled||busy;
 return <section className="portal-email-login" data-testid="portal-email-login" aria-label="이메일 코드로 로그인">
  {!sentTo?<form onSubmit={e=>{e.preventDefault();void run(async()=>{setSentTo(await requestPortalEmailCode(client,email));setCode('');});}}>
   <label htmlFor={emailId}>이메일 코드로 로그인</label>
   <input id={emailId} type="email" inputMode="email" autoComplete="email" value={email} disabled={off} onChange={e=>setEmail(e.target.value)} placeholder="허용된 계정 이메일"/>
   <button type="submit" data-primary disabled={off||!email.trim()}>{busy?'보내는 중…':'코드 받기'}</button>
   <p className="portal-email-login-note">메일로 받은 코드로 로그인합니다. 한 번 로그인하면 앱을 업데이트해도 유지됩니다.</p>
  </form>:<form onSubmit={e=>{e.preventDefault();void run(()=>verifyPortalEmailCode(client,sentTo,code));}}>
   <label htmlFor={codeId}>{sentTo}로 보낸 코드</label>
   <input id={codeId} inputMode="numeric" autoComplete="one-time-code" maxLength={9} value={code} disabled={off} onChange={e=>setCode(e.target.value)} placeholder="메일의 숫자 코드"/>
   <button type="submit" data-primary disabled={off||!code.trim()}>{busy?'확인 중…':'로그인'}</button>
   <button type="button" disabled={off} onClick={()=>{setSentTo(null);setError('');}}>이메일 다시 입력</button>
   <p className="portal-email-login-note">메일이 안 오면 스팸함을 확인하세요. 코드는 1시간 동안 유효합니다.</p>
  </form>}
  {error&&<p className="portal-email-login-error" role="alert">{error}</p>}
 </section>;
}
