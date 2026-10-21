import React,{useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ChevronRight,MessageSquare,Monitor,Plus,RefreshCw,Search,X} from 'lucide-react';
import {AiTerminalPanel,type AiTerminalEntry} from './AiTerminalPanel';
import {localAiTerminalTransport,type AiTerminalTransport} from './aiTerminalClient';
import {createTerminalRequester} from './aiTerminalScheduling';
import {communityTerminalTransport,communityWorkroomTransport,listCommunityControlDevices,loadCommunityRemoteProjects,type CommunityControlDevice} from './agentDialogueControlClient';
import {COMMUNITY_BYPASS_UNAVAILABLE,communityDeviceLabel} from './workroomDeviceLabel';
import {CommunityChatPanel} from './CommunityChatPanel';
import {WorkroomConversationPanel} from './WorkroomConversationPanel';
import {WorkroomRestartBanner} from './WorkroomRestartBanner';
import {AgentRuntimeClient} from '../packages/runtime-sdk/client';
import {reconcileRegisteredWorkroomTargets} from './workroomProjectMention';
import type {CommunityMentionDeviceProjects} from './workroomCommunityMention';
import type {AiTerminalRequest,AiTerminalResponse,AiTerminalSummary} from './aiTerminalProtocol';
import {openWorkroomPopout} from './workroomPopoutClient';
import {workroomPopoutTitle} from './workroomPopout';
import {WORKROOM_DEVICE_EVENT,takePendingWorkroomDeviceRequest,workroomDeviceRequest,type WorkroomDeviceRequest} from './workroomDeviceSelection';
import {SESSION_DIRECTORY_MAX_DEVICES,SessionDirectoryInventory,sessionDirectoryDeviceKey,sessionDirectoryLiveGroups,sessionDirectoryStartProjects,type SessionDirectoryDevice,type SessionDirectorySnapshot} from './workroomSessionDirectoryModel';
import {useWorkroomActivitySnapshot,useWorkroomSeen} from './useWorkroomActivity';
import type {WorkroomActivityView} from './workroomActivityProtocol';
import {workroomAttentionCount,workroomOutputAge} from './workroomActivityView';
import {sliceAcrossGroups} from './incrementalList';
import {IncrementalListMore,useIncrementalRender} from './components/IncrementalListMore';
import './WorkroomSessionDirectory.css';

type PanelProps=React.ComponentProps<typeof AiTerminalPanel>;
type OpenView={key:string;deviceId:string;entry:AiTerminalEntry;notice:string;savedTitle?:string};
type PendingEntry={id:string;key:string;deviceId:string;entry:AiTerminalEntry;label:string};
const REFRESH_MS=15_000;
const MAX_PENDING_ENTRIES=8;
const viewBinding=(value:OpenView|null)=>value?`${value.key}:${value.deviceId}:${value.entry.nonce}`:'';
const localDevice=(label?:string):SessionDirectoryDevice=>({endpointId:'',deviceId:'local',label:label?.trim()||'이 기기',local:true});
const peerDevice=(device:CommunityControlDevice):SessionDirectoryDevice=>({endpointId:device.endpointId,deviceId:device.deviceId,label:communityDeviceLabel(device.displayName),local:false});
const observedLabel=(value:number|null)=>value?new Date(value).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'아직 확인하지 않음';
const startedLabel=(value:string)=>new Date(value).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});

/** A clock for 「N분 전 출력」 that only ticks while the directory is shown. */
function useMinuteClock(active:boolean){
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{if(!active)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),15_000);return()=>clearInterval(timer);},[active]);
  return now;
}

