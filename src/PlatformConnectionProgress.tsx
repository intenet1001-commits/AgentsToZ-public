import {useEffect,useRef,useState} from 'react';
import {PLATFORM_CLI_LABELS} from './platformCliProtocol';
import {pendingPlatformConnection,platformConnectionResult} from './platformCliOperationClient';
import type {PlatformCliOperationView} from './platformCliOperation';
export function PlatformConnectionProgress({requestId,ko,onComplete}:{requestId?:string|null;ko:boolean;onComplete?:(view:PlatformCliOperationView)=>void}){
  const [view,setView]=useState<PlatformCliOperationView|null>(null),[error,setError]=useState('');
  const id=requestId===undefined?pendingPlatformConnection():requestId;
  const completed=useRef<string|null>(null),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const read=async()=>{if(!id)return;try{const next=await platformConnectionResult(id);if(!mounted.current)return next;setView(next);setError('');if(next.state==='completed'&&completed.current!==id){completed.current=id;onComplete?.(next);}return next;}catch{if(mounted.current)setError(ko?'결과를 아직 읽지 못했습니다. 같은 요청으로 다시 확인하세요.':'Result unavailable. Read this same request again.');}};
  useEffect(()=>{setView(null);if(!id)return;let current=true,timer:ReturnType<typeof setTimeout>;const deadline=Date.now()+600_000;const poll=async()=>{if(!current)return;const next=!document.hidden?await read():null;if(current&&(!next||next.state==='waiting')&&Date.now()<deadline)timer=setTimeout(poll,2000);};void poll();return()=>{current=false;clearTimeout(timer);};},[id]);
  if(!id)return null;
  const provider=view?.provider??view?.account?.provider;
  return <div className="my-3 rounded-xl border border-[var(--accent-line)] p-3 text-xs leading-5" role="status">
    {view?.label&&<strong className="block">{provider?PLATFORM_CLI_LABELS[provider]+' · ':''}{view.label}</strong>}
    <p>{view?.state==='completed'?(ko?`연결 확인: ${view.account?.identity??'완료'} · 이 요청의 실제 연결 확인이 완료됐습니다.`:`Connection checked: ${view.account?.identity??'complete'}`):view?.state==='failed'||view?.state==='interrupted'?view.message:(ko?'계정 확인 대기 중입니다. macOS 키체인 확인창이 보이면 직접 허용해 주세요. 창을 닫거나 대기가 길어져도 같은 요청 결과부터 확인합니다.':'Waiting for account verification. Approve the macOS Keychain prompt yourself if shown. Read this same result after a long wait or reopening.')}</p>
    {error&&<p>{error}</p>}
    <button type="button" className="mt-2 min-h-11 rounded-lg border border-[var(--line)] px-3" onClick={()=>void read()}>{ko?'같은 계정 확인 결과 보기':'Read this account check result'}</button>
  </div>;
}
