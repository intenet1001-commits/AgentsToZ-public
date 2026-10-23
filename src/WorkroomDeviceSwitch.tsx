import {projectStateRequest} from './projectStateBundleClient';
import {readToolBatchRequest} from './readToolBatchClient';
import {workPackClient} from './workPackClient';
import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowLeft,MessagesSquare,Terminal} from 'lucide-react';
import {AiTerminalPanel} from './AiTerminalPanel';
import {localAiTerminalTransport} from './aiTerminalClient';
import {createTerminalRequester} from './aiTerminalScheduling';
import {communityTerminalTransport,communityWorkroomTransport,listCommunityControlDevices,loadCommunityRemoteProjects,
  type CommunityControlDevice,type CommunityRemoteProjects} from './agentDialogueControlClient';
import {COMMUNITY_BYPASS_UNAVAILABLE,communityDeviceLabel} from './workroomDeviceLabel';
import {WORKROOM_EFFORT_ELSEWHERE} from './workroomEffortView';
import {CommunityChatPanel} from './CommunityChatPanel';
import {WORKROOM_DEVICE_EVENT,WORKROOM_DEVICE_STORAGE_KEY,takePendingWorkroomDeviceRequest,workroomDeviceRequest} from './workroomDeviceSelection';
import type {CommunityMentionDeviceProjects} from './workroomCommunityMention';
import type {AiTerminalRequest,AiTerminalResponse} from './aiTerminalProtocol';
import {WorkroomSessionDirectory} from './WorkroomSessionDirectory';
import {CommunityWorkspace,type CommunityWorkspaceChannel} from './CommunityWorkspace';
import {localWorkroomTransport} from './aiTerminalClient';
import {AgentRuntimeClient} from './agentRuntimeClient';
import {reconcileRegisteredWorkroomTargets} from './workroomProjectMention';
import {SERVICE_USE_CHANGED_EVENT} from './projectUseMention';
import {openWorkroomPopout} from './workroomPopoutClient';
import {workroomPopoutTitle} from './workroomPopout';
import type {WorkroomThreadSummary} from './workroomThreadProtocol';

type PanelProps=React.ComponentProps<typeof AiTerminalPanel>;
type SwitchProps=PanelProps&{sessionDirectory?:boolean;initialDevice?:string;onEntryConsumed?:(nonce:number)=>void};
const SELECTED_KEY=WORKROOM_DEVICE_STORAGE_KEY;
const DEVICES_REFRESH_MS=15_000;
const readSelected=()=>{try{return sessionStorage.getItem(SELECTED_KEY)??'';}catch{return '';}};
const writeSelected=(value:string)=>{try{value?sessionStorage.setItem(SELECTED_KEY,value):sessionStorage.removeItem(SELECTED_KEY);}catch{/* per-window convenience only */}};

/**
 * The Workroom with a 「기기」 choice: this Mac, or another Mac in the same community. Another Mac's
 * Workroom is the same screen the phone portal uses (`remote`), only its requests go through the
 * community control mailbox instead of the phone relay. With no other device in the community the
 * selector is not shown at all and this is exactly the old Workroom.
 */