/** Live sessions first: one line each, grouped 응답 필요 → 작업 중 → 완료 → 대기 → 종료 (the host's own activity). */
function SessionDirectoryLiveList({snapshot,query,activity,opening,now,onOpen}:{snapshot:SessionDirectorySnapshot;query:string;activity:ReadonlyMap<string,WorkroomActivityView>;opening:string;now:number;onOpen:(session:AiTerminalSummary)=>void}){
  const groups=useMemo(()=>sessionDirectoryLiveGroups(snapshot,query,activity),[snapshot,query,activity]);
  const total=groups.reduce((count,group)=>count+group.rows.length,0);
  const {limit,showMore}=useIncrementalRender(total,`${sessionDirectoryDeviceKey(snapshot.device)}:${query}`);
  const shown=sliceAcrossGroups(groups.map(group=>({key:group.id,items:group.rows})),limit);
  if(!snapshot.observedAt)return null;
  if(!total)return <p className="session-directory-live-empty">{query?'검색에 맞는 작업 세션이 없습니다.':'실행 중인 작업 세션이 없습니다.'}</p>;
  return <div className="session-directory-live" data-testid="session-directory-live">
    {shown.map(slice=>{const group=groups.find(item=>item.id===slice.key)!;return <section key={group.id} className="session-directory-live-group" data-testid="session-directory-live-group" data-group={group.id} aria-label={`${group.title} ${slice.total}개`}>
      <h4>{group.title}<small>{slice.total}</small></h4>
      <ul>{slice.items.map(row=><li key={row.key}><button type="button" className="session-directory-row" data-testid="session-directory-row" data-session-key={row.key} data-activity={row.presentation.tone} disabled={!!opening} title={[row.targetLabel,row.session.accountLabel,`${startedLabel(row.session.createdAt)} 시작`].filter(Boolean).join(' · ')} onClick={()=>onOpen(row.session)}>
        <span className={`session-directory-state session-directory-state--${row.presentation.tone}`} aria-hidden="true"/>
        <span className="session-directory-row-state" data-testid="session-directory-row-state">{row.presentation.label}</span>
        <span className="session-directory-row-title">{row.label}</span>
        <span className="session-directory-row-meta">{row.activity?workroomOutputAge(row.activity.lastOutputAt,now):`${startedLabel(row.session.createdAt)} 시작`}</span>
        <ChevronRight size={15}/>
      </button></li>)}</ul>
    </section>;})}
    <IncrementalListMore shown={limit} total={total} onMore={showMore} testId="session-directory-live-more"/>
  </div>;
}

/** Starting a conversation in a project with no live session: folded below everything else. */
function SessionDirectoryStartList({snapshot,query,onStart}:{snapshot:SessionDirectorySnapshot;query:string;onStart:(targetId:string)=>void}){
  const projects=useMemo(()=>sessionDirectoryStartProjects(snapshot,query),[snapshot,query]);
  const {limit,showMore}=useIncrementalRender(projects.length,`${sessionDirectoryDeviceKey(snapshot.device)}:${query}`);
  if(!projects.length)return null;
  return <details className="session-directory-start" data-testid="session-directory-start">
    <summary>프로젝트에서 새 대화 시작<small>{projects.length}개</small></summary>
    <ul>{projects.slice(0,limit).map(project=><li key={project.targetId}><button type="button" className="session-directory-new" data-testid="session-directory-start-project" onClick={()=>onStart(project.targetId)}><Plus size={14}/>{project.label}</button></li>)}</ul>
    <IncrementalListMore shown={limit} total={projects.length} onMore={showMore} testId="session-directory-start-more"/>
  </details>;
}

