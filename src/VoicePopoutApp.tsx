import React,{useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {getCurrentWindow} from '@tauri-apps/api/window';
import {AgentsToZVoiceDock} from './components/AgentsToZVoiceDock';
import {VoiceButton,OPEN_OPS_VOICE_EVENT} from './VoiceSessionPanel';
import {localVoiceTransport} from './voiceSessionClient';
import {voiceMediaClient} from './voiceMediaClient';
import {openWorkroomPopout} from './workroomPopoutClient';
import {workroomPopoutTitle} from './workroomPopout';
import {emptyVoicePopoutContext,VOICE_POPOUT_CONTEXT_EVENT,type VoicePopoutContext} from './voicePopout';
import type {VoiceActiveTarget} from './voiceSessionProtocol';
import {isMacHelpdeskSurface} from './helpdeskKnowledge';
import {isTauri} from '@tauri-apps/api/core';
import {LifeBuoy} from 'lucide-react';
import {WorkModeControl} from './WorkModeControl';
import {applyAppTheme,readAppTheme} from './appAppearance';
import './VoicePopoutApp.css';

export function VoicePopoutApp({panel=false}:{panel?:boolean}){
  const [context,setContext]=useState<VoicePopoutContext>(emptyVoicePopoutContext),[error,setError]=useState('');
  const content=useRef<HTMLDivElement>(null);
  const opened=useRef('');
  useEffect(()=>{
    let stopped=false,closing=false;const offs:(()=>void)[]=[];
    const retain=(off:()=>void)=>{if(stopped)off();else offs.push(off);};
    const failed=(e:unknown)=>{if(!stopped)setError(String(e));};
    void listen<VoicePopoutContext>(VOICE_POPOUT_CONTEXT_EVENT,e=>setContext(e.payload)).then(retain).catch(failed);
    void listen('voice-dock:open-panel',()=>window.dispatchEvent(new Event(OPEN_OPS_VOICE_EVENT))).then(retain).catch(failed);
    void invoke<VoicePopoutContext>('get_voice_dock_context').then(c=>{if(!stopped)setContext(c);}).catch(e=>{if(!stopped)setError(String(e));});
    void getCurrentWindow().onCloseRequested(async e=>{
      e.preventDefault();if(closing)return;closing=true;
      // stop() releases local media synchronously before waiting for its host receipt.
      try{await voiceMediaClient.stop();await invoke('close_voice_window');}catch(e){closing=false;failed(e);}
    }).then(retain).catch(failed);
    const openRoom=(e:Event)=>{
      const target=(e as CustomEvent<VoiceActiveTarget>).detail;
      if(target?.kind==='ops'){opened.current='';return;}
      if(target?.kind==='workroom'){
        const key=target.targetId+':'+target.sessionId;if(opened.current===key)return;opened.current=key;
        void openWorkroomPopout({targetId:target.targetId,sessionId:target.sessionId,agent:target.agent,bypassPermissions:false},workroomPopoutTitle(target.label,target.agent)).catch(e=>{if(opened.current===key)opened.current='';setError(String(e));});
      }
    };
    window.addEventListener('agentstoz:voice-workroom-opened',openRoom);
    window.addEventListener('agentstoz:voice-target-change',openRoom);
    const theme=()=>applyAppTheme(readAppTheme());window.addEventListener('storage',theme);
    return()=>{stopped=true;offs.forEach(off=>off());window.removeEventListener('agentstoz:voice-workroom-opened',openRoom);window.removeEventListener('agentstoz:voice-target-change',openRoom);window.removeEventListener('storage',theme);};
  },[]);
  useEffect(()=>{
    const node=content.current;if(!node)return;let frame=0,last=0,lastViewport=0;
    const resize=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const height=Math.min(760,Math.max(116,Math.ceil(Math.max(node.scrollHeight,node.getBoundingClientRect().height))+4)),viewportHeight=window.innerHeight;if(Math.abs(height-last)<2&&Math.abs(viewportHeight-lastViewport)<2)return;last=height;lastViewport=viewportHeight;void invoke('resize_voice_window',{height,viewportHeight}).catch(e=>setError(String(e)));});};
    const observer=new ResizeObserver(resize);observer.observe(node);resize();
    window.addEventListener('resize',resize);
    return()=>{observer.disconnect();window.removeEventListener('resize',resize);cancelAnimationFrame(frame);};
  },[]);
  const action=(kind:'ops'|'device'|'helpdesk',key?:string)=>{void invoke('voice_dock_action',{kind,key:key??null}).catch(e=>setError(String(e)));};
  return <main className="voice-popout" aria-label="아젠투지 음성 독립 창"><div ref={content} className="voice-popout__content">
    {isTauri()&&<header className={`voice-popout__titlebar${isMacHelpdeskSurface(true,navigator.platform)?' voice-popout__titlebar--mac':''}`} data-tauri-drag-region><span data-tauri-drag-region>아젠투지 호출</span><WorkModeControl compact/>{isMacHelpdeskSurface(true,navigator.platform)&&<button type="button" data-testid="voice-helpdesk-open" onClick={()=>action('helpdesk')} aria-label="아젠투지 헬프데스크 열기"><LifeBuoy size={14} aria-hidden="true"/>헬프데스크</button>}</header>}
    {error&&<p role="alert">{error}</p>}
    <VoiceButton target={{kind:'ops'}} label="아젠투지" hideTrigger openOnEvent initialOpen={panel}/>
    <AgentsToZVoiceDock transport={localVoiceTransport} deviceName={context.deviceName} onOpenOpsWorkroom={context.opsAvailable?()=>action('ops'):undefined} opsDevices={context.devices} onOpenDeviceWorkroom={key=>action('device',key)}/>
  </div></main>;
}
