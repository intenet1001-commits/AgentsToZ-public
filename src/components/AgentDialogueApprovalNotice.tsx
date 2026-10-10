import {useEffect,useState} from 'react';
import {manageAgentDialogue} from '../AgentDialoguePanel';

/** Fast while this device exposes a dialogue endpoint (only then can an AI ask); slow otherwise. */
const ACTIVE_POLL_MS=4_000;
const IDLE_POLL_MS=60_000;

/**
 * An approval request lives only in the 기기 간 대화 window, which is closed most of the time.
 * Without this notice the request silently expires and the cross-device test looks broken
 * (VOC 2026-10-04). It reads the same UI-only status the window reads and never approves.
 */
export function AgentDialogueApprovalNotice({paused,onOpen}:{paused:boolean;onOpen:()=>void}){
  const [count,setCount]=useState(0);
  useEffect(()=>{
    if(paused){setCount(0);return;}
    let stopped=false,timer:ReturnType<typeof setTimeout>|null=null;
    const tick=async()=>{
      timer=null;
      let delay=IDLE_POLL_MS;
      if(document.visibilityState==='visible'){
        try{
          const status=await manageAgentDialogue('status');
          if(stopped)return;
          setCount(Array.isArray(status.pending)?status.pending.length:0);
          if(Array.isArray(status.enabled)&&status.enabled.length>0)delay=ACTIVE_POLL_MS;
        }catch{if(!stopped)setCount(0);}
      }
      if(!stopped)timer=setTimeout(()=>void tick(),delay);
    };
    void tick();
    const onVisible=()=>{
      if(document.visibilityState!=='visible'||!timer)return;
      clearTimeout(timer);void tick();
    };
    document.addEventListener('visibilitychange',onVisible);
    return()=>{stopped=true;if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',onVisible);};
  },[paused]);
  if(paused||count===0)return null;
  return <button type="button" data-testid="agent-dialogue-approval-notice" onClick={onOpen}
    className="fixed right-4 top-16 z-[250] min-h-11 rounded-full bg-[var(--accent)] px-4 text-[13px] font-semibold text-white shadow-[var(--shadow-lg)]">
    기기 간 대화 승인 요청 {count}건 · 확인하기
  </button>;
}