/** Project conversations across the current Mac and community Macs; viewing never starts a CLI. */
export function WorkroomSessionDirectory(props:PanelProps&{onEntryConsumed?:(nonce:number)=>void}){
  const [documentVisible,setDocumentVisible]=useState(()=>typeof document==='undefined'||document.visibilityState!=='hidden');
  const visible=props.visible!==false&&documentVisible;
  const propsRef=useRef(props);propsRef.current=props;
  const [snapshots,setSnapshots]=useState<SessionDirectorySnapshot[]>([]);
  const [devices,setDevices]=useState<CommunityControlDevice[]>([]);
  const devicesRef=useRef(devices);devicesRef.current=devices;
  const [unread,setUnread]=useState(0);
  const [deviceError,setDeviceError]=useState('');
  const [deviceLoading,setDeviceLoading]=useState(false);
  const [limited,setLimited]=useState(false);
  const [filter,setFilter]=useState('all');
  const [query,setQuery]=useState('');
  const activity=useWorkroomActivitySnapshot();
  const [savedOpen,setSavedOpen]=useState(false);
  const [savedSummary,setSavedSummary]=useState<{count:number;more:boolean;pending:number;loaded:boolean}|null>(null);
  const [view,setView]=useState<OpenView|null>(null);
  const [viewOpen,setViewOpen]=useState(false);
  const viewRef=useRef(view);viewRef.current=view;
  const [draftDirty,setDraftDirty]=useState(false);
  const dirtyRef=useRef({binding:'',dirty:false});
  const [pendingEntries,setPendingEntries]=useState<PendingEntry[]>([]);
  const pendingEntriesRef=useRef(pendingEntries);pendingEntriesRef.current=pendingEntries;
  const [activeSession,setActiveSession]=useState<{id:string;label:string}|null>(null);
  const activeSessionId=useRef<string|null>(null);
  const [notice,setNotice]=useState('');
  const [opening,setOpening]=useState('');
  const [pendingDevice,setPendingDevice]=useState<WorkroomDeviceRequest|null>(()=>takePendingWorkroomDeviceRequest());
  const inventory=useRef<SessionDirectoryInventory|null>(null);
  const refreshAll=useRef<()=>void>(()=>{});
  const nonce=useRef(0),actionGeneration=useRef(0),entryApplied=useRef<number|undefined>(undefined);
  const dialog=useRef<HTMLDialogElement>(null);
  const requesters=useRef(new Map<string,{deviceId:string;request:(request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>}>());
  const snapshotsRef=useRef(snapshots);snapshotsRef.current=snapshots;
  // Keep one open view's owner and draft when that Mac leaves the community roster.
  const retainedViewSnapshot=useRef<SessionDirectorySnapshot|null>(null);
  useEffect(()=>{const onVisibility=()=>setDocumentVisible(document.visibilityState!=='hidden');document.addEventListener('visibilitychange',onVisibility);return()=>document.removeEventListener('visibilitychange',onVisibility);},[]);
  const assertDeviceOwner=useCallback((device:SessionDirectoryDevice)=>{
    if(!device.local&&devicesRef.current.find(peer=>peer.endpointId===device.endpointId)?.deviceId!==device.deviceId)throw new Error('대상 기기의 연결 소유자를 다시 확인하세요. 작성한 요청은 보존했습니다.');
  },[]);
  const ownedTerminalTransport=useCallback((device:SessionDirectoryDevice):AiTerminalTransport=>{
    const transport=device.local?localAiTerminalTransport:communityTerminalTransport(device.endpointId);
    return request=>{assertDeviceOwner(device);return transport(request);};
  },[assertDeviceOwner]);
  const requester=useCallback((key:string,deviceId?:string)=>{
    const owner=key==='local'?'local':deviceId??devicesRef.current.find(peer=>peer.endpointId===key)?.deviceId??'';
    const prior=requesters.current.get(key);if(prior?.deviceId===owner)return prior.request;
    const next=createTerminalRequester(ownedTerminalTransport({endpointId:key,deviceId:owner,label:'',local:key==='local'}),key!=='local');
    requesters.current.set(key,{deviceId:owner,request:next});return next;
  },[ownedTerminalTransport]);

  useEffect(()=>{
    if(!visible)return;
    let alive=true,listFlight:Promise<void>|null=null;
    const current=new SessionDirectoryInventory(async device=>{
      const key=sessionDirectoryDeviceKey(device);
      if(device.local){
        const [result,targets]=await Promise.all([requester(key,device.deviceId)({operation:'list'}),new AgentRuntimeClient().targets().catch(()=>null)]);
        if(!result.sessions)throw new Error('이 기기의 대화 세션 목록을 확인하지 못했습니다.');
        const supplied=propsRef.current.projects;
        const discovered=targets?.targets.map(target=>({targetId:target.targetId,projectTargetId:target.projectTargetId,label:target.label,scope:target.scope,worktreeCapable:target.worktreeCapable,...(target.branch?{branch:target.branch}:{})}));
        return {projects:discovered?reconcileRegisteredWorkroomTargets(supplied,discovered):supplied,sessions:result.sessions,opsTargetId:propsRef.current.opsTargetId??null};
      }
      const [projectList,result]=await Promise.all([loadCommunityRemoteProjects(device.endpointId),requester(key,device.deviceId)({operation:'list'})]);
      if(!result.sessions)throw new Error('그 기기의 대화 세션 목록을 확인하지 못했습니다.');
      return {projects:projectList.projects,sessions:result.sessions,opsTargetId:projectList.opsTargetId};
    },()=>{if(alive)setSnapshots(current.snapshots());},Date.now,snapshotsRef.current);
    inventory.current=current;
    const configure=(peers:readonly CommunityControlDevice[])=>current.configure([localDevice(propsRef.current.deviceName),...peers.map(peerDevice)]);
    configure(devicesRef.current);void current.refresh();
    const loadDevices=()=>{
      if(listFlight)return listFlight;
      setDeviceLoading(true);
      listFlight=listCommunityControlDevices().then(result=>{
        if(!alive)return;
        const peers=result.devices.slice(0,SESSION_DIRECTORY_MAX_DEVICES-1);
        setLimited(result.devices.length>peers.length);setDevices(peers);devicesRef.current=peers;
        setUnread(result.unread);setDeviceError('');configure(peers);
        const keys=new Set(['local',...peers.map(peer=>peer.endpointId)]);
        for(const key of requesters.current.keys())if(!keys.has(key))requesters.current.delete(key);
        setFilter(previous=>previous==='all'||keys.has(previous)?previous:'all');
        setPendingDevice(previous=>{if(previous?.device&&!keys.has(previous.device)){setNotice('요청한 기기가 현재 연결 목록에 없습니다. 기기를 다시 선택해 주세요.');return null;}return previous;});
        void current.refresh();
      }).catch(error=>{if(alive)setDeviceError(error instanceof Error?error.message:'함께 연결된 기기를 확인하지 못했습니다.');})
        .finally(()=>{listFlight=null;if(alive)setDeviceLoading(false);});
      return listFlight;
    };
    const refresh=()=>{void current.refresh();void loadDevices();};
    refreshAll.current=refresh;void loadDevices();
    const timer=setInterval(refresh,REFRESH_MS);
    return()=>{alive=false;clearInterval(timer);current.dispose();if(inventory.current===current)inventory.current=null;refreshAll.current=()=>{};actionGeneration.current++;};
  },[visible,requester]);

  // A changed registry is authoritative, without restarting a directory poll on every port status update.
  const projectKey=JSON.stringify([props.projects,props.deviceName,props.opsTargetId]);
  useEffect(()=>{
    const current=inventory.current;if(!current)return;
    current.configure([localDevice(propsRef.current.deviceName),...devicesRef.current.map(peerDevice)]);
    void current.refreshDevice('local');
  },[projectKey]);
  useEffect(()=>{
    const onRequest=(event:Event)=>{const request=workroomDeviceRequest((event as CustomEvent).detail);if(!request)return;takePendingWorkroomDeviceRequest();setPendingDevice(request);setFilter(request.device||'local');refreshAll.current();};
    window.addEventListener(WORKROOM_DEVICE_EVENT,onRequest);
    return()=>window.removeEventListener(WORKROOM_DEVICE_EVENT,onRequest);
  },[]);

  // Keep the last panel mounted without readers/xterm while closed, so X/Escape preserves its draft.
  const closeView=useCallback(()=>{actionGeneration.current++;setOpening('');setViewOpen(false);},[]);
  useEffect(()=>{
    const element=dialog.current;if(!element)return;
    if(visible&&viewOpen&&!element.open)element.showModal();
    else if((!visible||!viewOpen)&&element.open)element.close();
    return()=>{if(element.open)element.close();};
  },[!!view,viewOpen,visible]);
  const hasUnsentDraft=useCallback(()=>dirtyRef.current.binding===viewBinding(viewRef.current)&&dirtyRef.current.dirty,[]);
  const preserveDraft=useCallback(()=>{
    if(!hasUnsentDraft())return false;
    setNotice('작성 중인 요청을 보존했습니다. 먼저 전송하거나 비운 뒤 다른 대화를 열어 주세요.');setViewOpen(true);return true;
  },[hasUnsentDraft]);
  const replaceView=useCallback((next:OpenView)=>{
    const same=viewBinding(next)===viewBinding(viewRef.current);
    viewRef.current=next;
    if(!same){const dirty=!!next.entry.prompt?.length;dirtyRef.current={binding:viewBinding(next),dirty};setDraftDirty(dirty);setActiveSession(null);activeSessionId.current=next.entry.sessionId??null;}
    setView(next);setViewOpen(true);
  },[]);
  const holdEntry=useCallback((next:PendingEntry)=>{
    const prior=pendingEntriesRef.current;
    if(prior.some(item=>item.id===next.id))return true;
    if(prior.length>=MAX_PENDING_ENTRIES){setNotice('대기 요청이 8개입니다. 보관한 요청을 먼저 확인해 주세요. 새 요청은 아직 받아들이지 않았습니다.');return false;}
    const held=[...prior,next];pendingEntriesRef.current=held;setPendingEntries(held);
    setNotice('작성 중인 요청을 보존하고 새 요청을 대기 목록에 보관했습니다. 기존 내용을 전송하거나 비운 뒤 직접 열 수 있습니다.');return true;
  },[]);
  const openDraft=useCallback((snapshot:SessionDirectorySnapshot,entry?:AiTerminalEntry)=>{
    if(preserveDraft())return false;
    actionGeneration.current++;setOpening('');setNotice('');
    const targetId=entry?.targetId??snapshot.opsTargetId??snapshot.projects.find(project=>project.scope!=='worktree')?.targetId??snapshot.projects[0]?.targetId??'';
    replaceView({key:sessionDirectoryDeviceKey(snapshot.device),deviceId:snapshot.device.deviceId,entry:{...entry,nonce:++nonce.current,targetId},notice:''});return true;
  },[preserveDraft,replaceView]);
  useEffect(()=>{
    if(!visible||!props.entry||entryApplied.current===props.entry.nonce)return;
    const local=snapshots.find(snapshot=>snapshot.device.local);if(!local)return;
    const entry=props.entry,held=hasUnsentDraft();
    const accepted=held?holdEntry({id:`external:${entry.nonce}`,key:'local',deviceId:local.device.deviceId,entry:{...entry},label:entry.title||local.projects.find(project=>project.targetId===entry.targetId)?.label||'이 기기의 새 요청'}):openDraft(local,entry);
    if(!accepted)return;
    entryApplied.current=entry.nonce;if(!held)setFilter('local');props.onEntryConsumed?.(entry.nonce);
  },[props.entry?.nonce,snapshots,openDraft,visible,hasUnsentDraft,holdEntry,pendingEntries.length]);
  useEffect(()=>{
    if(!visible||!pendingDevice)return;
    const key=pendingDevice.device||'local';setFilter(key);
    if(!pendingDevice.ops){setPendingDevice(null);return;}
    const snapshot=snapshots.find(item=>sessionDirectoryDeviceKey(item.device)===key);
    if(!snapshot?.observedAt)return;
    if(!snapshot.opsTargetId){setNotice(`${snapshot.device.label}의 총괄 프로젝트를 확인하지 못했습니다.`);setPendingDevice(null);return;}
    const entry={nonce:0,targetId:snapshot.opsTargetId};
    const accepted=hasUnsentDraft()?holdEntry({id:`device:${key}:${pendingDevice.nonce}`,key,deviceId:snapshot.device.deviceId,entry,label:`${snapshot.device.label} 총괄 대화`}):openDraft(snapshot,entry);
    if(accepted)setPendingDevice(null);
  },[pendingDevice,snapshots,openDraft,visible,hasUnsentDraft,holdEntry,pendingEntries.length]);
  const openPending=(pending:PendingEntry)=>{
    if(preserveDraft())return;
    const snapshot=snapshotsRef.current.find(item=>sessionDirectoryDeviceKey(item.device)===pending.key);
    if(!snapshot||snapshot.device.deviceId!==pending.deviceId){setNotice('요청한 기기의 원래 소유자를 현재 목록에서 확인하지 못했습니다. 대기 요청은 보존했습니다.');return;}
    if(!openDraft(snapshot,pending.entry))return;
    const remaining=pendingEntriesRef.current.filter(item=>item.id!==pending.id);pendingEntriesRef.current=remaining;setPendingEntries(remaining);setFilter(pending.key);
  };
  const binding=viewBinding(view);
  const onDraftStateChange=useMemo(()=>{
    const bound=binding;return(dirty:boolean)=>{if(!bound||viewBinding(viewRef.current)!==bound)return;dirtyRef.current={binding:bound,dirty};setDraftDirty(dirty);};
  },[binding]);
  const onActiveSessionChange=useMemo(()=>{
    const bound=binding;return(session:{id:string;label:string}|null)=>{if(!bound||viewBinding(viewRef.current)!==bound)return;activeSessionId.current=session?.id??null;setActiveSession(session);};
  },[binding]);

  const openSession=async(snapshot:SessionDirectorySnapshot,session:AiTerminalSummary,savedTitle?:string)=>{
    const key=sessionDirectoryDeviceKey(snapshot.device);
    const same=viewRef.current?.key===key&&viewRef.current.deviceId===snapshot.device.deviceId&&activeSessionId.current===session.id;
    if(!snapshot.device.local&&!same&&preserveDraft())return;
    const action=++actionGeneration.current;
    setOpening(`${key}:${session.id}`);setNotice('');
    try{
      const fresh=await inventory.current?.refreshDevice(key);
      if(action!==actionGeneration.current)return;
      if(!fresh||fresh.error)throw new Error(fresh?.error||'그 기기의 현재 목록을 확인하지 못했습니다.');
      if(fresh.device.deviceId!==snapshot.device.deviceId)throw new Error('대상 기기의 연결 소유자가 변경됐습니다. 원래 기기를 다시 확인해 주세요.');
      const exact=fresh.sessions.find(candidate=>candidate.id===session.id&&candidate.targetId===session.targetId&&candidate.agent===session.agent);
      if(!exact)throw new Error('이 세션이 현재 목록에 없습니다. 목록을 새로고침해 주세요.');
      const project=fresh.projects.find(candidate=>candidate.targetId===exact.targetId);
      const previous=viewRef.current?.key===key&&viewRef.current.deviceId===fresh.device.deviceId&&activeSessionId.current===exact.id?viewRef.current:null;
      const entry=previous?.entry??{nonce:++nonce.current,targetId:exact.targetId,sessionId:exact.id,agent:exact.agent};
      if(fresh.device.local){
        try{
          const windowTitle=workroomPopoutTitle(project?.label??'프로젝트',exact.agent);
          await openWorkroomPopout({sessionId:exact.id,targetId:exact.targetId,agent:exact.agent,bypassPermissions:propsRef.current.bypassPermissions??true},savedTitle?`${savedTitle} · ${windowTitle}`:windowTitle);
          if(action===actionGeneration.current)setNotice(`${project?.label??'프로젝트'}의 대화 창을 열었습니다.`);
          return;
        }catch(error){
          if(action!==actionGeneration.current)return;
          if(!previous&&preserveDraft())return;
          replaceView({key,deviceId:fresh.device.deviceId,entry,savedTitle,notice:`새 창을 열지 못해 이 화면에서 크게 엽니다. ${error instanceof Error?error.message:String(error)}`});return;
        }
      }
      if(!previous&&preserveDraft())return;
      replaceView({key,deviceId:fresh.device.deviceId,entry,notice:''});
    }catch(error){if(action===actionGeneration.current)setNotice(error instanceof Error?error.message:String(error));}
    finally{if(action===actionGeneration.current)setOpening('');}
  };

  const currentViewSnapshot=view?snapshots.find(snapshot=>sessionDirectoryDeviceKey(snapshot.device)===view.key&&snapshot.device.deviceId===view.deviceId):undefined;
  if(currentViewSnapshot)retainedViewSnapshot.current=currentViewSnapshot;
  const activeSnapshot=currentViewSnapshot??(view&&retainedViewSnapshot.current&&sessionDirectoryDeviceKey(retainedViewSnapshot.current.device)===view.key&&retainedViewSnapshot.current.device.deviceId===view.deviceId?retainedViewSnapshot.current:undefined);
  const viewConnected=!!currentViewSnapshot;
  const activeTransport=useMemo(()=>activeSnapshot?ownedTerminalTransport(activeSnapshot.device):undefined,[activeSnapshot?.device.endpointId,activeSnapshot?.device.deviceId,activeSnapshot?.device.local,ownedTerminalTransport]);
  const activeWorkspaceTransport=useMemo(()=>{
    if(!activeSnapshot||activeSnapshot.device.local)return undefined;
    const device=activeSnapshot.device,transport=communityWorkroomTransport(device.endpointId);
    return ((request)=>{assertDeviceOwner(device);return transport(request);}) as typeof transport;
  },[activeSnapshot?.device.endpointId,activeSnapshot?.device.deviceId,activeSnapshot?.device.local,assertDeviceOwner]);
  const mentionDevices=useMemo<CommunityMentionDeviceProjects[]>(()=>snapshots.filter(snapshot=>sessionDirectoryDeviceKey(snapshot.device)!==view?.key).map(snapshot=>({deviceId:sessionDirectoryDeviceKey(snapshot.device),label:snapshot.device.label,...(snapshot.observedAt?{projects:snapshot.projects}:{}),...(snapshot.error?{error:snapshot.error}:{})})),[snapshots,view?.key]);
  const communityMention=useMemo(()=>mentionDevices.length?{devices:mentionDevices,requestProjects:(key:string)=>{void inventory.current?.refreshDevice(key);},requester}:undefined,[mentionDevices,requester]);
  const shown=snapshots.filter(snapshot=>filter==='all'||sessionDirectoryDeviceKey(snapshot.device)===filter);
  const totalRunning=snapshots.reduce((count,snapshot)=>count+snapshot.sessions.filter(session=>session.state==='running').length,0);
  const ended=snapshots.reduce((count,snapshot)=>count+snapshot.sessions.filter(session=>session.state==='exited').length,0);
  const refreshing=deviceLoading||snapshots.some(snapshot=>snapshot.loading);
  const attention=workroomAttentionCount(activity.sessions.values());
  const now=useMinuteClock(visible);
  const onSavedSummary=useCallback((summary:{count:number;more:boolean;pending:number;loaded:boolean})=>setSavedSummary(summary),[]);
  // Seen = this window is visible and focused and its open dialog shows the session (critique item 29).
  useWorkroomSeen(activeSession?.id,visible&&viewOpen&&!!activeSnapshot?.device.local);

  return <section className="workroom-session-directory" data-testid="session-directory">
    <header className="session-directory-header"><div><span className="session-directory-eyebrow">기기 전체의 AI 작업</span><h2>작업 세션</h2><p>진행 중인 대화를 확인하고, 필요한 작업을 이어가세요.</p></div><button type="button" className="session-directory-button session-directory-button--primary" onClick={()=>{const snapshot=snapshots.find(item=>sessionDirectoryDeviceKey(item.device)===filter)??snapshots.find(item=>item.device.local);if(snapshot)openDraft(snapshot);}} disabled={!snapshots.length}><Plus size={16}/>새 대화</button></header>
    <div className="session-directory-filters">
      <label className="session-directory-search"><Search size={16} aria-hidden="true"/><span>검색</span><input aria-label="대화 세션 검색" placeholder="프로젝트, AI, 기기 검색" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      <label>기기<select aria-label="대화 세션 기기" value={filter} onChange={event=>setFilter(event.target.value)}><option value="all">모든 기기</option>{snapshots.map(snapshot=><option key={sessionDirectoryDeviceKey(snapshot.device)} value={sessionDirectoryDeviceKey(snapshot.device)}>{snapshot.device.label}{snapshot.device.local?' (이 기기)':''}</option>)}</select></label>
      <button type="button" className="session-directory-button" aria-label="대화 세션 새로고침" onClick={()=>refreshAll.current()}><RefreshCw size={15}/>{refreshing?'확인 중…':'새로고침'}</button>
    </div>
    <p className="session-directory-summary" data-testid="session-directory-summary">실행 중 {totalRunning}개{attention>0?` · 확인할 세션 ${attention}개`:''}{ended>0?` · 종료 ${ended}개`:''} · 조회 대상 기기 {snapshots.length}개</p>
    {(deviceError||limited)&&<p className="session-directory-notice" role="status">{deviceError?`기기 목록 확인 실패: ${deviceError} 마지막으로 확인한 목록을 유지합니다.`:`한 번에 ${SESSION_DIRECTORY_MAX_DEVICES}개 기기까지 표시합니다.`}</p>}
    {view&&!viewOpen&&activeSnapshot&&<button type="button" className="session-directory-button" data-testid="session-directory-resume-view" onClick={()=>setViewOpen(true)}>대화 창 다시 보기 · {activeSnapshot.device.label}</button>}
    {!!pendingEntries.length&&<section className="session-directory-pending" data-testid="session-directory-pending" aria-label="대기 중인 요청"><strong>대기 중인 요청 {pendingEntries.length}개</strong><p>작성 중인 요청을 전송하거나 비운 뒤 원하는 요청을 열어 주세요.</p>{view&&<button type="button" className="session-directory-button" data-testid="session-directory-review-draft" onClick={()=>setViewOpen(true)}>작성 중 요청 확인</button>}<ul>{pendingEntries.map(pending=><li key={pending.id}><span>{pending.label}</span><button type="button" className="session-directory-button" data-testid="session-directory-open-pending" disabled={draftDirty} onClick={()=>openPending(pending)}>대기 요청 열기</button></li>)}</ul></section>}
    {notice&&<p className="session-directory-notice" role="status" data-testid="session-directory-notice">{notice}</p>}
    {!snapshots.length&&<p role="status">대화 세션을 불러오는 중…</p>}
    {shown.map(snapshot=>{
      const key=sessionDirectoryDeviceKey(snapshot.device);
      return <section key={key} className="session-directory-device" data-testid="session-directory-device" data-device-key={key} data-device-owner={snapshot.device.deviceId}>
        <header><h3><Monitor size={16} aria-hidden="true"/>{snapshot.device.label}{snapshot.device.local&&<small>이 기기</small>}</h3><span>{snapshot.loading?'확인 중 · ':''}확인 {observedLabel(snapshot.observedAt)}</span></header>
        {snapshot.error&&<p className="session-directory-notice" role="status">확인 실패: {snapshot.error}{snapshot.observedAt?' 이전 목록을 표시합니다.':''} <button type="button" className="session-directory-button" onClick={()=>void inventory.current?.refreshDevice(key)}>다시 확인</button></p>}
        {!snapshot.observedAt&&!snapshot.error&&<p role="status">프로젝트와 세션을 확인하고 있습니다…</p>}
        {/* Above the live list: the sessions an update (or a crash) ended, offered back once (w14). */}
        {snapshot.device.local&&<WorkroomRestartBanner visible={visible} projects={snapshot.projects} onResumed={()=>refreshAll.current()}/>}
        <SessionDirectoryLiveList snapshot={snapshot} query={query} activity={activity.sessions} opening={opening} now={now} onOpen={session=>void openSession(snapshot,session)}/>
        {snapshot.device.local&&<details className="session-directory-saved" data-testid="session-directory-saved" open={savedOpen||!!savedSummary?.pending} onToggle={event=>setSavedOpen(event.currentTarget.open)}>
          <summary>저장된 대화{savedSummary?.loaded?` ${savedSummary.count}개${savedSummary.more?' 이상':''}`:''}{savedSummary?.pending?` · 결과 확인 ${savedSummary.pending}개`:''}</summary>
          <WorkroomConversationPanel visible={visible} query={query} projects={snapshot.projects} sessions={snapshot.sessions} onOpen={(session,title)=>openSession(snapshot,session,title)} onSummary={onSavedSummary}/>
        </details>}
        <SessionDirectoryStartList snapshot={snapshot} query={query} onStart={targetId=>openDraft(snapshot,{nonce:0,targetId})}/>
      </section>;
    })}
    <details className="session-directory-help"><summary>세션 상태와 대화 저장 안내</summary><p className="session-directory-footnote">작업 세션은 응답 필요 · 작업 중 · 완료 · 응답 멈춤 · 대기 · 실행 중 · 종료 순으로 보입니다. 「완료」는 AI의 대화 기록이 작업 끝을 알린 세션이고, 「응답 멈춤」은 화면이 조용해진 것만 본 세션입니다. 상태는 이 기기의 세션만 표시하며, 종료된 세션은 호스트가 정리할 때까지 「종료」에 남습니다. 창을 닫아도 실행은 계속되고, 앱 종료 후에는 저장된 대화에서 이어 열기를 검토할 수 있습니다.</p></details>
    {devices.length>0&&<CommunityChatPanel visible={visible} unread={unread} label={`함께 있는 대상 ${devices.length}개`}/>}
    {view&&activeSnapshot&&<dialog ref={dialog} className="workroom-session-dialog" data-testid="session-directory-dialog" aria-label={`${activeSnapshot.device.label} 대화 창`} onCancel={event=>{if(event.target!==event.currentTarget)return;event.preventDefault();closeView();}}>
      <header className="workroom-session-dialog-header"><div><strong>{activeSession?.id===view.entry.sessionId&&view.savedTitle?view.savedTitle:activeSession?.label||activeSnapshot.projects.find(project=>project.targetId===view.entry.targetId)?.label||'대화 세션'}</strong><span>{activeSnapshot.device.label}</span></div><button type="button" className="session-directory-button" data-testid="session-directory-dialog-close" aria-label="대화 창 닫기" onClick={closeView}><X size={18}/></button></header>
      {view.notice&&<p className="session-directory-notice" role="status">{view.notice}</p>}
      {!viewConnected&&<p className="session-directory-notice" role="status">이 기기가 현재 커뮤니티 연결 목록에 없습니다. 작성한 요청은 보존했습니다. 다시 연결되면 같은 대화를 이어갈 수 있습니다.</p>}
      <div className="workroom-session-dialog-content"><fieldset className="session-directory-view-controls" disabled={!viewConnected}><AiTerminalPanel key={`${view.key}:${view.deviceId}`} {...props} restartBanner={undefined} popout visible={visible&&viewOpen&&viewConnected} projects={activeSnapshot.projects} entry={view.entry} sessionScope={`directory:${activeSnapshot.device.local?'local':activeSnapshot.device.deviceId}`} transport={activeTransport} workspaceTransport={activeWorkspaceTransport} remote={!activeSnapshot.device.local} slowPolling={!activeSnapshot.device.local} bypassUnavailable={activeSnapshot.device.local?props.bypassUnavailable:COMMUNITY_BYPASS_UNAVAILABLE} opsTargetId={activeSnapshot.opsTargetId??undefined} deviceName={activeSnapshot.device.label} communityMention={communityMention} onDraftStateChange={onDraftStateChange} onActiveSessionChange={onActiveSessionChange} onManageProject={activeSnapshot.device.local?props.onManageProject:undefined} onWhatISaid={activeSnapshot.device.local?props.onWhatISaid:undefined} onRememberSession={activeSnapshot.device.local?props.onRememberSession:undefined}/></fieldset></div>
    </dialog>}
  </section>;
}
