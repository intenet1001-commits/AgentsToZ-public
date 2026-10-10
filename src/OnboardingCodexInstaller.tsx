import React,{useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {CODEX_INSTALL_RECIPE,CODEX_INSTALL_LABELS,parseCodexInstallReceipt,type CodexInstallReceipt} from './onboardingCodexInstall';
import {WINDOWS_ONBOARDING_RECIPES} from './onboardingWindowsInstall';
import {isWindowsClient} from './clientPlatform';

type Transport=(body:Record<string,unknown>)=>Promise<{status:number;body:any}>;
const native:Transport=body=>invoke('onboarding_management_request',{body,tool:'codex'});
const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
export default function OnboardingCodexInstall({transport=native,onContinue}:{transport?:Transport;onContinue?:()=>void}){
  const [receipt,setReceipt]=useState<CodexInstallReceipt|null>(null),[loaded,setLoaded]=useState(false),[supported,setSupported]=useState(false);
  const [interrupted,setInterrupted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const alive=useRef(false),epoch=useRef(0),lock=useRef(false);
  async function run(operation:string){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');const generation=epoch.current;
    try{
      const response=await transport({operation,...(operation==='status'?{}:{expectedRevision:receipt?.revision??'0'})});
      if(response.status!==200||response.body.success!==true)throw new Error('request');
      const value=response.body.receipt===null?null:parseCodexInstallReceipt(response.body.receipt);
      if(alive.current&&generation===epoch.current){setReceipt(value);setInterrupted(response.body.interrupted===true);setSupported(response.body.supported===true);setLoaded(true);}
    }catch{if(alive.current&&generation===epoch.current)setError('설치 상태를 확인하지 못했습니다. 상태를 다시 읽고 이어가세요. 기존 파일과 로그인 정보는 유지됩니다.');}
    finally{if(generation===epoch.current){lock.current=false;if(alive.current)setBusy(false);}}
  }
  useEffect(()=>{alive.current=true;void run('status');return()=>{alive.current=false;epoch.current++;lock.current=false;};},[]);
  const active=!interrupted&&receipt&&['preparing','installing'].includes(receipt.state);
  useEffect(()=>{
    if(!active||error)return;
    const timer=setInterval(()=>{if(document.visibilityState==='visible')void run('status');},2000);
    return()=>clearInterval(timer);
  },[active,error]);
  return <section aria-label="Codex 자동 설치" className="mt-4 rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] p-4">
    <h4 className="font-semibold">Codex 설치하기</h4>
    <p className="mt-2 text-sm">{interrupted?'이전 설치가 중단되었습니다. 설치 결과를 먼저 확인하세요.':receipt?CODEX_INSTALL_LABELS[receipt.state]:'앱에서 공식 Codex를 설치할 수 있습니다.'}</p>
    {error&&<p role="alert" className="mt-2 text-sm text-[var(--danger)]">{error}</p>}
    {loaded&&!supported&&<p className="mt-2 text-sm">{isWindowsClient()
      ?'이 Windows에는 winget(앱 설치 관리자)이 없어 자동 설치를 쓸 수 없습니다. Microsoft Store에서 「앱 설치 관리자」를 설치한 뒤 상태를 다시 읽어 주세요.'
      :'자동 설치는 Apple Silicon Mac 또는 winget이 있는 Windows에서 지원합니다. 다른 환경에서는 공식 설치 안내를 이용하세요.'}</p>}
    {/* ⚠️ 설치 방식이 플랫폼마다 다르므로 문구도 갈라야 한다. Windows는 winget으로
        설치하고 서명자를 확인하는데, macOS 문구("약 112MB 공식 배포본 다운로드")를
        그대로 보여 주면 일어나지 않는 일을 약속하게 된다. */}
    {receipt?.state==='reviewed'&&<p className="mt-3 text-sm leading-relaxed">{isWindowsClient()
      ?`winget 공식 목록에서 ${WINDOWS_ONBOARDING_RECIPES.codex.packageId}(Codex CLI)를 설치하고, 설치된 실행 파일의 서명이 ${WINDOWS_ONBOARDING_RECIPES.codex.publisherCommonName}인지 확인합니다. 설치 위치는 winget이 정하며 기존 설치·계정·셸 설정은 유지합니다.`
      :`Codex ${CODEX_INSTALL_RECIPE.version}과 필요한 보조 파일을 OpenAI 공식 배포본에서 내려받아 이 Mac에 설치합니다. 약 112MB를 다운로드하며 파일과 서명을 검증합니다. 기존 설치·계정·셸 설정은 유지합니다.`}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {loaded&&supported&&!receipt&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('review')}>자동 설치 준비</button>}
      {supported&&receipt?.state==='reviewed'&&<button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} disabled={busy||!!error} onClick={()=>void run('install')}>확인하고 설치</button>}
      {supported&&receipt&&receipt.state!=='reviewed'&&!active&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('check')}>설치 결과 확인</button>}
      {supported&&receipt&&['needs-review','cancelled'].includes(receipt.state)&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('review')}>설치 내용 다시 검토</button>}
      {supported&&active&&<button type="button" className={button} disabled={busy||!!error} onClick={()=>void run('cancel')}>설치 중단</button>}
      {receipt&&['installed','configured'].includes(receipt.state)&&onContinue&&<button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} disabled={busy||!!error} onClick={onContinue}>다음 단계 확인</button>}
      {(!loaded||error)&&<button type="button" className={button} disabled={busy} onClick={()=>void run('status')}>{busy?'확인 중…':'상태 다시 읽기'}</button>}
    </div>
  </section>;
}