export function WorkroomDeviceSwitch({sessionDirectory=false,initialDevice,onEntryConsumed,...props}:SwitchProps){
  const [useRevision,setUseRevision]=useState(0);
  useEffect(()=>{const changed=()=>setUseRevision(n=>n+1);window.addEventListener(SERVICE_USE_CHANGED_EVENT,changed);return()=>window.removeEventListener(SERVICE_USE_CHANGED_EVENT,changed);},[]);
  const [hub,setHub]=useState(false),[peers,setPeers]=useState<CommunityControlDevice[]>([]);
  const [threadView,setThreadView]=useState<{channel:CommunityWorkspaceChannel;targetId:string;thread:WorkroomThreadSummary}|null>(null);
  const [threadOpen,setThreadOpen]=useState(false),[notice,setNotice]=useState('');
  const dialog=useRef<HTMLDialogElement>(null),visible=props.visible!==false;
  useEffect(()=>{if(!visible||!hub)return;let alive=true,flight=false;const load=()=>{if(flight)return;flight=true;void listCommunityControlDevices().then(r=>{if(alive)setPeers(prior=>JSON.stringify(prior)===JSON.stringify(r.devices)?prior:r.devices);}).catch(e=>{if(alive)setNotice(e instanceof Error?e.message:String(e));}).finally(()=>{flight=false;});};load();const timer=setInterval(load,15000);return()=>{alive=false;clearInterval(timer);};},[visible,hub]);
  useEffect(()=>{if(props.entry)setHub(false);},[props.entry?.nonce]);
  const channels=useMemo<CommunityWorkspaceChannel[]>(()=>[
    {id:'local',projectState:projectStateRequest,readToolBatch:readToolBatchRequest,workPacks:workPackClient,label:props.deviceName?.trim()||'이 기기',projectRevision:JSON.stringify([props.projects,useRevision]),projects:async()=>reconcileRegisteredWorkroomTargets(props.projects,(await new AgentRuntimeClient().targets({includeProductUses:true})).targets),transport:props.workspaceTransport??localWorkroomTransport},
    ...peers.map(peer=>({id:peer.endpointId,label:communityDeviceLabel(peer.displayName),projects:async()=>(await loadCommunityRemoteProjects(peer.endpointId)).projects,transport:communityWorkroomTransport(peer.endpointId)})),
  ],[props.projects,props.deviceName,props.workspaceTransport,peers,useRevision]);
  useEffect(()=>{const el=dialog.current;if(!el)return;if(threadOpen&&visible&&!el.open)el.showModal();else if((!threadOpen||!visible)&&el.open)el.close();},[threadOpen,visible]);
  const openThread=async(id:string,targetId:string,thread:WorkroomThreadSummary)=>{
    if(!thread.sessionId)return;const channel=channels.find(c=>c.id===id);if(!channel)return;
    if(id==='local')try{await openWorkroomPopout({sessionId:thread.sessionId,targetId,agent:thread.agent,bypassPermissions:false},workroomPopoutTitle(thread.title,thread.agent));return;}catch{setNotice('새 창을 열지 못해 이 화면에서 연결 워크룸을 엽니다.');}
    setThreadView({channel,targetId,thread});setThreadOpen(true);
  };
  return <>
    {!props.popout&&<nav className="community-entry" aria-label="대화 보기"><button type="button" aria-pressed={!hub} onClick={()=>setHub(false)}><Terminal size={16} aria-hidden="true"/>작업 세션</button><button type="button" aria-pressed={hub} onClick={()=>setHub(true)}><MessagesSquare size={16} aria-hidden="true"/>커뮤니티 · 업무 스레드</button></nav>}
    {notice&&<p role="status">{notice}</p>}
    <div hidden={hub}>{sessionDirectory?<WorkroomSessionDirectory {...props} visible={visible&&!hub} onEntryConsumed={onEntryConsumed}/>:<WorkroomDeviceWorkspace {...props} visible={visible&&!hub} initialDevice={initialDevice}/>}</div>
    <div hidden={!hub}><CommunityWorkspace channels={channels} visible={visible&&hub} onOpenWorkroom={(id,target,thread)=>void openThread(id,target,thread)}/></div>
    <dialog ref={dialog} className="community-workroom-dialog" aria-label={threadView?threadView.thread.title+' · 연결 워크룸':'연결 워크룸'} onCancel={()=>setThreadOpen(false)} onClose={()=>setThreadOpen(false)}>
      <button type="button" onClick={()=>setThreadOpen(false)}><ArrowLeft size={15} aria-hidden="true"/>워크룸 보기 닫기</button>
      {threadView&&<AiTerminalPanel key={threadView.channel.id+':'+threadView.thread.id} projects={[{targetId:threadView.targetId,label:threadView.thread.title}]} visible={visible&&threadOpen} remote={threadView.channel.id!=='local'} slowPolling={threadView.channel.id!=='local'} sessionScope={'community-thread:'+threadView.channel.id}
        transport={threadView.channel.id==='local'?props.transport??localAiTerminalTransport:communityTerminalTransport(threadView.channel.id)} workspaceTransport={threadView.channel.transport} deviceName={threadView.channel.label}
        bypassUnavailable={threadView.channel.id==='local'?undefined:COMMUNITY_BYPASS_UNAVAILABLE} effortReadOnly={threadView.channel.id==='local'?undefined:WORKROOM_EFFORT_ELSEWHERE}
        entry={{nonce:1,targetId:threadView.targetId,sessionId:threadView.thread.sessionId!,agent:threadView.thread.agent}}/>}
    </dialog>
  </>;
}

