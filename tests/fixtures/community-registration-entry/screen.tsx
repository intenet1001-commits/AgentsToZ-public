import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {CommunityDeviceRegistration} from '../../../src/CommunityDeviceRegistration';
import {CommunityWorkspace,type CommunityWorkspaceChannel} from '../../../src/CommunityWorkspace';
import {AgentDialoguePanel} from '../../../src/AgentDialoguePanel';
import '../../../src/workspaceDesign.css';

// Only in-memory DTOs and native-command stand-ins. No installed app, approval, port or remote session.
const f=window as any,params=new URLSearchParams(location.search);
f.isTauri=params.get('native')!=='0';
let status={supported:true,installed:true,bundled:true,running:false,updatePending:false,otherInstanceRunning:false,instanceStatusUnknown:false};
f.calls=[];f.workspaceCalls=[];f.failStatus=false;f.holdNextStatus=false;f.openVerified=true;f.failOpen=false;
const held:{value:unknown;resolve:(value:unknown)=>void;reject:(error:Error)=>void}[]=[];
const statusTimers=new Map<number,()=>void>(),originalSetInterval=window.setInterval.bind(window),originalClearInterval=window.clearInterval.bind(window);let nextTimer=900_000;
window.setInterval=((fn:TimerHandler,ms?:number,...args:unknown[])=>{if(ms===5000&&typeof fn==='function'){const id=nextTimer++;statusTimers.set(id,()=>fn(...args));return id;}return originalSetInterval(fn,ms,...args);}) as typeof window.setInterval;
window.clearInterval=((id?:number)=>{if(id&&statusTimers.delete(id))return;originalClearInterval(id);}) as typeof window.clearInterval;
f.tick=()=>{for(const fn of statusTimers.values())fn();};
f.timerCount=()=>statusTimers.size;
f.setStatus=(patch:Partial<typeof status>)=>{status={...status,...patch};};
f.releaseOldStatus=(success=true)=>{const item=held.shift();if(!item)throw Error('No held status');success?item.resolve(item.value):item.reject(Error('fixture: status unavailable'));};
f.heldCount=()=>held.length;
let hidden=false;Object.defineProperty(document,'hidden',{get:()=>hidden,configurable:true});f.setHidden=(value:boolean)=>{hidden=value;};
f.__TAURI_INTERNALS__={invoke:async(command:string,args:unknown={})=>{
  f.calls.push({command,args});
  if(command==='get_viewer_helper'){
    if(f.holdNextStatus){f.holdNextStatus=false;if(held.length>=2)throw Error('Held reply budget exceeded');return new Promise((resolve,reject)=>held.push({value:{...status},resolve,reject}));}
    if(f.failStatus)throw Error('fixture: status unavailable');return {...status};
  }
  if(command==='open_viewer_helper'){
    if(f.failOpen||status.instanceStatusUnknown||status.otherInstanceRunning)throw Error('fixture: native fresh negative guard');
    return {verified:f.openVerified};
  }
  if(command==='agent_dialogue_management_request'){
    const operation=(args as any).body.operation;
    if(operation==='status')return {status:200,body:{success:true,enabled:[],pending:[],remoteRevocationPending:0}};
    throw Error('No dialogue mutation is allowed in this fixture');
  }
  throw Error('Unexpected native command: '+command);
}};
window.fetch=(async(_input:RequestInfo|URL,_init?:RequestInit):Promise<Response>=>{throw Error('Network access is not allowed in this fixture');}) as typeof fetch;
const channel:CommunityWorkspaceChannel={id:'local',label:'시험 Mac',projects:async()=>[{targetId:'fixture-project-001',label:'시험 프로젝트'}],transport:async(request:any)=>{
  f.workspaceCalls.push(request);
  if(request.workspace?.action==='workroom.threads.list')return {kind:'workspace',action:'workroom.threads.list',threads:{threads:[],nextThreadId:null}};
  throw Error('This fixture never starts or replies to a Workroom');
}};
function Fixture(){
  const [visible,setVisible]=useState(true),[surface,setSurface]=useState('entry');
  f.setVisible=setVisible;f.setSurface=setSurface;
  return <main>
    {surface==='entry'?<CommunityDeviceRegistration visible={visible}/>:surface==='workspace'?<CommunityWorkspace visible={visible} channels={[channel]} onOpenWorkroom={()=>{throw Error('No Workroom may open');}}/>:surface==='empty'?<CommunityWorkspace visible={visible} channels={[]} onOpenWorkroom={()=>{}}/>:surface==='dialogue'?<AgentDialoguePanel projects={[]} deviceName="시험 Mac" deviceId="fixture-device" onRenameDevice={async()=>{throw Error('No rename');}} onClose={()=>setSurface('entry')}/>:null}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
