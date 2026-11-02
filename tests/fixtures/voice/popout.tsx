import React from 'react';
import {createRoot} from 'react-dom/client';
import {VoicePopoutApp} from '../../../src/VoicePopoutApp';
import {NativeVoiceLauncher} from '../../../src/NativeVoiceLauncher';
import {WorkModeControl} from '../../../src/WorkModeControl';
import {QrRemoteControlDialog} from '../../../src/QrRemoteControlDialog';
import '../../../src/workspaceDesign.css';
import {voiceMediaClient} from '../../../src/voiceMediaClient';
import type {VoiceSnapshot} from '../../../src/voiceSessionProtocol';

Object.defineProperty(navigator,'platform',{value:'MacIntel',configurable:true});
const f=window as any;f.isTauri=true;f.helpdeskOpens=0;window.addEventListener('agentstoz:open-helpdesk',()=>f.helpdeskOpens++);f.nativeCalls=[];f.failScreenStatus=f.failViewerStatus=new URLSearchParams(location.search).has('helper-status-fail');f.requests=[];f.trackStops=0;f.mediaStarts=0;f.client=voiceMediaClient;
let next=1;const callbacks=new Map<number,Function>(),listeners=new Map<number,{event:string;handler:number}>();
// The voice window's saved-notice stack (and the main window's while it is closed) reads the local API; answer it here
// so the fixture never reaches whatever sidecar listens on this Mac's 3001.
const realFetch=window.fetch.bind(window);f.localApiReads=[];
window.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(url.host==='127.0.0.1:3001'){f.localApiReads.push(url.pathname);if(url.pathname==='/api/project-memory/auto-checkpoint/status')return new Response(JSON.stringify({schemaVersion:1,settings:{enabled:false,enabledAt:null,thresholds:[]},running:false,sessions:[],recoveryCheckpoints:[]}),{headers:{'Content-Type':'application/json'}});return new Response('{}',{status:404});}
 return realFetch(input,init);}) as typeof fetch;
