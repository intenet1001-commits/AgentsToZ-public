import React,{useEffect,useRef,useState} from 'react';
import {isTauri} from '@tauri-apps/api/core';
import {createCommonMemoryClient,commonMemoryHttpTransport,type CommonMemoryClient} from './commonMemoryClient';
import {startCommonMemoryFollowupPolling} from './commonMemoryFollowupWatcher';
import {rememberCommonMemoryNavigation,type CommonMemoryUpdate} from './commonMemoryFollowup';

const localClient=createCommonMemoryClient(commonMemoryHttpTransport(isTauri()?'http://127.0.0.1:3001/api/common-memory':undefined));
export function CommonMemoryFollowupNotice({onOpen,client=localClient,hidden=false}:{onOpen:()=>void;client?:CommonMemoryClient;hidden?:boolean}) {
  const [updates,setUpdates]=useState<CommonMemoryUpdate[]>([]),[partial,setPartial]=useState(false),[scope,setScope]=useState('');
  const hiddenRef=useRef(hidden),poller=useRef<ReturnType<typeof startCommonMemoryFollowupPolling>|null>(null);hiddenRef.current=hidden;
  useEffect(()=>{
    const current=startCommonMemoryFollowupPolling({
      read:async offset=>{const result=await client.updates(offset);return result;},
      hidden:hiddenRef.current,documentVisible:()=>document.visibilityState==='visible',
      result:value=>{setUpdates(value.updates);setPartial(value.partial);setScope(value.scopeId);},error:()=>setUpdates([]),
    });
    poller.current=current;
    const visible=()=>void current.check();document.addEventListener('visibilitychange',visible);
    return ()=>{current.stop();if(poller.current===current)poller.current=null;document.removeEventListener('visibilitychange',visible);};
  },[client]);
  // While the 공통기억 tab is open the notice is hidden and does not poll.
  useEffect(()=>{void poller.current?.setHidden(hidden);},[hidden]);
  const suggested=updates.filter(u=>u.suggested);
  if(hidden||!suggested.length)return null;
  return <div role="status" className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--accent-soft)] px-3 py-2 text-sm" data-testid="common-memory-followup-notice">
    <span>공통기억 {suggested.length}개에 정리할 내용이 모였습니다{partial?' · 확인한 범위 기준':''}.</span>
    <button className="min-h-11 rounded-lg border border-[var(--line)] px-3" onClick={()=>{rememberCommonMemoryNavigation(scope,suggested[0]!.groupId);onOpen();}}>추천 업데이트 보기</button>
  </div>;
}