function WorkroomDeviceWorkspace(props:PanelProps&{initialDevice?:string}){
  const [devices,setDevices]=useState<CommunityControlDevice[]>([]);
  const [unread,setUnread]=useState(0);
  // A local opaque pop-out route must not inherit a peer selected in its opener's sessionStorage.
  const [selected,setSelected]=useState(()=>props.initialDevice??readSelected());
  const [remote,setRemote]=useState<{endpointId:string;loading:boolean;error:string;value:CommunityRemoteProjects|null}|null>(null);
  const visible=props.visible!==false;

  useEffect(()=>{
    if(!visible)return;
    let alive=true;
    // ⚠️ A failed refresh keeps the last list. Emptying it dropped the selected Mac for one render,
    // which swapped in this Mac's panel and back — remounting the screen, losing its scroll and any
    // open dialog (seen on 1호 → 3호: the end-session confirmation vanished). Only a successful list
    // that no longer has the device moves back to this Mac. An unchanged list keeps its identity.
    const load=()=>listCommunityControlDevices().then(result=>{
      if(!alive)return;
      awaitingList.current=false;
      setDevices(prior=>JSON.stringify(prior)===JSON.stringify(result.devices)?prior:result.devices);
      // 읽지 않음은 이 조회의 덤이다 — 대화창이 접혀 있는 동안 따로 두드리지 않기 위한 것이다.
      setUnread(result.unread);
    }).catch(()=>{/* keep the last known list */});
    reloadDevices.current=()=>void load();
    void load();const timer=setInterval(load,DEVICES_REFRESH_MS);
    return ()=>{alive=false;clearInterval(timer);reloadDevices.current=()=>{};};
  },[visible]);

  // 「아젠투지 호출 → OPS 워크룸 열기 · 3호」가 보내는 요청. 기기를 고르고, ops면 목록이 온 뒤
  // 그 기기의 OPS 프로젝트를 한 번 골라 준다(`entry`).
  // The dock may ask before this screen exists (it loads lazily on first use): take that request on mount.
  const [opsRequest,setOpsRequest]=useState<number>(()=>{const pending=takePendingWorkroomDeviceRequest();return props.initialDevice===undefined&&pending?.ops?pending.nonce:0;});
  const reloadDevices=useRef<()=>void>(()=>{});
  // A request can name a device this screen's list (refreshed every 15s) has not seen yet. Until the next
  // list arrives that is not «the device left» — resetting here silently dropped the request (2026-10-06 review).
  const awaitingList=useRef(false);
  useEffect(()=>{
    const onRequest=(event:Event)=>{
      const request=workroomDeviceRequest((event as CustomEvent).detail);
      if(!request)return;
      takePendingWorkroomDeviceRequest(); // this screen took it; a later mount must not replay it
      setSelected(request.device);writeSelected(request.device);
      setOpsRequest(request.ops?request.nonce:0);
      awaitingList.current=true;reloadDevices.current();
    };
    window.addEventListener(WORKROOM_DEVICE_EVENT,onRequest);
    return ()=>window.removeEventListener(WORKROOM_DEVICE_EVENT,onRequest);
  },[]);
  const device=devices.find(item=>item.endpointId===selected)??null;
  // A device that left the community drops back to this Mac rather than leaving a dead screen.
  useEffect(()=>{if(selected&&devices.length&&!device&&!awaitingList.current){setSelected('');writeSelected('');}},[selected,devices,device]);

  const loadRemote=useCallback((endpointId:string)=>{
    setRemote(prior=>({endpointId,loading:true,error:'',value:prior?.endpointId===endpointId?prior.value:null}));
    loadCommunityRemoteProjects(endpointId)
      .then(value=>setRemote(prior=>prior?.endpointId===endpointId?{endpointId,loading:false,error:'',value}:prior))
      .catch(error=>setRemote(prior=>prior?.endpointId===endpointId?{endpointId,loading:false,
        error:error instanceof Error?error.message:'프로젝트 목록을 불러오지 못했습니다.',value:prior.value}:prior));
  },[]);
  useEffect(()=>{if(device)loadRemote(device.endpointId);else setRemote(null);},[device?.endpointId,loadRemote]);

  const transports=useMemo(()=>device?{terminal:communityTerminalTransport(device.endpointId),
    workroom:communityWorkroomTransport(device.endpointId)}:null,[device?.endpointId]);

  // 커뮤니티 차원의 `@`·`#`(2026-10-05) — 입력칸에서 「2호 @…」를 쓸 수 있게, 기기마다 프로젝트 목록을
  // **쓸 때 한 번** 받아 둔다. 고른 기기의 목록은 위 `loadRemote`가 이미 받으므로 그것을 그대로 쓴다.
  const [mentionProjects,setMentionProjects]=useState<Record<string,{projects?:CommunityRemoteProjects['projects'];error?:string}>>({});
  const mentionProjectsRef=useRef(mentionProjects);mentionProjectsRef.current=mentionProjects;
  const mentionInFlight=useRef(new Set<string>());
  const requestMentionProjects=useCallback((endpointId:string)=>{
    // 한 번 받은 목록은 다시 묻지 않는다. 실패한 기기는 다시 쓸 때 한 번 더 시도한다.
    if(mentionInFlight.current.has(endpointId)||mentionProjectsRef.current[endpointId]?.projects)return;
    mentionInFlight.current.add(endpointId);
    loadCommunityRemoteProjects(endpointId)
      .then(value=>setMentionProjects(prior=>({...prior,[endpointId]:{projects:value.projects}})))
      .catch(error=>setMentionProjects(prior=>({...prior,[endpointId]:{
        error:error instanceof Error?error.message:'그 아젠투지의 프로젝트 목록을 받지 못했습니다.'}})))
      .finally(()=>{mentionInFlight.current.delete(endpointId);});
  },[]);
  // 기기 손잡이는 `endpointId`다 — 이 목록은 화면 안에서만 쓰이고 세션·요청에는 실리지 않는다.
  // 지금 몰고 있는 기기는 목록에서 뺀다(그 기기의 프로젝트는 그냥 `@프로젝트`다). 다른 기기를 몰고
  // 있을 때는 **이 Mac**이 `@` 대상이 되므로 `local` 줄로 넣는다.
  const mentionDevices=useMemo<CommunityMentionDeviceProjects[]>(()=>{
    const rows:CommunityMentionDeviceProjects[]=[];
    if(device)rows.push({deviceId:'local',label:props.deviceName?.trim()||'이 기기',projects:props.projects,sessionScope:props.sessionScope??'local'});
    for(const item of devices){
      if(device&&item.endpointId===device.endpointId)continue;
      const cached=mentionProjects[item.endpointId];
      rows.push({deviceId:item.endpointId,label:communityDeviceLabel(item.displayName),sessionScope:'community:'+item.deviceId,
        ...(cached?.projects?{projects:cached.projects}:{}),...(cached?.error?{error:cached.error}:{})});
    }
    return rows;
  },[device?.endpointId,devices,mentionProjects,props.deviceName,props.projects,props.sessionScope]);
  // ⚠️ 기기마다 **한 번만** 만든다 — 요청 함수가 순서를 지키는 대기열을 들고 있어서, 새로 만들면
  // 같은 기기에 보내는 요청들이 서로의 순서를 모른다.
  const requesters=useRef(new Map<string,(request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>>());
  const mentionRequester=useCallback((deviceId:string)=>{
    const cached=requesters.current.get(deviceId);
    if(cached)return cached;
    const made=deviceId==='local'?createTerminalRequester(localAiTerminalTransport,false)
      :createTerminalRequester(communityTerminalTransport(deviceId),true);
    requesters.current.set(deviceId,made);
    return made;
  },[]);
  const communityMention=useMemo(()=>mentionDevices.length?{devices:mentionDevices,
    requestProjects:(deviceId:string)=>{if(deviceId!=='local')requestMentionProjects(deviceId);},
    requester:mentionRequester,workspaceRequester:(deviceId:string)=>deviceId==='local'?props.workspaceTransport??localWorkroomTransport:communityWorkroomTransport(deviceId)}:undefined,[mentionDevices,requestMentionProjects,mentionRequester,props.workspaceTransport]);

  const choose=(value:string)=>{setSelected(value);writeSelected(value);};
  const localLabel=props.deviceName?.trim()?`${props.deviceName.trim()} (이 기기)`:'이 기기';
  // 기기는 **탭**이다 — 두 번 누르는 드롭다운보다 한 번에 바뀌고, 어느 호가 있는지 한눈에 보인다
  // (VOC 2026-10-05). 기기가 하나도 없으면 줄 자체가 없어 예전 화면과 같다.
  const switcher=devices.length>0?<div className="ai-terminal-field ai-terminal-field--device" data-testid="workroom-device-switch">
    <span className="ai-terminal-label">기기</span>
    <div className="ai-terminal-devices" role="group" aria-label="워크룸 기기" data-testid="workroom-device-tabs">
      <button type="button" className="ai-terminal-device-tab" aria-pressed={!device} data-testid="workroom-device-tab-local" onClick={()=>choose('')}>{localLabel}</button>
      {devices.map(item=><button key={item.endpointId} type="button" className="ai-terminal-device-tab"
        aria-pressed={device?.endpointId===item.endpointId} data-testid={'workroom-device-tab-'+item.deviceId}
        title={`${communityDeviceLabel(item.displayName)}의 워크룸에서 실행합니다.`} onClick={()=>choose(item.endpointId)}>{communityDeviceLabel(item.displayName)}</button>)}
    </div>
    {device&&remote?.loading&&<span className="ai-terminal-hint" data-testid="workroom-device-loading">{communityDeviceLabel(device.displayName)}의 프로젝트를 불러오는 중…</span>}
    {device&&remote?.error&&<span className="ai-terminal-hint ai-terminal-hint--error" role="alert" data-testid="workroom-device-error">
      {remote.error} <button type="button" className="ai-terminal-btn" onClick={()=>loadRemote(device.endpointId)}>다시 시도</button></span>}
    {device&&!remote?.loading&&!remote?.error&&<span className="ai-terminal-hint" data-testid="workroom-device-remote-note">이 화면의 터미널은 {communityDeviceLabel(device.displayName)}에서 실행됩니다.</span>}
    {/* 대화창은 「기기」 줄 바로 아래다 — 다른 호를 생각하는 자리가 여기이기 때문이다. 접혀 있으면 한 줄만
        차지하고, 읽을 것이 있으면 그 줄이 개수를 말한다(VOC 2026-10-05). */}
    <CommunityChatPanel visible={visible} unread={unread} label={`함께 있는 대상 ${devices.length}개`}/>
  </div>:null;

  if(!device||!transports)return <AiTerminalPanel {...props} deviceSwitch={switcher} communityMention={communityMention}/>;
  const value=remote?.endpointId===device.endpointId?remote.value:null;
  // OPS를 함께 고르라는 요청이 있었고 목록이 왔으면 그 프로젝트를 한 번 고른다.
  const entry=opsRequest&&value?.opsTargetId?{nonce:opsRequest,targetId:value.opsTargetId}:props.entry;
  return <AiTerminalPanel key={'community:'+device.deviceId} remote slowPolling popout={props.popout} visible={props.visible} entry={entry}
    onActiveSessionChange={props.onActiveSessionChange}
    bypassPermissions={props.bypassPermissions} onBypassPermissionsChange={props.onBypassPermissionsChange}
    bypassUnavailable={COMMUNITY_BYPASS_UNAVAILABLE} effortReadOnly={WORKROOM_EFFORT_ELSEWHERE}
    projects={value?.projects??[]} opsTargetId={value?.opsTargetId??undefined}
    deviceName={value?.deviceName??communityDeviceLabel(device.displayName)}
    sessionScope={'community:'+device.deviceId} transport={transports.terminal} workspaceTransport={transports.workroom}
    deviceSwitch={switcher} communityMention={communityMention}/>;
}