f.nativeEvent=(event:string,payload:unknown)=>{for(const [id,item] of listeners)if(item.event===event)callbacks.get(item.handler)?.({event,id,payload});};
// The Rust side clears its window and tells main (voice-dock:closed); `silently` skips the event, like a close while main slept.
f.closeVoiceWindow=(silently=false)=>{created=false;if(!silently)f.nativeEvent('voice-dock:closed',null);};
f.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event:string,id:number)=>listeners.delete(id)};
const context={deviceName:'시험 Mac',opsAvailable:true,devices:[]};let created=false;
// Closed-lid work mirrors work_mode.rs: a one-time grant first, then a hold only while it is chosen.
let workMode={supported:true,revision:0,endsAt:null as number|null,keepDisplayOn:false,alwaysOn:false,lid:{supported:true,granted:false,state:'off',error:null as string|null}};
f.workMode=()=>workMode;
/** Lets a test move the native revision past events it injected, as the Rust worker's counter would be. */
f.setWorkMode=(patch:Partial<typeof workMode>)=>{workMode={...workMode,...patch};};
// AgentsToZ Screen as screen_helper.rs reports it: installed and not running until 「열기」.
let screenHelper={supported:true,installed:true,running:false,updatePending:false,otherInstanceRunning:false,instanceStatusUnknown:false,state:null as null|Record<string,unknown>};
f.setScreenHelper=(patch:Partial<typeof screenHelper>)=>{screenHelper={...screenHelper,...patch};};
// At most two held replies per helper for completion-order tests; never a live IPC call.
const heldHelperStatus=new Map<string,{snapshot:unknown;resolve:(v:unknown)=>void;reject:(e:Error)=>void}[]>();
f.heldHelperStatuses=()=>[...heldHelperStatus].flatMap(([kind,rows])=>rows.map(()=>kind));
f.releaseHeldHelperStatuses=(success:boolean,oldestOnly=false)=>{for(const [kind,rows] of heldHelperStatus){const selected=rows.splice(0,oldestOnly?1:rows.length);if(!rows.length)heldHelperStatus.delete(kind);for(const row of selected)if(success)row.resolve(row.snapshot);else row.reject(Error('fixture: older status failed'));}};
const readHelperStatus=(kind:'Screen'|'Viewer',value:unknown)=>{
 if(f[`holdNext${kind}Status`]){f[`holdNext${kind}Status`]=false;const rows=heldHelperStatus.get(kind)??[];if(rows.length>=2)throw Error('fixture: held status budget exceeded');return new Promise((resolve,reject)=>{rows.push({snapshot:value,resolve,reject});heldHelperStatus.set(kind,rows);});}
 if(f[`fail${kind}Status`])throw Error('fixture: helper status unavailable');
 return value;
};
// AgentsToZ Viewer as screen_helper.rs reports it: carried by this app, installed and not running until 「다른 Mac 화면 보기」.
let viewerHelper={supported:true,installed:true,bundled:true,running:false,updatePending:false,otherInstanceRunning:false,instanceStatusUnknown:false};
f.setViewerHelper=(patch:Partial<typeof viewerHelper>)=>{viewerHelper={...viewerHelper,...patch};};
let session:VoiceSnapshot;
f.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'voice-dock'},currentWebview:{label:'voice-dock'}},transformCallback:(fn:Function)=>{const id=next++;callbacks.set(id,fn);return id;},unregisterCallback:(id:number)=>callbacks.delete(id),
 invoke:async(command:string,args:any={})=>{
  f.nativeCalls.push({command,args});
  if(command==='get_work_mode')return {...workMode};
  if(command==='set_work_mode'){
   if(f.failWorkMode)throw Error('전원 요청 실패');
   // Mirrors work_mode.rs: always-on has no end time and takes no minutes.
   if(args.alwaysOn&&args.minutes)throw Error('연중무휴는 근무 시간을 함께 지정하지 않습니다.');
   if(args.closedLid&&!workMode.lid.granted)throw Error('먼저 「처음 한 번 허용」을 눌러 주세요.');
   const running=!!args.alwaysOn||args.minutes>0;
   workMode={supported:true,revision:workMode.revision+1,endsAt:args.minutes?Date.now()+args.minutes*60000:null,keepDisplayOn:!!args.keepDisplayOn,alwaysOn:!!args.alwaysOn,
    lid:{...workMode.lid,state:running&&args.closedLid?'active':'off'}};
   f.nativeEvent('work-mode:changed',{...workMode});return {...workMode};
  }
  if(command==='set_closed_lid_grant'){
   if(f.cancelGrant)throw Error('허용을 취소했어요.');
   workMode={...workMode,revision:workMode.revision+1,lid:{...workMode.lid,granted:!!args.granted}};
   f.nativeEvent('work-mode:changed',{...workMode});return {...workMode};
  }
  if(command==='get_screen_helper')return readHelperStatus('Screen',{...screenHelper});
  if(command==='open_screen_helper'){
   if(f.failScreenOpen)throw Error('AgentsToZ Screen을 열지 못했습니다: 찾을 수 없음');
   if(!screenHelper.running)screenHelper={...screenHelper,installed:true,running:true,state:{power:'off',viewing:false,devices:0,capture:true,control:false,loginItem:'off'}};
   return {verified:!f.unverifiedScreenOpen};
  }
  if(command==='get_viewer_helper')return readHelperStatus('Viewer',{...viewerHelper});
  if(command==='open_viewer_helper'){
   if(f.failViewerOpen)throw Error('AgentsToZ Viewer를 열지 못했습니다: 찾을 수 없음');
   viewerHelper={...viewerHelper,installed:true,running:true};
   return {verified:!f.unverifiedViewerOpen};
  }
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
const workModeMain=new URLSearchParams(location.search).has('workmode-main');
// The QR remote-control dialog with LAN remote off, for its AgentsToZ Screen entry (same helper stub as the panel).
const qrRemote=new URLSearchParams(location.search).has('qr-remote');
// A browser tab has no helper to ask.
if(new URLSearchParams(location.search).has('browser'))f.isTauri=false;
const offline=()=>Promise.reject(Error('fixture: no LAN remote'));
const qrApi={status:async()=>({enabled:false,listener:null,pairing:null,sessions:[],stalled:null}),interfaces:async()=>[{address:'192.168.0.10',name:'Wi‑Fi'}],
 enable:offline,rotatePairing:offline,revokeSession:offline,revokeAllSessions:offline,disable:offline};
createRoot(document.getElementById('root')!).render(<React.StrictMode>{qrRemote?<QrRemoteControlDialog open onClose={()=>{}} api={qrApi as any}/>:workModeMain?<div className="workspace-shell" style={{height:'100dvh'}}><div data-testid="top-toolbar" className="ui-toolbar-scroll"><div className="workspace-brand">AgentsToZ</div><WorkModeControl/><nav data-testid="main-nav">프로젝트 · 워크룸 · 기억</nav></div><div className="workspace-content">프로젝트</div></div>:primary?<NativeVoiceLauncher context={context}/>:<VoicePopoutApp/>}</React.StrictMode>);
