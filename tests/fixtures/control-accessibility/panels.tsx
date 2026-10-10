import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentDialoguePanel} from '../../../src/AgentDialoguePanel';
import {QrRemoteControlDialog} from '../../../src/QrRemoteControlDialog';
import {InternetQrRemoteControlDialog} from '../../../src/InternetQrRemoteControlDialog';

const fixture=window as any;
fixture.requests=[];
fixture.closeCount=0;
fixture.openWorkroomCount=0;
fixture.holdEnable=false;
fixture.releaseEnable=null;
fixture.enabled=[{target:'ops',kind:'ops',endpointId:'ops-11111111',displayName:'총괄'}];
fixture.pending=[
  {id:'request-11111111',summary:'알파 기기 요청',expiresAt:'2030-01-01T00:00:00Z',client:'Codex',connection:'알파',source:{target:'ops'},operation:'join',roomId:null},
  {id:'request-22222222',summary:'베타 기기 요청',expiresAt:'2030-01-01T00:00:00Z',client:'Codex',connection:'베타',source:{target:'ops'},operation:'join',roomId:null},
];
const peers=[
  {endpointId:'peer-11111111',displayName:'상대 알파',kind:'ops',deviceId:'device-alpha'},
  {endpointId:'peer-22222222',displayName:'상대 베타',kind:'ops',deviceId:'device-beta'},
];
fixture.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.origin).pathname;
  if(path==='/api/agent-dialogue/manage'){
    const body=JSON.parse(String(init?.body??'{}'));fixture.requests.push(body);
    if(body.operation==='enable'){
      if(fixture.holdEnable){fixture.holdEnable=false;await new Promise<void>(resolve=>{fixture.releaseEnable=resolve;});}
      const portId=body.source?.portId;
      if(portId)fixture.enabled.push({target:`project:${portId}`,kind:'project',portId,endpointId:`endpoint-${portId}`,displayName:portId});
    }
    const response=body.operation==='status'?{enabled:fixture.enabled,pending:fixture.pending,remoteRevocationPending:0}
      :body.operation==='peers'?{peers}
      :body.operation==='pairings'?{pairings:[{peerEndpointId:'peer-11111111',state:'active'},{peerEndpointId:'peer-22222222',state:'active'}]}
      :body.operation==='community-status'?{joined:false,members:[]}:{};
    return new Response(JSON.stringify({success:true,...response}),{headers:{'Content-Type':'application/json'}});
  }
  if(path.startsWith('/api/agent-runtime/terminals'))return new Response(JSON.stringify({success:true,connections:[],projects:[],workspaceRoots:[]}),{headers:{'Content-Type':'application/json'}});
  throw new Error('Unexpected network request: '+path);
};

const lanSessions=[
  {id:'lan-11111111',label:'아이폰 알파',connected:true,pairedAt:'2026-01-01T00:00:00Z',lastSeenAt:null,expiresAt:'2030-01-01T00:00:00Z'},
  {id:'lan-22222222',label:'아이폰 베타',connected:true,pairedAt:'2026-01-02T00:00:00Z',lastSeenAt:null,expiresAt:'2030-01-01T00:00:00Z'},
];
const lanApi:any={status:async()=>({enabled:true,listener:{host:'192.168.1.10',port:9001},pairing:null,sessions:lanSessions,stalled:null}),interfaces:async()=>[{address:'192.168.1.10',name:'Wi-Fi'}]};
const internetSessions=[
  {sessionId:'pending-11111111',pairingId:null,controllerId:'controller-a',controllerName:'인터넷 알파',controllerKeyFingerprint:'a',approvalState:'pending',sasCode:'123456',createdAt:'2026-01-01T00:00:00Z',expiresAt:'2030-01-01T00:00:00Z',approvedAt:null,taskScopeGranted:false,conversationScopeGranted:false},
  {sessionId:'pending-22222222',pairingId:null,controllerId:'controller-b',controllerName:'인터넷 베타',controllerKeyFingerprint:'b',approvalState:'pending',sasCode:'654321',createdAt:'2026-01-01T00:00:00Z',expiresAt:'2030-01-01T00:00:00Z',approvedAt:null,taskScopeGranted:false,conversationScopeGranted:false},
  {sessionId:'approved-33333333',pairingId:null,controllerId:'controller-c',controllerName:'연결 감마',controllerKeyFingerprint:'c',approvalState:'approved',sasCode:null,createdAt:'2026-01-01T00:00:00Z',expiresAt:'2030-01-01T00:00:00Z',approvedAt:'2026-01-01T00:00:00Z',taskScopeGranted:false,conversationScopeGranted:false},
  {sessionId:'approved-44444444',pairingId:null,controllerId:'controller-d',controllerName:'연결 델타',controllerKeyFingerprint:'d',approvalState:'approved',sasCode:null,createdAt:'2026-01-01T00:00:00Z',expiresAt:'2030-01-01T00:00:00Z',approvedAt:'2026-01-01T00:00:00Z',taskScopeGranted:false,conversationScopeGranted:false},
];
const internetApi:any={status:async()=>({status:{enabled:true,state:'approval-required',controllerUrl:null,hostExpiresAt:'2030-01-01T00:00:00Z',pairingExpiresAt:null,lastRelayContactAt:null,sessions:internetSessions,error:null},suggestedControllerOrigin:null})};
const mode=new URL(location.href).searchParams.get('panel');
function Fixture(){
  const [open,setOpen]=React.useState(true);
  const onClose=()=>{fixture.closeCount++;setOpen(false);};
  if(!open)return <p>닫힘</p>;
  if(mode==='dialogue')return <AgentDialoguePanel projects={[{id:'project-a',name:'프로젝트 알파'},{id:'project-b',name:'프로젝트 베타'}]} opsProjectId={null} deviceName="이 기기" deviceId="device-local" onRenameDevice={async()=>{}} onClose={onClose}/>;
  if(mode==='lan')return <QrRemoteControlDialog open onClose={onClose} api={lanApi}/>;
  return <InternetQrRemoteControlDialog open onClose={onClose} onOpenWorkroom={()=>{fixture.openWorkroomCount++;}} api={internetApi}/>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
