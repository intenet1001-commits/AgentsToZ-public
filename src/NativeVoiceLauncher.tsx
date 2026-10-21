import React,{useEffect,useReducer,useRef,useState} from 'react';
import {Mic} from 'lucide-react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {OPEN_OPS_VOICE_EVENT} from './VoiceSessionPanel';
import {VOICE_POPOUT_ACTION_EVENT,type VoicePopoutContext} from './voicePopout';
import {revealMainWindow} from './mainWindowReveal';
import {initialVoiceDockWindowState,OPEN_VOICE_DOCK_EVENT,showVoiceDockReopen,voiceDockWindowReducer} from './voiceDockWindowState';
import './NativeVoiceLauncher.css';

const VOICE_DOCK_CLOSED_EVENT='voice-dock:closed';
// Lifts the toast stack above the reopen button while it is shown (the dock itself is a separate window here).
const REOPEN_OFFSET='52px';

/** The desktop microphone lives exclusively in the voice window, never here. */
export function NativeVoiceLauncher({context,onOpenOpsWorkroom,onOpenDeviceWorkroom}:{context:VoicePopoutContext;onOpenOpsWorkroom?:()=>void;onOpenDeviceWorkroom?:(key:string)=>void}){
  const [error,setError]=useState('');
  const [dock,dispatch]=useReducer(voiceDockWindowReducer,initialVoiceDockWindowState);
  const epoch=useRef(dock.epoch);epoch.current=dock.epoch;
  const current=useRef({context,onOpenOpsWorkroom,onOpenDeviceWorkroom});current.current={context,onOpenOpsWorkroom,onOpenDeviceWorkroom};
  const openRef=useRef<(panel:boolean)=>void>(()=>{});
  useEffect(()=>{
    let stopped=false;const offs:(()=>void)[]=[];
    const retain=(off:()=>void)=>{if(stopped)off();else offs.push(off);};
    const open=(panel:boolean)=>{
      dispatch({type:'open-requested'});
      void invoke('open_voice_window',{panel}).then(()=>{if(!stopped)dispatch({type:'opened'});})
        .catch(e=>{if(!stopped){dispatch({type:'open-failed'});setError(String(e));}});
    };
    openRef.current=open;
    // The window can also be closed with its own close button while this one sleeps — ask when we come forward.
    const check=()=>{
      if(document.visibilityState==='hidden')return;
      const asked=epoch.current;
      void invoke<boolean>('voice_window_open').then(isOpen=>{if(!stopped)dispatch({type:'queried',epoch:asked,open:isOpen});}).catch(()=>{});
    };
    const show=()=>open(true);
    const reopenDock=()=>open(false);
    window.addEventListener(OPEN_OPS_VOICE_EVENT,show);
    window.addEventListener(OPEN_VOICE_DOCK_EVENT,reopenDock);
    window.addEventListener('focus',check);
    document.addEventListener('visibilitychange',check);
    void listen(VOICE_DOCK_CLOSED_EVENT,()=>dispatch({type:'closed'})).then(retain).catch(e=>{if(!stopped)setError(String(e));});
    void listen<{kind:string;key?:string}>(VOICE_POPOUT_ACTION_EVENT,event=>{
      const now=current.current;
      if(event.payload.kind==='ops')now.onOpenOpsWorkroom?.();
      if(event.payload.kind==='device'&&now.context.devices.some(d=>d.key===event.payload.key)){
        void revealMainWindow().catch(e=>setError(String(e)));
        now.onOpenDeviceWorkroom?.(event.payload.key!);
      }
    }).then(retain).catch(e=>{if(!stopped)setError(String(e));});
    open(false);
    return()=>{
      stopped=true;offs.forEach(off=>off());
      window.removeEventListener(OPEN_OPS_VOICE_EVENT,show);window.removeEventListener(OPEN_VOICE_DOCK_EVENT,reopenDock);
      window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',check);
    };
  },[]);
  useEffect(()=>{void invoke('set_voice_dock_context',{context}).catch(e=>setError(String(e)));},[context.deviceName,context.opsAvailable,JSON.stringify(context.devices)]);
  const reopen=()=>openRef.current(false);
  const offerReopen=!error&&showVoiceDockReopen(dock);
  useEffect(()=>{
    if(!offerReopen)return;
    const root=document.documentElement;root.style.setProperty('--voice-dock-offset',REOPEN_OFFSET);
    return()=>{root.style.removeProperty('--voice-dock-offset');};
  },[offerReopen]);
  if(error)return <div role="alert" data-testid="voice-popout-error">음성 독립 창을 열지 못했습니다. {error}<button type="button" onClick={()=>{setError('');reopen();}}>다시 열기</button></div>;
  if(!offerReopen)return null;
  return <button type="button" className="voice-dock-reopen" data-testid="voice-dock-reopen" aria-label="아젠투지 호출 열기 — 닫은 음성 호출 창을 다시 엽니다" title="닫은 「아젠투지 호출」 창을 다시 엽니다" onClick={reopen}><Mic aria-hidden="true" size={14}/>아젠투지 호출 열기</button>;
}
