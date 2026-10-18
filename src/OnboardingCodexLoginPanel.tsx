import React,{useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {CODEX_LOGIN_LABELS,parseCodexLoginReceipt,type CodexLoginReceipt} from './onboardingCodexLogin';
type Transport=(body:Record<string,unknown>)=>Promise<{status:number;body:any}>;
const native:Transport=body=>invoke('onboarding_management_request',{body,tool:'codex-login'});
const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
export default function OnboardingCodexLoginPanel({transport=native,onContinue}:{transport?:Transport;onContinue?:()=>void}){
 const [receipt,setReceipt]=useState<CodexLoginReceipt|null>(null),[loaded,setLoaded]=useState(false),[supported,setSupported]=useState(false);
 const [interrupted,setInterrupted]=useState(false),[browserReady,setBrowserReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(false),epoch=useRef(0),lock=useRef(false),revision=useRef('0');
 async function run(operation:string){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');const generation=epoch.current;
  try{
   const response=await transport({operation,...(operation==='status'?{}:{expectedRevision:revision.current})});
   if(response.status!==200||response.body.success!==true)throw new Error('request');
   const value=response.body.receipt===null?null:parseCodexLoginReceipt(response.body.receipt);
   if(alive.current&&generation===epoch.current){revision.current=value?.revision??'0';setReceipt(value);setInterrupted(response.body.interrupted===true);setSupported(response.body.supported===true);setBrowserReady(response.body.browserReady===true);setLoaded(true);}
  }catch{if(alive.current&&generation===epoch.current)setError('로그인 상태를 확인하지 못했습니다. 상태를 다시 읽고 이어가세요. 기존 로그인 정보는 유지됩니다.');}
  finally{if(generation===epoch.current){lock.current=false;if(alive.current)setBusy(false);}}
 }
 useEffect(()=>{alive.current=true;void run('status');return()=>{alive.current=false;epoch.current++;lock.current=false;};},[]);
 const active=receipt?.state==='authenticating'&&!interrupted;
 useEffect(()=>{if(!active||error)return;const timer=setInterval(()=>{if(document.visibilityState==='visible')void run('status');},2000);return()=>clearInterval(timer);},[active,error]);
 return <section aria-label="Codex 로그인" className="mt-4 rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] p-4">
  <h4 className="font-semibold">ChatGPT 계정 연결</h4>
  <p className="mt-2 text-sm" aria-live="polite">{interrupted?'이전 로그인이 중단되었습니다. 결과부터 확인해 주세요.':receipt?CODEX_LOGIN_LABELS[receipt.state]:'이미 로그인되어 있는지 먼저 확인합니다.'}</p>
  <p className="mt-2 text-sm leading-relaxed">공식 로그인 화면에서 계정 선택과 인증만 진행하세요. 로그인 정보는 Codex의 기존 저장 설정을 따르며 대화나 장기기억에 보내지 않습니다.</p>
  {receipt?.state==='storage-review'&&<p className="mt-2 text-sm">기존 로그인 파일의 접근 권한을 확인해야 합니다. 파일을 삭제하거나 새 계정으로 덮어쓰지 않고 공식 안내에 따라 점검하세요.</p>}
  {receipt?.state==='needs-review'&&<p className="mt-2 text-sm">별도 프로필·회사 네트워크 설정이나 완료되지 않은 로그인이 있을 수 있습니다. 기존 환경에서 로그인을 확인한 뒤 다시 확인하세요.</p>}
  {loaded&&!supported&&<p className="mt-2 text-sm">이 로그인 도우미는 Mac 앱에서 지원합니다. 다른 환경에서는 공식 안내를 이용하세요.</p>}
  {error&&<p role="alert" className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
  <div className="mt-3 flex flex-wrap gap-2">
   {loaded&&supported&&!active&&receipt?.state!=='ready-to-login'&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('check')}>로그인 상태 확인</button>}
   {supported&&receipt?.state==='ready-to-login'&&<button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} disabled={busy||!!error} onClick={()=>void run('login')}>ChatGPT 계정으로 로그인</button>}
   {active&&browserReady&&<button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} disabled={busy||!!error} onClick={()=>void run('open-login')}>로그인 화면 열기</button>}
   {active&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('cancel')}>로그인 취소 · 나중에</button>}
   {receipt?.state==='configured'&&onContinue&&<button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} disabled={busy||!!error} onClick={onContinue}>첫 AI 작업으로 이어가기</button>}
   {(!loaded||error)&&<button type="button" className={button} disabled={busy} onClick={()=>void run('status')}>{busy?'확인 중…':'상태 다시 읽기'}</button>}
  </div>
 </section>;
}
