import React,{useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {GITHUB_RECIPE,GITHUB_SETUP_LABELS,parseGithubReceipt,type GithubSetupReceipt} from './onboardingGithub';
import {writeOnboardingClipboard} from './onboardingClipboard';

type Transport=(body:Record<string,unknown>)=>Promise<{status:number;body:any}>;
const native:Transport=body=>invoke('onboarding_management_request',{body});
const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
export default function OnboardingGithubSetup({transport=native}:{transport?:Transport}){
 const [receipt,setReceipt]=useState<GithubSetupReceipt|null>(null),[loaded,setLoaded]=useState(false),[supported,setSupported]=useState(true);
 const [interrupted,setInterrupted]=useState(false);
 const [code,setCode]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[copy,setCopy]=useState('');
 const copying=useRef(false);
 const alive=useRef(false),generation=useRef(0),lock=useRef(false);
 async function run(operation:string){
  if(lock.current)return;lock.current=true;setBusy(true);setError('');const epoch=generation.current;
  try{
   const response=await transport({operation,...(operation==='status'?{}:{expectedRevision:receipt?.revision??'0'})});
   if(response.status!==200||response.body.success!==true)throw new Error('request');
   const value=response.body.receipt===null?null:parseGithubReceipt(response.body.receipt);
   if(alive.current&&epoch===generation.current){setReceipt(value);setInterrupted(response.body.interrupted===true);setSupported(response.body.supported===true);setCode(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(response.body.code??'')?response.body.code:null);setLoaded(true);}
  }catch{if(alive.current&&epoch===generation.current)setError('설치 도우미에 연결하지 못했습니다. 최신 설치 앱에서 상태를 다시 읽어 주세요. 기존 결과는 유지됩니다.');}
  finally{if(epoch===generation.current){lock.current=false;if(alive.current)setBusy(false);}}
 }
 useEffect(()=>{alive.current=true;void run('status');return()=>{alive.current=false;generation.current++;lock.current=false;};},[]);
 const active=!interrupted&&receipt&&['preparing','installing','authenticating'].includes(receipt.state);
 useEffect(()=>{
  if(!active||error)return;
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void run('status');},2000);
  return()=>clearInterval(timer);
 },[active,error]);
 async function openLogin(){
  if(!code||copying.current)return;copying.current=true;
  try{const copied=await writeOnboardingClipboard(code);setCopy(copied?'코드를 복사했습니다. GitHub 화면에 붙여 넣으세요.':'위 코드를 GitHub 화면에 입력하세요.');
  await run('open-login');}finally{copying.current=false;}
 }
 return <section aria-label="GitHub 설치 도우미" className="mt-4 rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] p-4">
  <h4 className="font-semibold">GitHub 설치·연결</h4>
  <p className="mt-2 text-sm text-[var(--ink-2)]">{interrupted?'이전 작업이 중단되었습니다. 실제 결과부터 확인해 주세요.':receipt?GITHUB_SETUP_LABELS[receipt.state]:'검증된 공식 CLI를 설치하고 GitHub 계정을 연결합니다.'}</p>
  {error&&<p role="alert" className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
  {!supported&&<p className="mt-2 text-sm">현재 Apple Silicon Mac 설치 앱에서 사용할 수 있습니다.</p>}
  {loaded&&supported&&receipt?.state==='reviewed'&&<p className="mt-3 text-sm leading-relaxed">GitHub CLI {GITHUB_RECIPE.version}의 공식 서명과 파일을 검증해 내 계정의 도구 폴더에 설치합니다. 이미 설치돼 있으면 재사용하며 기존 파일이나 셸 설정을 덮어쓰지 않습니다.</p>}
  {receipt?.state==='installed'&&<p className="mt-3 text-sm">GitHub.com 계정을 연결합니다. Git 연결 방식은 HTTPS로 설정되며 기존 SSH 키를 만들거나 업로드하지 않습니다. 비밀번호와 계정 승인은 GitHub 화면에서 진행합니다.</p>}
  {receipt?.state==='storage-review'&&<p role="alert" className="mt-3 text-sm leading-relaxed">GitHub 로그인은 확인했지만 로그인 정보가 일반 설정 파일에 저장되어 있습니다. Mac의 키체인 접근 상태를 확인한 뒤 안전한 저장 방식으로 연결해야 합니다. 기존 로그인 정보는 유지하며 이 단계는 완료로 처리하지 않습니다.</p>}
  {code&&receipt?.state==='authenticating'&&<div className="mt-3">
   <p className="text-sm">GitHub에 입력할 일회용 코드</p><p className="my-2 select-all font-mono text-xl">{code}</p>
   <button className={button} type="button" disabled={busy||!!error} onClick={()=>void openLogin()}>코드 복사하고 GitHub 열기</button>
   <p role="status" className="mt-2 text-sm">{copy}</p>
  </div>}
  <div className="mt-3 flex flex-wrap gap-2">
   {loaded&&supported&&!receipt&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('review')}>설치 준비</button>}
   {receipt?.state==='reviewed'&&<button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} disabled={busy||!!error} onClick={()=>void run('install')}>확인하고 설치 시작</button>}
   {receipt?.state==='installed'&&<button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} disabled={busy||!!error} onClick={()=>void run('login')}>GitHub 계정 연결</button>}
   {receipt&&!active&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('check')}>설치·연결 결과 확인</button>}
   {receipt&&['needs-review','cancelled'].includes(receipt.state)&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('review')}>설치 내용 다시 검토</button>}
   {active&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('cancel')}>이 단계 중단</button>}
   <button type="button" className={button} disabled={busy} onClick={()=>void run('status')}>{busy?'확인 중…':'상태 다시 읽기'}</button>
  </div>
 </section>;
}
