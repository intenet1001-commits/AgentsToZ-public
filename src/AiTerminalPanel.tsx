import { workroomSessionLabels, workroomSessionStartedAt } from './workroomSessionLabel';
import {aiTerminalAgentLabel} from './aiTerminalAgentLabel';
import {workroomSessionOwner} from './workroomSessionOwner';
import {ErrorVocActions} from './RemoteVocComposer';
import {VoiceSentReceipt} from './VoiceSessionPanel';
import {WorkroomSessionFooter,type WorkroomTransport} from './WorkroomSessionFooter';
import {WorkroomSharedShellPanel} from './WorkroomSharedShellPanel';
import {codexContextUsedFromFooter} from './workroomSessionStatus';
import type {MobileWorkspaceScope} from './mobileWorkspaceProtocol';
import {singleFlight} from './singleFlight';
import {AgentRuntimeClient} from '../packages/runtime-sdk/client';
import React, {useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import {AtSign, ExternalLink, Hash, ImagePlus, Maximize2, Mic, Minimize2, Plus, RotateCcw, RotateCw, Send} from 'lucide-react';
import {WORKROOM_AGENT_NAMES,workroomPopoutAvailability,workroomPopoutTitle} from './workroomPopout';
import {openWorkroomPopout} from './workroomPopoutClient';
import {isTauri} from './lib/env';
import {WORKROOM_MODEL_COMMANDS,WORKROOM_SLASH_COMMANDS,cliInfoFromScreen,isWorkroomPaletteCommand,readSlashFavorites,slashCommandCandidates,toggleSlashFavorite,workroomMemoryCommand,type WorkroomCliInfo} from './workroomCliCommands';
import {WORKROOM_FONT_DEFAULT,WORKROOM_FONT_MAX,WORKROOM_FONT_MIN,initialWorkroomFontSize,readWorkroomWide,stepWorkroomFontSize,workroomPreferenceStorage,writeWorkroomFontSize,writeWorkroomRemoteFontSize,writeWorkroomWide} from './workroomTerminalView';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './AiTerminalPanel.css';
import {AI_TERMINAL_AGENTS, AI_TERMINAL_MAX_REFERENCES, AI_TERMINAL_PREFIX, AI_TERMINAL_UNKNOWN_REQUEST_ERROR, aiTerminalSnapshotUnsupported, type AiTerminalAgent,type AiTerminalRequest,type AiTerminalResponse,type AiTerminalSummary} from './aiTerminalProtocol';
import {WORKROOM_CAPTURE_LABELS,WORKROOM_CAPTURE_SHORTCUTS,WORKROOM_IMAGE_MAX_ATTACHMENTS,workroomCaptureShortcut,workroomImageFiles,workroomImageMessage,type WorkroomCaptureMode,type WorkroomImageAttachment} from './workroomImageAttachments';
import {captureWorkroomScreen,saveWorkroomImageBlob} from './workroomImageClient';
import {workroomRestartConfirm,workroomRestartNotice,workroomRestartTitle} from './workroomRestart';
import {WORKROOM_COMPOSER_KEYS_HINT,workroomComposerKeyToCli} from './workroomComposerKeys';
import {aiTerminalSupportsPrompt} from './aiTerminalPromptArgs';
import {createTerminalCompositionOverlapFilter,createTerminalHangulInputFallback,splitTerminalInput,splitTerminalSubmission} from './aiTerminalInput';
import {localAiTerminalTransport,localWorkroomTransport,requestWorkroomAppDispatch,terminalLocalRequest,type AiTerminalTransport} from './aiTerminalClient';
import {WORKROOM_APP_AGENTS,WORKROOM_APP_NAMES,workroomAppAgentOf,workroomAppChoice,workroomAppConfirmMessage,workroomAppFailureText,workroomAppReceipt,workroomAppRoutePreview,workroomAppRoutesAvailable,workroomAppSendLabel,workroomAppTakesTask,workroomAppTaskKept,workroomCliAgentOf,type WorkroomAppAgent,type WorkroomAppClipboardState,type WorkroomRouteChoice} from './workroomAppRoute';
import {TerminalMemoryStatus} from './TerminalMemoryStatus';
import {buildWorkroomMemoryReviewPrompt,type WorkroomMemoryReviewTarget} from './workroomMemoryReview';
import {reconcileTerminalSummaries} from './terminalSummaryReconciliation';
import {HELD_PART_NOTICE,createTerminalRequester,createTerminalReadCadence,terminalSubmissionGroup,type TerminalSubmissionGroup} from './aiTerminalScheduling';
import {offlineInputNotice,phoneIsOnline} from './phoneNetwork';

/**
 * An input error the phone's own network explains, by the relay controller's code. `offline` — nothing was sent
 * (the device has no network); `held` — the input is kept on the phone and goes out once. Either is stale once the
 * phone reaches the Mac again, so it is cleared then instead of contradicting the header's 「연결됨」 (review
 * 2026-10-10). HELD_PART_NOTICE is not: it tells the user what to tidy up after reconnecting.
 */
function phoneNetworkInputError(error:unknown,message:string):'offline'|'held'|null{
 if(message===HELD_PART_NOTICE)return null;
 const code=error&&typeof error==='object'?(error as {code?:unknown}).code:undefined;
 if(code==='REMOTE_CONTROL_PHONE_OFFLINE')return 'offline';
 return code==='REMOTE_CONTROL_REQUEST_UNSENT'||code==='REMOTE_CONTROL_REQUEST_UNSENT_AHEAD'?'held':null;
}
import {DEVICE_ATTRIBUTES_REPLY} from './aiTerminalDeviceAttributes';
import {AI_INITIAL_PROMPT_MAX_BYTES,aiInitialPromptError,aiInitialPromptDraftError} from './aiInitialPrompt';
import {defaultWorkroomRouteAgent,planWorkroomRoute,reconcileRegisteredWorkroomTargets,suggestedWorkroomTargets,workroomDeliveryInstruction,workroomRoutePreview,type WorkroomMentionProject} from './workroomProjectMention';
import {deliverWorkroomRoute,renderWorkroomScreenLines,workroomStartCarriesPrompt} from './workroomRouteDelivery';
import {applyCommunityMention,communityMentionState,communityReferencesFor,type CommunityMentionDeviceProjects,type CommunityReferenceChip} from './workroomCommunityMention';
import {workroomSessionStateLabel} from './remoteControlScreenText';
export interface AiTerminalEntry {nonce:number;targetId:string;prompt?:string;title?:string;agent?:AiTerminalAgent;sessionId?:string;resumeLatest?:boolean}
function sameWorkroomTargets(a:readonly {targetId:string;label:string;projectTargetId?:string}[],b:readonly {targetId:string;label:string;projectTargetId?:string}[]):boolean {
 return a.length===b.length&&a.every((x,i)=>x.targetId===b[i]!.targetId&&x.label===b[i]!.label&&x.projectTargetId===b[i]!.projectTargetId&&JSON.stringify(x)===JSON.stringify(b[i]));
}
/** 커뮤니티 기기가 없을 때의 고정 빈 목록 — 렌더마다 새 배열을 만들면 memo가 전부 깨진다. */
const NO_COMMUNITY_DEVICES:readonly CommunityMentionDeviceProjects[]=[];
export function AiTerminalPanel({visible=true,projects:suppliedProjects,transport=localAiTerminalTransport,remote=false,entry,onManageProject,onWhatISaid,onRememberSession,sessionScope='local',workspaceTransport,bypassPermissions:controlledBypass,onBypassPermissionsChange,referencesSupported=true,opsTargetId,popout=false,onActiveSessionChange,deviceName,deviceSwitch,slowPolling=false,communityMention,bypassUnavailable}: {
 bypassPermissions?:boolean;onBypassPermissionsChange?:(enabled:boolean)=>void;
 /** Set while driving another Mac: that Mac refuses a bypassed start from a community peer, so the panel starts
  *  without it and the toggle says why. The saved preference is untouched and returns with this Mac. */
 bypassUnavailable?:string;workspaceTransport?:WorkroomTransport;visible?:boolean;projects:WorkroomMentionProject[];transport?:AiTerminalTransport;remote?:boolean;entry?:AiTerminalEntry|null;onManageProject?:(id:string)=>void;onWhatISaid?:()=>void;onRememberSession?:(id:string)=>void;sessionScope?:string;
 /** The host accepts `#` references (local always; remote hosts advertise it). */
 referencesSupported?:boolean;
 /** The OPS project: its composer says the box types to the OPS workroom AI; 아젠투지 voice is the dock, not an entry here (VOC 2026-09-29). */
 opsTargetId?:string;
 /** Rendered alone in a separate OS window (「새 창으로 분리」). There is no app sidebar to hide. */
 popout?:boolean;
 /** 다른 아젠투지를 거쳐 모는 중 — 읽기 한 번이 두 홉이라 박자를 늦춘다. */
 slowPolling?:boolean;
 /** The pop-out window titles itself after the session it shows. */
 onActiveSessionChange?:(session:{label:string;agent:AiTerminalAgent}|null)=>void;
 /** Display only. The selected transport and session scope decide which device owns these sessions. */
 deviceName?:string;
 /** The 「기기」 selector when this Mac can drive other community Macs (src/WorkroomDeviceSwitch.tsx). */
 deviceSwitch?:React.ReactNode;
 /**
  * 커뮤니티 차원의 `@`·`#`(2026-10-05): 기호 앞에 기기 이름을 적으면 그 기기의 프로젝트가 후보가 된다.
  * 목록은 **쓸 때 한 번** 불러온다(`requestProjects`) — 쓰지도 않을 기기 목록을 미리 긁지 않는다.
  * `requester`는 그 기기의 터미널 요청 함수다(없으면 그 기기로는 전달하지 않는다).
  */
 communityMention?:{
  devices:readonly CommunityMentionDeviceProjects[];
  requestProjects:(deviceId:string)=>void;
  requester:(deviceId:string)=>((request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>)|null;
 };
}) {
 const memoryTransport=useMemo<WorkroomTransport>(()=>workspaceTransport??(remote?async()=>{throw new Error('호스트의 워크룸 저장 연결을 확인하세요.');}:localWorkroomTransport),[workspaceTransport,remote]);
 const [localBypass,setLocalBypass]=useState(()=>{try{return sessionStorage.getItem('agentstoz-terminal-bypass:'+sessionScope)!=='false'}catch{return true}});
 const bypassPermissions=(controlledBypass??localBypass)&&!bypassUnavailable;
 const [optionsOpen,setOptionsOpen]=useState(false);
 const changeBypass=(enabled:boolean)=>{setLocalBypass(enabled);try{sessionStorage.setItem('agentstoz-terminal-bypass:'+sessionScope,String(enabled))}catch{}onBypassPermissionsChange?.(enabled);};
 const panel=useRef<HTMLElement>(null);
 useEffect(()=>{if(!visible)return;const viewport=window.visualViewport;const update=()=>panel.current?.style.setProperty('--workroom-viewport-height',`${viewport?.height??window.innerHeight}px`);update();viewport?.addEventListener('resize',update);window.addEventListener('resize',update);return()=>{viewport?.removeEventListener('resize',update);window.removeEventListener('resize',update);};},[visible]);
 const [contextUsed,setContextUsed]=useState<number|null>(null);const [cliInfo,setCliInfo]=useState<WorkroomCliInfo>({});
 const promptId=useId();const promptField=useRef<HTMLTextAreaElement>(null);
 const [focusRequest,setFocusRequest]=useState(0);
 useEffect(()=>{if(visible&&focusRequest)promptField.current?.focus();},[visible,focusRequest]);
 const [targetReload,setTargetReload]=useState(0);const [targetError,setTargetError]=useState(false);
 const requestTargets=useMemo(()=>singleFlight(()=>new AgentRuntimeClient().targets()),[]);
 const [discovered,setDiscovered]=useState<{targetId:string;label:string;projectTargetId?:string}[]>([]);
 // The AgentsToZ Project/Folder registry is the visible authority. Runtime
 // discovery may contain old aliases, detached worktrees or targets owned by
 // another surface. Reconcile only matching runtime metadata into the current
 // registered list, so a partial runtime response cannot hide a project.
 // The phone portal rebuilds `projects` on every status poll (~1s). Effects keyed on its identity (refresh → list)
 // re-ran each time and kept the phone's one-at-a-time relay busy with `list`, so terminal reads never got a turn
 // and the workroom stayed blank (2026-10-02, iPhone 17: ~32 lists and one read per minute). Key by content.
 const suppliedKey=JSON.stringify(suppliedProjects);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 const stableSupplied=useMemo(()=>suppliedProjects,[suppliedKey]);
 const projects=useMemo(()=>{
  if(remote||!discovered.length)return stableSupplied;
  return reconcileRegisteredWorkroomTargets(stableSupplied,discovered);
 },[remote,discovered,stableSupplied]);
 const projectTargetIds=useMemo(()=>new Set(projects.map(project=>project.targetId)),[projects]);
 useEffect(()=>{
  if(remote||!visible)return;let stopped=false;let retry:ReturnType<typeof setTimeout>|undefined;let retryDelay=5000;
  const load=async()=>{try{const r=await requestTargets();if(!stopped){setDiscovered(old=>sameWorkroomTargets(old,r.targets)?old:r.targets);setTargetError(false)}}catch{if(!stopped){setTargetError(true);retry=setTimeout(load,retryDelay);retryDelay=Math.min(30000,retryDelay*2)}}};
  void load();return()=>{stopped=true;clearTimeout(retry)};
 },[remote,visible,targetReload,requestTargets]);
 const [sessions,setSessions]=useState<AiTerminalSummary[]>([]);const [selected,setSelected]=useState(()=>{try{return sessionStorage.getItem('agentstoz-terminal-selection:'+sessionScope)??''}catch{return ''}});
 const [showEnded,setShowEnded]=useState(false);
 const [dismissed,setDismissed]=useState<string[]>(()=>{try{const value=JSON.parse(sessionStorage.getItem('agentstoz-terminal-dismissed:'+sessionScope)??'[]');return Array.isArray(value)?value.filter(id=>typeof id==='string').slice(-24):[]}catch{return []}});
 useEffect(()=>{try{sessionStorage.setItem('agentstoz-terminal-dismissed:'+sessionScope,JSON.stringify(dismissed))}catch{}},[dismissed,sessionScope]);
 const sessionsRef=useRef(sessions);sessionsRef.current=sessions;
 const closing=useRef(new Set<string>());
 const inputPaused=useRef(new Set<string>());
 const inventoryEpoch=useRef(0);
 useEffect(()=>{try{sessionStorage.setItem('agentstoz-terminal-selection:'+sessionScope,selected)}catch{}},[selected,sessionScope]);
 const [target,setTarget]=useState(()=>{try{return sessionStorage.getItem('agentstoz-terminal-target:'+sessionScope)??''}catch{return ''}});
 const [agent,setAgent]=useState<AiTerminalAgent>(()=>{try{const saved=sessionStorage.getItem('agentstoz-terminal-agent:'+sessionScope);return AI_TERMINAL_AGENTS.includes(saved as AiTerminalAgent)?saved as AiTerminalAgent:'codex'}catch{return 'codex'}});
 useEffect(()=>{try{sessionStorage.setItem('agentstoz-terminal-target:'+sessionScope,target);sessionStorage.setItem('agentstoz-terminal-agent:'+sessionScope,agent)}catch{}},[target,agent,sessionScope]);
 const [prompt,setPrompt]=useState('');const [error,setError]=useState('');const phoneNetworkError=useRef<{text:string;kind:'offline'|'held'}|null>(null);const [connectionError,setConnectionError]=useState('');const [readError,setReadError]=useState('');const [busy,setBusy]=useState(false);
 const [terminalDraft,setTerminalDraft]=useState('');const [terminalCursor,setTerminalCursor]=useState(0);const [routeTargetId,setRouteTargetId]=useState('');
 // 참고(`#`)는 **어느 기기의** 프로젝트인지 함께 기억한다 — 폴더는 받는 쪽 호스트만 풀 수 있다.
 const [referenceChips,setReferenceChips]=useState<CommunityReferenceChip[]>([]);
 // `@` routing picks its receiving AI ('' = suggested). After delivery the sender stays here; the receipt offers the jump.
 // 받는 곳이 다른 아젠투지면 `routeDeviceId`가 그 기기다('' = 이 화면이 몰고 있는 기기).
 const [routeAgentChoice,setRouteAgentChoice]=useState<WorkroomRouteChoice|''>('');const [routeDeviceId,setRouteDeviceId]=useState('');
 const routeTo=(targetId:string,deviceId='')=>{setRouteTargetId(targetId);setRouteDeviceId(targetId?deviceId:'');setRouteAgentChoice('');};
 const [routeReceipt,setRouteReceipt]=useState<{sessionId:string;text:string}|null>(null);
 // 앱 받는 곳(Codex·Claude·Hermes·Antigravity 앱)의 결과 — 세션이 없으니 「그 세션으로 이동」도 없다.
 const [appRouteReceipt,setAppRouteReceipt]=useState<string|null>(null);
 const [fontSize,setFontSize]=useState(()=>initialWorkroomFontSize(remote,typeof window==='undefined'?0:window.innerWidth,workroomPreferenceStorage()));
 // A remote screen saves its size only when the user picks one (the old save-on-mount pinned phones at 16).
 const chooseFontSize=(delta:1|-1)=>setFontSize(size=>{const next=stepWorkroomFontSize(size,delta);if(remote)writeWorkroomRemoteFontSize(workroomPreferenceStorage(),next);return next;});const fontSizeRef=useRef(fontSize);fontSizeRef.current=fontSize;
 // A remote viewer has its own readable copy of the host screen. It never changes the shared PTY size.
 const [readableMode,setReadableMode]=useState(remote);
 const [readableScreen,setReadableScreen]=useState('');
 // Wide view hides the app sidebar, so it exists only on the Mac, not in the phone portal.
 // It applies only while a session row (and so its exit toggle) is on screen.
 const [wide,setWide]=useState(()=>!remote&&!popout&&readWorkroomWide(workroomPreferenceStorage()));
 const [rawInput,setRawInput]=useState(false);const rawInputRef=useRef(false);rawInputRef.current=rawInput;const terminalComposer=useRef<HTMLTextAreaElement>(null);
 const [composerOpen,setComposerOpen]=useState(false);const [requestTitle,setRequestTitle]=useState('');
 const startBusy=useRef(false),draftGeneration=useRef(0),selectionGeneration=useRef(0);
 const pendingResume=useRef<{targetId:string;selection:number}|null>(null);
 const [resuming,setResuming]=useState(false);
 const latestEntryNonce=useRef(entry?.nonce);latestEntryNonce.current=entry?.nonce;
 const activeSession=sessions.find(s=>s.id===selected);
 const activeSessionRef=useRef(activeSession);activeSessionRef.current=activeSession;
 const sessionLabels=useMemo(()=>workroomSessionLabels(sessions,targetId=>projects.find(p=>p.targetId===targetId)?.label),[sessions,projects]);
 const sessionDevice=workroomSessionOwner('',undefined,deviceName,remote);
 const sessionOwner=(targetId:string)=>workroomSessionOwner(targetId,opsTargetId,deviceName,remote);
 const targetProject=projects.find(p=>p.targetId===target);
 const supportsPrompt=aiTerminalSupportsPrompt(agent);
 const promptError=aiInitialPromptError(prompt);
 const canStart=!!targetProject&&(!prompt.trim()||supportsPrompt)&&!promptError&&!busy&&!resuming;
 const [connections,setConnections]=useState<{id:string;label:string;allowed:boolean;durable?:boolean;expiresAt?:string|null;workspaceScopes?:MobileWorkspaceScope[]}[]>([]);
 const [grantRoots,setGrantRoots]=useState<{workspaceRootId:string;name:string}[]>([]);
 const [workspaceScopes,setWorkspaceScopes]=useState<MobileWorkspaceScope[]>([]);
 const [grantRoot,setGrantRoot]=useState('');
 const host=useRef<HTMLDivElement>(null);const terminal=useRef<Terminal|null>(null);const fit=useRef<FitAddon|null>(null);
 // The size this window last fitted. A new CLI starts at it instead of 100×28, so it does not draw its
 // first screen for another size and redraw (NHCS opens its terminals at the window's real size).
 const lastSize=useRef({cols:100,rows:28});
 const [restartNotice,setRestartNotice]=useState<{sessionId:string;text:string}|null>(null);
 // Images for the next request (VOC 2026-10-02 "캡쳐해서 넣기"): saved on this Mac, sent as absolute paths.
 const [images,setImages]=useState<WorkroomImageAttachment[]>([]);const imagesRef=useRef(images);imagesRef.current=images;
 const [imageBusy,setImageBusy]=useState(false);
 const sendInput=useRef<((data:string)=>void)|null>(null);
 const flushInput=useRef<(()=>void)|null>(null);const wakeRead=useRef<(()=>void)|null>(null);
 const cursor=useRef(0);const generation=useRef(0);const applied=useRef<number|null>(null);
 const remoteClaimedSize=useRef('');
 const request=useMemo(()=>createTerminalRequester(transport,remote),[transport,remote]);
 const canWrite=useCallback((id:string)=>!closing.current.has(id)&&sessionsRef.current.some(s=>s.id===id&&s.state==='running'),[]);
 const refreshConnections=useMemo(()=>singleFlight(()=>terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',{}).then(r=>{setConnections(r.connections??[]);setGrantRoots(r.workspaceRoots??[])}).catch(()=>{})),[]);
 useEffect(()=>{if(!target && projects.length)setTarget(projects[0]!.targetId)},[target,projects]);
 useEffect(()=>{if(entry && applied.current!==entry.nonce){if(entry.prompt&&prompt.trim()&&entry.prompt!==prompt&&!startBusy.current){applied.current=entry.nonce;setError('작성 중인 요청을 유지했습니다. 초안을 비운 뒤 발언을 다시 가져오세요.');return;}draftGeneration.current++;applied.current=entry.nonce;const invalid=aiInitialPromptDraftError(entry.prompt??'');if(invalid){setError(invalid+' 현재 초안은 유지했습니다.');return;}setTarget(entry.targetId);setPrompt(entry.prompt??'');setRequestTitle(entry.title??'');setComposerOpen(!!entry.prompt);if(entry.prompt)setFocusRequest(value=>value+1);setSelected(entry.sessionId??'');if(entry.agent)setAgent(entry.agent);
   pendingResume.current=entry.resumeLatest?{targetId:entry.targetId,selection:selectionGeneration.current}:null;
   setResuming(!!entry.resumeLatest);
 }},[entry]);
 const refresh=useMemo(()=>singleFlight(async(clearError=true)=>{const epoch=inventoryEpoch.current;try{const r=await request({operation:'list'});if(epoch!==inventoryEpoch.current)return;const scopedSessions=(r.sessions??[]).filter(session=>remote||projectTargetIds.has(session.targetId));setSessions(old=>reconcileTerminalSummaries(old,scopedSessions));
   const resume=pendingResume.current;pendingResume.current=null;setResuming(false);
   if(resume&&resume.selection===selectionGeneration.current){
    const latest=scopedSessions.filter(s=>s.targetId===resume.targetId&&s.state==='running').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    // The target list can arrive after this read; a session the panel itself just started
    // for that target is not in `scopedSessions` yet and must not be deselected.
    if(latest){setSelected(latest.id);setAgent(latest.agent);}
    else setSelected(current=>sessionsRef.current.some(s=>s.id===current&&s.targetId===resume.targetId&&s.state==='running')?current:'');
   // Deselect only a session the Mac no longer has. A session outside the current scope can
   // be one this panel just started whose target list has not arrived yet (a worktree first
   // seen at runtime); clearing it then left the new session unselected.
   }else setSelected(current=>current && !(r.sessions??[]).some(s=>s.id===current)?'':current);
   setConnectionError('');if(clearError)setError('');
 }catch(e){if(epoch===inventoryEpoch.current)setConnectionError(String(e instanceof Error?e.message:e));}}),[request,projectTargetIds,remote]);
 useEffect(()=>{
   if(!showEnded&&sessions.some(s=>s.id===selected&&s.state==='exited')){
     // A CLI can fail during startup. Keep its final output mounted so a
     // mobile user sees the reason instead of a terminal that disappears.
     setShowEnded(true);
   }
 },[sessions,selected,showEnded]);
 // Reloading the target list belongs to opening the Workroom (or an entry), never to `refresh`
 // changing. They were one effect: a target reload built new project arrays → a new `refresh` →
 // this effect again → another target reload, ~36 times a second (targets, list and access each
 // ~1,080 requests per 30s, sidecar at 87–103% CPU with one Workroom window open).
 useEffect(()=>{if(!visible)return;void refresh(false);},[visible,refresh,entry?.nonce]);
 useEffect(()=>{if(!visible||remote)return;void refreshConnections();setTargetReload(value=>value+1);const timer=setInterval(()=>void refreshConnections(),5000);return()=>clearInterval(timer);},[visible,remote,refreshConnections,entry?.nonce]);
 useEffect(()=>{if(!visible)return;const timer=setInterval(()=>void refresh(false),slowPolling?12000:remote?5000:2000);return()=>clearInterval(timer);},[visible,remote,refresh,slowPolling]);
 const reportInputError=useCallback((e:unknown)=>{const message=e instanceof Error?e.message:String(e);const kind=phoneNetworkInputError(e,message);phoneNetworkError.current=kind?{text:message,kind}:null;setError(message);},[]);
 // `kinds` — which of the phone-network errors this event proves stale. A successful remote read proves both: the
 // controller refuses every terminal request while anything is still in its outbox, so a read that worked means the
 // held input has gone out.
 const clearPhoneNetworkError=useCallback((kinds:readonly ('offline'|'held')[])=>{const held=phoneNetworkError.current;if(!held||!kinds.includes(held.kind))return;phoneNetworkError.current=null;setError(current=>current===held.text?'':current);},[]);
 // A phone that gets its network back must not keep saying it is offline until the next list poll (5–12 s) or
 // the read backoff (up to 10 s) — the header already says 「연결됨」 by then (review 2026-10-10).
 useEffect(()=>{if(!visible||!remote)return;const onOnline=()=>{clearPhoneNetworkError(['offline']);void refresh(false);wakeRead.current?.();};window.addEventListener('online',onOnline);return()=>window.removeEventListener('online',onOnline);},[visible,remote,refresh,clearPhoneNetworkError]);
 const enqueue=useCallback((r:Omit<AiTerminalRequest,'requestId'>,group?:TerminalSubmissionGroup)=>{
   if(!r.sessionId||!canWrite(r.sessionId)||inputPaused.current.has(r.sessionId))return;
   // A remote viewer must not reflow the Mac's PTY merely by opening or rotating the phone.
   // The first actual input claims the current phone size immediately before that input.
   if(remote&&r.operation==='input'){
    const screen=terminal.current;if(screen&&host.current?.clientWidth){fit.current?.fit();const cols=Math.max(20,Math.min(300,screen.cols)),rows=Math.max(5,Math.min(150,screen.rows));const key=r.sessionId+':'+cols+'x'+rows;
     if(remoteClaimedSize.current!==key){remoteClaimedSize.current=key;void request({operation:'resize',sessionId:r.sessionId,cols,rows}).catch(e=>{if(canWrite(r.sessionId!))reportInputError(e);});}
    }
   }
   // The requester owns the bounded FIFO. A second Promise chain here would
   // retain arbitrary pasted input and prevent close from reaching that FIFO.
   void request(r,{group}).then(()=>{if(r.operation==='input')wakeRead.current?.();})
    // A failed submission reports once, on its first failed part; the parts and inputs dropped after it stay quiet.
    .catch(e=>{if(r.sessionId&&canWrite(r.sessionId)&&!e?.partOfFailedSubmission)reportInputError(e);});
 },[request,canWrite,remote,reportInputError]);
 useEffect(()=>{
  if(!visible||!host.current||!activeSession)return;
  setContextUsed(null);setCliInfo({});
  // Keep xterm's IME layer initialized for the lifetime of a running session.
  // Turning disableStdin off after mount corrupts some macOS composition
  // sequences, so the opt-in gate lives in acceptInput instead.
  const t=new Terminal({fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:fontSizeRef.current,scrollback:2000,allowProposedApi:false,theme:{background:'#111315',foreground:'#e5e7eb'},cursorBlink:true,allowTransparency:false,disableStdin:activeSession.state!=='running'});
  let cliTimer:ReturnType<typeof setTimeout>|undefined;
  const cliListener=(activeSession.agent==='claude'||activeSession.agent==='codex')?t.onWriteParsed(()=>{
    // Display evidence only. The banner scrolls away, so keep the last value seen.
    if(cliTimer)return;cliTimer=setTimeout(()=>{cliTimer=undefined;const b=t.buffer.active,lines:string[]=[];for(let i=Math.max(0,b.length-200);i<b.length;i++)lines.push(b.getLine(i)?.translateToString(true)??'');const found=cliInfoFromScreen(activeSession.agent,lines);if(found.model||found.effort)setCliInfo(prev=>({...prev,...found}));},300);
  }):undefined;
  const contextListener=t.onWriteParsed(()=>{
    if(activeSession.agent!=='codex')return;
    const b=t.buffer.active,lines:string[]=[];for(let i=b.baseY;i<b.length;i++)lines.push(b.getLine(i)?.translateToString(true)??'');
    setContextUsed(codexContextUsedFromFooter(lines));
  });
  const f=new FitAddon();t.loadAddon(f);t.open(host.current);terminal.current=t;fit.current=f;
  let pending='',inputTimer:ReturnType<typeof setTimeout>|undefined,hangulTimer:ReturnType<typeof setTimeout>|undefined;
  const hangulInput=createTerminalHangulInputFallback();
  const overlapInput=createTerminalCompositionOverlapFilter();
  const flushTransport=()=>{clearTimeout(inputTimer);const data=pending;pending='';inputTimer=undefined;if(selected&&canWrite(selected)){const parts=splitTerminalInput(data),group=parts.length>1?terminalSubmissionGroup():undefined;for(const part of parts)enqueue({operation:'input',sessionId:selected,data:part},group);}};
  const appendInput=(data:string)=>{if(!data)return;pending+=data;if(!inputTimer)inputTimer=setTimeout(flushTransport,remote?180:8);};
  const flushHangul=()=>{clearTimeout(hangulTimer);hangulTimer=undefined;appendInput(hangulInput.flush());};
  const flush=()=>{clearTimeout(hangulTimer);hangulTimer=undefined;pending+=hangulInput.flush();flushTransport();};
  // The host answers Device Attributes and cursor-position queries itself (aiTerminalScreen.ts); this xterm's own DA answer
  // would be a second one. Its cursor-position answer (forwarded in direct input only) is removed by the host instead
  // (aiTerminalReplyFilter.ts): an older Mac does not answer, and there this late answer is the only one.
  const acceptInput=(data:string)=>{if(DEVICE_ATTRIBUTES_REPLY.test(data))return;if(!rawInputRef.current||!selected||inputPaused.current.has(selected)||!canWrite(selected))return;clearTimeout(hangulTimer);hangulTimer=undefined;const overlap=overlapInput.push(data);if(overlap.retract&&pending.endsWith(overlap.retract))pending=pending.slice(0,-overlap.retract.length);const result=hangulInput.push(overlap.data);appendInput(result.ready);if(result.pending)hangulTimer=setTimeout(flushHangul,600);};
  sendInput.current=(data:string)=>{flush();if(selected)enqueue({operation:'input',sessionId:selected,data});};flushInput.current=flush;const input=t.onData(acceptInput);
  let dimensions='';
  const resize=new ResizeObserver(()=>{if(!visible||!host.current?.clientWidth)return;f.fit();lastSize.current={cols:Math.max(20,Math.min(300,t.cols)),rows:Math.max(5,Math.min(150,t.rows))};const next=t.cols+'x'+t.rows;if(!remote&&selected&&canWrite(selected)&&next!==dimensions){dimensions=next;enqueue({operation:'resize',sessionId:selected,cols:Math.max(20,Math.min(300,t.cols)),rows:Math.max(5,Math.min(150,t.rows))});}});
  resize.observe(host.current);
  // On a phone the project controls can place a new terminal below the viewport.
  // Reveal it once on selection/return; output polling must not pull a reader
  // back down after they deliberately scroll elsewhere.
  const revealFrame=remote?requestAnimationFrame(()=>host.current?.scrollIntoView({block:'center',behavior:'auto'})):undefined;
  return()=>{if(revealFrame!==undefined)cancelAnimationFrame(revealFrame);sendInput.current=null;flushInput.current=null;flush();input.dispose();contextListener.dispose();cliListener?.dispose();clearTimeout(cliTimer);resize.disconnect();t.dispose();terminal.current=null;};
 },[selected,activeSession?.id,enqueue,visible,remote,canWrite]);
 useEffect(()=>{
  cursor.current=0;remoteClaimedSize.current='';terminal.current?.reset();setReadError('');setReadableScreen('');const mine=++generation.current;
  if(!visible||!activeSession)return;
  const reading=remote?new Terminal({cols:activeSession.cols,rows:activeSession.rows,scrollback:0,allowProposedApi:true}):null;
  const showReadableScreen=()=>{
   if(!reading)return;
   const buffer=reading.buffer.active;
   const lines=Array.from({length:reading.rows},(_,index)=>buffer.getLine(buffer.baseY+index)?.translateToString(true)??'');
   while(lines.length&&!lines[0]?.trim())lines.shift();
   while(lines.length&&!lines.at(-1)?.trim())lines.pop();
   setReadableScreen(lines.join('\n'));
  };
  const cadence=createTerminalReadCadence(remote,undefined,{slow:slowPolling});
  let snapshotReads=0,snapshotSupported=remote;
  let stopped=false,inFlight=false,wakePending=false;let timer:ReturnType<typeof setTimeout>;let releaseWrite:(()=>void)|undefined,releaseReadingWrite:(()=>void)|undefined;let nextDelay=remote?700:120;let failures=0;
  const poll=async()=>{
   if(stopped||inFlight)return;inFlight=true;clearTimeout(timer);
   const snapshot=snapshotSupported&&snapshotReads<2;
   try {const r=await request({operation:'read',sessionId:selected,after:cursor.current,...(snapshot?{snapshot:true as const}:{})});
    if(stopped||generation.current!==mine)return;
    setReadError('');failures=0;if(remote)clearPhoneNetworkError(['offline','held']);
    if(snapshot){snapshotReads++;if(snapshotReads===1&&r.truncated){terminal.current?.reset();reading?.reset();}if(!r.hasMore||snapshotReads>=2)snapshotSupported=false;}
    else if(r.truncated){terminal.current?.reset();reading?.reset();setError('이전 출력 일부가 보관 범위를 넘었습니다. Ctrl+L로 화면을 다시 그릴 수 있습니다.');}
    if(reading&&r.session&&(reading.cols!==r.session.cols||reading.rows!==r.session.rows))reading.resize(r.session.cols,r.session.rows);
    const chunks=(r.chunks??[]).filter(c=>c.seq>cursor.current);
    if(chunks.length){const text=chunks.map(c=>c.text).join(''),screen=terminal.current;await Promise.all([
     new Promise<void>(resolve=>{releaseWrite=resolve;if(screen)screen.write(text,resolve);else resolve();}),
     new Promise<void>(resolve=>{releaseReadingWrite=resolve;if(reading)reading.write(text,resolve);else resolve();}),
    ]);releaseWrite=undefined;releaseReadingWrite=undefined;if(stopped||generation.current!==mine)return;cursor.current=chunks.at(-1)!.seq;showReadableScreen();}
    nextDelay=cadence.next(chunks.length>0,!!r.hasMore);
    if(r.session){setSessions(old=>old.map(s=>s.id===selected&&s.state!=='exited'?r.session!:s));if(r.session.state==='exited'&&!r.hasMore)return;}
   }catch(e){if(!stopped){if(snapshot&&aiTerminalSnapshotUnsupported(e)){snapshotSupported=false;snapshotReads=2;setReadError('');failures=0;nextDelay=0;}else{setReadError(e instanceof Error?e.message:String(e));failures=Math.min(5,failures+1);nextDelay=Math.min(remote?10000:5000,500*2**(failures-1));}}}
   finally{inFlight=false;}
   if(!stopped){timer=setTimeout(poll,wakePending?0:nextDelay);wakePending=false;}
  };wakeRead.current=()=>{if(stopped)return;cadence.wake();if(inFlight){wakePending=true;return;}clearTimeout(timer);timer=setTimeout(poll,0)};void poll();return()=>{stopped=true;wakeRead.current=null;clearTimeout(timer);releaseWrite?.();releaseReadingWrite?.();reading?.dispose()};
 },[selected,activeSession?.id,visible,request,remote]);
 const start=async()=>{
  if(!canStart||startBusy.current)return;
  startBusy.current=true;
  const entryRevision=applied.current,selection=selectionGeneration.current;
  // The composer is disabled while start is in flight, so only a newer entry
  // entry can supersede this submitted draft. Session-tab changes must not
  // make the already accepted request reappear.
  const current=()=>entryRevision===applied.current;
  inventoryEpoch.current++;setBusy(true);setError('');
  try{
   const r=await request({operation:'start',targetId:target,agent,cols:lastSize.current.cols,rows:lastSize.current.rows,bypassPermissions,...(prompt.trim()?{prompt}: {})});
   if(r.session){
    inventoryEpoch.current++;setSessions(s=>[...s.filter(x=>x.id!==r.session!.id),r.session!]);
    // A Mac launch is a dedicated conversation window from its first turn.
    // The phone keeps the terminal inline because its relay is page-bound.
    let openedWindow=false;
    if(!remote&&!popout&&isTauri()){
     try{
      const project=projects.find(project=>project.targetId===r.session!.targetId);
      await openWorkroomPopout({sessionId:r.session.id,targetId:r.session.targetId,agent:r.session.agent,bypassPermissions},workroomPopoutTitle(project?.label??'',r.session.agent));
      openedWindow=true;
     }catch(e){setError('새 창을 열지 못해 이 화면에서 작업을 엽니다. '+(e instanceof Error?e.message:String(e)));}
    }
    if(current()){
     // A response belongs to the submitted draft, not a newer explicit session
     // selection. Keep that terminal and its pending input mounted unchanged.
     if(selection===selectionGeneration.current)setSelected(openedWindow?'':r.session.id);
     setPrompt('');setRequestTitle('');setComposerOpen(false);
    }
   }
  }catch(e){if(current()&&selection===selectionGeneration.current)setError(e instanceof Error?e.message:String(e));}
  finally{inventoryEpoch.current++;startBusy.current=false;setBusy(false);}
 };
 const pauseForSave=useCallback((paused:boolean)=>{if(!selected)return;if(paused){flushInput.current?.();inputPaused.current.add(selected)}else inputPaused.current.delete(selected);if(terminal.current)terminal.current.options.disableStdin=paused||!canWrite(selected);},[selected,canWrite]);
 const close=async(memoryPolicy:'skip'|'saved',saveRequestId?:string)=>{
  inventoryEpoch.current++;const id=selected;const screen=terminal.current;
  if(!id||closing.current.has(id))return;
  setBusy(true);setError('');inputPaused.current.add(id);if(screen)screen.options.disableStdin=true;
  // An explicit stop cancels text not yet sent. A stalled input response must
  // not prevent the close request or block the next session's input chain.
  closing.current.add(id);flushInput.current?.();
  try{
   const response=await request({operation:'close',sessionId:id,memoryPolicy,...(saveRequestId?{saveRequestId}:{})});
   const ended=response.session;
   if(!ended||ended.id!==id||ended.state!=='exited')throw new Error('세션 종료 상태를 확인하지 못했습니다. 새로고침해 주세요.');
   inventoryEpoch.current++;
   // React may not have rendered the refreshed list when queued callbacks run.
   // Fence those callbacks with the confirmed close result immediately.
   sessionsRef.current=sessionsRef.current.map(s=>s.id===id?ended:s);
   setSessions(old=>old.map(s=>s.id===id?ended:s));setError('');setShowEnded(false);
   setSelected(current=>current===id?sessionsRef.current.filter(s=>s.id!==id&&s.state==='running').at(-1)?.id??'':current);
   await refresh();
  }catch(e){setError(e instanceof Error?e.message:String(e));throw e;}
  finally{
   inventoryEpoch.current++;closing.current.delete(id);inputPaused.current.delete(id);
   if(screen&&terminal.current===screen)screen.options.disableStdin=!canWrite(id);setBusy(false);
  }
 };
 // 「다시 시작」 (VOC 2026-10-02, src/workroomRestart.ts): one request; the Mac ends the old CLI after reading
 // which conversation it ran, then opens the same project and AI in its own permission mode.
 const restart=async()=>{
  const old=activeSession;if(!old||remote||busy||closing.current.has(old.id))return;
  if(old.state==='running'&&!window.confirm(workroomRestartConfirm(sessionLabels.get(old.id)??'이 세션')))return;
  const selection=selectionGeneration.current;
  inventoryEpoch.current++;setBusy(true);setError('');setRestartNotice(null);
  // Keystrokes not yet sent belong to the CLI being replaced; they must not reach either one.
  closing.current.add(old.id);inputPaused.current.add(old.id);flushInput.current?.();
  try{
   const size={cols:lastSize.current.cols,rows:lastSize.current.rows};
   let response:AiTerminalResponse,legacy=false;
   try{response=await request({operation:'start',targetId:old.targetId,agent:old.agent,...size,resumeFrom:old.id});}
   catch(e){
    // A sidecar older than this window refuses the key: end the old CLI, then open a fresh one.
    if(!(e instanceof Error&&e.message===AI_TERMINAL_UNKNOWN_REQUEST_ERROR))throw e;
    legacy=true;
    if(old.state==='running')await request({operation:'close',sessionId:old.id});
    response=await request({operation:'start',targetId:old.targetId,agent:old.agent,...size,bypassPermissions});
   }
   const next=response.session;if(!next)throw new Error('다시 시작한 세션을 확인하지 못했습니다. 터미널 새로고침으로 확인하세요.');
   inventoryEpoch.current++;
   sessionsRef.current=[...sessionsRef.current.filter(s=>s.id!==next.id),next];
   setSessions(list=>[...list.filter(s=>s.id!==next.id),next]);
   // The new session replaces it; the old one does not linger in 「종료된 세션 보기」.
   setDismissed(ids=>[...ids.filter(id=>id!==old.id),old.id].slice(-24));
   if(selection===selectionGeneration.current){setSelected(next.id);setShowEnded(false);}
   setRestartNotice({sessionId:next.id,text:workroomRestartNotice(old.agent,legacy?undefined:response.resumed)});
   await refresh();
  }catch(e){setError('다시 시작하지 못했습니다. '+(e instanceof Error?e.message:String(e)));}
  finally{inventoryEpoch.current++;closing.current.delete(old.id);inputPaused.current.delete(old.id);setBusy(false);}
 };
 const addImage=(image:WorkroomImageAttachment)=>{if(imagesRef.current.some(item=>item.path===image.path))return;const next=[...imagesRef.current,image];imagesRef.current=next;setImages(next);};
 const imageRoomLeft=()=>{if(imagesRef.current.length<WORKROOM_IMAGE_MAX_ATTACHMENTS)return true;setError(`이미지는 한 요청에 ${WORKROOM_IMAGE_MAX_ATTACHMENTS}개까지 넣을 수 있습니다.`);return false;};
 const attachBlobs=async(blobs:Blob[])=>{
  if(remote||!blobs.length)return;setImageBusy(true);setError('');
  try{for(const blob of blobs){if(!imageRoomLeft())break;addImage(await saveWorkroomImageBlob(blob));}}
  catch(e){setError('이미지를 넣지 못했습니다. '+(e instanceof Error?e.message:String(e)));}
  finally{setImageBusy(false);}
 };
 const capture=async(mode:WorkroomCaptureMode)=>{
  if(remote||imageBusy||!imageRoomLeft())return;setImageBusy(true);setError('');
  try{const image=await captureWorkroomScreen(mode);if(image)addImage(image);}
  catch(e){setError('화면을 캡처하지 못했습니다. '+(e instanceof Error?e.message:String(e)));}
  finally{setImageBusy(false);requestAnimationFrame(()=>terminalComposer.current?.focus());}
 };
 const captureRef=useRef(capture);captureRef.current=capture;
 const runningSessions=sessions.filter(s=>s.state==='running'), endedSessions=sessions.filter(s=>s.state==='exited'&&!dismissed.includes(s.id));
 const visibleSessions=showEnded?sessions.filter(s=>s.state==='running'||!dismissed.includes(s.id)):runningSessions;
 useEffect(()=>{setRawInput(false);setRouteTargetId('');setRouteAgentChoice('');setRouteReceipt(null);setAppRouteReceipt(null);},[selected]);
 useEffect(()=>{const screen=terminal.current;if(!screen)return;screen.options.disableStdin=!activeSession||activeSession.state!=='running';if(activeSession?.state==='running'){fit.current?.fit();if(!remote)enqueue({operation:'resize',sessionId:activeSession.id,cols:Math.max(20,Math.min(300,screen.cols)),rows:Math.max(5,Math.min(150,screen.rows))});}},[activeSession?.id,activeSession?.state,enqueue,visible,remote]);
 // One PTY has one size. When the same session is open in another window (pop-out), the PTY takes that
 // window's size and this one wraps wrongly. Coming back to the front re-asserts this window's size,
 // so the CLI redraws for the window the user is actually looking at.
 useEffect(()=>{if(!visible||remote)return;const reassert=()=>{if(document.visibilityState==='hidden')return;const screen=terminal.current;const session=activeSessionRef.current;if(!screen||!session||session.state!=='running'||!host.current?.clientWidth)return;fit.current?.fit();enqueue({operation:'resize',sessionId:session.id,cols:Math.max(20,Math.min(300,screen.cols)),rows:Math.max(5,Math.min(150,screen.rows))});};window.addEventListener('focus',reassert);document.addEventListener('visibilitychange',reassert);return()=>{window.removeEventListener('focus',reassert);document.removeEventListener('visibilitychange',reassert);};},[visible,enqueue,remote]);
 // A font change keeps the host box the same size, so the ResizeObserver never fires: refit and tell the CLI here.
 useEffect(()=>{if(!remote)writeWorkroomFontSize(workroomPreferenceStorage(),fontSize);const screen=terminal.current;if(!screen||screen.options.fontSize===fontSize)return;screen.options.fontSize=fontSize;if(!visible||!host.current?.clientWidth)return;fit.current?.fit();if(!remote&&activeSession?.state==='running')enqueue({operation:'resize',sessionId:activeSession.id,cols:Math.max(20,Math.min(300,screen.cols)),rows:Math.max(5,Math.min(150,screen.rows))});},[fontSize,remote,activeSession?.id,activeSession?.state,enqueue,visible]);
 useEffect(()=>{if(remote||popout)return;writeWorkroomWide(workroomPreferenceStorage(),wide);const root=document.documentElement;if(wide&&visible&&activeSession)root.dataset.workroomWide='true';else delete root.dataset.workroomWide;return()=>{delete root.dataset.workroomWide;};},[wide,visible,remote,popout,!!activeSession]);
 // ⌥⌘4 영역 · ⌥⌘5 창 · ⌥⌘3 전체 화면, while this Workroom is in front with a running session.
 useEffect(()=>{if(!visible||remote||activeSession?.state!=='running')return;const onKey=(event:KeyboardEvent)=>{const mode=workroomCaptureShortcut(event);if(!mode)return;event.preventDefault();event.stopPropagation();void captureRef.current(mode);};window.addEventListener('keydown',onKey,true);return()=>window.removeEventListener('keydown',onKey,true);},[visible,remote,activeSession?.state]);
 const [slashFavorites,setSlashFavorites]=useState<string[]>([]);const [slashPadOpen,setSlashPadOpen]=useState(false);
 const [addingSlash,setAddingSlash]=useState(false),[customSlash,setCustomSlash]=useState('');
 useEffect(()=>{setSlashFavorites(activeSession?readSlashFavorites(workroomPreferenceStorage(),activeSession.agent):[]);setSlashPadOpen(false);},[activeSession?.agent]);
 const toggleFavorite=(command:string)=>{if(activeSession)setSlashFavorites(toggleSlashFavorite(workroomPreferenceStorage(),activeSession.agent,command));};
 const addCustomFavorite=()=>{const value=customSlash.trim();if(!activeSession||!isWorkroomPaletteCommand(value,activeSession.agent)){setError(activeSession?.agent==='codex'?'Codex CLI 명령은 /model, 설치된 스킬은 $remember-session처럼 입력하세요.':'슬래시 명령 하나만 입력하세요. 예: /compact, /cs-ceo:goal');return;}if(!slashFavorites.includes(value))toggleFavorite(value);setError('');setCustomSlash('');setAddingSlash(false);};
 const activeProject=projects.find(p=>p.targetId===(activeSession?.targetId??target));
 useEffect(()=>{onActiveSessionChange?.(activeSession?{label:activeProject?.label??'',agent:activeSession.agent}:null);},[activeSession?.id,activeSession?.agent,activeProject?.label,onActiveSessionChange]);
 // Local requests carry a fresh request id each and the sidecar queues per session, so any
 // number of windows can drive one session. Remote pairings live in this page only.
 const popoutAvailability=workroomPopoutAvailability({remote,tauri:isTauri()});
 const popOut=async()=>{
  if(!activeSession)return;
  if(!popoutAvailability.available){setError(popoutAvailability.reason);return;}
  try{await openWorkroomPopout({sessionId:activeSession.id,targetId:activeSession.targetId,agent:activeSession.agent,bypassPermissions},workroomPopoutTitle(activeProject?.label??'',activeSession.agent));}
  catch(e){setError('새 창을 열지 못했습니다. '+(e instanceof Error?e.message:String(e)));}
 };
 /**
  * 「새 작업」 on a Mac opens one more clean window of the same project instead of unfolding this
  * window's composer: a launch here has been a dedicated window since its first turn anyway. The
  * phone keeps the fold because its relay is page-bound and cannot carry a second window.
  */
 const openFreshWindow=async()=>{
  if(!activeSession||!activeProject||busy||startBusy.current)return;
  startBusy.current=true;inventoryEpoch.current++;setBusy(true);setError('');
  try{
   // 머리에서 고른 프로젝트·AI로 연다. 예전에는 `activeSession.agent`를 그대로 써서 같은 프로젝트를
   // **다른 AI로** 새 창에 열 방법이 없었다(VOC 2026-10-05) — 그 선택은 이미 머리에 있는데 안 읽었다.
   const r=await request({operation:'start',targetId:target||activeSession.targetId,agent,
    cols:lastSize.current.cols,rows:lastSize.current.rows,bypassPermissions});
   if(!r.session)throw new Error('세션을 시작하지 못했습니다.');
   inventoryEpoch.current++;setSessions(list=>[...list.filter(item=>item.id!==r.session!.id),r.session!]);
   await openWorkroomPopout({sessionId:r.session.id,targetId:r.session.targetId,agent:r.session.agent,bypassPermissions},
    workroomPopoutTitle((targetProject??activeProject).label??'',r.session.agent));
  }catch(e){setError('새 창을 열지 못했습니다. '+(e instanceof Error?e.message:String(e)));}
  finally{startBusy.current=false;setBusy(false);}
 };
 const openListedSession=async(session:AiTerminalSummary)=>{
  selectionGeneration.current++;setError('');
  if(!remote&&!popout&&isTauri()){
   try{
    const project=projects.find(item=>item.targetId===session.targetId);
    await openWorkroomPopout({sessionId:session.id,targetId:session.targetId,agent:session.agent,bypassPermissions},workroomPopoutTitle(project?.label??'',session.agent));
    setSelected('');return;
   }catch(e){setError('새 창을 열지 못해 이 화면에서 세션을 엽니다. '+(e instanceof Error?e.message:String(e)));}
  }
  setSelected(session.id);requestAnimationFrame(()=>terminalComposer.current?.focus());
 };
 // 커뮤니티 차원의 `@`·`#`(2026-10-05): 기호 앞의 기기 이름이 후보 목록을 그 기기의 것으로 바꾼다.
 const communityDevices=communityMention?.devices??NO_COMMUNITY_DEVICES;
 // ⚠️ 요청 함수는 **렌더 중에 만들지 않는다** — `createTerminalRequester`는 순서를 지키는 대기열을 들고
 // 있어서 렌더마다 새로 만들면 순서가 깨지고, 이 effect가 매 렌더 다시 돌아 `list`를 끝없이 보낸다.
 const communityMentionRef=useRef(communityMention);communityMentionRef.current=communityMention;
 const mention=useMemo(()=>communityMentionState(terminalDraft,terminalCursor,{local:projects,devices:communityDevices}),
   [terminalDraft,terminalCursor,projects,communityDevices]);
 // 목록은 **쓸 때** 받는다 — 커뮤니티에 있는 기기마다 미리 긁으면 쓰지도 않을 왕복이 생긴다.
 const mentionDeviceId=mention?.device?.deviceId??'';
 useEffect(()=>{if(mentionDeviceId)communityMentionRef.current?.requestProjects(mentionDeviceId);},[mentionDeviceId]);
 const routeDevice=routeDeviceId?communityDevices.find(device=>device.deviceId===routeDeviceId)??null:null;
 const routeProject=routeDeviceId?routeDevice?.projects?.find(project=>project.targetId===routeTargetId):projects.find(project=>project.targetId===routeTargetId);
 // 대화상자·영수증·미리보기가 모두 어느 기기인지 말하도록 라벨에 기기를 적는다.
 const routeTarget=routeProject?{...routeProject,label:routeDevice?`${routeDevice.label} · ${routeProject.label}`:routeProject.label}:undefined;
 // 다른 기기의 세션 목록은 받는 곳을 고른 뒤 한 번 읽는다 — 그래야 「전달/새로 열기」를 정직하게 말한다.
 const [deviceSessions,setDeviceSessions]=useState<{deviceId:string;loading:boolean;error:string;sessions:AiTerminalSummary[]}|null>(null);
 useEffect(()=>{
  const requester=routeDeviceId?communityMentionRef.current?.requester(routeDeviceId):null;
  if(!routeDeviceId||!requester){setDeviceSessions(null);return;}
  let alive=true;setDeviceSessions({deviceId:routeDeviceId,loading:true,error:'',sessions:[]});
  requester({operation:'list'}).then(response=>{if(alive)setDeviceSessions({deviceId:routeDeviceId,loading:false,error:'',sessions:response.sessions??[]});})
   .catch((listError:unknown)=>{if(alive)setDeviceSessions({deviceId:routeDeviceId,loading:false,
     error:listError instanceof Error?listError.message:'그 기기의 작업 세션 목록을 받지 못했습니다.',sessions:[]});});
  return ()=>{alive=false;};
 },[routeDeviceId]);
 const routeSessions=routeDeviceId?(deviceSessions?.deviceId===routeDeviceId?deviceSessions.sessions:[]):sessions;
 // Not limited to the sender's AI: suggested is whoever already runs in the target, else this session's AI.
 // 앱 받는 곳은 이 Mac 화면에서만 — 휴대폰(remote)·다른 아젠투지로 보낼 때는 CLI만 고를 수 있다(src/workroomAppRoute.ts).
 const appRoutesAvailable=workroomAppRoutesAvailable({remote,routeDeviceId});
 const routeApp=routeTarget&&activeSession&&appRoutesAvailable?workroomAppAgentOf(routeAgentChoice):null;
 const routeAgent=routeTarget&&activeSession&&!routeApp?workroomCliAgentOf(routeAgentChoice)||defaultWorkroomRouteAgent(routeSessions,routeDeviceId?null:activeSession,routeTarget.targetId,activeSession.agent):undefined;
 const routeChoiceValue=routeApp?workroomAppChoice(routeApp):routeAgent;
 const routePlan=routeTarget&&activeSession&&routeAgent&&(!routeDeviceId||deviceSessions?.deviceId===routeDeviceId&&!deviceSessions.loading)
   ?planWorkroomRoute(routeSessions,routeDeviceId?null:activeSession,routeTarget.targetId,routeAgent):null;
 const mentionKind=mention?.kind;
 const slashCandidates=activeSession?slashCommandCandidates(activeSession.agent,terminalDraft,terminalCursor):[];
 const mentionCandidates=mention?.candidates??[];
 const localReferenceIds=useMemo(()=>referenceChips.filter(chip=>!chip.deviceId).map(chip=>chip.targetId),[referenceChips]);
 const naturalTargets=useMemo(()=>suggestedWorkroomTargets(terminalDraft,projects,routeTargetId,localReferenceIds)
   .filter(project=>project.targetId!==activeSession?.targetId),[terminalDraft,projects,routeTargetId,localReferenceIds,activeSession?.targetId]);
 const chooseMention=(project:WorkroomMentionProject)=>{
  if(!mention)return;
  const applied=applyCommunityMention(mention,terminalDraft,terminalCursor,project);
  setTerminalDraft(applied.value);setTerminalCursor(applied.cursor);
  if(mention.kind==='reference'){
   const chip={deviceId:mention.device?.deviceId??'',targetId:project.targetId,label:project.label,token:applied.token};
   setReferenceChips(chips=>chips.some(item=>item.token===chip.token)?chips:[...chips,chip].slice(-AI_TERMINAL_MAX_REFERENCES));
  }else routeTo(project.targetId,mention.device?.deviceId??'');
  requestAnimationFrame(()=>{terminalComposer.current?.focus();terminalComposer.current?.setSelectionRange(applied.cursor,applied.cursor)});
 };
 // Offline, nothing can be sent: keep what was typed (the caller clears the box only on true) and say so.
 // The controller would refuse it anyway, after the box was already emptied (review 2026-10-10).
 const sendBoundInput=(data:string,references?:string[])=>{if(!data||!activeSession||activeSession.state!=='running'||busy)return false;if(remote&&!phoneIsOnline()){const text=offlineInputNotice();phoneNetworkError.current={text,kind:'offline'};setError(text);return false;}flushInput.current?.();const parts=splitTerminalSubmission(data),group=parts.length>1?terminalSubmissionGroup():undefined;parts.forEach((part,index)=>enqueue({operation:'input',sessionId:activeSession.id,data:part,...(references?.length&&index===parts.length-1?{references}:{})},group));return true;};
 const focusCliKeyboard=()=>{rawInputRef.current=true;setRawInput(true);requestAnimationFrame(()=>terminal.current?.focus());};
 // View and palette controls should not strand arrow/Enter keys on a focused button.
 // Preserve the user's current input mode, including a partly written composer draft.
 const restoreWorkroomKeyboard=()=>requestAnimationFrame(()=>{
  if(rawInputRef.current)terminal.current?.focus();else terminalComposer.current?.focus();
 });
 // Only references whose `#label` is still in the text are sent; deleting the text drops the reference.
 // 폴더는 받는 쪽 호스트가 푼다 — 그래서 **받는 기기와 같은 기기의 참고만** 폴더로 넘긴다.
 const liveReferences=(text:string,deviceId:string)=>referencesSupported?communityReferencesFor(referenceChips,text,deviceId):{references:[],dropped:[]};
 const activeReferences=(text:string)=>liveReferences(text,'').references;
 // A new session whose first request does not fit this connection gets the message typed once it is ready; the preview says so.
 let routeStartTyped=false;
 if(routePlan?.kind==='start'&&routeTarget&&routeAgent&&activeSession){
  const references=liveReferences(terminalDraft,routeDeviceId).references;
  const prompt=workroomDeliveryInstruction({task:terminalDraft,sourceLabel:activeProject?.label??'현재 워크룸',sourceAgentLabel:WORKROOM_AGENT_NAMES[activeSession.agent],
    sourceDeviceLabel:routeDeviceId?deviceName?.trim()||'이 기기':undefined,targetLabel:routeTarget.label});
  routeStartTyped=!workroomStartCarriesPrompt({operation:'start',targetId:routeTarget.targetId,agent:routeAgent,cols:100,rows:28,bypassPermissions,prompt,...(references.length?{references}:{})},remote?'relay':'local');
 }
 // Favorites and model buttons run immediately, exactly as if typed into the CLI.
 const runSlashCommand=(command:string)=>{if(activeSession&&isWorkroomPaletteCommand(command,activeSession.agent)&&sendBoundInput(command+'\r')){
   // CLI pickers open inside the PTY. A clicked toolbar button must hand the
   // keyboard back to that PTY; otherwise arrows and Enter stay on the button.
   focusCliKeyboard();
  }};
 const completeSlash=(command:string)=>{const value=command+(command.startsWith('$')?'':' ');setTerminalDraft(value);setTerminalCursor(value.length);requestAnimationFrame(()=>{terminalComposer.current?.focus();terminalComposer.current?.setSelectionRange(value.length,value.length);});};
 const draftMessage=()=>workroomImageMessage(terminalDraft,images.map(image=>image.path));
 const sendTerminalDraft=()=>{if(sendBoundInput(draftMessage()+'\r',activeReferences(terminalDraft))){setTerminalDraft('');setTerminalCursor(0);setReferenceChips([]);setImages([]);requestAnimationFrame(()=>terminalComposer.current?.focus());}};
 // `@` delivery (2026-09-29, review H1/M1/M2/L3/L4/L6 — src/workroomRouteDelivery.ts): the chosen AI's newest
 // running session in the target receives the handoff, after its screen was read and shown in the dialog and
 // never while it waits on a question. Only when none runs does a new session start, with the handoff as its
 // first request when this connection and this Mac can carry it, else typed once the session is ready (typing
 // into a CLI that is still starting could answer its trust or login screen). The sender stays in its session.
 const renderScreen=useCallback((text:string,cols:number,rows:number)=>renderWorkroomScreenLines((width,height)=>new Terminal({cols:width,rows:height,scrollback:0,allowProposedApi:true}),text,cols,rows),[]);
 // 앱 받는 곳(2026-10-08): 같은 핸드오프 글을 만들어 이 Mac의 앱을 연다. Codex 앱만 입력칸에 채우도록 요청할 수 있고(보내지 않고,
 // 앱이 확인해 주지 않는다) 나머지는 클립보드로 넘긴다. 어느 앱이든 먼저 클립보드에 복사한다 — 채우기의 백업이고, 앱이 앞으로
 // 오면 클립보드 쓰기가 거절될 수 있다. 작업은 받을 수 있는 Codex에만 보낸다(다른 앱은 받지도 않는 글로 크기 검사에 걸리지 않게).
 // 클립보드에 확실히 남지 않았으면 초안을 지우지 않는다.
 const deliverToApp=async(appAgent:WorkroomAppAgent)=>{
  const source=activeSession,target=routeTarget,task=draftMessage();
  if(!task.trim()||!source||source.state!=='running'||!target||busy)return;
  const handoff=workroomDeliveryInstruction({task,sourceLabel:activeProject?.label??'현재 워크룸',sourceAgentLabel:WORKROOM_AGENT_NAMES[source.agent],targetLabel:target.label});
  const references=liveReferences(task,'').references.length;
  if(!window.confirm(workroomAppConfirmMessage(appAgent,target.label,handoff,references)))return;
  let clipboard:WorkroomAppClipboardState;try{await navigator.clipboard.writeText(handoff);clipboard='copied';}catch{clipboard='failed';}
  setBusy(true);setError('');setRouteReceipt(null);setAppRouteReceipt(null);
  try{
   const result=await requestWorkroomAppDispatch({targetId:target.targetId,agent:appAgent,...(workroomAppTakesTask(appAgent,handoff)?{task:handoff}:{}),...(appAgent==='claude'&&bypassPermissions?{bypass:true}:{})});
   if(!result.ok){setError(workroomAppFailureText(result,clipboard));return;}
   setAppRouteReceipt(workroomAppReceipt({agent:appAgent,targetLabel:target.label,result,clipboard,bypassRequested:bypassPermissions,droppedReferences:references}));
   if(workroomAppTaskKept(result,clipboard)){setTerminalDraft('');setTerminalCursor(0);routeTo('');setReferenceChips([]);setImages([]);}
  }finally{setBusy(false);}
 };
 const deliverTerminalDraft=async()=>{
  if(routeApp)return deliverToApp(routeApp);
  const source=activeSession,target=routeTarget,agentChoice=routeAgent,task=draftMessage();
  if(!task.trim()||!source||source.state!=='running'||!target||!agentChoice||busy)return;
  // 다른 아젠투지로 보낼 때는 그 기기의 세션 목록과 그 기기의 요청 함수로 **똑같은 전달 절차**를 돈다.
  const crossRequest=routeDeviceId?communityMentionRef.current?.requester(routeDeviceId)??null:null;
  if(routeDeviceId&&!crossRequest){setError('그 기기로 보낼 연결을 확인하지 못했습니다. 기기 목록을 새로 불러온 뒤 다시 시도하세요.');return;}
  if(routeDeviceId&&(deviceSessions?.deviceId!==routeDeviceId||deviceSessions.loading)){setError('그 기기의 작업 세션 목록을 받는 중입니다. 잠시 후 다시 보내세요.');return;}
  if(routeDeviceId&&deviceSessions?.error){setError(deviceSessions.error);return;}
  const crossSessions=routeDeviceId?deviceSessions?.sessions??[]:sessionsRef.current;
  const crossProjects=routeDeviceId?routeDevice?.projects??[]:projects;
  const plan=planWorkroomRoute(crossSessions,routeDeviceId?null:source,target.targetId,agentChoice);
  if(plan.kind==='current'){sendTerminalDraft();routeTo('');return;}
  const {references,dropped}=liveReferences(task,routeDeviceId);
  setBusy(true);setError('');setRouteReceipt(null);
  try{
   const result=await deliverWorkroomRoute({
    sessions:crossSessions,source,sourceLabel:activeProject?.label??'현재 워크룸',target:{targetId:target.targetId,label:target.label},agent:agentChoice,task,
    ...(routeDeviceId?{crossDevice:{sourceDeviceLabel:deviceName?.trim()||'이 기기'}}:{}),
    references,transport:remote?'relay':'local',bypassPermissions:bypassPermissions&&!routeDeviceId,
    sessionLabel:(list,id)=>workroomSessionLabels(list,targetId=>crossProjects.find(p=>p.targetId===targetId)?.label).get(id),
    request:crossRequest??request,confirm:message=>window.confirm(message),render:renderScreen,
    receiverBusy:id=>!routeDeviceId&&(closing.current.has(id)||inputPaused.current.has(id)),
    onStarted:session=>{if(routeDeviceId){setDeviceSessions(current=>current&&current.deviceId===routeDeviceId?{...current,sessions:[...current.sessions.filter(item=>item.id!==session.id),session]}:current);return;}
     inventoryEpoch.current++;setSessions(current=>[...current.filter(item=>item.id!==session.id),session]);},
    onProgress:progress=>setRouteReceipt(routeDeviceId?{sessionId:'',text:progress.text}:progress),
   });
   if(result.status==='cancelled')return;
   // 다른 기기의 세션에는 이 화면에서 바로 이동할 수 없다 — 그 기기 탭을 거쳐야 하므로 id를 비운다.
   const dropNote=dropped.length?` 다른 기기의 # 언급(${dropped.map(chip=>chip.label).join(', ')})은 폴더 없이 이름만 전달했습니다.`:'';
   setRouteReceipt({sessionId:routeDeviceId?'':result.receiver.id,text:result.receipt+dropNote});
   // `held`: a new session opened but the message was not typed (it waits on a question): the draft stays.
   if(result.status==='delivered'){setTerminalDraft('');setTerminalCursor(0);routeTo('');setReferenceChips([]);setImages([]);}
  }catch(deliveryError){setRouteReceipt(null);setError(deliveryError instanceof Error?deliveryError.message:String(deliveryError));}
  finally{setBusy(false);}
 };
 // 「세션 기억하기」 types the CLI's own command into the running session and sends Enter, so the
 // agent holding this conversation writes the memory. Only agents that have such a command take
 // this path; the others keep the draft, and the label says which one will happen.
 const memoryCommand=activeSession&&activeSession.state==='running'?workroomMemoryCommand(activeSession.agent):null;
 const remoteMemoryDraft=()=>{
  if(!activeProject||busy)return;
  if(prompt.trim()){setError('작성 중인 요청을 유지했습니다. 먼저 내용을 실행하거나 비운 뒤 세션 기억 요청을 여세요.');setComposerOpen(true);return;}
  draftGeneration.current++;setTarget(activeProject.targetId);setAgent(activeSession?.agent==='claude'?'claude':'codex');setComposerOpen(true);setFocusRequest(value=>value+1);setRequestTitle('세션 기억하기 · 실행 전 확인');setError('');
  setPrompt('이 프로젝트의 remember-session 스킬을 실행해 완료된 작업과 검증된 결정을 장기기억에 저장하세요. 실제 저장소와 기존 기억을 먼저 확인하고, 진행 중인 작업이나 잠금 또는 미확정 저장이 있으면 강제로 해제하거나 덮어쓰거나 재실행하지 말고 현재 상태를 설명하세요.');
 };
 const reviewMemory=(review:WorkroomMemoryReviewTarget)=>{if(prompt.trim()){setError('작성 중인 요청을 유지했습니다. 먼저 내용을 실행하거나 비운 뒤 저장 확인 요청을 여세요.');setComposerOpen(true);return;}draftGeneration.current++;setTarget(review.targetId);setSelected('');setAgent('codex');setComposerOpen(true);setFocusRequest(value=>value+1);setRequestTitle(`저장 상태 진단 요청 · ${review.count}건`);setPrompt(buildWorkroomMemoryReviewPrompt(review));};
 // 빈 「새 작업」 칸은 **항상** 접는다. 처음엔 실행 중 세션이 있을 때만 접었는데, 그러면 세션이 0개인
 // 화면(다른 아젠투지를 막 고른 직후가 그렇다)에서는 늘 한 화면짜리 빈 칸이 먼저 보였다
 // (VOC 2026-10-05: 「항상 그 네모칸은 없어도 되지 않나?」). 요청 없이 열려면 「작업 시작」으로 충분하다.
 // 지우는 것이 아니라 접는 것이다 — 첫 요청을 담아 새 세션을 여는 유일한 길이기 때문이고,
 // 「새 작업 요청 작성」 버튼과 넘겨받은 초안(`entry`)이 그 길을 연다.
 const composerFoldable=true;
 const composerShown=!composerFoldable||composerOpen;
 return <section ref={panel} className={`ai-terminal-panel${popout&&activeSession&&!composerOpen?' ai-terminal-panel--focused':''}`} data-session-count={sessions.length} data-testid="ai-terminal-panel">
  <header className="ai-terminal-head">
   <h2 className="ai-terminal-title">워크룸 <span className="ai-terminal-hint">AI 터미널</span></h2>
   <div className="ai-terminal-context-actions">
    {!remote&&onManageProject&&activeProject&&<button className="ai-terminal-btn" title={activeProject.label} onClick={()=>onManageProject(('projectTargetId' in activeProject ? activeProject.projectTargetId as string : undefined)??activeProject.targetId)}>프로젝트·장기기억</button>}
    {/* A pop-out has no app to hand the request to, so it opens the same draft inside this window. */}
    {!remote&&(onRememberSession||popout||memoryCommand)&&activeProject&&<button data-testid="workroom-remember-session" disabled={!memoryCommand&&!onRememberSession&&busy} className="ai-terminal-btn" title={memoryCommand?`실행 중인 이 세션에 ${memoryCommand}를 입력하고 Enter까지 보냅니다.`:'작성칸에 저장 요청 초안을 넣습니다. 전송은 직접 누르세요.'} onClick={()=>{if(memoryCommand){runSlashCommand(memoryCommand);return;}if(onRememberSession)onRememberSession(activeProject.targetId);else remoteMemoryDraft();}}>{memoryCommand?'이 세션에서 기억하기':'세션 기억하기…'}</button>}
    {remote&&activeProject&&<button data-testid="workroom-remote-remember-session" disabled={busy} className="ai-terminal-btn" onClick={()=>onRememberSession?onRememberSession(activeProject!.targetId):remoteMemoryDraft()}>세션 기억하기…</button>}
    {onWhatISaid&&<button className="ai-terminal-btn" onClick={onWhatISaid}>내가 한 말</button>}
   </div>
   <p className="ai-terminal-caption">{popout?'이 창에서 기기·프로젝트·AI를 골라 새 작업을 시작할 수 있습니다. 창을 닫아도 세션은 유지됩니다.':remote?'프로젝트와 AI를 골라 작업을 시작하세요. 화면을 닫거나 탭을 옮겨도 실행 중인 세션은 유지됩니다.':'프로젝트와 AI를 골라 시작하면 별도 창에서 작업합니다. 창을 닫아도 세션은 유지됩니다.'}</p>
   <div className="ai-terminal-launch-options">
    <button type="button" className={`ai-terminal-btn${bypassPermissions?' ai-terminal-btn--warn':''}`} data-testid="workroom-launch-options" data-bypass={bypassPermissions?'on':'off'} aria-expanded={optionsOpen} aria-controls={promptId+'-options'} onClick={()=>setOptionsOpen(value=>!value)}>승인 없이 실행 (권한 우회) · {bypassUnavailable?'이 기기에서는 꺼짐':bypassPermissions?'켜짐':'꺼짐'}</button>
    {optionsOpen&&<div id={promptId+'-options'} className="ai-terminal-options-content">
     <label><input type="checkbox" checked={bypassPermissions} disabled={busy||!!bypassUnavailable} onChange={e=>changeBypass(e.target.checked)}/> 승인 없이 실행 (권한 우회)</label>
     {bypassUnavailable&&<p className="ai-terminal-hint" data-testid="workroom-bypass-unavailable">{bypassUnavailable}</p>}
     <p className="ai-terminal-hint">켜져 있으면 AI가 파일 수정·명령 실행 전에 묻지 않습니다. 처음이라면 꺼 두는 것을 권장합니다. 꺼 두면 각 AI의 기본 승인 설정을 따릅니다. 다음에 새로 여는 터미널부터 적용되고, 이미 실행 중인 세션에는 적용되지 않습니다.</p>
    </div>}
   </div>
   {deviceSwitch}
   <div className="ai-terminal-toolbar">
    <label className="ai-terminal-field ai-terminal-field--project"><span className="ai-terminal-label">프로젝트·워크트리</span>{!deviceSwitch&&<span className="ai-terminal-hint">{sessionDevice}</span>}
     <select aria-label="터미널 프로젝트" value={target} disabled={busy} onChange={e=>setTarget(e.target.value)} className="ai-terminal-select ai-terminal-select--project"><option value="">프로젝트 선택</option>{target&&!targetProject&&<option value={target}>프로젝트 연결 확인 필요</option>}{(()=>{const ops=opsTargetId?projects.find(p=>p.targetId===opsTargetId):undefined;if(!ops)return projects.map(p=><option key={p.targetId} value={p.targetId}>{p.label}</option>);
       // 총괄 is not one project among many (VOC 2026-10-08: OPS sat below mcp-series on the phone) — it leads, in its own group.
       return <><optgroup label="총괄 (OPS)"><option value={ops.targetId} data-testid="ai-terminal-project-ops">{ops.label} · {sessionOwner(ops.targetId)}</option></optgroup><optgroup label="프로젝트">{projects.filter(p=>p!==ops).map(p=><option key={p.targetId} value={p.targetId}>{p.label}</option>)}</optgroup></>;})()}</select>
    </label>
    <label className="ai-terminal-field"><span className="ai-terminal-label">AI</span>
     <select aria-label="터미널 AI" value={agent} disabled={busy} onChange={e=>setAgent(e.target.value as AiTerminalAgent)} className="ai-terminal-select">{AI_TERMINAL_AGENTS.map(a=><option key={a} value={a}>{aiTerminalAgentLabel(a)}</option>)}</select>
    </label>
    <button disabled={!canStart} onClick={()=>void start()} className="ai-terminal-btn ai-terminal-start"><Plus size={14}/>{busy?'시작 중…':'작업 시작'}</button>
    <button disabled={busy} onClick={()=>{void refresh();if(!remote){void refreshConnections();setTargetReload(value=>value+1)}}} aria-label="작업 세션 새로고침" className="ai-terminal-btn ai-terminal-btn--icon"><RotateCw size={14}/></button>
   </div>
   {activeSession&&<p className="ai-terminal-caption" data-testid="workroom-target-context">현재 세션: {activeProject?.label??'프로젝트'} · 시작할 작업: {targetProject?.label??'프로젝트 선택 필요'}</p>}
   {/* 전용 창에서는 실행 칸(프로젝트·AI)이 접혀 있고 이 버튼이 그 펼치기 버튼 자리를 쓴다. 그래서 AI를
       **여기서** 고를 수 있어야 한다 — 없으면 네 CLI 중 무엇으로 열리는지 따라가기만 하고 바꿀 길이
       없었다(VOC 2026-10-05). 프로젝트까지 바꾸려면 옆의 펼치기 버튼으로 간다. */}
   {composerFoldable&&(!!activeSession&&popoutAvailability.available&&!prompt.trim()&&!composerShown
    ?<div className="ai-terminal-new-window">
      <button className="ai-terminal-btn" data-testid="workroom-new-window" disabled={busy} title={`${(targetProject??activeProject)?.label??'이 프로젝트'}에서 ${aiTerminalAgentLabel(agent)}로 같은 프로젝트·AI로 깨끗한 작업을 새 창에 하나 더 엽니다.`} onClick={()=>void openFreshWindow()}>작업 하나 더 · 새 창</button>
      <label className="ai-terminal-new-window-agent"><span className="ai-terminal-label">AI</span>
       <select aria-label="새 창에서 열 AI" data-testid="workroom-new-window-agent" value={agent} disabled={busy} onChange={e=>setAgent(e.target.value as AiTerminalAgent)} className="ai-terminal-select">{AI_TERMINAL_AGENTS.map(a=><option key={a} value={a}>{aiTerminalAgentLabel(a)}</option>)}</select>
      </label>
      <button className="ai-terminal-btn" data-testid="workroom-composer-toggle" aria-expanded={false} title="프로젝트·워크트리까지 고르고 첫 요청을 적어서 엽니다." onClick={()=>{setFocusRequest(value=>value+1);setComposerOpen(true)}}>프로젝트·요청 고르기</button>
     </div>
    :<button className="ai-terminal-btn" data-testid="workroom-composer-toggle" aria-expanded={composerShown} onClick={()=>{if(!composerShown)setFocusRequest(value=>value+1);setComposerOpen(!composerShown)}}>{composerShown?'요청 칸 접기':prompt.trim()?'작성 중인 요청 다시 보기':'요청 적고 시작하기'}</button>)}
   {/* One voice entry (VOC 2026-09-29): 아젠투지 voice is the dock, not a second 「음성으로 시작」 here. The
       request box types to the OPS workroom's AI, which is the 총괄's hands — say so, since both are
       "아젠투지 OPS". ⚠️ 이 줄은 **접힌 칸 밖**이다: 칸이 기본으로 접히게 된 뒤(2026-10-05) 안에 두면
       정작 처음 보는 사람에게 보이지 않는다. */}
   {opsTargetId&&target===opsTargetId&&<p className="ai-terminal-hint" data-testid="workroom-ops-input-hint">여기서 시작하는 작업은 OPS 워크룸의 {aiTerminalAgentLabel(agent)}에게 갑니다. 총괄과 말하려면 화면 아래 「아젠투지 호출」을 누르세요.</p>}
   {activeSession&&!composerOpen&&!!prompt.trim()&&<p className="ai-terminal-caption">작성 중인 요청이 있습니다. 작업을 시작하면 이 요청을 전달합니다.</p>}
   {targetError&&<p className="ai-terminal-caption" role="alert">프로젝트·워크트리 목록을 갱신하지 못했습니다. 터미널 새로고침으로 다시 확인하세요.<ErrorVocActions message="프로젝트·워크트리 목록을 갱신하지 못했습니다." code="WORKROOM_TARGETS_FAILED" surface="workroom"/></p>}
  </header>
  {(error||connectionError||readError)&&<p role="alert" className="ai-terminal-error ai-terminal-launch-error">{error||connectionError||readError}<ErrorVocActions message={error||connectionError||readError} surface="workroom"/></p>}
  {resuming&&<p className="ai-terminal-caption" role="status">{targetProject?.label??'선택한 프로젝트'}의 실행 중인 세션을 확인하고 있습니다. 연결이 지연되면 터미널 새로고침으로 다시 확인하세요.</p>}
  {composerShown&&<div className="ai-terminal-prompt" data-testid="workroom-composer">
   <label className="ai-terminal-label" htmlFor={promptId}>{requestTitle||'어떤 작업을 할까요?'}</label>
   <textarea ref={promptField} id={promptId} aria-label="터미널에 전달할 작업" value={prompt} disabled={busy} onChange={e=>{const invalid=aiInitialPromptDraftError(e.target.value);if(invalid){setError(invalid+' 현재 초안은 유지했습니다.');return;}draftGeneration.current++;setPrompt(e.target.value)}} placeholder="작업을 적으면 선택한 AI에 전달합니다. 비워 두고 터미널만 열어도 됩니다." className="ai-terminal-textarea"/>
   <p className="ai-terminal-hint">{prompt.length>AI_INITIAL_PROMPT_MAX_BYTES?'24,000 초과':new TextEncoder().encode(prompt).length.toLocaleString('ko-KR')} / 24,000바이트</p>
   {promptError&&<p role="alert" className="ai-terminal-error">{promptError}<ErrorVocActions message={promptError} surface="workroom-prompt"/></p>}
   {remote&&requestTitle==='세션 기억하기 · 실행 전 확인'&&<p className="ai-terminal-hint" data-testid="workroom-remote-memory-guide">요청과 프로젝트를 확인하고 ‘선택한 AI로 시작’을 누르세요. 새 AI 세션에서 저장을 요청하며, 버튼을 누르는 것만으로 저장이 완료되지는 않습니다.</p>}
   <p className="ai-terminal-hint">{targetProject?`${targetProject.label}에서 ${aiTerminalAgentLabel(agent)}로 시작합니다.`:'등록된 프로젝트·워크트리를 선택해 주세요.'}</p>
   {agent==='codex'&&<p className="ai-terminal-hint">Codex의 $ 스킬 목록은 작업을 시작한 뒤 터미널 안에서 사용할 수 있습니다. 이 입력칸은 작업 내용을 전달합니다.</p>}
   {!!prompt.trim()&&<button className="ai-terminal-btn ai-terminal-start" disabled={!canStart} onClick={()=>void start()}>선택한 AI로 시작</button>}
  </div>}
  {remote&&!sessions.length&&!connectionError&&<p className="ai-terminal-hint" data-testid="workroom-remote-no-sessions">{sessionDevice}에 실행 중인 작업 세션이 없습니다. 이 기기에서 허용한 프로젝트의 세션만 표시됩니다.</p>}
  {!!sessions.length&&<div className={`ai-terminal-workspace${activeSession?'':' ai-terminal-workspace--idle'}`}>
  <aside className="ai-terminal-session-list"><h3>작업 세션 <span>{runningSessions.length}</span></h3><p className="ai-terminal-session-owner" data-testid="workroom-session-owner">{sessionDevice}의 세션</p>
  {!!endedSessions.length&&<button className="ai-terminal-btn" aria-pressed={showEnded} onClick={()=>setShowEnded(value=>!value)}>{showEnded?'종료된 세션 숨기기':'종료된 세션 보기'} ({endedSessions.length})</button>}
  <div className="ai-terminal-tabs" role="tablist" aria-label={`${sessionDevice}의 터미널 세션`}>{visibleSessions.map(s=><button role="tab" aria-selected={s.id===selected} key={s.id} title={`${sessionOwner(s.targetId)} · ${workroomSessionStartedAt(s.createdAt)||'시작 시각 확인 불가'}`} onClick={()=>void openListedSession(s)} className={`ai-terminal-tab${s.state==='running'?'':' ai-terminal-tab--ended'}`}><span className={`ai-terminal-dot${s.state==='running'?' ai-terminal-dot--running':''}`} aria-hidden="true"/><span className="ai-terminal-tab-owner">{sessionOwner(s.targetId)}</span>{sessionLabels.get(s.id)}<span className="ai-terminal-tab-state">{workroomSessionStateLabel(s)}</span></button>)}</div></aside>
  <div className="ai-terminal-body">
   {activeSession?<>
    <div className="ai-terminal-current"><span className="ai-terminal-tab-owner">{sessionOwner(activeSession.targetId)}</span><span className="ai-terminal-current-label">{sessionLabels.get(activeSession.id)}</span><div className="ai-terminal-view-controls" role="group" aria-label="터미널 보기">
    <button type="button" className="ai-terminal-btn ai-terminal-btn--icon" data-testid="workroom-font-decrease" aria-label="글자 작게" title="글자 작게" disabled={fontSize<=WORKROOM_FONT_MIN} onClick={()=>{chooseFontSize(-1);restoreWorkroomKeyboard()}}>A−</button>
    <button type="button" className="ai-terminal-btn ai-terminal-font-size" data-testid="workroom-font-size" aria-label={`글자 크기 ${fontSize} · 누르면 기본값`} title="누르면 기본 크기(13)로" onClick={()=>{setFontSize(WORKROOM_FONT_DEFAULT);restoreWorkroomKeyboard()}}>{fontSize}</button>
    <button type="button" className="ai-terminal-btn ai-terminal-btn--icon" data-testid="workroom-font-increase" aria-label="글자 크게" title="글자 크게" disabled={fontSize>=WORKROOM_FONT_MAX} onClick={()=>{chooseFontSize(1);restoreWorkroomKeyboard()}}>A+</button>
    {!remote&&!popout&&<button type="button" className="ai-terminal-btn" data-testid="workroom-wide-toggle" aria-pressed={wide} title={wide?'사이드바와 설정을 다시 표시':'사이드바와 설정을 숨기고 터미널을 화면 가득'} onClick={()=>{setWide(value=>!value);restoreWorkroomKeyboard()}}>{wide?<Minimize2 size={13}/>:<Maximize2 size={13}/>}{wide?'기본 보기':'넓게 보기'}</button>}
    {!remote&&<button type="button" className="ai-terminal-btn" data-testid="workroom-restart" disabled={busy} title={workroomRestartTitle(activeSession.state)} onClick={()=>void restart()}><RotateCcw size={13}/>다시 시작</button>}
    {remote&&<button type="button" className="ai-terminal-btn" data-testid="workroom-readable-toggle" aria-pressed={readableMode} onClick={()=>{setReadableMode(value=>!value);restoreWorkroomKeyboard()}}>{readableMode?'원본 터미널':'읽기 보기'}</button>}
    {!remote&&<button type="button" className="ai-terminal-btn" data-testid="workroom-popout" aria-disabled={!popoutAvailability.available} data-available={popoutAvailability.available?'true':'false'} title={popoutAvailability.reason} onClick={()=>void popOut()}><ExternalLink size={13}/>새 창으로 분리</button>}
   </div></div>
   {restartNotice&&restartNotice.sessionId===activeSession.id&&<p className="ai-terminal-caption ai-terminal-route-receipt" role="status" data-testid="workroom-restart-notice"><span>{restartNotice.text}</span><button type="button" className="ai-terminal-btn ai-terminal-btn--icon" aria-label="다시 시작 알림 닫기" onClick={()=>setRestartNotice(null)}>×</button></p>}
   <div className={`ai-terminal-surface${remote?' ai-terminal-surface--remote':''}`} onClick={()=>{if(!rawInput&&!readableMode)terminalComposer.current?.focus()}}><div ref={host} className="ai-terminal-screen" aria-hidden={remote&&readableMode}/>{remote&&readableMode&&<pre className="ai-terminal-readable" data-testid="workroom-readable-screen" role="region" aria-label="화면 너비에 맞춘 터미널 출력" style={{fontSize}}>{readableScreen||'화면을 불러오는 중…'}</pre>}</div>
   {activeSession.state==='exited'&&<p className="ai-terminal-hint" role="status" data-testid="workroom-exited-hint">터미널이 종료되었습니다 (종료 코드 {activeSession.exitCode??'확인 중'}). 입력칸은 실행 중인 세션에만 있습니다. 마지막 화면에서 종료 이유를 확인하고, {remote?'위 설정에서 새 작업을 시작할 수 있습니다':'위 「다시 시작」으로 같은 프로젝트·AI를 다시 열 수 있습니다(Claude Code·Codex는 이전 대화를 이어서)'}. 마지막 출력과 세션 저장 기록은 유지됩니다.</p>}
   {activeSession.state==='exited'&&<button data-testid="workroom-dismiss-session" className="ai-terminal-btn" onClick={()=>{setDismissed(ids=>[...ids.filter(id=>id!==selected),selected].slice(-24));setSelected('')}}>종료된 세션 목록에서 제거</button>}
   {activeSession.state==='running'&&<div className="ai-terminal-command" data-testid="workroom-command-composer">
    <div className="ai-terminal-command-head"><span><AtSign size={13}/><span><b>@ 호출</b> 다른 프로젝트 AI에게 맡기기 · <b># 언급</b> 참고로 보여 주기(여러 개){!!communityDevices.length&&<> · 기호 앞에 <b>기기 이름</b>을 적으면 그 아젠투지의 프로젝트</>}</span></span>{routeTarget&&<button type="button" className="ai-terminal-route-chip" data-testid="workroom-route-chip" onClick={()=>routeTo('')}>@ 호출 · {routeTarget.label} ×</button>}
     {routeTarget&&routeChoiceValue&&<label className="ai-terminal-route-agent" title={appRoutesAvailable?'그 프로젝트의 워크룸 CLI에 보내거나, 이 Mac의 앱(Codex·Claude·Hermes·Antigravity)으로 넘깁니다':'그 프로젝트에서 이 일을 받을 AI'}><span>{appRoutesAvailable?'받는 곳':'받는 AI'}</span><select aria-label={appRoutesAvailable?'받는 곳':'받는 AI'} data-testid="workroom-route-agent" data-route-surface={routeApp?'app':'cli'} value={routeChoiceValue} disabled={busy} onChange={e=>setRouteAgentChoice(e.target.value as WorkroomRouteChoice)} className="ai-terminal-select">{appRoutesAvailable?<><optgroup label="워크룸 CLI">{AI_TERMINAL_AGENTS.map(a=><option key={a} value={a}>{WORKROOM_AGENT_NAMES[a]}</option>)}</optgroup><optgroup label="앱">{WORKROOM_APP_AGENTS.map(a=><option key={a} value={workroomAppChoice(a)}>{WORKROOM_APP_NAMES[a]}</option>)}</optgroup></>:AI_TERMINAL_AGENTS.map(a=><option key={a} value={a}>{WORKROOM_AGENT_NAMES[a]}</option>)}</select></label>}
     {referenceChips.map(chip=><button type="button" key={chip.token} className="ai-terminal-route-chip ai-terminal-reference-chip" data-testid="workroom-reference-chip" title={chip.deviceId?'다른 아젠투지의 프로젝트입니다. 그 기기로 보낼 때만 폴더까지 함께 전달됩니다.':'AI가 이 프로젝트 폴더를 읽어서 참고합니다. 수정은 현재 프로젝트에서만 합니다.'} onClick={()=>setReferenceChips(chips=>chips.filter(item=>item.token!==chip.token))}># 언급 · {chip.deviceId?`${communityDevices.find(device=>device.deviceId===chip.deviceId)?.label??'다른 기기'} · ${chip.label}`:chip.label} ×</button>)}</div>
    <div className="ai-terminal-command-field">
     <textarea ref={terminalComposer} aria-label="워크룸 입력" value={terminalDraft} disabled={busy} rows={2} maxLength={20000} placeholder={activeSession.agent==='codex'?'요청 · CLI 명령 / · 설치된 스킬 $ · @ 호출 · # 언급':remote?'한글·명령·요청 입력 · @ 호출 · # 언급':'한글·명령·요청 입력 · @ 호출 · # 언급 · ⌘V 이미지'}
      onPaste={event=>{if(remote)return;const files=event.clipboardData?.files;const picks=workroomImageFiles(files);if(!picks.length||!files)return;
       // Rich copies (a web page, Notion) carry text and an image: the text still pastes, the image is attached.
       if(!event.clipboardData.getData('text/plain'))event.preventDefault();void attachBlobs(picks.map(index=>files[index]!));}}
      onChange={event=>{setTerminalDraft(event.target.value);setTerminalCursor(event.target.selectionStart??event.target.value.length)}}
      onSelect={event=>setTerminalCursor(event.currentTarget.selectionStart??event.currentTarget.value.length)}
      onKeyDown={event=>{if(event.nativeEvent.isComposing||event.keyCode===229)return;
        // The CLI's keys work from here too (NHCS draftKeyToCli, src/workroomComposerKeys.ts): arrows, Tab, Enter… while the box is empty.
        const cliKey=workroomComposerKeyToCli(event.key,{ctrl:event.ctrlKey,meta:event.metaKey,alt:event.altKey,shift:event.shiftKey},{empty:!terminalDraft.trim()&&!images.length&&!routeTarget,appCursor:!!terminal.current?.modes.applicationCursorKeysMode,menuOpen:!!slashCandidates.length||!!mentionCandidates.length,repeat:event.repeat});
        if(cliKey&&sendBoundInput(cliKey)){event.preventDefault();return;}
        if(event.key==='Tab'&&slashCandidates.length){event.preventDefault();completeSlash(slashCandidates[0]!.command);return;}if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();const exact=slashCandidates.some(c=>c.command===terminalDraft.trim());if(slashCandidates.length&&!exact&&!routeTarget){runSlashCommand(slashCandidates[0]!.command);setTerminalDraft('');setTerminalCursor(0);return;}if(routeTarget)void deliverTerminalDraft();else sendTerminalDraft();}}}/>
     <button type="button" className="ai-terminal-btn ai-terminal-start" disabled={busy||imageBusy||(!terminalDraft.trim()&&!images.length)} onClick={()=>routeTarget?void deliverTerminalDraft():sendTerminalDraft()}><Send size={13}/>{routeTarget?(routeApp?workroomAppSendLabel(routeApp,workroomDeliveryInstruction({task:draftMessage(),sourceLabel:activeProject?.label??'현재 워크룸',sourceAgentLabel:WORKROOM_AGENT_NAMES[activeSession.agent],targetLabel:routeTarget.label})):routeDeviceId?`${routeDevice?.label??'다른 아젠투지'}에 전달`:'프로젝트에 전달'):'현재 세션에 전송'}</button>
    </div>
    {!remote&&<div className="ai-terminal-images" data-testid="workroom-images" role="group" aria-label="이미지 넣기">
     <span className="ai-terminal-images-label"><ImagePlus size={13}/>이미지</span>
     {(['region','window','screen'] as const).map(mode=><button type="button" key={mode} className="ai-terminal-key" data-testid={`workroom-capture-${mode}`} disabled={busy||imageBusy} title={`${WORKROOM_CAPTURE_LABELS[mode]} · 캡처하는 동안 이 앱을 잠시 숨깁니다 · Esc로 취소`} onClick={()=>void capture(mode)}>{WORKROOM_CAPTURE_LABELS[mode]} <kbd>{WORKROOM_CAPTURE_SHORTCUTS[mode].label}</kbd></button>)}
     <span className="ai-terminal-hint">또는 ⌘V로 붙여넣기</span>
     {imageBusy&&<span className="ai-terminal-hint" role="status">이미지를 넣는 중…</span>}
     {!!images.length&&<div className="ai-terminal-image-chips">{images.map(image=><span key={image.path} className="ai-terminal-image-chip" data-testid="workroom-image-chip" title={image.path}>{image.thumbnail&&<img src={image.thumbnail} alt=""/>}<span>{image.name}</span><button type="button" aria-label={`${image.name} 빼기`} onClick={()=>{const next=imagesRef.current.filter(item=>item.path!==image.path);imagesRef.current=next;setImages(next);}}>×</button></span>)}</div>}
    </div>}
    <VoiceSentReceipt sessionId={activeSession.id}/>
    {routeTarget&&routeApp&&<p className="ai-terminal-hint" data-testid="workroom-route-plan" data-route-plan="app">{workroomAppRoutePreview(routeApp,routeTarget.label,workroomDeliveryInstruction({task:draftMessage(),sourceLabel:activeProject?.label??'현재 워크룸',sourceAgentLabel:WORKROOM_AGENT_NAMES[activeSession.agent],targetLabel:routeTarget.label}),liveReferences(draftMessage(),'').references.length)}{bypassPermissions&&routeApp!=='claude'?' 권한 우회는 Claude 앱에만 적용됩니다.':''}</p>}
    {appRouteReceipt&&<p className="ai-terminal-caption ai-terminal-route-receipt" role="status" data-testid="workroom-app-route-receipt"><span>{appRouteReceipt}</span><button type="button" className="ai-terminal-btn ai-terminal-btn--icon" aria-label="앱 전달 알림 닫기" onClick={()=>setAppRouteReceipt(null)}>×</button></p>}
    {routeTarget&&routeAgent&&routePlan&&<p className="ai-terminal-hint" data-testid="workroom-route-plan" data-route-plan={routePlan.kind}>{workroomRoutePreview(routePlan.kind,routeTarget.label,WORKROOM_AGENT_NAMES[routeAgent],{sessionLabel:routePlan.kind==='deliver'?sessionLabels.get(routePlan.session.id):undefined,typed:routeStartTyped})}</p>}
    {routeReceipt&&<p className="ai-terminal-caption ai-terminal-route-receipt" role="status" data-testid="workroom-route-receipt"><span>{routeReceipt.text}</span>{sessions.some(s=>s.id===routeReceipt.sessionId)&&<button type="button" className="ai-terminal-btn" data-testid="workroom-route-jump" onClick={()=>{const id=routeReceipt.sessionId;selectionGeneration.current++;setError('');setSelected(id);}}>그 세션으로 이동</button>}<button type="button" className="ai-terminal-btn ai-terminal-btn--icon" aria-label="전달 알림 닫기" onClick={()=>setRouteReceipt(null)}>×</button></p>}
    {(!!mentionCandidates.length||!!mention?.device)&&<div className="ai-terminal-mention-menu" role="listbox" aria-label={mentionKind==='reference'?'언급할 프로젝트 선택':'호출할 프로젝트 선택'} data-testid="workroom-mention-menu" data-mention-device={mention?.device?.label??''}>
     {!!mention?.device&&<p className="ai-terminal-hint" data-testid="workroom-mention-device">{mention.device.label}의 프로젝트</p>}
     {mentionCandidates.map(project=><button type="button" role="option" key={(mention?.device?.deviceId??'')+':'+project.targetId} onClick={()=>chooseMention(project)}>{mentionKind==='reference'?<Hash size={12}/>:<AtSign size={12}/>}<span>{project.label}</span>{!mention?.device&&project.targetId===activeSession.targetId&&<small>현재</small>}<small>{mentionKind==='reference'?'참고':'받는 곳'}</small></button>)}
     {mention?.loading&&<p className="ai-terminal-hint" data-testid="workroom-mention-loading">{mention.device?.label}의 프로젝트 목록을 받고 있습니다…</p>}
     {!!mention?.error&&<p className="ai-terminal-hint ai-terminal-hint--error" role="alert" data-testid="workroom-mention-error">{mention.error}</p>}
     {!mention?.loading&&!mention?.error&&!mentionCandidates.length&&<p className="ai-terminal-hint" data-testid="workroom-mention-empty">이름과 맞는 프로젝트가 없습니다.{mention?.hasMore?' 그 기기의 목록 일부만 받았습니다 — 「기기」에서 그 아젠투지를 골라 목록을 더 불러올 수 있습니다.':''}</p>}
     {!!mention?.hasMore&&!!mentionCandidates.length&&<p className="ai-terminal-hint" data-testid="workroom-mention-partial">그 기기의 목록 일부만 받았습니다.</p>}
    </div>}
    {!!slashCandidates.length&&<div className="ai-terminal-mention-menu ai-terminal-slash-menu" role="listbox" aria-label="CLI 명령과 스킬">{slashCandidates.map(c=><div key={c.command} className="ai-terminal-slash-option"><button type="button" role="option" onClick={()=>completeSlash(c.command)}><span>{c.command}</span><small>{c.description}</small></button><button type="button" className="ai-terminal-slash-star" aria-pressed={slashFavorites.includes(c.command)} aria-label={`${c.command} 즐겨찾기${slashFavorites.includes(c.command)?' 해제':' 추가'}`} onClick={()=>toggleFavorite(c.command)}>{slashFavorites.includes(c.command)?'★':'☆'}</button></div>)}<p className="ai-terminal-hint">Tab 완성 · Enter 바로 실행 · 목록에 없는 명령도 그대로 입력해 보낼 수 있습니다.</p></div>}
    {!referencesSupported&&referenceChips.length>0&&<p className="ai-terminal-hint" role="status">이 Mac 버전은 # 참고를 지원하지 않아 프로젝트 이름만 전달됩니다. Mac 앱을 업데이트하면 폴더까지 함께 전달됩니다.</p>}
    {!!routeDeviceId&&referenceChips.some(chip=>chip.deviceId!==routeDeviceId)&&<p className="ai-terminal-hint" role="status" data-testid="workroom-reference-cross-device">받는 기기와 다른 아젠투지의 # 언급은 폴더 없이 이름만 전달됩니다 — 폴더는 받는 쪽 Mac만 열 수 있습니다.</p>}
    {!!routeDeviceId&&deviceSessions?.deviceId===routeDeviceId&&deviceSessions.loading&&<p className="ai-terminal-hint" role="status" data-testid="workroom-route-device-loading">{routeDevice?.label}의 작업 세션 목록을 받고 있습니다…</p>}
    {!!routeDeviceId&&deviceSessions?.deviceId===routeDeviceId&&!!deviceSessions.error&&<p className="ai-terminal-hint ai-terminal-hint--error" role="alert" data-testid="workroom-route-device-error">{deviceSessions.error}</p>}
    {!routeTarget&&!!naturalTargets.length&&<div className="ai-terminal-natural-targets"><span>전달 대상 확인</span>{naturalTargets.map(project=><button type="button" key={project.targetId} onClick={()=>routeTo(project.targetId)}>‘{project.label}’ 선택</button>)}</div>}
    <p className="ai-terminal-hint">이 입력창은 macOS·iPhone의 한글 IME가 조합을 끝낸 문자열만 네 AI에 전달합니다. Shift+Enter는 줄바꿈입니다. {WORKROOM_COMPOSER_KEYS_HINT}{!remote&&' 넣은 이미지는 이 Mac의 파일 경로로 함께 전달되고, AI가 그 파일을 열어 봅니다.'}</p>
   </div>}
   {activeSession.state==='running'&&<div className="ai-terminal-slash-bar" data-testid="workroom-slash-bar" aria-label="슬래시 명령 즐겨찾기">
    {slashFavorites.map(command=><button type="button" key={command} className="ai-terminal-key ai-terminal-slash-favorite" disabled={busy} title={`${command} 실행`} onClick={()=>runSlashCommand(command)}>{command}</button>)}
    <button type="button" className="ai-terminal-key" data-testid="workroom-slash-pad-toggle" aria-expanded={slashPadOpen} onClick={()=>{setSlashPadOpen(open=>!open);restoreWorkroomKeyboard()}}>{slashPadOpen?'명령 모음 닫기':activeSession.agent==='codex'?'/ 명령 · $ 스킬':'/ 명령 모음'}</button>
   </div>}
   {activeSession.state==='running'&&slashPadOpen&&<div className="ai-terminal-slash-pad" data-testid="workroom-slash-pad" role="group" aria-label="CLI 명령과 스킬 모음">
    {activeSession.agent==='codex'&&<p className="ai-terminal-hint ai-terminal-slash-guide">Codex CLI 명령은 /, 설치된 스킬 호출은 $를 사용합니다. 아래 버튼은 표시된 그대로 터미널에 입력합니다.</p>}
    {[...WORKROOM_SLASH_COMMANDS[activeSession.agent],...slashFavorites.filter(command=>!WORKROOM_SLASH_COMMANDS[activeSession.agent].some(c=>c.command===command)).map(command=>({command,description:'직접 추가'}))].map(c=><div key={c.command} className="ai-terminal-slash-tile">
     <button type="button" disabled={busy} onClick={()=>{runSlashCommand(c.command);setSlashPadOpen(false);}}><strong>{c.command}</strong><small>{c.description}</small></button>
     <button type="button" className="ai-terminal-slash-star" aria-pressed={slashFavorites.includes(c.command)} aria-label={`${c.command} 즐겨찾기${slashFavorites.includes(c.command)?' 해제':' 추가'}`} onClick={()=>{toggleFavorite(c.command);restoreWorkroomKeyboard()}}>{slashFavorites.includes(c.command)?'★':'☆'}</button>
    </div>)}
    {addingSlash?<form className="ai-terminal-slash-custom" onSubmit={event=>{event.preventDefault();addCustomFavorite();}}><label htmlFor={promptId+'-custom-slash'}>추가할 {activeSession.agent==='codex'?'CLI 명령 또는 스킬':'슬래시 명령'}</label><input id={promptId+'-custom-slash'} autoFocus value={customSlash} onChange={event=>setCustomSlash(event.target.value)} placeholder={activeSession.agent==='codex'?'/model 또는 $remember-session':'/cs-ceo:goal'} maxLength={41}/><button type="submit" className="ai-terminal-btn">추가</button><button type="button" className="ai-terminal-btn" onClick={()=>{setAddingSlash(false);setCustomSlash('');}}>취소</button></form>:<button type="button" className="ai-terminal-slash-tile ai-terminal-slash-add" onClick={()=>setAddingSlash(true)}>+ 직접 추가</button>}
    <p className="ai-terminal-hint">누르면 바로 실행 · ☆로 위 줄에 고정 · 즐겨찾기는 이 기기에서 CLI별로 저장됩니다.</p>
   </div>}
   <div className="ai-terminal-keys"><button className="ai-terminal-key" aria-pressed={rawInput} disabled={activeSession.state!=='running'} onClick={()=>{const next=!rawInput;rawInputRef.current=next;setRawInput(next);requestAnimationFrame(()=>next?terminal.current?.focus():terminalComposer.current?.focus())}}>{rawInput?'직접 입력 끄기':'터미널 직접 입력'}</button>{['1','2','3','Esc','Tab','←','→','↑','↓','Ctrl+C','Ctrl+L','Ctrl+U','Enter'].map(key=><button disabled={activeSession.state!=='running'||busy} key={key} className="ai-terminal-key" onClick={()=>{if(sendBoundInput(({'1':'1','2':'2','3':'3','Esc':'\x1b','Tab':'\t','←':terminal.current?.modes.applicationCursorKeysMode?'\x1bOD':'\x1b[D','→':terminal.current?.modes.applicationCursorKeysMode?'\x1bOC':'\x1b[C','↑':terminal.current?.modes.applicationCursorKeysMode?'\x1bOA':'\x1b[A','↓':terminal.current?.modes.applicationCursorKeysMode?'\x1bOB':'\x1b[B','Ctrl+C':'\x03','Ctrl+L':'\x0c','Ctrl+U':'\x15','Enter':'\r'} as Record<string,string>)[key]!))focusCliKeyboard();}}>{key}</button>)}</div>
   {!remote&&<WorkroomSharedShellPanel key={'shell:'+activeSession.id} session={activeSession} visible={visible}/>}
   <WorkroomSessionFooter key={sessionScope+':'+activeSession.id} session={activeSession} usageReadable={!remote} cliInfo={cliInfo} modelCommands={WORKROOM_MODEL_COMMANDS[activeSession.agent]} onCommand={runSlashCommand} onReturnFocus={restoreWorkroomKeyboard} visible={visible} transport={memoryTransport} contextUsed={contextUsed} scope={sessionScope} onClose={close} onPause={pauseForSave}/>
   </>:<p className="ai-terminal-hint">{runningSessions.length?'작업 세션을 선택하면 이어서 입력할 수 있습니다.':'실행 중인 세션이 없습니다. 종료된 세션은 기록만 확인할 수 있습니다.'}</p>}
  </div>
  </div>}
  {!remote&&<TerminalMemoryStatus visible={visible} projects={projects} observationTargetId={activeSession?.targetId||target||undefined} onReview={reviewMemory} onManageProject={onManageProject}/>}
  {!remote&&connections.length>0&&<details className="ai-terminal-access"><summary>이 기기의 워크룸 작업 허용</summary><p>선택한 프로젝트에서 CLI 입력과 출력을 허용합니다. 테스터는 아래에서 별도로 허용합니다. 실행 허용 해제·연결 폐기는 진행 중인 원격 검사를 중단합니다. 일시적인 통신 단절에는 검사를 계속합니다. 연결의 남은 유효기간 동안 최대 30일 유지되며, 화면 잠금이나 앱 재시작 후에도 다시 승인하지 않습니다. 터미널에 표시되는 경로·계정 정보도 전송될 수 있습니다.</p><label>허용 범위<select value={grantRoot} onChange={e=>setGrantRoot(e.target.value)}><option value="">선택 프로젝트: {targetProject?.label??'프로젝트를 먼저 선택하세요'}</option>{grantRoots.map(r=><option key={r.workspaceRootId} value={r.workspaceRootId}>{r.name} · 이 기기가 새로 만든 프로젝트</option>)}</select></label><fieldset><legend>이 프로젝트에서 함께 허용할 모바일 기능</legend>{([['voice.use','음성 입력·실시간 대화'],['records.read','내가 한 말 조회'],['memory.save','세션 기억 저장'],['duty.manage','승인된 대직 방 관리'],['worktree.manage','병합된 워크트리 정리'],['tester.read','테스트 결과 조회'],['tester.run','테스트 실행·이 기기의 검사 취소']] as const).map(([scope,label])=><label key={scope}><input type="checkbox" checked={workspaceScopes.includes(scope)} onChange={e=>setWorkspaceScopes(current=>e.target.checked?[...new Set([...current,scope,...(scope==='tester.run'?['tester.read' as const]:[])])]:current.filter(s=>s!==scope&&(scope!=='tester.read'||s!=='tester.run')))}/>{label}</label>)}</fieldset>{connections.map(c=><label key={c.id}><input type="checkbox" checked={c.allowed} disabled={!grantRoot&&!targetProject&&!c.allowed} onChange={async e=>{try{const r=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',{owner:c.id,enabled:e.target.checked,rememberDevice:true,workspaceScopes,...(grantRoot?{workspaceRootIds:[grantRoot]}:{targetIds:target?[target]:[]})});setConnections(r.connections)}catch(e){setError(String(e))}}}/>{c.label}{c.durable&&c.expiresAt&&<span> · {new Date(c.expiresAt).toLocaleDateString()}까지</span>}<span> · 음성 {c.workspaceScopes?.includes('voice.use')?'허용':'미허용'} · 기록 {c.workspaceScopes?.includes('records.read')?'허용':'미허용'} · 저장 {c.workspaceScopes?.includes('memory.save')?'허용':'미허용'} · 대직 {c.workspaceScopes?.includes('duty.manage')?'허용':'미허용'} · 테스트 {c.workspaceScopes?.includes('tester.run')?'실행 허용':c.workspaceScopes?.includes('tester.read')?'조회만':'미허용'}</span><button type="button" disabled={!grantRoot&&!targetProject} onClick={async()=>{try{const r=await terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',{owner:c.id,enabled:true,rememberDevice:true,workspaceScopes,...(grantRoot?{workspaceRootIds:[grantRoot]}:{targetIds:target?[target]:[]})});setConnections(r.connections)}catch(e){setError(String(e))}}}>선택한 범위·권한 적용</button></label>)}</details>}
 </section>;
}
