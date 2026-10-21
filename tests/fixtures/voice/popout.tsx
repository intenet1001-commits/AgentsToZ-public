import React from 'react';
import {createRoot} from 'react-dom/client';
import {VoicePopoutApp} from '../../../src/VoicePopoutApp';
import {NativeVoiceLauncher} from '../../../src/NativeVoiceLauncher';
import {voiceMediaClient} from '../../../src/voiceMediaClient';
import type {VoiceSnapshot} from '../../../src/voiceSessionProtocol';

Object.defineProperty(navigator,'platform',{value:'MacIntel',configurable:true});
const f=window as any;f.isTauri=true;f.helpdeskOpens=0;window.addEventListener('agentstoz:open-helpdesk',()=>f.helpdeskOpens++);f.nativeCalls=[];f.requests=[];f.trackStops=0;f.mediaStarts=0;f.client=voiceMediaClient;
let next=1;const callbacks=new Map<number,Function>(),listeners=new Map<number,{event:string;handler:number}>();
f.nativeEvent=(event:string,payload:unknown)=>{for(const [id,item] of listeners)if(item.event===event)callbacks.get(item.handler)?.({event,id,payload});};
// The Rust side clears its window and tells main (voice-dock:closed); `silently` skips the event, like a close while main slept.
f.closeVoiceWindow=(silently=false)=>{created=false;if(!silently)f.nativeEvent('voice-dock:closed',null);};
f.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event:string,id:number)=>listeners.delete(id)};
const context={deviceName:'시험 Mac',opsAvailable:true,devices:[]};let created=false;
let session:VoiceSnapshot;
f.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'voice-dock'},currentWebview:{label:'voice-dock'}},transformCallback:(fn:Function)=>{const id=next++;callbacks.set(id,fn);return id;},unregisterCallback:(id:number)=>callbacks.delete(id),
 invoke:async(command:string,args:any={})=>{
  f.nativeCalls.push({command,args});
  if(command==='resize_voice_window'&&f.resizeNativeContent)return f.resizeNativeContent(args);
  if(command==='plugin:event|listen'){const id=next++;listeners.set(id,{event:args.event,handler:args.handler});return id;}
  if(command==='plugin:event|unlisten')return;
  if(command==='get_voice_dock_context')return context;
  if(command==='open_voice_window'){if(!created){created=true;f.creations=(f.creations??0)+1;}return;}
  if(command==='voice_window_open')return created;
  if(command==='close_voice_window'){f.voiceClosed=true;return;}
  if(command==='agent_runtime_request'){
   if(args.path!=='/api/agent-runtime/voice')throw Error('Popup may only request voice');
   const request=args.body;f.requests.push(request);
   if(request.action==='capabilities')return {status:200,body:{configured:true,model:'gpt-realtime-2.1',voice:'marin'}};
   if(request.action==='prepare'){session={id:'voice_fixture',state:'prepared',mode:'conversation',provider:'openai',label:'AgentsToZ OPS',activeTarget:{kind:'ops',label:'AgentsToZ OPS'},draft:null,notice:'준비 중',expiresAt:Date.now()+900000};return {status:200,body:{session:{...session}}};}
   if(request.action==='connect'){session.state='active';return {status:200,body:{session:{...session},sdp:'v=0'}};}
   if(request.action==='stop'){session.state='ended';return {status:200,body:{session:{...session}}};}
   return {status:200,body:{session:session?{...session}:undefined}};
  }
 }};
const track={stop(){f.trackStops++;},onended:null};
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{f.mediaStarts++;return {getTracks:()=>[track]};}},configurable:true});
class Channel extends EventTarget {readyState='open';onmessage:any;onclose:any;send(){}close(){this.readyState='closed';}}
class Peer {connectionState='connected';onconnectionstatechange:any;ontrack:any;addTrack(){}getSenders(){return[{track:null,replaceTrack:async()=>{}}];}createDataChannel(){return new Channel();}async createOffer(){return{type:'offer',sdp:'v=0'};}async setLocalDescription(){}async setRemoteDescription(){}close(){this.connectionState='closed';}}
f.RTCPeerConnection=Peer;
const primary=new URLSearchParams(location.search).has('primary');
createRoot(document.getElementById('root')!).render(<React.StrictMode>{primary?<NativeVoiceLauncher context={context}/>:<VoicePopoutApp/>}</React.StrictMode>);
