import {confirmAction} from './confirmAction';
import { workroomSessionLabels, workroomSessionStartedAt } from './workroomSessionLabel';
import {commonMemoryUuid as requestUuid} from './commonMemoryCrypto';
import {aiTerminalAgentLabel} from './aiTerminalAgentLabel';
import {workroomSessionOwner} from './workroomSessionOwner';
import {WORKROOM_LAUNCH_SUBMISSION_FEATURE,WORKROOM_SUBMISSION_FEATURE,WORKROOM_SUBMISSION_MAX_BYTES,WORKROOM_SUBMISSION_RECENT_FEATURE,validateSubmissionText,type WorkroomSubmissionReceipt} from './workroomSubmissionProtocol';
import {submitWorkroomDraft,pendingSubmissionKey,readPendingSubmission,writePendingSubmission,pendingAfterStatus,draftAfterWrittenStatus,WorkroomSubmissionUnsupportedError,WorkroomLaunchUnsupportedError,pendingLaunchKey,readPendingLaunches,writePendingLaunches,withPendingLaunch,blockingPendingLaunch,pendingLaunchAfterStatus,launchNeverStarted,submissionStateLabel,submissionRequestUnparsed,readDismissedSubmissions,rememberDismissedSubmission,recoveredPendingSubmission,recoveredPendingLaunch,uncertainRouteLaunchFor,routeDraftClearsOnSettle,type PendingWorkroomSubmission,type PendingWorkroomLaunch,type UncertainRouteLaunch,usableSessionStorage,readableSessionStorage,pendingLaunchesOnLoad,pageMemoryStorage} from './workroomSubmissionClient';
import {ErrorVocActions} from './RemoteVocComposer';
import {WorkroomDraftQueue,useWorkroomDraftVault} from './WorkroomDraftQueuePanel';
import {DRAFT_RAW_SEND_NOTICE,checkKeptDraft,draftSealNotice,draftVaultScopeFor,sendQueuedDraft,sendWithDraftSeal,type QueuedDraftSendOutcome,type QueuedWorkroomDraft} from './workroomDraftQueue';
import {VoiceSentReceipt} from './VoiceSessionPanel';
import {WorkroomSessionFooter,type WorkroomTransport} from './WorkroomSessionFooter';
import {WorkroomTerminalKeys} from './WorkroomTerminalKeys';
import {WorkroomEffortAdvice,WorkroomEffortBadge,WorkroomEffortOption,WorkroomSettings,useWorkroomEffort} from './WorkroomEffortControls';
import {WorkroomSharedShellPanel} from './WorkroomSharedShellPanel';
import {codexContextUsedFromFooter} from './workroomSessionStatus';
import type {MobileWorkspaceScope} from './mobileWorkspaceProtocol';
import {singleFlight} from './singleFlight';
import {AgentRuntimeClient} from '../packages/runtime-sdk/client';
import React, {useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {ArrowLeft, AtSign, ChevronRight, ExternalLink, Hash, Maximize2, Mic, Minimize2, Plus, RotateCcw, RotateCw, Send} from 'lucide-react';
import {forgetOpenWorkroomSession,isOwnWorkroomSessionViewState,isStaleWorkroomNewTaskState,isStaleWorkroomSessionViewState,isWorkroomNewTaskState,isWorkroomSessionViewState,withWorkroomNewTask,withoutWorkroomNewTask,newWorkroomSessionViewToken,openWorkroomSessionToRestore,refreshOpenWorkroomSession,rememberOpenWorkroomSession,sessionViewEscapeCloses,sessionViewVoiceCall,visualKeyboardOpen,withWorkroomSessionView,withoutWorkroomSessionView,workroomOpenSessionStorage} from './workroomSessionView';
import {voiceMediaClient} from './voiceMediaClient';
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
import {CliAccountPicker} from './CliAccountPicker';
import {workroomAttachmentsMessage,workroomCaptureShortcut,type WorkroomImageAttachment} from './workroomImageAttachments';
import {WorkroomAttachBar,useWorkroomAttachments,workroomComposerAttachCopy} from './WorkroomAttachBar';
import {RemoteAttachChips,RemoteAttachMenuButton,RemoteAttachSheetButtons,useRemoteAttachDrop,useRemoteWorkroomAttachments} from './RemoteWorkroomAttachBar';
import {REMOTE_ATTACH_BUDGET_REFUSAL,REMOTE_ATTACH_LAUNCH_NO_RECORD,REMOTE_ATTACH_NO_RECORD,REMOTE_ATTACH_ROUTE_REFUSAL,REMOTE_ATTACH_VAULT_NOTICE,remoteAttachIdsRefused,remoteAttachMovingLabel,type RemoteAttachContext} from './remoteWorkroomAttachments';
import {workroomRouteAttachmentRefusal} from './workroomAttachmentRules';
import {thisMachineLabel} from './clientPlatform';
import {workroomRestartConfirm,workroomRestartNotice,workroomRestartTitle} from './workroomRestart';
import {WORKROOM_COMPOSER_KEYS_HINT,workroomComposerKeyToCli,workroomNumberKeyNotice} from './workroomComposerKeys';
import {aiTerminalSupportsPrompt} from './aiTerminalPromptArgs';
import {createTerminalCompositionOverlapFilter,createTerminalHangulInputFallback,splitTerminalInput,splitTerminalSubmission} from './aiTerminalInput';
import {localAiTerminalTransport,localWorkroomTransport,requestWorkroomAppDispatch,terminalLocalRequest,type AiTerminalTransport} from './aiTerminalClient';
import {entryKeepsComposerDraft} from './aiTerminalEntry';
import {saveWorkroomAccess,workroomHistoryDropNotice} from './workroomAccessSave';
import {WORKROOM_APP_AGENTS,WORKROOM_APP_NAMES,workroomAppAgentOf,workroomAppChoice,workroomAppConfirmMessage,workroomAppFailureText,workroomAppReceipt,workroomAppRoutePreview,workroomAppRoutesAvailable,workroomAppSendLabel,workroomAppTakesTask,workroomAppTaskKept,workroomCliAgentOf,type WorkroomAppAgent,type WorkroomAppClipboardState,type WorkroomRouteChoice} from './workroomAppRoute';
import {TerminalMemoryStatus} from './TerminalMemoryStatus';
import {buildWorkroomMemoryReviewPrompt,type WorkroomMemoryReviewTarget} from './workroomMemoryReview';
import {reconcileTerminalSummaries} from './terminalSummaryReconciliation';
import {HELD_PART_NOTICE,createTerminalRequester,createTerminalReadCadence,terminalSubmissionGroup,type TerminalSubmissionGroup} from './aiTerminalScheduling';
import {offlineInputNotice,phoneIsOnline,phoneOfflineNotice} from './phoneNetwork';
import {usePhoneOnline} from './usePhoneOnline';

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
import {forgetFailedLegacyStart,legacyStartRetryConfirmation,readFailedLegacyStart,rememberFailedLegacyStart,sessionOpenedSinceFailedStart,legacyRouteSuspects,legacyRouteSessionSendConfirmation,legacyRouteSessionSendHeld} from './workroomLegacyStartGuard';
// The older-Mac start guard is advisory. Where the browser keeps no site data (the `sessionStorage` getter throws, or writes
// are refused) its records live in this page's memory instead, so a failed plain start still asks on its retry until the
// page closes (w4 L2). One store for every panel of this page: records are keyed by scope.
const legacyStartMemory=pageMemoryStorage();
const legacyStartStorage=()=>usableSessionStorage()??legacyStartMemory;
// @ handoffs whose plain start lost its answer, or whose retry was declined (w4 review, finding 1): a send of the same draft
// into a session of that target and AI the route did not know asks first. Page memory shared by every panel of this page,
// keyed by the receiver's scope — choosing that session clears the @ chip, so the protection cannot ride on the chip.
const legacyRouteSuspectStore=legacyRouteSuspects();
// Launch records need usable storage. Without it a launch record could not be kept or read — an @ route to another device
// (review 2026-10-15, finding 3) and this panel's own start (w4 L2) then take today's plain start instead of a launch.
const routeLaunchStorage=()=>usableSessionStorage();
import {applyCommunityMention,communityMentionState,communityReferencesFor,type CommunityMentionDeviceProjects,type CommunityReferenceChip} from './workroomCommunityMention';
import {projectMentionChoices,projectMentionKey,SERVICE_USE_CHANGED_EVENT} from './projectUseMention';
import {WorkroomUseConversation} from './WorkroomUseConversation';
import {workroomSessionStateLabel} from './remoteControlScreenText';
/** `keepDraft`: a session-only selection that leaves a draft in the new-task composer (and its target and AI) as it is. */
export interface AiTerminalEntry {nonce:number;targetId:string;prompt?:string;title?:string;agent?:AiTerminalAgent;sessionId?:string;resumeLatest?:boolean;keepDraft?:boolean}
function sameWorkroomTargets(a:readonly {targetId:string;label:string;projectTargetId?:string}[],b:readonly {targetId:string;label:string;projectTargetId?:string}[]):boolean {
 return a.length===b.length&&a.every((x,i)=>x.targetId===b[i]!.targetId&&x.label===b[i]!.label&&x.projectTargetId===b[i]!.projectTargetId&&JSON.stringify(x)===JSON.stringify(b[i]));
}
/** 커뮤니티 기기가 없을 때의 고정 빈 목록 — 렌더마다 새 배열을 만들면 memo가 전부 깨진다. */
const NO_COMMUNITY_DEVICES:readonly CommunityMentionDeviceProjects[]=[];
export function AiTerminalPanel({visible=true,onScreen,projects:suppliedProjects,transport=localAiTerminalTransport,remote=false,entry,onManageProject,onWhatISaid,onRememberSession,sessionScope='local',workspaceTransport,bypassPermissions:controlledBypass,onBypassPermissionsChange,referencesSupported=true,opsTargetId,popout=false,onActiveSessionChange,onDraftStateChange,deviceName,deviceSwitch,slowPolling=false,communityMention,bypassUnavailable,effortReadOnly,sessionFullscreen=false,remoteAttach,restartBanner,listRefresh}: {
 bypassPermissions?:boolean;onBypassPermissionsChange?:(enabled:boolean)=>void;
 /** Set while driving another Mac: that Mac refuses a bypassed start from a community peer, so the panel starts
  *  without it and the toggle says why. The saved preference is untouched and returns with this Mac. */
 bypassUnavailable?:string;
 /** Set while driving another community Mac: its 「에포트 자동」 is that Mac's own setting, shown read-only (w16). */
 effortReadOnly?:string;workspaceTransport?:WorkroomTransport;visible?:boolean;projects:WorkroomMentionProject[];transport?:AiTerminalTransport;remote?:boolean;entry?:AiTerminalEntry|null;onManageProject?:(id:string)=>void;onWhatISaid?:()=>void;onRememberSession?:(id:string)=>void;sessionScope?:string;
 /** The host accepts `#` references (local always; remote hosts advertise it). */
 referencesSupported?:boolean;
 onPrepareUse?:(projectId?:string)=>void;
 /** The OPS project: its composer says the box types to the OPS workroom AI; 아젠투지 voice is the dock, not an entry here (VOC 2026-09-29). */
 opsTargetId?:string;
 /** Rendered alone in a separate OS window (「새 창으로 분리」). There is no app sidebar to hide. */
 popout?:boolean;
 /** 다른 아젠투지를 거쳐 모는 중 — 읽기 한 번이 두 홉이라 박자를 늦춘다. */
 slowPolling?:boolean;
 /**
  * The phone portal (≤640px or a coarse pointer — `useWorkroomSessionFullscreen`, src/workroomSessionView.ts): a session
  * opens over the whole screen with 「←」 back to this list, as the Mac opens it in a window of its own, and the list
  * shows no terminal of its own. Remote panels only; the Mac app, its popout and a Mac driving another device never set it.
  */
 sessionFullscreen?:boolean;
 /**
  * Phone attachments (w13 step B): photos and files go to this Mac over the encrypted transit and come back as opaque ids
  * the next request names (src/remoteWorkroomAttachments.ts). Remote panels only; the portal passes it for this Mac's panel,
  * and an `unavailable` context with the reason for another AgentsToZ's. Absent: no 「+」 at all.
  */
 remoteAttach?:RemoteAttachContext;
 /**
  * The Workroom is the pane on screen (the portal's tab and pane, its Mac online). `visible` also drops while the portal loads more of the
  * Mac's projects (an automatic sweep retry): that hides nothing the user left, so an open full-screen session stays open
  * through it and only leaving the pane closes it (w7 review). Defaults to `visible`.
  */
 onScreen?:boolean;
 /** The pop-out window titles itself after the session it shows. */
 onActiveSessionChange?:(session:{id:string;label:string;agent:AiTerminalAgent}|null)=>void;
 /** Reports only whether unsent text/attachments remain; the containing directory never copies the draft. */
 onDraftStateChange?:(dirty:boolean)=>void;
 /** Display only. The selected transport and session scope decide which device owns these sessions. */
 deviceName?:string;
 /** The 「기기」 selector when this Mac can drive other community Macs (src/WorkroomDeviceSwitch.tsx). */
 deviceSwitch?:React.ReactNode;
 /** 「업데이트 전 실행 중이던 작업 세션」 (w14, this Mac only). On the Mac (pop-out) it sits above the session list and the
  *  terminal, where it is seen; the phone's list (`sessionFullscreen`) keeps it after the session rows so the first row's
  *  box does not move (with no session it is where the empty hint is). Each mode has one place: never remounted. */
 restartBanner?:React.ReactNode;
 /** A change reads the session list now (w14: sessions a restart banner reopened are listed at once, not ~5 s later). */
 listRefresh?:number;
 /**
  * 커뮤니티 차원의 `@`·`#`(2026-10-05): 기호 앞에 기기 이름을 적으면 그 기기의 프로젝트가 후보가 된다.
  * 목록은 **쓸 때 한 번** 불러온다(`requestProjects`) — 쓰지도 않을 기기 목록을 미리 긁지 않는다.
  * `requester`는 그 기기의 터미널 요청 함수다(없으면 그 기기로는 전달하지 않는다).
  */
 communityMention?:{
  devices:readonly CommunityMentionDeviceProjects[];
  requestProjects:(deviceId:string)=>void;
  requester:(deviceId:string)=>((request:Omit<AiTerminalRequest,'requestId'>)=>Promise<AiTerminalResponse>)|null;
  workspaceRequester?:(deviceId:string)=>WorkroomTransport|null;
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
 useEffect(()=>{const changed=()=>setTargetReload(n=>n+1);window.addEventListener(SERVICE_USE_CHANGED_EVENT,changed);return()=>window.removeEventListener(SERVICE_USE_CHANGED_EVENT,changed);},[]);
 const requestTargets=useMemo(()=>singleFlight(()=>new AgentRuntimeClient().targets({includeProductUses:true})),[]);
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
 const [composerSelection,setComposerSelection]=useState<{value:string;cursor:number;scope:string;sessionId:string|null}|null>(null);
 const terminalDraftLive=useRef(terminalDraft);terminalDraftLive.current=terminalDraft;
 const [submissionSupported,setSubmissionSupported]=useState(false),[submissionBusy,setSubmissionBusy]=useState(false);
 const submissionCapability=useRef<'probe'|'legacy'>('probe'),submissionInFlight=useRef(false);
 // 'legacy' once this path refused a launch or `recent` it could not parse (an older Mac forwarding to a newer one):
 // the receiver's advertised features do not hold for the whole path, so starts go back to a plain `start`.
 const launchCapability=useRef<'probe'|'legacy'>('probe');
 // The draft each unsettled submission carried, in memory only (the stored pending record never keeps text).
 const submittedDrafts=useRef(new Map<string,string>());
 const [pendingSubmission,setPendingSubmission]=useState<PendingWorkroomSubmission|null>(null);
 const pendingSubmissionRef=useRef(pendingSubmission);pendingSubmissionRef.current=pendingSubmission;
 // S3-8: opt-in encrypted keeping of requests in this origin. Off (or no IndexedDB/WebCrypto) → no vault, nothing stored.
 // One queue per receipt owner: the main window (session directory) and the popout of this Mac share one (draftVaultScopeFor).
 const draftVault=useWorkroomDraftVault();const draftVaultScope=draftVaultScopeFor(sessionScope);
 // terminal-start-submission-v1 / terminal-submission-recent-v1: what this host also offers beside submissions.
 const [launchSupported,setLaunchSupported]=useState(false),[recentSupported,setRecentSupported]=useState(false);
 // New sessions' first requests whose receipts are unsettled, one entry per launch (review 2026-10-15: a single slot let
 // a launch of another target erase one whose outcome was unknown). Metadata only; each blocks a second start of its
 // target and AI, because a retry of a lost start could open a second CLI with the same request.
 const [pendingLaunches,setPendingLaunches]=useState<PendingWorkroomLaunch[]>([]);
 const pendingLaunchesRef=useRef(pendingLaunches);pendingLaunchesRef.current=pendingLaunches;
 const pendingLaunch=pendingLaunches[0]??null;
 const launchDrafts=useRef(new Map<string,string>());
 // The draft of an @ route whose launch came back uncertain (review 2026-10-15, finding 2): settled as written, it is
 // cleared; sent again unchanged, the earlier launch is checked first instead of typing the handoff a second time.
 const routeLaunches=useRef(new Map<string,UncertainRouteLaunch>());const [launchChecking,setLaunchChecking]=useState(false);const outcomeCheck=useRef(false);
 // 참고(`#`)는 **어느 기기의** 프로젝트인지 함께 기억한다 — 폴더는 받는 쪽 호스트만 풀 수 있다.
 const [referenceChips,setReferenceChips]=useState<CommunityReferenceChip[]>([]);
 // `@` routing picks its receiving AI ('' = suggested). After delivery the sender stays here; the receipt offers the jump.
 // 받는 곳이 다른 아젠투지면 `routeDeviceId`가 그 기기다('' = 이 화면이 몰고 있는 기기).
 const [routeAgentChoice,setRouteAgentChoice]=useState<WorkroomRouteChoice|''>('');const [routeDeviceId,setRouteDeviceId]=useState('');
 const [routeRole,setRouteRole]=useState<'dev'|'use'>('dev'),[routeServiceKey,setRouteServiceKey]=useState('default');
 const [useConversation,setUseConversation]=useState<{project:WorkroomMentionProject;scope:string;transport:WorkroomTransport;draft:string}|null>(null);
 const useDrafts=useRef(new Map<string,string>()),useRecipients=useRef(new Map<string,string[]>()),[useDraftDirty,setUseDraftDirty]=useState(false);
 const routeTo=(targetId:string,deviceId='',role:'dev'|'use'='dev',serviceKey='default')=>{setRouteTargetId(targetId);setRouteDeviceId(targetId?deviceId:'');setRouteRole(role);setRouteServiceKey(serviceKey);setRouteAgentChoice('');};
 const routeLive=useRef({targetId:routeTargetId,deviceId:routeDeviceId});routeLive.current={targetId:routeTargetId,deviceId:routeDeviceId};
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
 const [composerOpen,setComposerOpen]=useState(false);const [requestTitle,setRequestTitle]=useState('');const composerOpenRef=useRef(false);composerOpenRef.current=composerOpen;
 const startBusy=useRef(false),draftGeneration=useRef(0),selectionGeneration=useRef(0);
 const restartConfirming=useRef(false),sendConfirming=useRef(false);
 const pendingResume=useRef<{targetId:string;selection:number}|null>(null);
 const [resuming,setResuming]=useState(false);
 const latestEntryNonce=useRef(entry?.nonce);latestEntryNonce.current=entry?.nonce;
 const activeSession=sessions.find(s=>s.id===selected);
 useEffect(()=>{setUseConversation(null);},[activeSession?.id,visible,sessionScope]);
 const activeSessionRef=useRef(activeSession);activeSessionRef.current=activeSession;
 // 「에포트 자동」 (w16 Build B): this Mac's setting and the active session's record, through the workspace channel the footer
 // already uses. Asked when shown, on a project/session change, a window coming back and after the host could have noticed
 // something (below) — never on a timer. An older Mac refuses the action and the option and receipt simply stay away.
 const effort=useWorkroomEffort({transport:memoryTransport,targetId:activeSession?.targetId??(target||undefined),sessionId:activeSession?.id,visible,readOnly:!!effortReadOnly});
 const refreshEffort=effort.refresh;
 const effortRecord=activeSession&&effort.state.sessionId===activeSession.id?effort.state.session:null;
 // The host reads the effort the CLI shows (and a change the person made) from rows its sampler reads about a second after
 // output; ask again a little after this screen saw the same line change.
 useEffect(()=>{if(cliInfo.effort||cliInfo.model)refreshEffort(1500);},[cliInfo.effort,cliInfo.model,refreshEffort]);
 // The phone's full-screen session view (w7, src/workroomSessionView.ts). The Mac opens every session in a window of its
 // own; the phone opens it over the whole screen, and 「←」 (or the web portal's browser back; the iOS app has none)
 // returns to this list. The list never mounts a terminal of its own, so terminal reads run only while a session is open. One history entry per open
 // view: closing from inside pops it, a back closes the view, a tab switch replaces it (the portal's navigateWorkspace).
 const fullscreen=remote&&sessionFullscreen;
 // `visible` also drops while the portal loads projects; only leaving the pane (`onScreen`) is leaving the Workroom.
 const paneShown=onScreen??visible;
 const fullscreenRef=useRef(fullscreen);fullscreenRef.current=fullscreen;const paneShownRef=useRef(paneShown);paneShownRef.current=paneShown;
 const selectedRef=useRef(selected);selectedRef.current=selected;
 const [sessionView,setSessionView]=useState(false);const sessionViewRef=useRef(false);
 const viewToken=useRef('');if(!viewToken.current)viewToken.current=newWorkroomSessionViewToken();
 const viewRoot=useRef<HTMLDivElement>(null);const viewDock=useRef<HTMLDivElement>(null);const viewOpener=useRef<HTMLElement|null>(null);const viewBacks=useRef(0);
 const viewTitleId=useId();
 // w11 (S4.5): on the phone a new task is one sheet over the list — project, AI, bypass, account (only with a choice), the
 // first request and the only start button; its hints and the session composer's sit behind one 「?」 each.
 const [newTaskOpen,setNewTaskOpen]=useState(false);const [newTaskHelp,setNewTaskHelp]=useState(false);const [commandHelp,setCommandHelp]=useState(false);
 const sheetRoot=useRef<HTMLDivElement>(null);const sheetTitleId=useId();const sheetOpener=useRef<HTMLElement|null>(null);
 // Read by the reload restore (w11 review): an open sheet or request box is the user's choice made since this panel mounted.
 const newTaskOpenRef=useRef(false);newTaskOpenRef.current=newTaskOpen;
 // w11 (S4.2): the session this phone had open before a reload is reopened once, from the first list.
 const restoreChecked=useRef(false);const sessionScopeRef=useRef(sessionScope);sessionScopeRef.current=sessionScope;
 // w11 (S4.3): the id of the whole-request submission merely in flight — 「보내는 중…」, not the recovery banner.
 const [sendingId,setSendingId]=useState<string|null>(null);
 // w11 (S4.1): 읽기 보기 follows new output while it is within 40px of the bottom; scrolled up, a pill offers the jump.
 const readableRef=useRef<HTMLPreElement>(null);const readableStick=useRef(true);const readableShownText=useRef('');const [readablePill,setReadablePill]=useState(false);
 const viewShown=fullscreen&&sessionView&&paneShown;
 // The view covers the portal's own offline notice and the voice dock, so it says both itself.
 const phoneOnline=usePhoneOnline();
 // Only the phone panel listens, and only to who answers: the client updates its microphone level many times a second,
 // and re-rendering this panel at that rate (also on the Mac) is not what a status line needs.
 const subscribeVoice=useCallback((listener:()=>void)=>fullscreen?voiceMediaClient.subscribe(listener):()=>{},[fullscreen]);
 const voicePartner=useSyncExternalStore(subscribeVoice,()=>fullscreen?sessionViewVoiceCall(voiceMediaClient.snapshot())?.partner??'':'',()=>'');
 const voiceCall=voicePartner?{partner:voicePartner}:null;
 // While an on-screen keyboard shrinks the view (set from window.visualViewport), and the rows the terminal had without it.
 const keyboardUp=useRef(false);const restingRows=useRef<{width:number;rows:number;fontSize:number}|null>(null);
 const sessionShown=!fullscreen||viewShown;
 // Shows the view on the current history entry: `own` — it is already this panel's (forward); else it becomes this one's.
 const showSessionView=useCallback((own:boolean)=>{
  const active=typeof document==='undefined'?null:document.activeElement;
  viewOpener.current=active instanceof HTMLElement?active:null;
  if(!own){try{history.replaceState(withWorkroomSessionView(history.state,viewToken.current),'');}catch{/* no history */}}
  sessionViewRef.current=true;setSessionView(true);setNewTaskOpen(false);
 },[]);
 const openSessionView=useCallback(()=>{
  if(!fullscreenRef.current||!paneShownRef.current||sessionViewRef.current)return;
  // Another panel's entry (a reload, another Mac) becomes this one's instead of stacking a second.
  try{const state=history.state;if(isWorkroomSessionViewState(state)){showSessionView(false);return;}
   // Started from the 「새 작업」 sheet: the view takes the sheet's entry, so back from the new session lands on the list.
   if(isWorkroomNewTaskState(state))history.replaceState(withWorkroomSessionView(withoutWorkroomNewTask(state),viewToken.current),'');
   else history.pushState(withWorkroomSessionView(state,viewToken.current),'');}catch{/* no history: 「←」 still closes it */}
  showSessionView(true);
 },[showSessionView]);
 const closeSessionView=useCallback((how:'ui'|'history'|'other')=>{
  if(!sessionViewRef.current)return;
  sessionViewRef.current=false;setSessionView(false);
  // Closed (「←」, back, the session ended, the Workroom left): a reload shows the list again (w11).
  forgetOpenWorkroomSession(workroomOpenSessionStorage(),sessionScopeRef.current);
  // Closed from inside (「←」, Escape) or by the page (no session, hidden): its own entry is popped, so the next back
  // leaves the Workroom instead of landing on a closed view.
  if(how!=='history'){try{if(isOwnWorkroomSessionViewState(history.state,viewToken.current)){viewBacks.current++;history.back();}}catch{/* no history */}}
  // Focus goes back to the session's row, else to whatever opened the view.
  const opener=viewOpener.current;viewOpener.current=null;
  requestAnimationFrame(()=>{
   const id=selectedRef.current;
   const row=id?[...(panel.current?.querySelectorAll<HTMLElement>('[data-session-id]')??[])].find(item=>item.dataset.sessionId===id):undefined;
   (row??(opener?.isConnected?opener:null))?.focus();
  });
 },[]);
 // A view entry an earlier load of this page left (a reload with the view open; iOS reloading a page whose WebContent
 // process it reclaimed): the list it was opened from is the entry before it, so step back onto it. Stripping the marker
 // in place left two identical list entries and a back that changed nothing (w7 review). A turn later, so a StrictMode
 // remount steps once; an entry of a panel of this page (the Mac before) is popped by that panel itself.
 useEffect(()=>{if(!fullscreen)return;const timer=setTimeout(()=>{if(sessionViewRef.current)return;try{if(!isStaleWorkroomSessionViewState(history.state))return;if(history.length>1){viewBacks.current++;history.back();}else history.replaceState(withoutWorkroomSessionView(history.state),'');}catch{/* no history */}},0);return()=>clearTimeout(timer);},[fullscreen]);
 useEffect(()=>{
  if(!fullscreen)return;
  // A back this panel started while it was not listening (the screen widened and closed the view) has arrived unheard:
  // counting it still swallowed the next real back (w7 review).
  viewBacks.current=0;
  const onPop=()=>{
   let state:unknown=null;try{state=history.state;}catch{/* no history */}
   const own=isOwnWorkroomSessionViewState(state,viewToken.current);
   if(viewBacks.current>0){viewBacks.current--;
    // Opened again before this panel's own back arrived: the open view gets its entry back.
    if(sessionViewRef.current&&!own){try{history.pushState(withWorkroomSessionView(state,viewToken.current),'');}catch{/* no history */}}
    return;}
   if(sessionViewRef.current){if(!own)closeSessionView('history');return;}
   // Closed, and the browser arrived on a view entry (forward after 「←」): the view opens on it — or, with no session to
   // show, the entry is stepped over. A step that changes nothing on screen reads as a broken back (w7 review).
   if(!isWorkroomSessionViewState(state))return;
   if(paneShownRef.current&&selectedRef.current)showSessionView(own);
   else{viewBacks.current++;try{history.back();}catch{viewBacks.current--;}}
  };
  window.addEventListener('popstate',onPop);return()=>window.removeEventListener('popstate',onPop);
 },[fullscreen,closeSessionView,showSessionView]);
 // Nothing left to show: no session selected, the Workroom left (another tab or pane), or no longer a phone screen. Not
 // while it only loads more projects (`visible` false with the pane still on screen).
 useEffect(()=>{if(sessionViewRef.current&&(!fullscreen||!paneShown||!selected))closeSessionView('other');},[fullscreen,paneShown,selected,closeSessionView]);
 // Every new selection opens it — a tapped row, 「작업 시작」, a resumed conversation, an entry naming a session,
 // 「그 세션으로 이동」. A selection restored from this tab's storage (a reload) does not: the list shows first.
 const lastSelected=useRef(selected);
 useEffect(()=>{const previous=lastSelected.current;lastSelected.current=selected;if(fullscreen&&paneShown&&selected&&selected!==previous)openSessionView();},[selected,fullscreen,paneShown,openSessionView]);
 // Leaving with the view open (another Mac, another device) takes its entry along. Checked a turn later: StrictMode's
 // simulated unmount runs this cleanup and mounts again at once, and that must not close a view an entry just opened.
 const mounted=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;setTimeout(()=>{if(mounted.current||!sessionViewRef.current)return;sessionViewRef.current=false;forgetOpenWorkroomSession(workroomOpenSessionStorage(),sessionScopeRef.current);try{if(isOwnWorkroomSessionViewState(history.state,viewToken.current))history.back();}catch{/* no history */}},0);};},[]);
 // Back where you were (w11): the open session is remembered for this Mac — refreshed when the page is hidden, since iOS may
 // reclaim it from the background — so a reload reopens it.
 useEffect(()=>{if(!viewShown||!selected)return;const store=workroomOpenSessionStorage();const write=()=>rememberOpenWorkroomSession(store,sessionScope,selected,Date.now());write();
  const onHidden=()=>{if(document.visibilityState==='hidden')write();};document.addEventListener('visibilitychange',onHidden);window.addEventListener('pagehide',write);
  return()=>{document.removeEventListener('visibilitychange',onHidden);window.removeEventListener('pagehide',write);};},[viewShown,selected,sessionScope]);
 // Focus moves into the view. The composer is not focused for the user: the keyboard stays down until it is tapped.
 useEffect(()=>{if(!viewShown)return;const frame=requestAnimationFrame(()=>{const root=viewRoot.current;if(root&&!root.contains(document.activeElement))root.focus({preventScroll:true});});return()=>cancelAnimationFrame(frame);},[viewShown]);
 // The @ / slash menu opens above the docked composer: no taller than the room between the top bar and the composer, so
 // it never starts above the screen (in landscape with the keyboard up it did, and its first candidates were cut off).
 const placeViewMenu=useCallback(()=>{
  const view=viewRoot.current,command=viewDock.current?.querySelector<HTMLElement>('.ai-terminal-command--docked'),bar=view?.querySelector<HTMLElement>('.ai-terminal-session-view-bar');
  if(!view||!command||!bar)return;
  view.style.setProperty('--workroom-menu-room',`${Math.max(0,Math.floor(command.getBoundingClientRect().top-bar.getBoundingClientRect().top-12))}px`);
 },[]);
 // The view covers the visual viewport, not the layout viewport: an iOS keyboard shrinks the visual one (and may scroll
 // the layout one), and the docked composer must stay above the keyboard.
 useEffect(()=>{
  if(!viewShown)return;const viewport=window.visualViewport;const root=document.documentElement;
  const update=()=>{
   const view=viewRoot.current;if(!view)return;
   // Read before the size changes: the terminal's refit (a ResizeObserver, after layout) keeps its rows while it is up.
   keyboardUp.current=visualKeyboardOpen(root.clientHeight,viewport?.height??window.innerHeight,viewport?.scale??1);
   view.dataset.keyboard=keyboardUp.current?'open':'closed';
   view.style.setProperty('--workroom-view-height',`${viewport?.height??window.innerHeight}px`);view.style.setProperty('--workroom-view-top',`${viewport?.offsetTop??0}px`);
   placeViewMenu();
  };
  update();viewport?.addEventListener('resize',update);viewport?.addEventListener('scroll',update);window.addEventListener('resize',update);
  root.dataset.workroomSessionView='open';
  return()=>{viewport?.removeEventListener('resize',update);viewport?.removeEventListener('scroll',update);window.removeEventListener('resize',update);delete root.dataset.workroomSessionView;keyboardUp.current=false;};
 },[viewShown,placeViewMenu]);
 // The composer grows (lines, chips, a route plan) and the dock with it.
 useLayoutEffect(()=>{if(!viewShown)return;placeViewMenu();const dock=viewDock.current;if(!dock||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(placeViewMenu);observer.observe(dock);return()=>observer.disconnect();},[viewShown,activeSession?.id,activeSession?.state,placeViewMenu]);
 // 읽기 보기 sticks to the bottom (w11, S4.1): new output follows while the view was within 40px of the bottom; otherwise the
 // reading place stays and the 「새 출력 ↓」 pill appears. A new session, or 읽기 보기 turned on, starts at the bottom.
 useLayoutEffect(()=>{
  const el=readableRef.current;
  if(!readableScreen||!el){readableStick.current=true;readableShownText.current='';setReadablePill(false);return;}
  const changed=readableShownText.current!==readableScreen;readableShownText.current=readableScreen;
  if(readableStick.current){el.scrollTop=el.scrollHeight;setReadablePill(false);}else if(changed)setReadablePill(true);
 },[readableScreen,readableMode,fontSize]);
 // Apply an autocomplete caret with its committed value, before the next input event.
 useLayoutEffect(()=>{
  if(!composerSelection)return;setComposerSelection(null);const field=terminalComposer.current;
  if(!visible||!field||field.disabled||composerSelection.scope!==sessionScope||composerSelection.sessionId!==(activeSession?.id??null)||field.value!==composerSelection.value)return;
  field.focus();field.setSelectionRange(composerSelection.cursor,composerSelection.cursor);
 },[composerSelection,terminalDraft,visible,sessionScope,activeSession?.id]);
 useEffect(()=>{submissionCapability.current='probe';launchCapability.current='probe';setSubmissionSupported(false);setLaunchSupported(false);setRecentSupported(false);},[transport,sessionScope]);
 // Writes or clears only the entry of `id`. Past the bound it throws before anything is sent.
 const rememberLaunch=useCallback((id:string,value:PendingWorkroomLaunch|null)=>{const next=withPendingLaunch(pendingLaunchesRef.current,id,value);try{writePendingLaunches(sessionStorage,pendingLaunchKey(sessionScope),next);}catch{/* the banner still shows for this page */}pendingLaunchesRef.current=next;setPendingLaunches(next);},[sessionScope]);
 // Unreadable storage is no storage, not an unreadable record (w4 L2): blocking every start until a dismissal helped no one.
 // Storage that cannot keep new records (blocked, or full) starts plainly and the panel says so once. Records that can be
 // read still block (w4 review, finding 3) — a corrupt one too: it may be a real unsettled launch.
 const [launchStorageNotice,setLaunchStorageNotice]=useState(false);const launchStorageNoticeShown=useRef(false);
 useEffect(()=>{const {list,storageUnusable}=pendingLaunchesOnLoad(readableSessionStorage(),pendingLaunchKey(sessionScope),!!usableSessionStorage());if(storageUnusable&&!launchStorageNoticeShown.current){launchStorageNoticeShown.current=true;setLaunchStorageNotice(true);}pendingLaunchesRef.current=list;setPendingLaunches(list);},[sessionScope]);
 // The same for whole-request submissions (w4 L2): unreadable storage has no record to show, and sends without a place for
 // a new record go as raw input (as the LAN page does). A readable record still shows and blocks (finding 3).
 useEffect(()=>{if(!selected){setPendingSubmission(null);return;}const storage=readableSessionStorage();if(!storage){setPendingSubmission(null);return;}try{const pending=readPendingSubmission(storage,pendingSubmissionKey(sessionScope,selected));if(pending&&pending.sessionId!==selected)throw Error('제출 대상이 변경되었습니다.');setPendingSubmission(pending);}catch{setPendingSubmission({id:'unreadable-record',sessionId:selected,receipt:null});setError('이전 제출 기록을 확인하지 못했습니다. 터미널 결과를 먼저 확인하세요.');}},[selected,sessionScope]);
 const sessionLabels=useMemo(()=>workroomSessionLabels(sessions,targetId=>projects.find(p=>p.targetId===targetId)?.label),[sessions,projects]);
 const sessionDevice=workroomSessionOwner('',undefined,deviceName,remote);
 const sessionOwner=(targetId:string)=>workroomSessionOwner(targetId,opsTargetId,deviceName,remote);
 const targetProject=projects.find(p=>p.targetId===target);
 const supportsPrompt=aiTerminalSupportsPrompt(agent);
 const promptError=aiInitialPromptError(prompt);
 // An unsettled launch of this target and AI (or of an unknown one, recovered after a reload) blocks another start.
 const launchBlocked=!!blockingPendingLaunch(pendingLaunches,target,agent);
 const canStart=!!targetProject&&(!prompt.trim()||supportsPrompt)&&!promptError&&!busy&&!resuming&&!launchBlocked;
 const [connections,setConnections]=useState<{id:string;label:string;allowed:boolean;durable?:boolean;expiresAt?:string|null;workspaceScopes?:MobileWorkspaceScope[];historyScopes?:string[]}[]>([]);
 const [grantRoots,setGrantRoots]=useState<{workspaceRootId:string;name:string}[]>([]);
 const [workspaceScopes,setWorkspaceScopes]=useState<MobileWorkspaceScope[]>([]);
 const [grantRoot,setGrantRoot]=useState('');
 const host=useRef<HTMLDivElement>(null);const terminal=useRef<Terminal|null>(null);const fit=useRef<FitAddon|null>(null);
 // Fits the terminal to its box — on the phone's full-screen view, to its box without the on-screen keyboard (below).
 const fitScreen=useRef<(()=>void)|null>(null);
 // The size this window last fitted. A new CLI starts at it instead of 100×28, so it does not draw its
 // first screen for another size and redraw (NHCS opens its terminals at the window's real size).
 const lastSize=useRef({cols:100,rows:28});
 const [restartNotice,setRestartNotice]=useState<{sessionId:string;text:string}|null>(null);
 // Images for the next request (VOC 2026-10-02 "캡쳐해서 넣기"): saved on this Mac, sent as absolute paths.
 const [images,setImages]=useState<WorkroomImageAttachment[]>([]);const imagesRef=useRef(images);imagesRef.current=images;
 const [imageBusy,setImageBusy]=useState(false);
 // Phone attachments (w13 step B): one queue for the session composer, bound to the session's project, and one for the
 // 「새 작업」 sheet, bound to its chosen project. On another project the ready ids follow (a rebind; ids are bound to one).
 const attachContext=remote?remoteAttach:undefined,remoteAttachOn=!!attachContext;
 const sessionAttach=useRemoteWorkroomAttachments(attachContext,activeSession?.targetId??'');
 const sheetAttach=useRemoteWorkroomAttachments(attachContext,target);
 const sessionChips=sessionAttach.chips,sheetChips=sheetAttach.chips;
 const sessionAttachMoving=sessionChips.some(chip=>chip.state!=='ready'&&chip.state!=='failed'),sessionAttachReady=sessionChips.some(chip=>chip.state==='ready');
 const sheetAttachMoving=sheetChips.some(chip=>chip.state!=='ready'&&chip.state!=='failed'),sheetAttachReady=sheetChips.some(chip=>chip.state==='ready');
 // The attachment ids each unsettled submission (and launch) carried: a later written status removes exactly those chips.
 // A launch whose answer was lost and that later settles as written takes its chips too — left behind, they sat ready
 // under an enabled start button, one tap from a second CLI with the same files (review w13).
 const submittedAttachKeys=useRef(new Map<string,string[]>()),launchAttachKeys=useRef(new Map<string,string[]>());const attachVaultNoticeShown=useRef(false);
 // What the send/start button says while chips are not all settled: waiting for the network is not a transfer.
 const sessionAttachLabel=remoteAttachMovingLabel(sessionChips),sheetAttachLabel=remoteAttachMovingLabel(sheetChips);
 // Attachments still on their way hold the start; ready ones are a first request of their own (the Mac writes their block).
 const canLaunch=canStart&&!sheetAttachMoving&&(!sheetAttachReady||supportsPrompt);
 const sendInput=useRef<((data:string)=>void)|null>(null);
 const flushInput=useRef<(()=>void)|null>(null);const wakeRead=useRef<(()=>void)|null>(null);
 const cursor=useRef(0);const generation=useRef(0);const applied=useRef<number|null>(null);
 const remoteClaimedSize=useRef('');
 const request=useMemo(()=>createTerminalRequester(transport,remote),[transport,remote]);
 // Which requester's list has answered at least once. Until it has, the remote panel cannot say 「no sessions」:
 // a first list behind an idle Mac takes seconds, and that sentence beside 「새 작업」 invited a duplicate start
 // (production audit 2026-10-16). Keyed by the requester, so switching Macs or devices starts unknown again.
 const [listedFor,setListedFor]=useState<unknown>(null);const listed=listedFor===request;
 // A success or a neutral outcome is said here, not in the red alert box: that box carries 「VOC 보내기」 and is announced
 // as an alert, which read as 「something broke」 for 「전달했습니다」 (2026-10-16 audit). An error replaces it, and so does
 // every new action (start, send, session switch…), which cleared the same line in the alert box before.
 const [notice,setNotice]=useState('');
 useEffect(()=>{if(error)setNotice('');},[error]);
 const canWrite=useCallback((id:string)=>!closing.current.has(id)&&sessionsRef.current.some(s=>s.id===id&&s.state==='running'),[]);
 const accessRequest=useCallback((body:Record<string,unknown>)=>terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',body),[]);
 const refreshConnections=useMemo(()=>singleFlight(()=>terminalLocalRequest(AI_TERMINAL_PREFIX+'/access',{}).then(r=>{setConnections(r.connections??[]);setGrantRoots(r.workspaceRoots??[])}).catch(()=>{})),[]);
 useEffect(()=>{if(!target && projects.length)setTarget(current=>current||projects[0]!.targetId)},[target,projects]);
 useLayoutEffect(()=>{if(entry && applied.current!==entry.nonce){if(entryKeepsComposerDraft(entry,prompt,requestTitle)){applied.current=entry.nonce;selectionGeneration.current++;pendingResume.current=null;setResuming(false);setSelected(entry.sessionId!);openSessionView();return;}if(entry.prompt&&prompt.trim()&&entry.prompt!==prompt&&!startBusy.current){applied.current=entry.nonce;setError('작성 중인 요청을 유지했습니다. 초안을 비운 뒤 발언을 다시 가져오세요.');return;}draftGeneration.current++;applied.current=entry.nonce;const invalid=aiInitialPromptDraftError(entry.prompt??'');if(invalid){setError(invalid+' 현재 초안은 유지했습니다.');return;}setTarget(entry.targetId);setPrompt(entry.prompt??'');setRequestTitle(entry.title??'');setComposerOpen(!entry.sessionId&&!entry.resumeLatest||!!entry.prompt);if(entry.prompt)setFocusRequest(value=>value+1);setSelected(entry.sessionId??'');if(entry.sessionId)openSessionView();if(entry.agent)setAgent(entry.agent);
   pendingResume.current=entry.resumeLatest?{targetId:entry.targetId,selection:selectionGeneration.current}:null;
   setResuming(!!entry.resumeLatest);
 }},[entry]);
 // `kinds` — which of the phone-network errors this event proves stale. A successful remote read or list proves both: the
 // controller refuses every terminal request while anything is still in its outbox, so a read or a list that worked means
 // the held input has gone out. The phone's session list reads no terminal (w7), so its list poll is what clears it.
 const clearPhoneNetworkError=useCallback((kinds:readonly ('offline'|'held')[])=>{const held=phoneNetworkError.current;if(!held||!kinds.includes(held.kind))return;phoneNetworkError.current=null;setError(current=>current===held.text?'':current);},[]);
 const refresh=useMemo(()=>singleFlight(async(clearError=true)=>{const epoch=inventoryEpoch.current;try{let r:AiTerminalResponse;try{r=await request({operation:'list',...(submissionCapability.current==='probe'?{capabilities:true}:{})});}catch(error){if(!(error instanceof Error)||error.message!==AI_TERMINAL_UNKNOWN_REQUEST_ERROR)throw error;submissionCapability.current='legacy';r=await request({operation:'list'});}if(epoch!==inventoryEpoch.current)return;// A probe sent before a refused submission answers after it: 'legacy' set meanwhile wins (W1-probe).
   const submissions=submissionCapability.current!=='legacy'&&!!r.features?.includes(WORKROOM_SUBMISSION_FEATURE);setSubmissionSupported(submissions);const launches=submissions&&launchCapability.current!=='legacy';setLaunchSupported(launches&&!!r.features?.includes(WORKROOM_LAUNCH_SUBMISSION_FEATURE));setRecentSupported(launches&&!!r.features?.includes(WORKROOM_SUBMISSION_RECENT_FEATURE));const scopedSessions=(r.sessions??[]).filter(session=>remote||projectTargetIds.has(session.targetId));setSessions(old=>reconcileTerminalSummaries(old,scopedSessions));
   const resume=pendingResume.current;pendingResume.current=null;setResuming(false);
   if(resume&&resume.selection===selectionGeneration.current){
    const latest=scopedSessions.filter(s=>s.targetId===resume.targetId&&s.state==='running').sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
    // The target list can arrive after this read; a session the panel itself just started
    // for that target is not in `scopedSessions` yet and must not be deselected.
    // The phone opens it full screen, also when it was the selected one already (w7).
   if(latest){setSelected(latest.id);setAgent(latest.agent);openSessionView();}
    else {
     const justStarted=sessionsRef.current.find(s=>s.id===selectedRef.current&&s.targetId===resume.targetId&&s.state==='running');
     if(justStarted){setSelected(justStarted.id);setAgent(justStarted.agent);openSessionView();}
     else {setSelected('');setSessionView(false);setComposerOpen(true);}
    }
   // Deselect only a session the Mac no longer has. A session outside the current scope can
   // be one this panel just started whose target list has not arrived yet (a worktree first
   // seen at runtime); clearing it then left the new session unselected.
   }else setSelected(current=>current && !(r.sessions??[]).some(s=>s.id===current)?'':current);
   // Back where you were (w11, S4.2): once, from the first list, the session this phone had open before a reload (or an iOS
   // reclaim) reopens full screen while it still runs. Never over a selection or entry made since this panel mounted.
   if(fullscreenRef.current&&paneShownRef.current&&!restoreChecked.current){restoreChecked.current=true;const store=workroomOpenSessionStorage(),id=openWorkroomSessionToRestore(store,sessionScopeRef.current,Date.now());
    if(id){const open=scopedSessions.find(s=>s.id===id);if(!open||open.state!=='running')forgetOpenWorkroomSession(store,sessionScopeRef.current);
     else if(!sessionViewRef.current&&!resume&&applied.current===null&&selectionGeneration.current===0&&!newTaskOpenRef.current&&!composerOpenRef.current){setSelected(id);setAgent(open.agent);openSessionView();}}}
   setConnectionError('');if(clearError)setError('');else if(remote)clearPhoneNetworkError(['offline','held']);setListedFor(()=>request);
   // The list this answer holds (w11, S4.4): a caller waiting for a session reads it here, not from `sessionsRef`, which only
   // follows the next render.
   return scopedSessions;
 }catch(e){if(epoch===inventoryEpoch.current)setConnectionError(String(e instanceof Error?e.message:e));}}),[request,projectTargetIds,remote,clearPhoneNetworkError]);
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
 useEffect(()=>{if(!visible)return;void refresh(false);},[visible,refresh,entry?.nonce,listRefresh]);
 useEffect(()=>{if(!visible||remote)return;void refreshConnections();setTargetReload(value=>value+1);const timer=setInterval(()=>void refreshConnections(),5000);return()=>clearInterval(timer);},[visible,remote,refreshConnections,entry?.nonce]);
 useEffect(()=>{if(!visible)return;const timer=setInterval(()=>void refresh(false),slowPolling?12000:remote?5000:2000);return()=>clearInterval(timer);},[visible,remote,refresh,slowPolling]);
 const reportInputError=useCallback((e:unknown)=>{const message=e instanceof Error?e.message:String(e);const kind=phoneNetworkInputError(e,message);phoneNetworkError.current=kind?{text:message,kind}:null;setError(message);},[]);
 // A phone that gets its network back must not keep saying it is offline until the next list poll (5–12 s) or
 // the read backoff (up to 10 s) — the header already says 「연결됨」 by then (review 2026-10-10).
 useEffect(()=>{if(!visible||!remote)return;const onOnline=()=>{clearPhoneNetworkError(['offline']);void refresh(false);wakeRead.current?.();void checkOutcomesRef.current(false);};window.addEventListener('online',onOnline);return()=>window.removeEventListener('online',onOnline);},[visible,remote,refresh,clearPhoneNetworkError]);
 const enqueue=useCallback((r:Omit<AiTerminalRequest,'requestId'>,group?:TerminalSubmissionGroup)=>{
   if(!r.sessionId||!canWrite(r.sessionId)||inputPaused.current.has(r.sessionId))return;
   // A remote viewer must not reflow the Mac's PTY merely by opening or rotating the phone.
   // The first actual input claims the current phone size immediately before that input.
   if(remote&&r.operation==='input'){
    const screen=terminal.current;if(screen&&host.current?.clientWidth){fitScreen.current?.();const cols=Math.max(20,Math.min(300,screen.cols)),rows=Math.max(5,Math.min(150,screen.rows));const key=r.sessionId+':'+cols+'x'+rows;
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
  if(!visible||!sessionShown||!host.current||!activeSession)return;
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
  // The phone's full-screen view (w7 review): while an on-screen keyboard shrinks the view, the terminal keeps the rows it
  // has without the keyboard and keeps the cursor's row in sight (the rows above it are clipped). Input claims this size
  // for the Mac's PTY: a claim taken above the keyboard left the CLI at ~12 rows after the keyboard closed, and the readable
  // view then showed 12 host rows in a full screen. Without a size from before the keyboard, it fits what it has.
  const revealCursor=()=>{
   const box=host.current,screen=t.element?.querySelector<HTMLElement>('.xterm-screen');if(!box||!screen)return;
   const extra=screen.offsetHeight-box.clientHeight;
   if(extra<=0){if(box.scrollTop)box.scrollTop=0;return;}
   // Whole rows at the top: the cursor's row is the last whole row in sight, the part-row gap is at the bottom.
   const row=screen.offsetHeight/Math.max(1,t.rows);
   box.scrollTop=Math.max(0,Math.min(extra,Math.ceil(((t.buffer.active.cursorY+1)*row-box.clientHeight)/row)*row));
  };
  fitScreen.current=()=>{
   const box=host.current;if(!box?.clientWidth)return;
   if(!fullscreenRef.current){f.fit();return;}
   const resting=restingRows.current;
   if(keyboardUp.current&&resting&&resting.width===box.clientWidth&&resting.fontSize===t.options.fontSize){
    const proposed=f.proposeDimensions();
    if(proposed&&Number.isFinite(proposed.cols)&&proposed.cols>0&&(t.cols!==proposed.cols||t.rows!==resting.rows))t.resize(proposed.cols,resting.rows);
   }else{
    f.fit();
    if(!keyboardUp.current)restingRows.current={width:box.clientWidth,rows:t.rows,fontSize:t.options.fontSize??0};
   }
   revealCursor();
  };
  const cursorListener=t.onCursorMove(()=>{if(fullscreenRef.current)revealCursor();});
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
  const resize=new ResizeObserver(()=>{if(!visible||!host.current?.clientWidth)return;fitScreen.current?.();lastSize.current={cols:Math.max(20,Math.min(300,t.cols)),rows:Math.max(5,Math.min(150,t.rows))};const next=t.cols+'x'+t.rows;if(!remote&&selected&&canWrite(selected)&&next!==dimensions){dimensions=next;enqueue({operation:'resize',sessionId:selected,cols:Math.max(20,Math.min(300,t.cols)),rows:Math.max(5,Math.min(150,t.rows))});}});
  resize.observe(host.current);
  // On a phone the project controls can place a new terminal below the viewport.
  // Reveal it once on selection/return; output polling must not pull a reader
  // back down after they deliberately scroll elsewhere.
  // The full-screen view opens on the terminal already; scrolling would also move the page under it.
  const revealFrame=remote&&!fullscreen?requestAnimationFrame(()=>host.current?.scrollIntoView({block:'center',behavior:'auto'})):undefined;
  return()=>{if(revealFrame!==undefined)cancelAnimationFrame(revealFrame);sendInput.current=null;flushInput.current=null;fitScreen.current=null;flush();input.dispose();cursorListener.dispose();contextListener.dispose();cliListener?.dispose();clearTimeout(cliTimer);resize.disconnect();t.dispose();terminal.current=null;};
 },[selected,activeSession?.id,enqueue,visible,remote,canWrite,sessionShown,fullscreen]);
 useEffect(()=>{
  cursor.current=0;remoteClaimedSize.current='';terminal.current?.reset();setReadError('');setReadableScreen('');const mine=++generation.current;
  // The phone's session list reads nothing: the selected session's output is read only while it is open (w7).
  if(!visible||!activeSession||!sessionShown)return;
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
    // Still watching (w11 review): the open session's record stays fresh, so its TTL counts from now, not from opening.
    if(sessionViewRef.current)refreshOpenWorkroomSession(workroomOpenSessionStorage(),sessionScopeRef.current,selected,Date.now());
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
 },[selected,activeSession?.id,visible,request,remote,sessionShown]);
 const start=async()=>{
  if(!canLaunch||startBusy.current)return;
  startBusy.current=true;
  const draftRevision=draftGeneration.current,selection=selectionGeneration.current;
  // The composer is disabled while start is in flight, so only something that replaces the draft (a newer entry with
  // its own prompt, a prepared request) can supersede this submitted one — each moves `draftGeneration`. Session-tab
  // changes must not make the already accepted request reappear. Nor does a keepDraft entry (the phone history selecting
  // a resumed session) count: it leaves the draft, and keeping the started request in the composer left it under an
  // enabled start button for a second CLI (integration review w4, finding 1).
  const current=()=>draftRevision===draftGeneration.current;
  inventoryEpoch.current++;setBusy(true);setError('');setNotice('');
  try{
   // A host with terminal-start-submission-v1 takes the first request as a whole-request submission: its receipt names
   // the new session, so a lost answer is checked (「새 세션 시작 결과 확인」) instead of starting a second CLI.
   // Phone attachments (w13): the ready ids ride the launch; the Mac appends their block to the first request. They never
   // go any other way — without a launch receipt (an older path, no place for its record) the start is refused instead.
   const attach=remote?sheetAttach.queue.ready():{ids:[] as string[],keys:[] as string[]};
   const launchText=prompt.trim()?prompt+'\r':attach.ids.length?'\r':'';
   if(attach.ids.length){
    if(!launchSupported)throw new Error('이 Mac은 첨부가 있는 새 작업을 아직 받지 않습니다 — 첨부를 빼고 시작하거나 Mac 앱을 업데이트하세요. 작성 내용은 유지했습니다.');
    if(!routeLaunchStorage())throw new Error(REMOTE_ATTACH_LAUNCH_NO_RECORD);
    if(sheetAttach.queue.requestBytes(prompt)-1>AI_INITIAL_PROMPT_MAX_BYTES)throw new Error(REMOTE_ATTACH_BUDGET_REFUSAL);
   }
   // Without usable storage the launch record could not be kept (w4 L2): a plain start, guarded below in this page's memory.
   let launchable=launchSupported&&!!launchText&&!!routeLaunchStorage();
   if(launchable){try{validateSubmissionText(launchText,!!attach.ids.length);}catch(error){if(attach.ids.length)throw error;launchable=false;}}
   let r:AiTerminalResponse;
   if(launchable){
    const id=requestUuid(),launchTarget=target,launchAgent=agent;
    rememberLaunch(id,{id,targetId:launchTarget,agent:launchAgent,receipt:null});launchDrafts.current.set(id,prompt);
    if(attach.keys.length)launchAttachKeys.current.set(id,attach.keys);
    let launched:AiTerminalSummary|undefined;
    const ask=async(value:Omit<AiTerminalRequest,'requestId'>)=>{const response=await request(value);if(response.session)launched=response.session;return response;};
    const receipt=await submitWorkroomDraft({id,text:launchText,launch:{targetId:launchTarget,agent:launchAgent,cols:lastSize.current.cols,rows:lastSize.current.rows,bypassPermissions},
     ...(attach.ids.length?{attachments:attach.ids}:{}),
     prepared:value=>rememberLaunch(id,{id,targetId:launchTarget,agent:launchAgent,receipt:value}),request:ask}).catch(async error=>{
      // The Mac no longer knows these ids (expired, consumed, another project): they are no longer ready here either. That
      // sentence comes only from before anything is prepared or started (begin, or the lease before the spawn fence), so
      // the launch record goes too: nothing started, and the kept prompt starts again normally (review w13).
      if(attach.ids.length&&error instanceof Error&&remoteAttachIdsRefused(error.message)){sheetAttach.queue.invalidate(attach.keys,error.message);rememberLaunch(id,null);launchDrafts.current.delete(id);launchAttachKeys.current.delete(id);throw error;}
      // Nothing ran: this path could not take a launch. The draft stays and the next start uses a plain `start`.
      if(error instanceof WorkroomSubmissionUnsupportedError){rememberLaunch(id,null);launchDrafts.current.delete(id);launchAttachKeys.current.delete(id);launchCapability.current='legacy';setLaunchSupported(false);setRecentSupported(false);throw error;}
      // One read-only status (never a re-send): a refusal before the spawn fence is recorded as rejected, so the banner
      // must not outlive it; a start whose answer alone was lost reads as written and is taken as it is.
      let status:WorkroomSubmissionReceipt|undefined;
      try{status=(await ask({operation:'submission',submission:{phase:'status',id}})).submission;}catch{/* the banner keeps its manual check */}
      if(status?.id===id&&status.state==='written'&&status.sessionId)return status;
      if(status?.id===id&&pendingLaunchesRef.current.some(item=>item.id===id)){if(launchNeverStarted(status)){rememberLaunch(id,null);launchDrafts.current.delete(id);launchAttachKeys.current.delete(id);}else rememberLaunch(id,{id,targetId:launchTarget,agent:launchAgent,receipt:status});}
      throw error;});
    if(receipt.state!=='written'||!receipt.sessionId){
     if(launchNeverStarted(receipt)){rememberLaunch(id,null);launchDrafts.current.delete(id);launchAttachKeys.current.delete(id);throw new Error('새 세션이 시작되지 않았습니다('+submissionStateLabel(receipt.state)+'). 작성 내용은 유지했습니다.');}
     rememberLaunch(id,{id,targetId:launchTarget,agent:launchAgent,receipt});throw new Error('새 세션 시작 결과가 아직 확정되지 않았습니다('+submissionStateLabel(receipt.state)+'). 세션 목록과 터미널을 확인하세요. 자동으로 다시 시작하지 않습니다.');}
    rememberLaunch(id,null);launchDrafts.current.delete(id);launchAttachKeys.current.delete(id);
    // Written: the attachments went with the first request (a refusal notice under them goes too).
    if(attach.keys.length)sheetAttach.settled(attach.keys);
    r={session:launched?.id===receipt.sessionId?launched:undefined};
    // The answer named the new session only in its receipt: list until it is there (w11, S4.4). Reading `sessionsRef` right
    // after a refresh saw the list before it (it follows the next render), so the start silently did nothing. A refresh
    // already in flight answers with what it read before the launch, hence up to three polls.
    for(let poll=0;poll<3&&!r.session;poll++){
     if(poll)await new Promise(resolve=>setTimeout(resolve,700));
     r={session:(await refresh(false))?.find(s=>s.id===receipt.sessionId)};
    }
    if(!r.session){
     // Written, so the request went with it: the draft goes (a second start would run it again), and the list says where.
     if(current()){setPrompt('');setRequestTitle('');setComposerOpen(false);setNewTaskOpen(false);setNotice('새 세션이 열렸습니다 — 목록을 확인하세요');}
     return;
    }
   }else{
    // A host without launch receipts (w2-followups #15): a lost start answer may still have opened the CLI with this
    // request. Retrying the same request asks first when a new session for this target and AI appeared since.
    const attempt={targetId:target,agent,prompt},guarded=!!prompt.trim(),storage=legacyStartStorage();
    let known=sessionsRef.current.map(session=>session.id);
    const failed=guarded&&storage?readFailedLegacyStart(storage,sessionScope,Date.now(),attempt):null;
    if(failed){
     let listed:AiTerminalSummary[]=sessionsRef.current;
     try{listed=(await request({operation:'list'})).sessions??listed;}catch{/* decide from what this panel already lists */}
     known=[...new Set([...known,...listed.map(session=>session.id)])];
     const opened=sessionOpenedSinceFailedStart(failed,attempt,listed);
     if(opened&&!(await confirmAction(legacyStartRetryConfirmation(targetProject?.label??'선택한 프로젝트',WORKROOM_AGENT_NAMES[agent])))){
      inventoryEpoch.current++;setSessions(old=>[...old.filter(x=>x.id!==opened.id),opened]);
      if(current()&&selection===selectionGeneration.current)setSelected(opened.id);
      setError('');setNotice('앞서 열린 세션을 선택했습니다. 같은 요청은 다시 보내지 않았고 작성 내용은 그대로 두었습니다.');
      return;
     }
    }
    try{r=await request({operation:'start',targetId:target,agent,cols:lastSize.current.cols,rows:lastSize.current.rows,bypassPermissions,...(prompt.trim()?{prompt}: {})});}
    catch(error){if(guarded&&storage)rememberFailedLegacyStart(storage,sessionScope,{...attempt,knownSessionIds:known,at:Date.now()});throw error;}
    // Only this request's own failed record is settled; a failed start of another request keeps asking on its retry.
    if(guarded&&storage)forgetFailedLegacyStart(storage,sessionScope,attempt);
   }
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
  setBusy(true);setError('');setNotice('');inputPaused.current.add(id);if(screen)screen.options.disableStdin=true;
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
   // The phone goes back to the list (the view closes) instead of opening another session full screen.
   setSelected(current=>current===id?(fullscreenRef.current?'':sessionsRef.current.filter(s=>s.id!==id&&s.state==='running').at(-1)?.id??''):current);
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
  const old=activeSession;if(!old||remote||busy||restartConfirming.current||closing.current.has(old.id))return;
  const selection=selectionGeneration.current,entryNonce=latestEntryNonce.current;
  restartConfirming.current=true;
  try{if(old.state==='running'&&!(await confirmAction(workroomRestartConfirm(sessionLabels.get(old.id)??'이 세션'))))return;}
  finally{restartConfirming.current=false;}
  // Native dialogs do not block JS. A selection, close or remount may have happened while it was open.
  if(!mounted.current||selection!==selectionGeneration.current||entryNonce!==latestEntryNonce.current
   ||activeSessionRef.current?.id!==old.id||activeSessionRef.current.state!==old.state||closing.current.has(old.id)||startBusy.current)return;
  inventoryEpoch.current++;setBusy(true);setError('');setNotice('');setRestartNotice(null);
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
 // Photos, files, captures, paste and Finder drops (S3 2026-10-16): src/WorkroomAttachBar.tsx. Mac only.
 const attach=useWorkroomAttachments({enabled:!remote,attachments:imagesRef,setAttachments:next=>{imagesRef.current=next;setImages(next);},busy:imageBusy,setBusy:setImageBusy,setError,focusComposer:()=>terminalComposer.current?.focus()});
 const captureRef=useRef(attach.capture);captureRef.current=attach.capture;
 // Capture this before the entry effect runs: its setPrompt applies on the next render. An incoming
 // nonempty draft must not briefly report clean while its own entry is still being applied.
 const incomingDraft=!!entry?.prompt?.length&&entry.nonce!==applied.current;
 useEffect(()=>{onDraftStateChange?.(!!(prompt.length||terminalDraft.length||images.length||referenceChips.length||imageBusy||incomingDraft||sessionChips.length||sheetChips.length||useDraftDirty));},[onDraftStateChange,prompt,terminalDraft,images.length,referenceChips.length,imageBusy,incomingDraft,sessionChips.length,sheetChips.length,useDraftDirty]);
 const runningSessions=sessions.filter(s=>s.state==='running'), endedSessions=sessions.filter(s=>s.state==='exited'&&!dismissed.includes(s.id));
 const visibleSessions=showEnded?sessions.filter(s=>s.state==='running'||!dismissed.includes(s.id)):runningSessions;
 useEffect(()=>{setRawInput(false);routeTo('');setRouteReceipt(null);setAppRouteReceipt(null);},[selected]);
 useEffect(()=>{const screen=terminal.current;if(!screen)return;screen.options.disableStdin=!activeSession||activeSession.state!=='running';if(activeSession?.state==='running'){fitScreen.current?.();if(!remote)enqueue({operation:'resize',sessionId:activeSession.id,cols:Math.max(20,Math.min(300,screen.cols)),rows:Math.max(5,Math.min(150,screen.rows))});}},[activeSession?.id,activeSession?.state,enqueue,visible,remote]);
 // One PTY has one size. When the same session is open in another window (pop-out), the PTY takes that
 // window's size and this one wraps wrongly. Coming back to the front re-asserts this window's size,
 // so the CLI redraws for the window the user is actually looking at.
 useEffect(()=>{if(!visible||remote)return;const reassert=()=>{if(document.visibilityState==='hidden')return;const screen=terminal.current;const session=activeSessionRef.current;if(!screen||!session||session.state!=='running'||!host.current?.clientWidth)return;fit.current?.fit();enqueue({operation:'resize',sessionId:session.id,cols:Math.max(20,Math.min(300,screen.cols)),rows:Math.max(5,Math.min(150,screen.rows))});};window.addEventListener('focus',reassert);document.addEventListener('visibilitychange',reassert);return()=>{window.removeEventListener('focus',reassert);document.removeEventListener('visibilitychange',reassert);};},[visible,enqueue,remote]);
 // A font change keeps the host box the same size, so the ResizeObserver never fires: refit and tell the CLI here.
 useEffect(()=>{if(!remote)writeWorkroomFontSize(workroomPreferenceStorage(),fontSize);const screen=terminal.current;if(!screen||screen.options.fontSize===fontSize)return;screen.options.fontSize=fontSize;if(!visible||!host.current?.clientWidth)return;fitScreen.current?.();if(!remote&&activeSession?.state==='running')enqueue({operation:'resize',sessionId:activeSession.id,cols:Math.max(20,Math.min(300,screen.cols)),rows:Math.max(5,Math.min(150,screen.rows))});},[fontSize,remote,activeSession?.id,activeSession?.state,enqueue,visible]);
 useEffect(()=>{if(remote||popout)return;writeWorkroomWide(workroomPreferenceStorage(),wide);const root=document.documentElement;if(wide&&visible&&activeSession)root.dataset.workroomWide='true';else delete root.dataset.workroomWide;return()=>{delete root.dataset.workroomWide;};},[wide,visible,remote,popout,!!activeSession]);
 // ⌥⌘4 영역 · ⌥⌘5 창 · ⌥⌘3 전체 화면, while this Workroom is in front with a running session.
 useEffect(()=>{if(!visible||remote||activeSession?.state!=='running')return;const onKey=(event:KeyboardEvent)=>{const mode=workroomCaptureShortcut(event);if(!mode)return;event.preventDefault();event.stopPropagation();void captureRef.current(mode);};window.addEventListener('keydown',onKey,true);return()=>window.removeEventListener('keydown',onKey,true);},[visible,remote,activeSession?.state]);
 const [slashFavorites,setSlashFavorites]=useState<string[]>([]);const [slashPadOpen,setSlashPadOpen]=useState(false);
 const [addingSlash,setAddingSlash]=useState(false),[customSlash,setCustomSlash]=useState('');
 useEffect(()=>{setSlashFavorites(activeSession?readSlashFavorites(workroomPreferenceStorage(),activeSession.agent):[]);setSlashPadOpen(false);},[activeSession?.agent]);
 const toggleFavorite=(command:string)=>{if(activeSession)setSlashFavorites(toggleSlashFavorite(workroomPreferenceStorage(),activeSession.agent,command));};
 const addCustomFavorite=()=>{const value=customSlash.trim();if(!activeSession||!isWorkroomPaletteCommand(value,activeSession.agent)){setError(activeSession?.agent==='codex'?'Codex CLI 명령은 /model, 설치된 스킬은 $remember-session처럼 입력하세요.':'슬래시 명령 하나만 입력하세요. 예: /compact, /cs-ceo:goal');return;}if(!slashFavorites.includes(value))toggleFavorite(value);setError('');setCustomSlash('');setAddingSlash(false);};
 const activeProject=projects.find(p=>p.targetId===(activeSession?.targetId??target));
 useEffect(()=>{onActiveSessionChange?.(activeSession?{id:activeSession.id,label:activeProject?.label??'',agent:activeSession.agent}:null);},[activeSession?.id,activeSession?.agent,activeProject?.label,onActiveSessionChange]);
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
  startBusy.current=true;inventoryEpoch.current++;setBusy(true);setError('');setNotice('');
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
  selectionGeneration.current++;setError('');setNotice('');
  if(!remote&&!popout&&isTauri()){
   try{
    const project=projects.find(item=>item.targetId===session.targetId);
    await openWorkroomPopout({sessionId:session.id,targetId:session.targetId,agent:session.agent,bypassPermissions},workroomPopoutTitle(project?.label??'',session.agent));
    setSelected('');return;
   }catch(e){setError('새 창을 열지 못해 이 화면에서 세션을 엽니다. '+(e instanceof Error?e.message:String(e)));}
  }
  setSelected(session.id);
  // On a phone the session opens full screen, and the keyboard stays down until the composer is tapped.
  if(fullscreenRef.current){openSessionView();return;}
  requestAnimationFrame(()=>terminalComposer.current?.focus());
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
 const routeProject=projectMentionChoices(routeDeviceId?routeDevice?.projects??[]:projects).find(project=>project.targetId===routeTargetId&&(project.executionRole??'dev')===routeRole&&(routeRole!=='use'||project.serviceKey===routeServiceKey));
 // 대화상자·영수증·미리보기가 모두 어느 기기인지 말하도록 라벨에 기기를 적는다.
 const routeTarget=routeProject?{...routeProject,label:routeDevice?`${routeDevice.label} · ${routeProject.label}`:routeProject.label}:undefined;
 // 다른 기기의 세션 목록은 받는 곳을 고른 뒤 한 번 읽는다 — 그래야 「전달/새로 열기」를 정직하게 말한다.
 const [deviceSessions,setDeviceSessions]=useState<{deviceId:string;loading:boolean;error:string;sessions:AiTerminalSummary[];submission?:boolean;launch?:boolean}|null>(null);
 useEffect(()=>{
  const requester=routeDeviceId?communityMentionRef.current?.requester(routeDeviceId):null;
  if(!routeDeviceId||!requester){setDeviceSessions(null);return;}
  let alive=true;setDeviceSessions({deviceId:routeDeviceId,loading:true,error:'',sessions:[]});
  // The same capability probe as this panel's own list: a Mac that predates `capabilities` refuses the key and is read plainly.
  requester({operation:'list',capabilities:true}).catch((probeError:unknown)=>{if(probeError instanceof Error&&probeError.message===AI_TERMINAL_UNKNOWN_REQUEST_ERROR)return requester({operation:'list'});throw probeError;})
   .then(response=>{if(alive)setDeviceSessions({deviceId:routeDeviceId,loading:false,error:'',sessions:response.sessions??[],submission:!!response.features?.includes(WORKROOM_SUBMISSION_FEATURE),launch:!!response.features?.includes(WORKROOM_SUBMISSION_FEATURE)&&!!response.features?.includes(WORKROOM_LAUNCH_SUBMISSION_FEATURE)});})
   .catch((listError:unknown)=>{if(alive)setDeviceSessions({deviceId:routeDeviceId,loading:false,
     error:listError instanceof Error?listError.message:'그 기기의 작업 세션 목록을 받지 못했습니다.',sessions:[]});});
  return ()=>{alive=false;};
 },[routeDeviceId]);
 const routeSessions=routeDeviceId?(deviceSessions?.deviceId===routeDeviceId?deviceSessions.sessions:[]):sessions;
 // Not limited to the sender's AI: suggested is whoever already runs in the target, else this session's AI.
 // 앱 받는 곳은 이 Mac 화면에서만 — 휴대폰(remote)·다른 아젠투지로 보낼 때는 CLI만 고를 수 있다(src/workroomAppRoute.ts).
 const appRoutesAvailable=workroomAppRoutesAvailable({remote,routeDeviceId});
 const routeApp=routeRole==='dev'&&routeTarget&&activeSession&&appRoutesAvailable?workroomAppAgentOf(routeAgentChoice):null;
 const routeAgent=routeRole==='dev'&&routeTarget&&activeSession&&!routeApp?workroomCliAgentOf(routeAgentChoice)||defaultWorkroomRouteAgent(routeSessions,routeDeviceId?null:activeSession,routeTarget.targetId,activeSession.agent):undefined;
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
   const chip={deviceId:mention.device?.deviceId??'',targetId:project.targetId,label:project.label,token:applied.token,executionRole:project.executionRole,serviceKey:project.serviceKey};
   setReferenceChips(chips=>chips.some(item=>item.token===chip.token)?chips:[...chips,chip].slice(-AI_TERMINAL_MAX_REFERENCES));
  }else routeTo(project.targetId,mention.device?.deviceId??'',project.executionRole,project.serviceKey);
  setComposerSelection({value:applied.value,cursor:applied.cursor,scope:sessionScope,sessionId:activeSession?.id??null});
 };
 // Offline, nothing can be sent: keep what was typed (the caller clears the box only on true) and say so.
 // The controller would refuse it anyway, after the box was already emptied (review 2026-10-10).
 const sendBoundInput=(data:string,references?:string[])=>{if(!data||!activeSession||activeSession.state!=='running'||busy)return false;if(!canWrite(activeSession.id)||inputPaused.current.has(activeSession.id)){setError('이 세션의 입력 권한 또는 이전 전송 결과를 확인하세요. 키를 전송하지 않았습니다.');return false;}if(remote&&!phoneIsOnline()){const text=offlineInputNotice();phoneNetworkError.current={text,kind:'offline'};setError(text);return false;}flushInput.current?.();setNotice('');const parts=splitTerminalSubmission(data),group=parts.length>1?terminalSubmissionGroup():undefined;parts.forEach((part,index)=>enqueue({operation:'input',sessionId:activeSession.id,data:part,...(references?.length&&index===parts.length-1?{references}:{})},group));return true;};
 const focusCliKeyboard=()=>{rawInputRef.current=true;setRawInput(true);requestAnimationFrame(()=>terminal.current?.focus());};
 const sendToolbarInput=(data:string)=>{
  if(/^[0-9]$/.test(data)&&activeSession&&terminal.current){
   const buffer=terminal.current.buffer.active,rows:string[]=[];
   for(let y=buffer.baseY;y<buffer.baseY+terminal.current.rows;y++)rows.push(buffer.getLine(y)?.translateToString(true)??'');
   const notice=workroomNumberKeyNotice(activeSession.agent,rows);if(notice){setError(notice);return false;}
  }
  const sent=sendBoundInput(data);
  // Numeric selection must not summon the phone keyboard. Other controls keep
  // the Mac CLI ready for the next physical key, as before.
  if(sent&&!/^[0-9]$/.test(data)&&(!remote||rawInputRef.current))focusCliKeyboard();
  return sent;
 };
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
  // A launch receipt carries up to 24,000 bytes on any connection (w2-followups #14), so nothing is typed after start.
  const launchCarries=(routeDeviceId?deviceSessions?.submission===true&&deviceSessions.launch===true:submissionSupported&&launchSupported)&&!!routeLaunchStorage()&&!(images.length&&(remote||!!routeDeviceId))
   &&(()=>{try{validateSubmissionText(prompt+'\r');return true;}catch{return false;}})();
  routeStartTyped=!launchCarries&&!workroomStartCarriesPrompt({operation:'start',targetId:routeTarget.targetId,agent:routeAgent,cols:100,rows:28,bypassPermissions,prompt,...(references.length?{references}:{})},remote?'relay':'local');
 }
 // Favorites and model buttons run immediately, exactly as if typed into the CLI.
 const runSlashCommand=(command:string)=>{if(activeSession&&isWorkroomPaletteCommand(command,activeSession.agent)&&sendBoundInput(command+'\r')){
   // CLI pickers open inside the PTY. A clicked toolbar button must hand the
   // keyboard back to that PTY; otherwise arrows and Enter stay on the button.
   focusCliKeyboard();
  }};
 const completeSlash=(command:string)=>{const value=command+(command.startsWith('$')?'':' ');setTerminalDraft(value);setTerminalCursor(value.length);setComposerSelection({value,cursor:value.length,scope:sessionScope,sessionId:activeSession?.id??null});};
 const draftMessage=()=>workroomAttachmentsMessage(terminalDraft,images);
 // An uncertain `@` launch may have opened this very session with this very draft (integration review A1): checking it
 // first is the only way to know, so nothing is typed. Its own banner settles it; dismissing it there releases this too.
 const repeatsUncertainRouteLaunch=async (draft:string,session:AiTerminalSummary)=>{
  if(uncertainRouteLaunchFor(routeLaunches.current,{draft,targetId:session.targetId,deviceId:'',agent:session.agent})){
   setError('이 글로 앞서 연 새 세션의 시작 결과가 아직 확정되지 않았습니다. 지금 세션이 그 세션일 수 있습니다. 「새 세션 시작 결과 확인」으로 먼저 확인하세요. 보내지 않았습니다.');return true;
  }
  // A plain-started @ handoff with no receipt to check (w4 review, finding 1): only the user can say, so ask once.
  const suspect=legacyRouteSuspectStore.find({scope:sessionScope,targetId:session.targetId,agent:session.agent,draft,sessionId:session.id},Date.now());
  if(!suspect)return false;
  const label=sessionLabels.get(session.id),agentName=WORKROOM_AGENT_NAMES[session.agent];
  if(!(await confirmAction(legacyRouteSessionSendConfirmation(suspect.label,agentName,label)))){setError(legacyRouteSessionSendHeld(suspect.label,agentName,label));return true;}
  legacyRouteSuspectStore.clear(suspect);return false;
 };
 const sendTerminalDraft=async()=>{
  if(routeRole==='use'||routeTargetId&&!routeTarget){setError('선택한 호출 대상과 USE 준비 상태를 확인하세요. 현재 세션으로 전송하지 않았습니다.');return;}
  if(sendConfirming.current)return;
  if(submissionInFlight.current||pendingSubmission?.sessionId===activeSession?.id)return;
  const selectedSession=activeSession?.id,selection=selectionGeneration.current,entryNonce=latestEntryNonce.current;
  sendConfirming.current=true;
  try{if(activeSession&&await repeatsUncertainRouteLaunch(terminalDraft,activeSession))return;}
  finally{sendConfirming.current=false;}
  if(!mounted.current||activeSessionRef.current?.id!==selectedSession||selection!==selectionGeneration.current
   ||entryNonce!==latestEntryNonce.current||terminalDraftLive.current!==terminalDraft||submissionInFlight.current
   ||pendingSubmissionRef.current?.sessionId===selectedSession)return;
  // Phone attachments (w13): only ready ids go, by a whole-request submission whose begin names them — never as raw input.
  // A chip still on its way holds the send; failed ones stay behind (the summary says the rest goes without them).
  const attach=remote?sessionAttach.queue.ready():{ids:[] as string[],keys:[] as string[]};
  if(remote&&sessionAttachMoving){setError(sessionAttachLabel+' — 끝나면 보내세요. 작성 내용은 유지했습니다.');return;}
  if(attach.ids.length){
   if(!submissionSupported){setError('이 Mac은 첨부가 있는 요청을 아직 받지 않습니다 — 첨부를 빼고 보내거나 Mac 앱을 업데이트하세요. 작성 내용은 유지했습니다.');return;}
   if(usableSessionStorage()==null){setError(REMOTE_ATTACH_NO_RECORD);return;}
   if(sessionAttach.queue.requestBytes(terminalDraft)>WORKROOM_SUBMISSION_MAX_BYTES){setError(REMOTE_ATTACH_BUDGET_REFUSAL+'. 작성 내용은 유지했습니다.');return;}
  }
  // Images go with a whole-request submission only from this Mac; the host checks every path before writing.
  // No place for the pending record (w4 L2): raw input as before, never a record-less submission.
  // Raw input has no submission id to seal under: with the vault on, the composer says it was not kept (w4 review, 4a).
  if(!attach.ids.length&&(!submissionSupported||images.length&&remote||!usableSessionStorage())){if(sendBoundInput(draftMessage()+'\r',activeReferences(terminalDraft))){setTerminalDraft('');setTerminalCursor(0);setReferenceChips([]);setImages([]);if(draftVault.vault)setError(DRAFT_RAW_SEND_NOTICE);requestAnimationFrame(()=>terminalComposer.current?.focus());}return;}
  if(!activeSession||activeSession.state!=='running'||busy||!canWrite(activeSession.id)||remote&&!phoneIsOnline())return;
  const sessionId=activeSession.id,draft=terminalDraft,text=draftMessage()+'\r',id=requestUuid(),key=pendingSubmissionKey(sessionScope,sessionId);
  const remember=(value:PendingWorkroomSubmission|null)=>{writePendingSubmission(sessionStorage,key,value);if(activeSessionRef.current?.id===sessionId)setPendingSubmission(value);};
  try{validateSubmissionText(text,!!attach.ids.length);remember({id,sessionId,receipt:null});}catch(error){setError(error instanceof Error?error.message:'제출 기록을 보관하지 못해 전송하지 않았습니다.');return;}
  submissionInFlight.current=true;setSubmissionBusy(true);setSendingId(id);setNotice('');flushInput.current?.();submittedDrafts.current.set(id,draft);
  if(attach.keys.length)submittedAttachKeys.current.set(id,attach.keys);
  // A request with attachments is not sealed into the draft vault (its ids live an hour on the Mac; a kept copy could not
  // carry them back). With the vault on, the composer says so once.
  const references=activeReferences(draft),vault=attach.ids.length?null:draftVault.vault;
  if(attach.ids.length&&draftVault.vault&&!attachVaultNoticeShown.current){attachVaultNoticeShown.current=true;setNotice(REMOTE_ATTACH_VAULT_NOTICE);}
  // Opted in: the text is sealed under this submission id, and when the seal is stored within the wait the request
  // leaves only after it, so a crash right after the send keeps it — stopped, never re-sent on its own. A written receipt
  // removes it again; anything else leaves it in the queue. Sealed as attempted: if this page dies, a later «not found»
  // may only mean another receipt owner, so the queue never sends it again on its own evidence. A slow or failed seal
  // never blocks the send: it goes once anyway, before any seal, and the composer says it was not (or may not be) kept —
  // a notice about keeping only, since the submission it is shown with may still be refused (src/workroomDraftQueue.ts).
  let sealNote='';
  const withSealNote=(message:string)=>sealNote?message+' '+sealNote:message;
  const sending=sendWithDraftSeal({vault,scope:draftVaultScope,sessionId,id,text,references,...(attach.ids.length?{attachments:attach.ids}:{}),request,prepared:receipt=>remember({id,sessionId,receipt}),
    onSealed:sealed=>{sealNote=draftSealNotice(sealed);if(sealNote)setError(sealNote);}});
  const kept=sending.stored;
  const forget=()=>{void kept.then((saved:boolean)=>saved?vault!.delete(id).catch(()=>undefined):undefined).then(draftVault.bump);};
  void sending.receipt.then(receipt=>{
    if(receipt.state!=='written'){remember({id,sessionId,receipt});void kept.then(draftVault.bump);setError(withSealNote('요청 전송 결과가 미확정입니다. 터미널과 제출 결과를 확인하세요. 자동으로 다시 보내지 않습니다.'));return;}
    // Written: whether it was kept no longer matters, so a seal notice shown while sending goes away.
    if(sealNote)setError(current=>current===sealNote?'':current);
    forget();remember(null);submittedDrafts.current.delete(id);if(activeSessionRef.current?.id===sessionId&&terminalDraftLive.current===draft){setTerminalDraft('');setTerminalCursor(0);setReferenceChips([]);setImages([]);}wakeRead.current?.();
    // Written: the attachments went with it, whatever the text box holds now (a refusal notice under them goes too).
    submittedAttachKeys.current.delete(id);if(attach.keys.length)sessionAttach.settled(attach.keys);
    // A whole request may have left 「에포트 자동」 advice on the host (w16).
    refreshEffort(800);
  }).catch(error=>{
    // The Mac refused the ids before anything was prepared or written (begin, or the lease before the write fence): the
    // chips are no longer ready, and the pending record goes — it proves nothing was written, so the kept text is
    // sendable again without a 「possible duplicate」 dismissal (review w13).
    if(attach.ids.length&&error instanceof Error&&remoteAttachIdsRefused(error.message)){submittedAttachKeys.current.delete(id);sessionAttach.queue.invalidate(attach.keys,error.message);submittedDrafts.current.delete(id);try{remember(null);}catch{/* the banner only asks to check */}setError(error.message);return;}
    // An older receiver advertised submission but refused it before anything ran: nothing was prepared or written,
    // so this transport goes back to raw input. The draft stays; the user's next click sends it the old way.
    if(error instanceof WorkroomSubmissionUnsupportedError){forget();submittedDrafts.current.delete(id);try{remember(null);}catch{/* the banner only asks to check */}submissionCapability.current='legacy';setSubmissionSupported(false);setError(error.message);return;}
    void kept.then(draftVault.bump);setError(withSealNote(error instanceof Error?error.message:'제출 결과를 확인하지 못했습니다. 작성 내용은 유지했습니다.'));
  }).finally(()=>{submissionInFlight.current=false;setSubmissionBusy(false);setSendingId(null);});
 };
 // S3-8 queue. One press on one stored request: the receipt of its pre-assigned id is read first, and an existing receipt
 // is shown instead of sending (never twice). Only the host's own «no such submission» lets it go, with the same id.
 const sendQueuedDraftItem=async(item:QueuedWorkroomDraft):Promise<QueuedDraftSendOutcome|null>=>{
  const session=activeSessionRef.current;
  if(!session||session.state!=='running'||busy||submissionInFlight.current||pendingSubmissionRef.current?.sessionId===session.id){setError('앞서 보낸 요청의 결과를 확인한 뒤 보내세요. 보관한 요청은 그대로입니다.');return null;}
  if(!canWrite(session.id)||remote&&!phoneIsOnline()){setError('지금은 보낼 수 없습니다. 연결을 확인하세요. 보관한 요청은 그대로입니다.');return null;}
  const vault=draftVault.vault;if(!vault){setError('작성 내용 보관이 꺼져 있어 보내지 않았습니다.');return null;}
  if(sendConfirming.current)return null;
  sendConfirming.current=true;
  try{if(await repeatsUncertainRouteLaunch(item.text.replace(/\r$/,''),session))return null;}
  finally{sendConfirming.current=false;}
  if(!mounted.current||activeSessionRef.current?.id!==session.id||activeSessionRef.current.state!=='running'
   ||!canWrite(session.id)||submissionInFlight.current||pendingSubmissionRef.current?.sessionId===session.id)return null;
  const sessionId=session.id,id=item.submissionId,key=pendingSubmissionKey(sessionScope,sessionId);
  const remember=(value:PendingWorkroomSubmission|null)=>{try{writePendingSubmission(sessionStorage,key,value);}catch{/* banner for this page only */}if(activeSessionRef.current?.id===sessionId)setPendingSubmission(value);};
  submissionInFlight.current=true;setSubmissionBusy(true);setSendingId(id);setNotice('');flushInput.current?.();
  try{
   const outcome=await sendQueuedDraft({draft:item,sessionId,request,claim:()=>vault.claimForSend(draftVaultScope,sessionId,id),prepared:receipt=>remember({id,sessionId,receipt})});
   if(outcome.kind==='unproven'){setError('이 요청은 이미 한 번 보낸 기록이 있지만 지금 연결로는 실행 여부를 확인할 수 없습니다. 다시 보내지 않았습니다. 터미널을 확인하세요.');return outcome;}
   const receipt=outcome.receipt;
   if(receipt.state==='written'){remember(null);await vault.delete(id).catch(()=>undefined);setError('');setNotice(outcome.kind==='existing'?'이 요청은 이미 터미널에 전달됐습니다. 다시 보내지 않았습니다.':'보관한 요청 전체를 터미널에 전달했습니다. AI의 실제 응답을 확인하세요.');wakeRead.current?.();refreshEffort(800);return outcome;}
   // A receipt that proves nothing ran (refused, or prepared before a host restart) blocks nothing; any other one keeps
   // the existing recovery banner, exactly like a direct send.
   if(!(outcome.kind==='existing'&&(receipt.state==='rejected'||receipt.state==='held')))remember({id,sessionId,receipt});
   setError((outcome.kind==='existing'?'이 요청은 이미 보낸 기록이 있습니다':'보관한 요청의 전송 결과가 미확정입니다')+' — 제출 상태: '+submissionStateLabel(receipt.state)+'. 터미널 결과를 확인하세요. 다시 보내지 않았습니다.');
   return outcome;
  }catch(error){
   if(error instanceof WorkroomSubmissionUnsupportedError){remember(null);submissionCapability.current='legacy';setSubmissionSupported(false);setError(error.message);return null;}
   setError(error instanceof Error?error.message:'보관한 요청을 보내지 못했습니다. 보관한 요청은 그대로입니다.');return null;
  }finally{submissionInFlight.current=false;setSubmissionBusy(false);setSendingId(null);}
 };
 const queueCurrentDraft=async()=>{
  if(routeTargetId)throw Error('호출 대상이 있는 요청은 그 대상의 대화에서 확인하세요.');
  const session=activeSessionRef.current,vault=draftVault.vault;
  if(!session||!vault)throw Error('보관할 세션이 없습니다.');
  if(sessionAttach.queue.snapshot().length)throw Error(REMOTE_ATTACH_VAULT_NOTICE+'.');
  const draft=terminalDraft,text=draftMessage()+'\r';
  validateSubmissionText(text);
  await vault.save({scope:draftVaultScope,sessionId:session.id,submissionId:requestUuid(),text,references:activeReferences(draft)});
  if(terminalDraftLive.current===draft){setTerminalDraft('');setTerminalCursor(0);setReferenceChips([]);setImages([]);}
 };
 // Only a request whose receipt proved it never ran may go back to the composer, where sending makes a new request.
 const takeBackQueuedDraft=(item:{text:string})=>{
  if(terminalDraftLive.current.trim())return false;
  const value=item.text.replace(/\r$/,'');setTerminalDraft(value);setTerminalCursor(value.length);return true;
 };
 // A request kept for another session (one that ended): a read-only status of its original id under that session.
 const checkKeptDraftItem=(item:{submissionId:string;sessionId:string})=>checkKeptDraft({draft:item,request});
 // A status answer settles or keeps the pending record; it never re-sends anything (MISS-10: written clears the banner).
 const settleSubmission=(pending:PendingWorkroomSubmission,receipt:WorkroomSubmissionReceipt,quiet:boolean)=>{
  if(receipt.id!==pending.id||pending.receipt&&receipt.storeId!==pending.receipt.storeId)throw Error('같은 호스트의 제출 기록을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');
  // A written receipt settles it. The composer follows the direct written path's rule: cleared only while it still holds
  // the submitted draft, so the enabled send button cannot type the same request a second time.
  const value=pendingAfterStatus(pending,receipt);writePendingSubmission(sessionStorage,pendingSubmissionKey(sessionScope,pending.sessionId),value);
  if(activeSessionRef.current?.id===pending.sessionId)setPendingSubmission(value);
  if(value){if(!quiet)setError('제출 상태: '+submissionStateLabel(receipt.state)+'. 터미널 결과를 확인하세요. 자동으로 다시 보내지 않습니다.');return;}
  const outcome=draftAfterWrittenStatus(submittedDrafts.current.get(pending.id),terminalDraftLive.current);submittedDrafts.current.delete(pending.id);
  if(outcome.clear&&activeSessionRef.current?.id===pending.sessionId){setTerminalDraft('');setTerminalCursor(0);setReferenceChips([]);setImages([]);}
  // A written receipt settles its attachments too: the chips that went with it go.
  const sentAttachments=submittedAttachKeys.current.get(pending.id);submittedAttachKeys.current.delete(pending.id);if(sentAttachments)sessionAttach.settled(sentAttachments);
  setError(outcome.message);wakeRead.current?.();
 };
 const inspectPendingSubmission=async()=>{if(!pendingSubmission||submissionBusy)return;const pending=pendingSubmission;setSubmissionBusy(true);try{const result=await request({operation:'submission',sessionId:pending.sessionId,submission:{phase:'status',id:pending.id}});const receipt=result.submission;if(!receipt)throw Error('같은 호스트의 제출 기록을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다.');settleSubmission(pending,receipt,false);}catch(error){setError(error instanceof Error?error.message:'제출 결과를 확인하지 못했습니다.');}finally{setSubmissionBusy(false);}};
 // A launch receipt written with its session settles it: that session is listed and selected. Anything else stays.
 const settleLaunch=async(pending:PendingWorkroomLaunch,receipt:WorkroomSubmissionReceipt,session:AiTerminalSummary|undefined,quiet:boolean)=>{
  if(receipt.id!==pending.id)throw Error('다른 요청의 시작 영수증입니다. 자동으로 다시 시작하지 않습니다.');
  if(!pendingLaunchesRef.current.some(item=>item.id===pending.id))return;
  const value=pendingLaunchAfterStatus(pending,receipt);rememberLaunch(pending.id,value);
  if(value){if(!quiet)setError('새 세션 시작 상태: '+submissionStateLabel(receipt.state)+'. 세션 목록과 터미널을 확인하세요. 자동으로 다시 시작하지 않습니다.');return;}
  // Definitively not started (refused before the spawn fence, or prepared before a restart): the banner goes, the draft
  // stays, and starting again is the user's own choice.
  if(launchNeverStarted(receipt)){launchDrafts.current.delete(pending.id);routeLaunches.current.delete(pending.id);launchAttachKeys.current.delete(pending.id);if(!quiet)setError('새 세션은 시작되지 않았습니다('+submissionStateLabel(receipt.state)+'). 작성 내용은 유지했습니다.');return;}
  if(session&&session.id===receipt.sessionId){inventoryEpoch.current++;setSessions(old=>[...old.filter(x=>x.id!==session.id),session]);}
  const draft=launchDrafts.current.get(pending.id);launchDrafts.current.delete(pending.id);
  if(draft!==undefined&&draft===prompt){setPrompt('');setRequestTitle('');}
  // Its attachments went with that first request: they go with it, whatever the prompt holds now (review w13).
  const launchedAttachments=launchAttachKeys.current.get(pending.id);launchAttachKeys.current.delete(pending.id);if(launchedAttachments)sheetAttach.settled(launchedAttachments);
  // An @ route's launch: its draft and route chip go too while they still hold that request, so sending it again
  // cannot type the same handoff into the session it opened.
  const routed=routeLaunches.current.get(pending.id);routeLaunches.current.delete(pending.id);
  // Also after a session switch cleared the chip (integration review A1); a draft re-aimed at another target is kept.
  const clears=routed?routeDraftClearsOnSettle(routed,{draft:terminalDraftLive.current,...routeLive.current}):null;
  if(clears?.clearDraft){setTerminalDraft('');setTerminalCursor(0);if(clears.clearChip)routeTo('');setReferenceChips([]);setImages([]);}
  setSelected(receipt.sessionId!);setError('새 세션이 이미 시작되었습니다. 같은 요청을 다시 보내지 마세요.');
 };
 // Read-only recovery (S3-4): on mount, a selection change, reconnect and `online`, ask once for the outcome of what this
 // page (or, after a reload, this controller) left unsettled. Status and `recent` only — never input, never a start.
 const checkOutcomes=async(manual:boolean)=>{
  if(outcomeCheck.current||submissionInFlight.current||startBusy.current||!submissionSupported)return;
  outcomeCheck.current=true;if(manual)setLaunchChecking(true);
  const dismissed=(()=>{try{return readDismissedSubmissions(localStorage);}catch{return new Set<string>();}})();
  try{
   if(launchSupported){
    if(!pendingLaunchesRef.current.length&&recentSupported&&!manual){
     let receipts:WorkroomSubmissionReceipt[];
     try{receipts=(await request({operation:'submission',submission:{phase:'recent'}})).submissions??[];}
     catch(error){
      // A path that cannot parse `recent` (an older forwarding Mac) cannot parse a launch either: plain starts from here.
      if(submissionRequestUnparsed(error)){launchCapability.current='legacy';setLaunchSupported(false);setRecentSupported(false);}
      throw error;
     }
     const recovered=recoveredPendingLaunch(receipts,dismissed);if(recovered&&!pendingLaunchesRef.current.length)rememberLaunch(recovered.id,recovered);}
    // Every unsettled launch of this scope, each with one read-only status.
    for(const pending of [...pendingLaunchesRef.current]){
     if(!/^[A-Za-z0-9_-]{8,160}$/.test(pending.id))continue;
     try{const result=await request({operation:'submission',submission:{phase:'status',id:pending.id}});if(result.submission)await settleLaunch(pending,result.submission,result.session,!manual);}
     catch(error){if(manual)setError(error instanceof Error?error.message:'새 세션 시작 결과를 확인하지 못했습니다.');}
    }
   }
   const sessionId=activeSessionRef.current?.id;
   if(!manual&&sessionId){
    let pending=pendingSubmissionRef.current?.sessionId===sessionId?pendingSubmissionRef.current:null;
    if(!pending&&recentSupported){
     const found=recoveredPendingSubmission((await request({operation:'submission',sessionId,submission:{phase:'recent'}})).submissions??[],dismissed,sessionId);
     if(found&&activeSessionRef.current?.id===sessionId&&!pendingSubmissionRef.current){try{writePendingSubmission(sessionStorage,pendingSubmissionKey(sessionScope,sessionId),found);}catch{/* banner for this page only */}setPendingSubmission(found);pending=found;}
    }
    if(pending&&pending.id!=='unreadable-record'){
     try{const result=await request({operation:'submission',sessionId,submission:{phase:'status',id:pending.id}});if(result.submission&&pendingSubmissionRef.current?.id===pending.id&&!submissionInFlight.current)settleSubmission(pending,result.submission,true);}catch{/* the banner keeps its manual check */}
    }
   }
  }catch{/* automatic checks stay quiet; the banners keep their manual checks */}
  finally{outcomeCheck.current=false;if(manual)setLaunchChecking(false);}
 };
 const checkOutcomesRef=useRef(checkOutcomes);checkOutcomesRef.current=checkOutcomes;
 useEffect(()=>{if(!visible||!submissionSupported)return;void checkOutcomesRef.current(false);},[visible,selected,sessionScope,transport,submissionSupported,launchSupported,recentSupported]);
 const dismissSubmissionRecord=(id:string)=>{try{rememberDismissedSubmission(localStorage,id);}catch{/* storage unavailable: the banner may return after a reload */}};
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
  if(!(await confirmAction(workroomAppConfirmMessage(appAgent,target.label,handoff,references))))return;
  let clipboard:WorkroomAppClipboardState;try{await navigator.clipboard.writeText(handoff);clipboard='copied';}catch{clipboard='failed';}
  setBusy(true);setError('');setNotice('');setRouteReceipt(null);setAppRouteReceipt(null);
  try{
   const result=await requestWorkroomAppDispatch({targetId:target.targetId,agent:appAgent,...(workroomAppTakesTask(appAgent,handoff)?{task:handoff}:{}),...(appAgent==='claude'&&bypassPermissions?{bypass:true}:{})});
   if(!result.ok){setError(workroomAppFailureText(result,clipboard));return;}
   setAppRouteReceipt(workroomAppReceipt({agent:appAgent,targetLabel:target.label,result,clipboard,bypassRequested:bypassPermissions,droppedReferences:references}));
   if(workroomAppTaskKept(result,clipboard)){setTerminalDraft('');setTerminalCursor(0);routeTo('');setReferenceChips([]);setImages([]);}
  }finally{setBusy(false);}
 };
 const deliverTerminalDraft=async()=>{
  if(routeRole==='use'){
   if(!routeTarget)return;
   if(images.length||sessionChips.length){setError('USE 작업에는 첨부파일을 보낼 수 없습니다. 현재 초안과 첨부는 유지했습니다.');return;}
   const useTransport=routeDeviceId?communityMentionRef.current?.workspaceRequester?.(routeDeviceId):memoryTransport;
   if(!useTransport){setError('선택한 기기의 USE 작업 연결을 확인하세요.');return;}
   setUseConversation({project:routeTarget,scope:`use-mention:${sessionScope}:${activeSession?.id??'new'}:${routeDeviceId}:${projectMentionKey(routeTarget)}`,transport:useTransport,draft:terminalDraft});return;
  }
  if(routeApp)return deliverToApp(routeApp);
  const source=activeSession,target=routeTarget,agentChoice=routeAgent,task=draftMessage();
  if(!task.trim()||!source||source.state!=='running'||!target||!agentChoice||busy)return;
  // Attachments name files on this Mac by path; another AgentsToZ would open a different file at that path (S3 review).
  const attachmentRefusal=workroomRouteAttachmentRefusal(images,{crossDevice:!!routeDeviceId,machine:thisMachineLabel()});if(attachmentRefusal){setError(attachmentRefusal);return;}
  // 다른 아젠투지로 보낼 때는 그 기기의 세션 목록과 그 기기의 요청 함수로 **똑같은 전달 절차**를 돈다.
  const crossRequest=routeDeviceId?communityMentionRef.current?.requester(routeDeviceId)??null:null;
  if(routeDeviceId&&!crossRequest){setError('그 기기로 보낼 연결을 확인하지 못했습니다. 기기 목록을 새로 불러온 뒤 다시 시도하세요.');return;}
  if(routeDeviceId&&(deviceSessions?.deviceId!==routeDeviceId||deviceSessions.loading)){setError('그 기기의 작업 세션 목록을 받는 중입니다. 잠시 후 다시 보내세요.');return;}
  if(routeDeviceId&&deviceSessions?.error){setError(deviceSessions.error);return;}
  const crossSessions=routeDeviceId?deviceSessions?.sessions??[]:sessionsRef.current;
  const crossProjects=routeDeviceId?routeDevice?.projects??[]:projects;
  const plan=planWorkroomRoute(crossSessions,routeDeviceId?null:source,target.targetId,agentChoice);
  // Phone attachments are bound to this session's project (w13): refused before any confirm, the draft and chips stay.
  if(plan.kind!=='current'&&remote&&sessionAttach.queue.snapshot().length){setError(REMOTE_ATTACH_ROUTE_REFUSAL);return;}
  if(plan.kind==='current'){sendTerminalDraft();routeTo('');return;}
  const {references,dropped}=liveReferences(task,routeDeviceId);
  // A whole-request submission where the destination advertises it (S3-3). Its unsettled record goes where the
  // receiver's own tab reads it: this panel's scope, or the scope of that device's panel. Images ride a submission
  // from this Mac to itself only, exactly as in the composer.
  const routeScope=routeDeviceId?routeDevice?.sessionScope:sessionScope;
  const routeSubmissionSupported=!!routeScope&&!(images.length&&(remote||!!routeDeviceId))&&(routeDeviceId?deviceSessions?.submission===true:submissionSupported)&&!!usableSessionStorage();
  // Records are read wherever storage reads (w4 review, findings 2 and 3): a receiver's unsettled record refuses the route
  // even when this connection cannot send a submission now — blocked storage has none to read.
  const routeSubmission=routeScope?{supported:routeSubmissionSupported,
   pending:(id:string)=>{const storage=readableSessionStorage();return storage?readPendingSubmission(storage,pendingSubmissionKey(routeScope,id)):null;},
   remember:(id:string,value:PendingWorkroomSubmission|null)=>{writePendingSubmission(sessionStorage,pendingSubmissionKey(routeScope,id),value);if(!routeDeviceId&&activeSessionRef.current?.id===id)setPendingSubmission(value);},
   // A new session's first request rides a launch receipt where the destination takes it (w2-followups #14). Its
   // unsettled record is the launch banner of the receiver's panel: this panel's own, or that device's scope.
   // Records are kept per launch id there: this route writes and clears only its own entry. A device scope needs usable
   // storage for it; without it, today's plain start (finding 3).
   // Storage that cannot keep a new launch record starts plainly, but the readable records there still refuse a new session
   // of the same target and AI first (finding 3), as this panel's own start does.
   ...((routeDeviceId?deviceSessions?.launch===true:launchSupported)?(()=>{
    const pending=routeDeviceId?()=>{const storage=readableSessionStorage();return storage?readPendingLaunches(storage,pendingLaunchKey(routeScope)):[];}:()=>pendingLaunchesRef.current;
    if(!routeLaunchStorage())return {launchRecords:pending};
    return {launch:routeDeviceId?{pending,
     remember:(id:string,value:PendingWorkroomLaunch|null)=>{const key=pendingLaunchKey(routeScope);writePendingLaunches(sessionStorage,key,withPendingLaunch(readPendingLaunches(sessionStorage,key),id,value));}}
     :{pending,remember:rememberLaunch}};
   })():{})}:undefined;
  // The same draft to the same target and AI after an uncertain launch: that launch is checked first, never re-sent.
  const routeKey={draft:terminalDraft,targetId:target.targetId,deviceId:routeDeviceId,agent:agentChoice};
  const earlierLaunchId=[...routeLaunches.current].find(([,entry])=>entry.draft===routeKey.draft&&entry.targetId===routeKey.targetId&&entry.deviceId===routeKey.deviceId&&entry.agent===routeKey.agent)?.[0];
  setBusy(true);setError('');setNotice('');setRouteReceipt(null);
  try{
   const result=await deliverWorkroomRoute({submission:routeSubmission,...(earlierLaunchId?{earlierLaunchId}:{}),
    // A receiver without launch receipts: a failed plain start of this handoff asks before it is sent again (w4 L1).
    ...(routeScope?{legacyStart:{storage:legacyStartStorage(),scope:routeScope,
     onUncertain:(known:readonly string[])=>legacyRouteSuspectStore.add({scope:routeScope,targetId:routeKey.targetId,agent:routeKey.agent,draft:routeKey.draft,label:target.label,knownSessionIds:[...known],at:Date.now()})}}:{}),
    sessions:crossSessions,source,sourceLabel:activeProject?.label??'현재 워크룸',target:{targetId:target.targetId,label:target.label},agent:agentChoice,task,
    ...(routeDeviceId?{crossDevice:{sourceDeviceLabel:deviceName?.trim()||'이 기기'}}:{}),
    references,transport:remote?'relay':'local',bypassPermissions:bypassPermissions&&!routeDeviceId,
    sessionLabel:(list,id)=>workroomSessionLabels(list,targetId=>crossProjects.find(p=>p.targetId===targetId)?.label).get(id),
    request:crossRequest??request,confirm:confirmAction,render:renderScreen,
    receiverBusy:id=>!routeDeviceId&&(closing.current.has(id)||inputPaused.current.has(id)),
    onStarted:session=>{if(routeDeviceId){setDeviceSessions(current=>current&&current.deviceId===routeDeviceId?{...current,sessions:[...current.sessions.filter(item=>item.id!==session.id),session]}:current);return;}
     inventoryEpoch.current++;setSessions(current=>[...current.filter(item=>item.id!==session.id),session]);},
    onProgress:progress=>setRouteReceipt(routeDeviceId?{sessionId:'',text:progress.text}:progress),
   });
   if(result.status==='cancelled')return;
   if(earlierLaunchId)routeLaunches.current.delete(earlierLaunchId);
   if(result.status==='uncertain'&&result.launchId)routeLaunches.current.set(result.launchId,routeKey);
   // 다른 기기의 세션에는 이 화면에서 바로 이동할 수 없다 — 그 기기 탭을 거쳐야 하므로 id를 비운다.
   const dropNote=dropped.length?` 다른 기기의 # 언급(${dropped.map(chip=>chip.label).join(', ')})은 폴더 없이 이름만 전달했습니다.`:'';
   setRouteReceipt({sessionId:routeDeviceId?'':result.receiver?.id??'',text:result.receipt+dropNote});
   // `held`: a new session opened but the message was not typed (it waits on a question): the draft stays.
   // `uncertain`: a submission went out without a written receipt — the draft stays and is never sent again on its own.
   if(result.status==='delivered'){if(routeScope)legacyRouteSuspectStore.clear({scope:routeScope,targetId:routeKey.targetId,agent:routeKey.agent,draft:routeKey.draft});setTerminalDraft('');setTerminalCursor(0);routeTo('');setReferenceChips([]);setImages([]);}
  }catch(deliveryError){
   setRouteReceipt(null);
   // A receiver that advertised submission but refused it before anything ran: the next send to it goes the old way.
   // A path that could not parse a launch ran nothing: only new sessions go back to a plain `start`.
   if(deliveryError instanceof WorkroomLaunchUnsupportedError){
    if(routeDeviceId)setDeviceSessions(current=>current&&current.deviceId===routeDeviceId?{...current,launch:false}:current);
    else{launchCapability.current='legacy';setLaunchSupported(false);setRecentSupported(false);}
   }
   if(deliveryError instanceof WorkroomSubmissionUnsupportedError){
    if(routeDeviceId)setDeviceSessions(current=>current&&current.deviceId===routeDeviceId?{...current,submission:false}:current);
    else{submissionCapability.current='legacy';setSubmissionSupported(false);}
   }
   setError(deliveryError instanceof Error?deliveryError.message:String(deliveryError));}
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
 // The phone's 「새 작업」 sheet (w11, S4.5). Anything that opens the request box there — an entry carrying a request, 세션
 // 기억하기…, a memory review — opens the sheet; closing it keeps the draft. Starting opens the new session full screen (w7),
 // which closes the sheet; leaving the Workroom closes it too.
 const newTaskShown=fullscreen&&newTaskOpen&&paneShown;
 // Files dropped on the phone's composers (w13: an iPad dragging from Files or Photos, a desktop browser): the session view
 // and the inline command box feed the session's queue, the sheet and the inline request box the new task's.
 const inlineCommand=useRef<HTMLDivElement>(null),inlinePrompt=useRef<HTMLDivElement>(null);
 const sessionRunning=activeSession?.state==='running';
 const viewDrop=useRemoteAttachDrop(viewRoot,sessionAttach,remoteAttachOn&&viewShown&&sessionRunning);
 const sheetDrop=useRemoteAttachDrop(sheetRoot,sheetAttach,remoteAttachOn&&newTaskShown);
 const inlineCommandDrop=useRemoteAttachDrop(inlineCommand,sessionAttach,remoteAttachOn&&!fullscreen&&sessionRunning);
 const inlinePromptDrop=useRemoteAttachDrop(inlinePrompt,sheetAttach,remoteAttachOn&&!fullscreen&&composerShown);
 // Opening the sheet is a choice made after the page loaded: the pending reload restore no longer applies (w11 review).
 const openNewTask=()=>{restoreChecked.current=true;const active=typeof document==='undefined'?null:document.activeElement;sheetOpener.current=active instanceof HTMLElement?active:null;setNewTaskHelp(false);setNewTaskOpen(true);};
 const closeNewTask=()=>{setNewTaskOpen(false);setComposerOpen(false);const opener=sheetOpener.current;sheetOpener.current=null;
  requestAnimationFrame(()=>{(opener?.isConnected?opener:panel.current?.querySelector<HTMLElement>('[data-testid="workroom-new-task"]'))?.focus();});};
 useEffect(()=>{if(fullscreen&&composerOpen&&!sessionViewRef.current)setNewTaskOpen(true);},[fullscreen,composerOpen]);
 useEffect(()=>{if(!fullscreen||!paneShown)setNewTaskOpen(false);},[fullscreen,paneShown]);
 // The sheet's one history entry (w11 review), like the session view's: the web portal's browser back (Safari's edge swipe)
 // closes the sheet — the draft stays — instead of leaving 원격 작업; forward reopens it. Closed any other way (「닫기」,
 // Escape, a pane change, unmount) its entry is popped a turn later, so a StrictMode remount keeps it. Starting replaces it
 // with the session view's (openSessionView).
 const sheetToken=useRef('');if(!sheetToken.current)sheetToken.current=newWorkroomSessionViewToken();
 const sheetBacks=useRef(0);const newTaskShownRef=useRef(false);newTaskShownRef.current=newTaskShown;
 useEffect(()=>{
  if(!newTaskShown)return;
  try{if(!isWorkroomNewTaskState(history.state))history.pushState(withWorkroomNewTask(history.state,sheetToken.current),'');}catch{/* no history: 「닫기」 still closes it */}
  return()=>{setTimeout(()=>{if(mounted.current&&newTaskShownRef.current)return;try{if(isWorkroomNewTaskState(history.state)){sheetBacks.current++;history.back();}}catch{/* no history */}},0);};
 },[newTaskShown]);
 useEffect(()=>{
  if(!fullscreen)return;sheetBacks.current=0;
  const onPop=()=>{
   let state:unknown=null;try{state=history.state;}catch{/* no history */}
   const sheetEntry=isWorkroomNewTaskState(state);
   if(sheetBacks.current>0){sheetBacks.current--;
    // Opened again before this panel's own back arrived: the open sheet gets its entry back.
    if(newTaskShownRef.current&&!sheetEntry){try{history.pushState(withWorkroomNewTask(state,sheetToken.current),'');}catch{/* no history */}}
    return;}
   if(newTaskShownRef.current){if(!sheetEntry){setNewTaskOpen(false);setComposerOpen(false);}return;}
   if(!sheetEntry||sessionViewRef.current)return;
   // Forward onto the sheet's entry: the sheet opens on it; with the Workroom not on screen the entry is stepped over.
   if(paneShownRef.current){restoreChecked.current=true;setNewTaskHelp(false);setNewTaskOpen(true);}
   else{sheetBacks.current++;try{history.back();}catch{sheetBacks.current--;}}
  };
  window.addEventListener('popstate',onPop);
  // A sheet entry an earlier load left (a reload with the sheet open): its list entry is the one before it.
  const timer=setTimeout(()=>{if(newTaskShownRef.current)return;try{if(!isStaleWorkroomNewTaskState(history.state))return;if(history.length>1){sheetBacks.current++;history.back();}else history.replaceState(withoutWorkroomNewTask(history.state),'');}catch{/* no history */}},0);
  return()=>{window.removeEventListener('popstate',onPop);clearTimeout(timer);};
 },[fullscreen]);
 // Like the session view: focus moves in (not to the request box, so the keyboard stays down), the sheet covers the visual
 // viewport (an iOS keyboard shrinks it and the start button stays above the keyboard), and the page behind does not scroll.
 useEffect(()=>{
  if(!newTaskShown)return;const viewport=window.visualViewport;const root=document.documentElement;
  const update=()=>{const sheet=sheetRoot.current;if(!sheet)return;sheet.style.setProperty('--workroom-view-height',`${viewport?.height??window.innerHeight}px`);sheet.style.setProperty('--workroom-view-top',`${viewport?.offsetTop??0}px`);};
  update();viewport?.addEventListener('resize',update);viewport?.addEventListener('scroll',update);window.addEventListener('resize',update);
  root.dataset.workroomSheet='open';
  const frame=requestAnimationFrame(()=>{const sheet=sheetRoot.current;if(sheet&&!sheet.contains(document.activeElement))sheet.focus({preventScroll:true});});
  return()=>{cancelAnimationFrame(frame);viewport?.removeEventListener('resize',update);viewport?.removeEventListener('scroll',update);window.removeEventListener('resize',update);delete root.dataset.workroomSheet;};
 },[newTaskShown]);
 const memoryStatus=!remote?<TerminalMemoryStatus visible={visible} projects={projects} observationTargetId={activeSession?.targetId||target||undefined} onReview={reviewMemory} onManageProject={onManageProject}/>:null;
 const errorLine=<>{(error||connectionError||readError)&&<p role="alert" className="ai-terminal-error ai-terminal-launch-error">{error||connectionError||readError}<ErrorVocActions message={error||connectionError||readError} surface="workroom"/></p>}</>;
 const noticeLine=<>{notice&&!error&&<p className="ai-terminal-caption ai-terminal-route-receipt" role="status" data-testid="workroom-notice"><span>{notice}</span><button type="button" className="ai-terminal-btn ai-terminal-btn--icon" aria-label="알림 닫기" onClick={()=>setNotice('')}>×</button></p>}</>;
 // The pieces of an open session. The Mac and a desktop browser show them beside the session list in the order they
 // always had; the phone's full-screen view (w7) docks the composer and the keys at the bottom and puts the rest under
 // the terminal, one scroll away.
 const viewSwitchable=sessions.filter(s=>s.state==='running'||s.id===selected);
 // 「보내는 중…」 for a submission merely in flight (w11, S4.3) — the phone's; see `recovery`.
 const sendingShown=fullscreen&&!!sendingId&&pendingSubmission?.id===sendingId;
 const effortSettings=<WorkroomSettings onOpen={()=>refreshEffort(0)}><WorkroomEffortOption state={effort.state} onChange={effort.set} remote={remote} deviceName={deviceName} readOnly={effortReadOnly}/></WorkroomSettings>;
 const part=(()=>{if(!activeSession)return null;const docked=viewShown;return {
  viewControls:<div className="ai-terminal-view-controls" role="group" aria-label="터미널 보기">
    {effortSettings}
    <button type="button" className="ai-terminal-btn ai-terminal-btn--icon" data-testid="workroom-font-decrease" aria-label="글자 작게" title="글자 작게" disabled={fontSize<=WORKROOM_FONT_MIN} onClick={()=>{chooseFontSize(-1);restoreWorkroomKeyboard()}}>A−</button>
    <button type="button" className="ai-terminal-btn ai-terminal-font-size" data-testid="workroom-font-size" aria-label={`글자 크기 ${fontSize} · 누르면 기본값`} title="누르면 기본 크기(13)로" onClick={()=>{setFontSize(WORKROOM_FONT_DEFAULT);restoreWorkroomKeyboard()}}>{fontSize}</button>
    <button type="button" className="ai-terminal-btn ai-terminal-btn--icon" data-testid="workroom-font-increase" aria-label="글자 크게" title="글자 크게" disabled={fontSize>=WORKROOM_FONT_MAX} onClick={()=>{chooseFontSize(1);restoreWorkroomKeyboard()}}>A+</button>
    {!remote&&!popout&&<button type="button" className="ai-terminal-btn" data-testid="workroom-wide-toggle" aria-pressed={wide} title={wide?'사이드바와 설정을 다시 표시':'사이드바와 설정을 숨기고 터미널을 화면 가득'} onClick={()=>{setWide(value=>!value);restoreWorkroomKeyboard()}}>{wide?<Minimize2 size={13}/>:<Maximize2 size={13}/>}{wide?'기본 보기':'넓게 보기'}</button>}
    {!remote&&<button type="button" className="ai-terminal-btn" data-testid="workroom-restart" disabled={busy} title={workroomRestartTitle(activeSession.state)} onClick={()=>void restart()}><RotateCcw size={13}/>다시 시작</button>}
    {remote&&<button type="button" className="ai-terminal-btn" data-testid="workroom-readable-toggle" aria-pressed={readableMode} onClick={()=>{readableStick.current=true;setReadableMode(value=>!value);restoreWorkroomKeyboard()}}>{readableMode?'원본 터미널':'읽기 보기'}</button>}
    {!remote&&<button type="button" className="ai-terminal-btn" data-testid="workroom-popout" aria-disabled={!popoutAvailability.available} data-available={popoutAvailability.available?'true':'false'} title={popoutAvailability.reason} onClick={()=>void popOut()}><ExternalLink size={13}/>새 창으로 분리</button>}
    </div>,
  restartLine:<>{restartNotice&&restartNotice.sessionId===activeSession.id&&<p className="ai-terminal-caption ai-terminal-route-receipt" role="status" data-testid="workroom-restart-notice"><span>{restartNotice.text}</span><button type="button" className="ai-terminal-btn ai-terminal-btn--icon" aria-label="다시 시작 알림 닫기" onClick={()=>setRestartNotice(null)}>×</button></p>}</>,
  surface:<div className={`ai-terminal-surface${remote?' ai-terminal-surface--remote':''}`} onClick={()=>{if(!rawInput&&!readableMode)terminalComposer.current?.focus()}}><div ref={host} className="ai-terminal-screen" aria-hidden={remote&&readableMode}/>{remote&&readableMode&&<pre ref={readableRef} className="ai-terminal-readable" data-testid="workroom-readable-screen" role="region" aria-label="화면 너비에 맞춘 터미널 출력" style={{fontSize}}
   onScroll={event=>{const el=event.currentTarget,near=el.scrollTop+el.clientHeight>=el.scrollHeight-40;readableStick.current=near;if(near)setReadablePill(false);}}>{readableScreen||'화면을 불러오는 중…'}</pre>}
   {remote&&readableMode&&readablePill&&<button type="button" className="ai-terminal-btn ai-terminal-readable-pill" data-testid="workroom-readable-new-output" onClick={event=>{event.stopPropagation();const el=readableRef.current;readableStick.current=true;setReadablePill(false);if(el)el.scrollTop=el.scrollHeight;}}>새 출력 ↓</button>}</div>,
  exitedHint:<>{activeSession.state==='exited'&&<p className="ai-terminal-hint" role="status" data-testid="workroom-exited-hint">터미널이 종료되었습니다 (종료 코드 {activeSession.exitCode??'확인 중'}). 입력칸은 실행 중인 세션에만 있습니다. 마지막 화면에서 종료 이유를 확인하고, {remote?(docked?'「← 워크룸」 목록에서 새 작업을 시작할 수 있습니다':'위 설정에서 새 작업을 시작할 수 있습니다'):'위 「다시 시작」으로 같은 프로젝트·AI를 다시 열 수 있습니다(Claude Code·Codex는 이전 대화를 이어서)'}. 마지막 출력과 세션 저장 기록은 유지됩니다.</p>}</>,
  dismiss:<>{activeSession.state==='exited'&&<button data-testid="workroom-dismiss-session" className="ai-terminal-btn" onClick={()=>{setDismissed(ids=>[...ids.filter(id=>id!==selected),selected].slice(-24));setSelected('')}}>종료된 세션 목록에서 제거</button>}</>,
  exitedQueue:<>{/* No composer here: while keeping is on, the kept requests of this scope stay reachable (check, delete) instead of waiting out their 7 days. Off, nothing is kept, so nothing shows. */}
   {activeSession.state==='exited'&&submissionSupported&&draftVault.enabled&&<WorkroomDraftQueue state={draftVault} scope={draftVaultScope} sessionId={null} blocked canQueue={false} composerEmpty={false}
    onQueue={queueCurrentDraft} onSend={sendQueuedDraftItem} onTakeBack={takeBackQueuedDraft} onCheck={checkKeptDraftItem}/>}</>,
  usage:<><b>@ 호출</b> 다른 프로젝트 AI에게 맡기기 · <b># 언급</b> 참고로 보여 주기(여러 개){!!communityDevices.length&&<> · 기호 앞에 <b>기기 이름</b>을 적으면 그 아젠투지의 프로젝트</>}</>,
  commandChips:<>{routeTarget&&<button type="button" className="ai-terminal-route-chip" data-testid="workroom-route-chip" onClick={()=>routeTo('')}>@ 호출 · {routeTarget.label} ×</button>}
     {routeTarget&&routeChoiceValue&&<label className="ai-terminal-route-agent" title={appRoutesAvailable?'그 프로젝트의 워크룸 CLI에 보내거나, 이 Mac의 앱(Codex·Claude·Hermes·Antigravity)으로 넘깁니다':'그 프로젝트에서 이 일을 받을 AI'}><span>{appRoutesAvailable?'받는 곳':'받는 AI'}</span><select aria-label={appRoutesAvailable?'받는 곳':'받는 AI'} data-testid="workroom-route-agent" data-route-surface={routeApp?'app':'cli'} value={routeChoiceValue} disabled={busy} onChange={e=>setRouteAgentChoice(e.target.value as WorkroomRouteChoice)} className="ai-terminal-select">{appRoutesAvailable?<><optgroup label="워크룸 CLI">{AI_TERMINAL_AGENTS.map(a=><option key={a} value={a}>{WORKROOM_AGENT_NAMES[a]}</option>)}</optgroup><optgroup label="앱">{WORKROOM_APP_AGENTS.map(a=><option key={a} value={workroomAppChoice(a)}>{WORKROOM_APP_NAMES[a]}</option>)}</optgroup></>:AI_TERMINAL_AGENTS.map(a=><option key={a} value={a}>{WORKROOM_AGENT_NAMES[a]}</option>)}</select></label>}
     {referenceChips.map(chip=><button type="button" key={chip.token} className="ai-terminal-route-chip ai-terminal-reference-chip" data-testid="workroom-reference-chip" title={chip.deviceId?'다른 아젠투지의 프로젝트입니다. 그 기기로 보낼 때만 폴더까지 함께 전달됩니다.':'AI가 이 프로젝트 폴더를 읽어서 참고합니다. 수정은 현재 프로젝트에서만 합니다.'} onClick={()=>setReferenceChips(chips=>chips.filter(item=>item.token!==chip.token))}># 언급 · {chip.deviceId?`${communityDevices.find(device=>device.deviceId===chip.deviceId)?.label??'다른 기기'} · ${chip.label}`:chip.label} ×</button>)}</>,
  // An honest sending state (w11, S4.3): a submission merely in flight says so; the banner is for an unknown outcome only —
  // a lost answer, a timeout, an unsettled receipt, a record found on load.
  // Phone only (the w11 brief keeps the Mac, its pop-out and a desktop browser as they were): there the banner still stands
  // for the whole submission, in flight or not, with its plain buttons.
  recovery:<>{sendingShown&&pendingSubmission?.sessionId===activeSession.id&&<p className="ai-terminal-hint" role="status" data-testid="workroom-submission-sending">보내는 중…</p>}
   {pendingSubmission?.sessionId===activeSession.id&&!sendingShown&&<div className="ai-terminal-hint" role="status" data-testid="workroom-submission-recovery"><p>{pendingSubmission.receipt?.state==='written'?'요청 전체를 전달했습니다. 터미널에서 AI의 응답을 확인하세요.':'앞서 보낸 요청의 전송 결과를 확인해야 합니다. 작성 내용은 유지하며 자동으로 다시 보내지 않습니다.'}</p><button type="button" className={fullscreen?'ai-terminal-btn':undefined} disabled={submissionBusy} onClick={()=>void inspectPendingSubmission()}>제출 결과 확인</button><button type="button" className={fullscreen?'ai-terminal-btn':undefined} disabled={submissionBusy} onClick={async ()=>{if(!(await confirmAction('터미널에서 앞선 요청의 결과를 확인하셨나요? 같은 내용을 다시 보내면 중복 실행될 수 있습니다. 작성 내용은 유지합니다.')))return;try{dismissSubmissionRecord(pendingSubmission.id);writePendingSubmission(sessionStorage,pendingSubmissionKey(sessionScope,pendingSubmission.sessionId),null);setPendingSubmission(null);}catch{setError('제출 확인 기록을 정리하지 못했습니다.');}}}>터미널 결과 확인했음</button></div>}</>,
  submissionHint:<>{submissionSupported&&<p className="ai-terminal-hint">관련된 교정·실패 기록을 함께 전달합니다. 전송 결과가 확인되지 않으면 작성 내용을 유지합니다.</p>}</>,
  draftQueue:<>{submissionSupported&&<WorkroomDraftQueue state={draftVault} scope={draftVaultScope} sessionId={activeSession.id} blocked={busy||submissionBusy||pendingSubmission?.sessionId===activeSession.id}
     canQueue={!busy&&!routeTargetId&&!!terminalDraft.trim()&&!(images.length&&remote)&&!sessionChips.length} composerEmpty={!terminalDraft.trim()} onQueue={queueCurrentDraft} onSend={sendQueuedDraftItem} onTakeBack={takeBackQueuedDraft} onCheck={checkKeptDraftItem}/>}</>,
  commandField:<div className={`ai-terminal-command-field${remoteAttachOn?' ai-terminal-command-field--attach':''}`}>
     {remoteAttachOn&&<RemoteAttachMenuButton attach={sessionAttach} disabled={busy||activeSession.state!=='running'}/>}
     <textarea ref={terminalComposer} aria-label="워크룸 입력" value={terminalDraft} disabled={busy} rows={docked?1:2} maxLength={20000} placeholder={docked?(activeSession.agent==='codex'?'요청 · / 명령 · $ 스킬':'요청 · @ 호출 · # 언급'):activeSession.agent==='codex'?'요청 · CLI 명령 / · 설치된 스킬 $ · @ 호출 · # 언급':remote?'한글·명령·요청 입력 · @ 호출 · # 언급':`한글·명령·요청 입력 · @ 호출 · # 언급 · ${workroomComposerAttachCopy().placeholder}`}
      onPaste={event=>{if(!remote)attach.paste(event);}}
      onChange={event=>{setTerminalDraft(event.target.value);setTerminalCursor(event.target.selectionStart??event.target.value.length)}}
      onSelect={event=>setTerminalCursor(event.currentTarget.selectionStart??event.currentTarget.value.length)}
      onKeyDown={event=>{if(event.nativeEvent.isComposing||event.keyCode===229)return;
        // The CLI's keys work from here too (NHCS draftKeyToCli, src/workroomComposerKeys.ts): arrows, Tab, Enter… while the box is empty.
        const cliKey=workroomComposerKeyToCli(event.key,{ctrl:event.ctrlKey,meta:event.metaKey,alt:event.altKey,shift:event.shiftKey},{empty:!terminalDraft.trim()&&!images.length&&!sessionChips.length&&!routeTarget,appCursor:!!terminal.current?.modes.applicationCursorKeysMode,menuOpen:!!slashCandidates.length||!!mentionCandidates.length,repeat:event.repeat});
        if(cliKey&&sendBoundInput(cliKey)){event.preventDefault();return;}
        if(event.key==='Tab'&&slashCandidates.length){event.preventDefault();completeSlash(slashCandidates[0]!.command);return;}if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();const exact=slashCandidates.some(c=>c.command===terminalDraft.trim());if(slashCandidates.length&&!exact&&!routeTarget){runSlashCommand(slashCandidates[0]!.command);setTerminalDraft('');setTerminalCursor(0);return;}if(routeTarget)void deliverTerminalDraft();else sendTerminalDraft();}}}/>
     <button type="button" className="ai-terminal-btn ai-terminal-start" disabled={busy||imageBusy||submissionBusy||remote&&sessionAttachMoving||!!routeTargetId&&!routeTarget||!routeTarget&&pendingSubmission?.sessionId===activeSession.id||(routeRole!=='use'&&!terminalDraft.trim()&&!images.length&&!sessionAttachReady)} onClick={()=>routeTarget?void deliverTerminalDraft():sendTerminalDraft()}><Send size={13}/>{remote&&sessionAttachMoving?sessionAttachLabel:routeTarget?(routeRole==='use'?'USE 대화 열기':routeApp?workroomAppSendLabel(routeApp,workroomDeliveryInstruction({task:draftMessage(),sourceLabel:activeProject?.label??'현재 워크룸',sourceAgentLabel:WORKROOM_AGENT_NAMES[activeSession.agent],targetLabel:routeTarget.label})):routeDeviceId?`${routeDevice?.label??'다른 아젠투지'}에 전달`:'프로젝트에 전달'):fullscreen&&sendingId?'보내는 중…':submissionBusy?'요청 전송 확인 중':'현재 세션에 전송'}</button>
    </div>,
  // The phone's chips (w13): above the field, in the dock and inline alike.
  remoteChips:<>{remoteAttachOn&&<RemoteAttachChips attach={sessionAttach} focusComposer={()=>terminalComposer.current?.focus()}/>}</>,
  images:<>{!remote&&<WorkroomAttachBar attach={attach} attachments={images} busy={imageBusy} disabled={busy} panel={panel} rawInput={rawInput} session={activeSession} focusComposer={()=>terminalComposer.current?.focus()}/>}</>,
  voiceReceipt:<VoiceSentReceipt sessionId={activeSession.id}/>,
  appPlan:<>{routeTarget&&routeApp&&<p className="ai-terminal-hint" data-testid="workroom-route-plan" data-route-plan="app">{workroomAppRoutePreview(routeApp,routeTarget.label,workroomDeliveryInstruction({task:draftMessage(),sourceLabel:activeProject?.label??'현재 워크룸',sourceAgentLabel:WORKROOM_AGENT_NAMES[activeSession.agent],targetLabel:routeTarget.label}),liveReferences(draftMessage(),'').references.length)}{bypassPermissions&&routeApp!=='claude'?' 권한 우회는 Claude 앱에만 적용됩니다.':''}</p>}</>,
  appReceipt:<>{appRouteReceipt&&<p className="ai-terminal-caption ai-terminal-route-receipt" role="status" data-testid="workroom-app-route-receipt"><span>{appRouteReceipt}</span><button type="button" className="ai-terminal-btn ai-terminal-btn--icon" aria-label="앱 전달 알림 닫기" onClick={()=>setAppRouteReceipt(null)}>×</button></p>}</>,
  routePlan:<>{routeRole==='use'&&(routeTarget?<p className="ai-terminal-hint" data-testid="workroom-use-route-plan">{routeTarget.label}의 제품 운영 대화에서 허용된 앱 도구를 선택합니다.</p>:<p role="alert" data-testid="workroom-use-unavailable">선택한 USE 호출 대상의 활성화·연결 상태를 다시 확인하세요.</p>)}{routeTarget&&routeAgent&&routePlan&&<p className="ai-terminal-hint" data-testid="workroom-route-plan" data-route-plan={routePlan.kind}>{workroomRoutePreview(routePlan.kind,routeTarget.label,WORKROOM_AGENT_NAMES[routeAgent],{sessionLabel:routePlan.kind==='deliver'?sessionLabels.get(routePlan.session.id):undefined,typed:routeStartTyped})}</p>}</>,
  routeReceipt:<>{routeReceipt&&<p className="ai-terminal-caption ai-terminal-route-receipt" role="status" data-testid="workroom-route-receipt"><span>{routeReceipt.text}</span>{sessions.some(s=>s.id===routeReceipt.sessionId)&&<button type="button" className="ai-terminal-btn" data-testid="workroom-route-jump" onClick={()=>{const id=routeReceipt.sessionId;selectionGeneration.current++;setError('');setSelected(id);}}>그 세션으로 이동</button>}<button type="button" className="ai-terminal-btn ai-terminal-btn--icon" aria-label="전달 알림 닫기" onClick={()=>setRouteReceipt(null)}>×</button></p>}</>,
  mentionMenu:<>{(!!mentionCandidates.length||!!mention?.device)&&<div className="ai-terminal-mention-menu" role="listbox" aria-label={mentionKind==='reference'?'언급할 프로젝트 선택':'호출할 프로젝트 선택'} data-testid="workroom-mention-menu" data-mention-device={mention?.device?.label??''}>
     {!!mention?.device&&<p className="ai-terminal-hint" data-testid="workroom-mention-device">{mention.device.label}의 프로젝트</p>}
     {mentionCandidates.map(project=><button type="button" role="option" key={(mention?.device?.deviceId??'')+':'+projectMentionKey(project)} onClick={()=>chooseMention(project)}>{mentionKind==='reference'?<Hash size={12}/>:<AtSign size={12}/>}<span>{project.label}</span>{!mention?.device&&project.targetId===activeSession.targetId&&project.executionRole!=='use'&&<small>현재</small>}<small>{project.executionRole==='use'?'USE · ':''}{mentionKind==='reference'?'참고':'받는 곳'}</small></button>)}
     {mention?.loading&&<p className="ai-terminal-hint" data-testid="workroom-mention-loading">{mention.device?.label}의 프로젝트 목록을 받고 있습니다…</p>}
     {!!mention?.error&&<p className="ai-terminal-hint ai-terminal-hint--error" role="alert" data-testid="workroom-mention-error">{mention.error}</p>}
     {!mention?.loading&&!mention?.error&&!mentionCandidates.length&&<p className="ai-terminal-hint" data-testid="workroom-mention-empty">이름과 맞는 프로젝트가 없습니다.{mention?.hasMore?' 그 기기의 목록 일부만 받았습니다 — 「기기」에서 그 아젠투지를 골라 목록을 더 불러올 수 있습니다.':''}</p>}
     {!!mention?.hasMore&&!!mentionCandidates.length&&<p className="ai-terminal-hint" data-testid="workroom-mention-partial">그 기기의 목록 일부만 받았습니다.</p>}
    </div>}</>,
  slashMenu:<>{!!slashCandidates.length&&<div className="ai-terminal-mention-menu ai-terminal-slash-menu" role="listbox" aria-label="CLI 명령과 스킬">{slashCandidates.map(c=><div key={c.command} className="ai-terminal-slash-option"><button type="button" role="option" onClick={()=>completeSlash(c.command)}><span>{c.command}</span><small>{c.description}</small></button><button type="button" className="ai-terminal-slash-star" aria-pressed={slashFavorites.includes(c.command)} aria-label={`${c.command} 즐겨찾기${slashFavorites.includes(c.command)?' 해제':' 추가'}`} onClick={()=>toggleFavorite(c.command)}>{slashFavorites.includes(c.command)?'★':'☆'}</button></div>)}<p className="ai-terminal-hint">Tab 완성 · Enter 바로 실행 · 목록에 없는 명령도 그대로 입력해 보낼 수 있습니다.</p></div>}</>,
  refsUnsupported:<>{!referencesSupported&&referenceChips.length>0&&<p className="ai-terminal-hint" role="status">이 Mac 버전은 # 참고를 지원하지 않아 프로젝트 이름만 전달됩니다. Mac 앱을 업데이트하면 폴더까지 함께 전달됩니다.</p>}</>,
  crossDevice:<>{!!routeDeviceId&&referenceChips.some(chip=>chip.deviceId!==routeDeviceId)&&<p className="ai-terminal-hint" role="status" data-testid="workroom-reference-cross-device">받는 기기와 다른 아젠투지의 # 언급은 폴더 없이 이름만 전달됩니다 — 폴더는 받는 쪽 Mac만 열 수 있습니다.</p>}</>,
  deviceLoading:<>{!!routeDeviceId&&deviceSessions?.deviceId===routeDeviceId&&deviceSessions.loading&&<p className="ai-terminal-hint" role="status" data-testid="workroom-route-device-loading">{routeDevice?.label}의 작업 세션 목록을 받고 있습니다…</p>}</>,
  deviceError:<>{!!routeDeviceId&&deviceSessions?.deviceId===routeDeviceId&&!!deviceSessions.error&&<p className="ai-terminal-hint ai-terminal-hint--error" role="alert" data-testid="workroom-route-device-error">{deviceSessions.error}</p>}</>,
  natural:<>{!routeTarget&&!!naturalTargets.length&&<div className="ai-terminal-natural-targets"><span>전달 대상 확인</span>{naturalTargets.map(project=><button type="button" key={projectMentionKey(project)} onClick={()=>routeTo(project.targetId,'',project.executionRole,project.serviceKey)}>‘{project.label}’ 선택</button>)}</div>}</>,
  imeHint:<p className="ai-terminal-hint">{popout?'Enter 전송 · Shift+Enter 줄바꿈 · 빈 칸의 방향키·Tab은 AI로 전달 · Esc 취소 · Ctrl+C 중단':<>이 입력창은 macOS·iPhone의 한글 IME가 조합을 끝낸 문자열만 네 AI에 전달합니다. Shift+Enter는 줄바꿈입니다. {WORKROOM_COMPOSER_KEYS_HINT}{!remote&&workroomComposerAttachCopy().composerNote}</>}</p>,
  slashBar:<>{activeSession.state==='running'&&<div className="ai-terminal-slash-bar" data-testid="workroom-slash-bar" aria-label="슬래시 명령 즐겨찾기">
    {slashFavorites.map(command=><button type="button" key={command} className="ai-terminal-key ai-terminal-slash-favorite" disabled={busy} title={`${command} 실행`} onClick={()=>runSlashCommand(command)}>{command}</button>)}
    <button type="button" className="ai-terminal-key" data-testid="workroom-slash-pad-toggle" aria-expanded={slashPadOpen} onClick={()=>{setSlashPadOpen(open=>!open);restoreWorkroomKeyboard()}}>{slashPadOpen?'명령 모음 닫기':activeSession.agent==='codex'?'/ 명령 · $ 스킬':'/ 명령 모음'}</button>
   </div>}</>,
  slashPad:<>{activeSession.state==='running'&&slashPadOpen&&<div className="ai-terminal-slash-pad" data-testid="workroom-slash-pad" role="group" aria-label="CLI 명령과 스킬 모음">
    {activeSession.agent==='codex'&&<p className="ai-terminal-hint ai-terminal-slash-guide">Codex CLI 명령은 /, 설치된 스킬 호출은 $를 사용합니다. 아래 버튼은 표시된 그대로 터미널에 입력합니다.</p>}
    {[...WORKROOM_SLASH_COMMANDS[activeSession.agent],...slashFavorites.filter(command=>!WORKROOM_SLASH_COMMANDS[activeSession.agent].some(c=>c.command===command)).map(command=>({command,description:'직접 추가'}))].map(c=><div key={c.command} className="ai-terminal-slash-tile">
     <button type="button" disabled={busy} onClick={()=>{runSlashCommand(c.command);setSlashPadOpen(false);}}><strong>{c.command}</strong><small>{c.description}</small></button>
     <button type="button" className="ai-terminal-slash-star" aria-pressed={slashFavorites.includes(c.command)} aria-label={`${c.command} 즐겨찾기${slashFavorites.includes(c.command)?' 해제':' 추가'}`} onClick={()=>{toggleFavorite(c.command);restoreWorkroomKeyboard()}}>{slashFavorites.includes(c.command)?'★':'☆'}</button>
    </div>)}
    {addingSlash?<form className="ai-terminal-slash-custom" onSubmit={event=>{event.preventDefault();addCustomFavorite();}}><label htmlFor={promptId+'-custom-slash'}>추가할 {activeSession.agent==='codex'?'CLI 명령 또는 스킬':'슬래시 명령'}</label><input id={promptId+'-custom-slash'} autoFocus value={customSlash} onChange={event=>setCustomSlash(event.target.value)} placeholder={activeSession.agent==='codex'?'/model 또는 $remember-session':'/cs-ceo:goal'} maxLength={41}/><button type="submit" className="ai-terminal-btn">추가</button><button type="button" className="ai-terminal-btn" onClick={()=>{setAddingSlash(false);setCustomSlash('');}}>취소</button></form>:<button type="button" className="ai-terminal-slash-tile ai-terminal-slash-add" onClick={()=>setAddingSlash(true)}>+ 직접 추가</button>}
    <p className="ai-terminal-hint">누르면 바로 실행 · ☆로 위 줄에 고정 · 즐겨찾기는 이 기기에서 CLI별로 저장됩니다.</p>
   </div>}</>,
  keys:<WorkroomTerminalKeys sessionId={activeSession.id} disabled={activeSession.state!=='running'||busy} rawInputDisabled={activeSession.state!=='running'} rawInput={rawInput} onToggleRaw={()=>{const next=!rawInput;rawInputRef.current=next;setRawInput(next);requestAnimationFrame(()=>next?terminal.current?.focus():terminalComposer.current?.focus());}} onSend={sendToolbarInput} appCursor={()=>!!terminal.current?.modes.applicationCursorKeysMode}/>,
  shell:<>{!remote&&<WorkroomSharedShellPanel key={'shell:'+activeSession.id} session={activeSession} visible={visible}/>}</>,
  footer:<WorkroomSessionFooter key={sessionScope+':'+activeSession.id} session={activeSession} usageReadable={!remote} cliInfo={cliInfo}
   effortBadge={<WorkroomEffortBadge session={effortRecord}/>} effortAdvice={<WorkroomEffortAdvice session={effortRecord}/>} modelCommands={WORKROOM_MODEL_COMMANDS[activeSession.agent]} onCommand={runSlashCommand} onReturnFocus={restoreWorkroomKeyboard} visible={visible} transport={memoryTransport} contextUsed={contextUsed} scope={sessionScope} onClose={close} onPause={pauseForSave}/>,
 };})();
 // The launch controls, shared by the inline header (the Mac, a desktop browser) and the phone's 「새 작업」 sheet (w11).
 const headTitle=<><h2 className="ai-terminal-title">워크룸 <span className="ai-terminal-hint">AI 터미널</span></h2>{!activeSession&&effortSettings}</>;
 const contextActions=<div className="ai-terminal-context-actions">
   {!remote&&onManageProject&&activeProject&&<button className="ai-terminal-btn" title={activeProject.label} onClick={()=>onManageProject(('projectTargetId' in activeProject ? activeProject.projectTargetId as string : undefined)??activeProject.targetId)}>프로젝트·장기기억</button>}
   {/* A pop-out has no app to hand the request to, so it opens the same draft inside this window. */}
   {!remote&&(onRememberSession||popout||memoryCommand)&&activeProject&&<button data-testid="workroom-remember-session" disabled={!memoryCommand&&!onRememberSession&&busy} className="ai-terminal-btn" title={memoryCommand?`실행 중인 이 세션에 ${memoryCommand}를 입력하고 Enter까지 보냅니다.`:'작성칸에 저장 요청 초안을 넣습니다. 전송은 직접 누르세요.'} onClick={()=>{if(memoryCommand){runSlashCommand(memoryCommand);return;}if(onRememberSession)onRememberSession(activeProject.targetId);else remoteMemoryDraft();}}>{memoryCommand?'이 세션에서 기억하기':'세션 기억하기…'}</button>}
   {remote&&activeProject&&<button data-testid="workroom-remote-remember-session" disabled={busy} className="ai-terminal-btn" onClick={()=>onRememberSession?onRememberSession(activeProject!.targetId):remoteMemoryDraft()}>세션 기억하기…</button>}
   {onWhatISaid&&<button className="ai-terminal-btn" onClick={onWhatISaid}>내가 한 말</button>}
  </div>;
 const launchOptions=<div className="ai-terminal-launch-options">
   <button type="button" className={`ai-terminal-btn${bypassPermissions?' ai-terminal-btn--warn':''}`} data-testid="workroom-launch-options" data-bypass={bypassPermissions?'on':'off'} {...(effort.state.supported===true&&effort.state.auto!==null?{'data-effort-auto':effort.state.auto?'on':'off'}:{})} aria-expanded={optionsOpen} aria-controls={promptId+'-options'} onClick={()=>{if(!optionsOpen)refreshEffort(0);setOptionsOpen(value=>!value);}}>승인 없이 실행 (권한 우회) · {bypassUnavailable?'이 기기에서는 꺼짐':bypassPermissions?'켜짐':'꺼짐'}</button>
   {optionsOpen&&<div id={promptId+'-options'} className="ai-terminal-options-content">
    <label><input type="checkbox" checked={bypassPermissions} disabled={busy||!!bypassUnavailable} onChange={e=>changeBypass(e.target.checked)}/> 승인 없이 실행 (권한 우회)</label>
    {bypassUnavailable&&<p className="ai-terminal-hint" data-testid="workroom-bypass-unavailable">{bypassUnavailable}</p>}
    <p className="ai-terminal-hint">켜져 있으면 AI가 파일 수정·명령 실행 전에 묻지 않습니다. 처음이라면 꺼 두는 것을 권장합니다. 꺼 두면 각 AI의 기본 승인 설정을 따릅니다. 다음에 새로 여는 터미널부터 적용되고, 이미 실행 중인 세션에는 적용되지 않습니다.</p>
   </div>}
  </div>;
 const accountPicker=<CliAccountPicker key={sessionScope} agent={agent} targetId={target||activeSession?.targetId||''} request={request} remote={remote} visible={visible} onlyWhenChoice={fullscreen}/>;
 const projectField=<label className="ai-terminal-field ai-terminal-field--project"><span className="ai-terminal-label">프로젝트·워크트리</span>{!deviceSwitch&&<span className="ai-terminal-hint">{sessionDevice}</span>}
    <select aria-label="터미널 프로젝트" value={target} disabled={busy} onChange={e=>setTarget(e.target.value)} className="ai-terminal-select ai-terminal-select--project"><option value="">프로젝트 선택</option>{target&&!targetProject&&<option value={target}>프로젝트 연결 확인 필요</option>}{(()=>{const ops=opsTargetId?projects.find(p=>p.targetId===opsTargetId):undefined;if(!ops)return projects.map(p=><option key={p.targetId} value={p.targetId}>{p.label}</option>);
      // 총괄 is not one project among many (VOC 2026-10-08: OPS sat below mcp-series on the phone) — it leads, in its own group.
      return <><optgroup label="총괄 (OPS)"><option value={ops.targetId} data-testid="ai-terminal-project-ops">{ops.label} · {sessionOwner(ops.targetId)}</option></optgroup><optgroup label="프로젝트">{projects.filter(p=>p!==ops).map(p=><option key={p.targetId} value={p.targetId}>{p.label}</option>)}</optgroup></>;})()}</select>
   </label>;
 const agentField=<label className="ai-terminal-field"><span className="ai-terminal-label">AI</span>
    <select aria-label="터미널 AI" value={agent} disabled={busy} onChange={e=>setAgent(e.target.value as AiTerminalAgent)} className="ai-terminal-select">{AI_TERMINAL_AGENTS.map(a=><option key={a} value={a}>{aiTerminalAgentLabel(a)}</option>)}</select>
   </label>;
 const refreshButton=<button disabled={busy} onClick={()=>{void refresh();if(!remote){void refreshConnections();setTargetReload(value=>value+1)}}} aria-label="작업 세션 새로고침" className="ai-terminal-btn ai-terminal-btn--icon"><RotateCw size={14}/></button>;
 // In the 「새 작업」 sheet the voice dock is under the sheet (w11 review): the copy says to close it first.
 const opsHint=<>{opsTargetId&&target===opsTargetId&&<p className="ai-terminal-hint" data-testid="workroom-ops-input-hint">여기서 시작하는 작업은 OPS 워크룸의 {aiTerminalAgentLabel(agent)}에게 갑니다. 총괄과 말하려면 {newTaskShown?'이 창을 닫고 ':''}화면 아래 「아젠투지 호출」을 누르세요.</p>}</>;
 const targetErrorLine=<>{targetError&&<p className="ai-terminal-caption" role="alert">프로젝트·워크트리 목록을 갱신하지 못했습니다. 터미널 새로고침으로 다시 확인하세요.<ErrorVocActions message="프로젝트·워크트리 목록을 갱신하지 못했습니다." code="WORKROOM_TARGETS_FAILED" surface="workroom"/></p>}</>;
 // The launch notices sit on the overview — and in the 「새 작업」 sheet while it is open (w11 review): on the phone the only
 // start button is in the sheet, which covers the overview, and a blocked start has to say why and offer the check.
 const endedToggle=<>{!!endedSessions.length&&<button className="ai-terminal-btn ai-terminal-ended-toggle" aria-pressed={showEnded} onClick={()=>setShowEnded(value=>!value)}>{showEnded?'종료된 세션 숨기기':'종료된 세션 보기'} ({endedSessions.length})</button>}</>;
 const launchNotices=<>
  {launchStorageNotice&&<div className="ai-terminal-hint" role="status" data-testid="workroom-launch-storage-notice"><p>이 브라우저에 사이트 데이터를 저장할 수 없어 새 세션 시작 결과를 기록할 수 없습니다. 새 세션은 기록 없이 시작하고, 시작 응답을 받지 못한 요청은 이 화면을 닫기 전까지만 기억해 같은 요청을 다시 시작할 때 먼저 묻습니다.</p><button type="button" className="ai-terminal-btn" data-testid="workroom-launch-storage-notice-dismiss" onClick={()=>setLaunchStorageNotice(false)}>확인</button></div>}
  {pendingLaunch&&<div className="ai-terminal-hint" role="status" data-testid="workroom-launch-recovery"><p>새 세션 시작 결과를 확인해야 합니다. 같은 요청으로 세션이 두 번 열리지 않도록 자동으로 다시 시작하지 않습니다{pendingLaunch.receipt?` (현재: ${submissionStateLabel(pendingLaunch.receipt.state)})`:''}.{pendingLaunches.length>1?` 확인할 새 세션 시작이 ${pendingLaunches.length-1}건 더 있습니다.`:''}</p>
   <button type="button" className="ai-terminal-btn" data-testid="workroom-launch-check" disabled={launchChecking||!launchSupported} onClick={()=>void checkOutcomes(true)}>새 세션 시작 결과 확인</button>
   <button type="button" className="ai-terminal-btn" data-testid="workroom-launch-dismiss" disabled={launchChecking} onClick={async ()=>{if(!(await confirmAction('세션 목록에서 앞선 새 세션이 열렸는지 확인하셨나요? 같은 요청으로 다시 시작하면 세션이 두 번 열릴 수 있습니다. 작성 내용은 유지합니다.')))return;dismissSubmissionRecord(pendingLaunch.id);launchDrafts.current.delete(pendingLaunch.id);routeLaunches.current.delete(pendingLaunch.id);launchAttachKeys.current.delete(pendingLaunch.id);rememberLaunch(pendingLaunch.id,null);}}>세션 목록 확인했음</button></div>}
  {newTaskShown&&launchBlocked&&<p className="ai-terminal-hint" role="status" data-testid="workroom-new-task-blocked">{targetProject?.label??'이 프로젝트'} · {aiTerminalAgentLabel(agent)}로 앞서 연 새 세션의 시작 결과를 아직 확인하지 못해, 같은 요청으로 세션이 두 번 열리지 않도록 새로 시작하지 않습니다. 위 「새 세션 시작 결과 확인」을 누르세요.</p>}
 </>;
 return <section ref={panel} className={`ai-terminal-panel${popout&&activeSession&&!composerOpen?' ai-terminal-panel--focused':''}${fullscreen?' ai-terminal-panel--overview':''}`} data-session-count={sessions.length} data-testid="ai-terminal-panel">
  {!fullscreen&&<header className="ai-terminal-head">
   {headTitle}
   {contextActions}
   <p className="ai-terminal-caption">{popout?'이 창에서 기기·프로젝트·AI를 골라 새 작업을 시작할 수 있습니다. 창을 닫아도 세션은 유지됩니다.':remote?'프로젝트와 AI를 골라 작업을 시작하세요. 화면을 닫거나 탭을 옮겨도 실행 중인 세션은 유지됩니다.':'프로젝트와 AI를 골라 시작하면 별도 창에서 작업합니다. 창을 닫아도 세션은 유지됩니다.'}</p>
   {launchOptions}
   {deviceSwitch}
   {accountPicker}
   <div className="ai-terminal-toolbar">
    {projectField}
    {agentField}
    <button disabled={!canLaunch} onClick={()=>void start()} className="ai-terminal-btn ai-terminal-start"><Plus size={14}/>{busy?'시작 중…':sheetAttachMoving?sheetAttachLabel:'작업 시작'}</button>
    {refreshButton}
   </div>
   {activeSession&&<p className="ai-terminal-caption" data-testid="workroom-target-context">현재 세션: {activeProject?.label??'프로젝트'}{activeSession.accountLabel?` · 계정: ${activeSession.accountLabel}`:''} · 시작할 작업: {targetProject?.label??'프로젝트 선택 필요'}</p>}
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
   {opsHint}
   {activeSession&&!composerOpen&&!!prompt.trim()&&<p className="ai-terminal-caption">작성 중인 요청이 있습니다. 작업을 시작하면 이 요청을 전달합니다.</p>}
   {targetErrorLine}
  </header>}
  {/* The phone (w11, S4 + critique 34): the running sessions come first, then one 「새 작업」 that opens the sheet with
      everything a start needs. The device tabs pick whose sessions these are, so they stay above the list. */}
  {/* One compact row (w11 review): the count, refresh — there with no session too — and 「새 작업」, at the top where the
      voice dock and the bottom navigation never reach (the Claude and Codex apps keep "new" at the top too). 세션
      기억하기…/내가 한 말 follow the list. */}
  {fullscreen&&<header className="ai-terminal-head ai-terminal-head--overview">
   <h2 className="ai-terminal-title">작업 세션 <span className="ai-terminal-overview-count">{runningSessions.length}</span></h2>
   {effortSettings}
   {refreshButton}
   <button type="button" className="ai-terminal-btn ai-terminal-new-task-open" data-testid="workroom-new-task" aria-haspopup="dialog" aria-expanded={newTaskShown} onClick={()=>openNewTask()}><Plus size={16} aria-hidden="true"/>새 작업{(!!prompt.trim()||sheetChips.length>0)&&<span className="ai-terminal-new-task-draft" data-testid="workroom-new-task-draft">{prompt.trim()?' · 작성 중':` · 첨부 ${sheetChips.length}`}</span>}</button>
  </header>}
  {fullscreen&&deviceSwitch}
  {fullscreen&&targetErrorLine}
  {!viewShown&&errorLine}
  {!viewShown&&noticeLine}
  {!newTaskShown&&launchNotices}
  {resuming&&<p className="ai-terminal-caption" role="status">{targetProject?.label??'선택한 프로젝트'}의 실행 중인 세션을 확인하고 있습니다. 연결이 지연되면 터미널 새로고침으로 다시 확인하세요.</p>}
  {!fullscreen&&composerShown&&<div ref={inlinePrompt} className="ai-terminal-prompt" data-testid="workroom-composer">
   <label className="ai-terminal-label" htmlFor={promptId}>{requestTitle||'어떤 작업을 할까요?'}</label>
   <textarea ref={promptField} id={promptId} aria-label="터미널에 전달할 작업" value={prompt} disabled={busy} onChange={e=>{const invalid=aiInitialPromptDraftError(e.target.value);if(invalid){setError(invalid+' 현재 초안은 유지했습니다.');return;}draftGeneration.current++;setPrompt(e.target.value)}} placeholder="작업을 적으면 선택한 AI에 전달합니다. 비워 두고 터미널만 열어도 됩니다." className="ai-terminal-textarea"/>
   <p className="ai-terminal-hint">{prompt.length>AI_INITIAL_PROMPT_MAX_BYTES?'24,000 초과':new TextEncoder().encode(prompt).length.toLocaleString('ko-KR')} / 24,000바이트</p>
   {promptError&&<p role="alert" className="ai-terminal-error">{promptError}<ErrorVocActions message={promptError} surface="workroom-prompt"/></p>}
   {remote&&requestTitle==='세션 기억하기 · 실행 전 확인'&&<p className="ai-terminal-hint" data-testid="workroom-remote-memory-guide">요청과 프로젝트를 확인하고 ‘선택한 AI로 시작’을 누르세요. 새 AI 세션에서 저장을 요청하며, 버튼을 누르는 것만으로 저장이 완료되지는 않습니다.</p>}
   <p className="ai-terminal-hint">{targetProject?`${targetProject.label}에서 ${aiTerminalAgentLabel(agent)}로 시작합니다.`:'등록된 프로젝트·워크트리를 선택해 주세요.'}</p>
   {agent==='codex'&&<p className="ai-terminal-hint">Codex의 $ 스킬 목록은 작업을 시작한 뒤 터미널 안에서 사용할 수 있습니다. 이 입력칸은 작업 내용을 전달합니다.</p>}
   {remoteAttachOn&&<><RemoteAttachSheetButtons attach={sheetAttach} disabled={busy}/><RemoteAttachChips attach={sheetAttach} focusComposer={()=>promptField.current?.focus()}/></>}
   {(!!prompt.trim()||sheetChips.length>0)&&<button className="ai-terminal-btn ai-terminal-start" disabled={!canLaunch} onClick={()=>void start()}>{sheetAttachMoving?sheetAttachLabel:'선택한 AI로 시작'}</button>}
  </div>}
  {/* Only while visible: a hidden panel (no Mac, a closed session, a device's projects still loading) asks for nothing. */}
  {remote&&visible&&!sessions.length&&!connectionError&&!listed&&<p className="ai-terminal-hint" role="status" data-testid="workroom-remote-sessions-loading">{sessionDevice}의 작업 세션을 확인하고 있습니다…</p>}
  {remote&&!sessions.length&&!connectionError&&listed&&<p className="ai-terminal-hint" data-testid="workroom-remote-no-sessions">{sessionDevice}에 실행 중인 작업 세션이 없습니다. 이 기기에서 허용한 프로젝트의 세션만 표시됩니다.</p>}
  {!fullscreen&&restartBanner}
  {!!sessions.length&&<div className={`ai-terminal-workspace${activeSession&&!fullscreen?'':' ai-terminal-workspace--idle'}${fullscreen?' ai-terminal-workspace--overview':''}`}>
  <aside className="ai-terminal-session-list">{!fullscreen&&<h3>작업 세션 <span>{runningSessions.length}</span></h3>}<p className={`ai-terminal-session-owner${fullscreen?' ai-terminal-sr-only':''}`} data-testid="workroom-session-owner">{sessionDevice}의 세션{fullscreen?' · 누르면 전체 화면으로 엽니다':''}</p>
  {!fullscreen&&endedToggle}
  <div className="ai-terminal-tabs" role="tablist" aria-label={`${sessionDevice}의 터미널 세션`}>{visibleSessions.map(s=><button role="tab" aria-selected={s.id===selected} key={s.id} data-session-id={s.id} aria-haspopup={fullscreen?'dialog':undefined} title={`${sessionOwner(s.targetId)} · ${workroomSessionStartedAt(s.createdAt)||'시작 시각 확인 불가'}`} onClick={()=>void openListedSession(s)} className={`ai-terminal-tab${s.state==='running'?'':' ai-terminal-tab--ended'}`}><span className={`ai-terminal-dot${s.state==='running'?' ai-terminal-dot--running':''}`} aria-hidden="true"/><span className="ai-terminal-tab-owner">{sessionOwner(s.targetId)}</span>{fullscreen?<span className="ai-terminal-tab-label">{sessionLabels.get(s.id)}</span>:sessionLabels.get(s.id)}{fullscreen&&<span className="ai-terminal-tab-break" aria-hidden="true"/>}<span className="ai-terminal-tab-state">{workroomSessionStateLabel(s)}</span>{fullscreen&&<><span className="ai-terminal-tab-time">{workroomSessionStartedAt(s.createdAt)}</span><ChevronRight size={16} className="ai-terminal-tab-open" aria-hidden="true"/></>}</button>)}</div>{fullscreen&&endedToggle}</aside>
  {!fullscreen&&<div className="ai-terminal-body">
   {activeSession&&part?<>
    <div className="ai-terminal-current"><span className="ai-terminal-tab-owner">{sessionOwner(activeSession.targetId)}</span><span className="ai-terminal-current-label">{sessionLabels.get(activeSession.id)}</span>{part.viewControls}</div>
    {part.restartLine}
    {part.surface}
    {part.exitedHint}
    {part.dismiss}
    {part.exitedQueue}
    {activeSession.state==='running'&&<div ref={inlineCommand} className="ai-terminal-command" data-testid="workroom-command-composer">
     <div className="ai-terminal-command-head"><span><AtSign size={13}/><span>{part.usage}</span></span>{part.commandChips}</div>
     {part.recovery}{part.submissionHint}{part.draftQueue}{part.remoteChips}{part.commandField}{part.images}{part.voiceReceipt}{part.appPlan}{part.appReceipt}{part.routePlan}{part.routeReceipt}{part.mentionMenu}{part.slashMenu}{part.refsUnsupported}{part.crossDevice}{part.deviceLoading}{part.deviceError}{part.natural}{part.imeHint}
    </div>}
    {part.slashBar}{part.slashPad}{part.keys}{part.shell}{part.footer}
   </>:<p className="ai-terminal-hint">{runningSessions.length?'작업 세션을 선택하면 이어서 입력할 수 있습니다.':'실행 중인 세션이 없습니다. 종료된 세션은 기록만 확인할 수 있습니다.'}</p>}
  </div>}
  </div>}
  {/* One place per mode, so a session starting mid-batch never remounts the banner (w14 Build B): with no sessions this
      is right where the empty hint is, with sessions it follows their rows and the first row's box does not move. */}
  {fullscreen&&restartBanner}
  {fullscreen&&<div className="ai-terminal-overview-more">{contextActions}</div>}
  {/* The phone's 「새 작업」 sheet (w11, S4.5): one layer over the page like the session view — project, AI, bypass, the
      account only when there is a choice, the first request, and the only start button. Hints wait behind 「?」. */}
  {newTaskShown&&typeof document!=='undefined'&&createPortal(<div ref={sheetRoot} className="ai-terminal-panel ai-terminal-new-task-sheet" role="dialog" aria-modal="true" aria-labelledby={sheetTitleId} tabIndex={-1}
    data-testid="workroom-new-task-sheet" onKeyDown={event=>{const target=event.target as Element;if(event.key==='Escape'&&!event.defaultPrevented&&!event.nativeEvent.isComposing&&target.tagName!=='SELECT'){event.preventDefault();event.stopPropagation();closeNewTask();}}}>
   <header className="ai-terminal-session-view-bar ai-terminal-new-task-bar">
    <h2 id={sheetTitleId} className="ai-terminal-session-view-title"><span>새 작업</span><span className="ai-terminal-tab-owner">{sessionDevice}</span></h2>
    <button type="button" className="ai-terminal-btn ai-terminal-btn--icon" data-testid="workroom-new-task-help" aria-expanded={newTaskHelp} aria-label={newTaskHelp?'새 작업 도움말 닫기':'새 작업 도움말 보기'} onClick={()=>setNewTaskHelp(open=>!open)}>?</button>
    <button type="button" className="ai-terminal-btn" data-testid="workroom-new-task-close" onClick={()=>closeNewTask()}>닫기</button>
   </header>
   <div className="ai-terminal-new-task-body">
    {!phoneOnline&&<p className="ai-terminal-hint ai-terminal-session-view-offline" role="status">{phoneOfflineNotice()}</p>}
    {errorLine}
    {launchNotices}
    {newTaskHelp&&<div className="ai-terminal-new-task-hints" data-testid="workroom-new-task-hints">
     <p className="ai-terminal-hint">{targetProject?`${targetProject.label}에서 ${aiTerminalAgentLabel(agent)}로 시작합니다.`:'등록된 프로젝트·워크트리를 선택해 주세요.'} 요청을 비워 두면 터미널만 엽니다. 화면을 닫거나 탭을 옮겨도 실행 중인 세션은 유지됩니다.</p>
     <p className="ai-terminal-hint">요청 칸에는 한글 IME가 조합을 끝낸 문자열만 들어갑니다. Enter는 줄바꿈이고, 아래 시작 버튼을 눌러야 보냅니다. {prompt.length>AI_INITIAL_PROMPT_MAX_BYTES?'24,000바이트를 넘었습니다.':`${new TextEncoder().encode(prompt).length.toLocaleString('ko-KR')} / 24,000바이트`}</p>
     {agent==='codex'&&<p className="ai-terminal-hint">Codex의 $ 스킬 목록은 작업을 시작한 뒤 터미널 안에서 사용할 수 있습니다. 이 칸은 첫 요청을 전달합니다.</p>}
    </div>}
    <div className="ai-terminal-new-task-fields">{projectField}{agentField}</div>
    {launchOptions}
    {effortSettings}
    {accountPicker}
    {opsHint}
    <label className="ai-terminal-label" htmlFor={promptId}>{requestTitle||'어떤 작업을 할까요? (선택)'}</label>
    <textarea ref={promptField} id={promptId} aria-label="터미널에 전달할 작업" value={prompt} disabled={busy} onChange={e=>{const invalid=aiInitialPromptDraftError(e.target.value);if(invalid){setError(invalid+' 현재 초안은 유지했습니다.');return;}draftGeneration.current++;setPrompt(e.target.value)}} placeholder="첫 요청 (비워 두면 터미널만 엽니다)" className="ai-terminal-textarea"/>
    {remoteAttachOn&&<><RemoteAttachSheetButtons attach={sheetAttach} disabled={busy}/><RemoteAttachChips attach={sheetAttach} focusComposer={()=>promptField.current?.focus()}/></>}
    {promptError&&<p role="alert" className="ai-terminal-error">{promptError}<ErrorVocActions message={promptError} surface="workroom-prompt"/></p>}
    {remote&&requestTitle==='세션 기억하기 · 실행 전 확인'&&<p className="ai-terminal-hint" data-testid="workroom-remote-memory-guide">요청과 프로젝트를 확인하고 ‘선택한 AI로 시작’을 누르세요. 새 AI 세션에서 저장을 요청하며, 버튼을 누르는 것만으로 저장이 완료되지는 않습니다.</p>}
   </div>
   <div className="ai-terminal-session-view-dock ai-terminal-new-task-dock">
    <button type="button" className="ai-terminal-btn ai-terminal-start" data-testid="workroom-new-task-start" disabled={!canLaunch} onClick={()=>void start()}><Plus size={14} aria-hidden="true"/>{busy?'시작 중…':sheetAttachMoving?sheetAttachLabel:prompt.trim()||sheetAttachReady?'선택한 AI로 시작':'작업 시작'}</button>
   </div>
  </div>,document.body)}
  {/* The phone's full-screen session view (w7): a dialog over the whole screen, outside the page (the portal header,
      the Mac tabs, the bottom navigation and the voice dock stay under it). Escape closes it except while typing. */}
  {viewShown&&typeof document!=='undefined'&&createPortal(<div ref={viewRoot} className="ai-terminal-panel ai-terminal-session-view" role="dialog" aria-modal="true" aria-labelledby={viewTitleId} tabIndex={-1}
    data-testid="workroom-session-view" data-session-id={activeSession?.id??''} data-session-state={activeSession?.state??'loading'}
    onKeyDown={event=>{if(sessionViewEscapeCloses(event,event.target as Element,viewRoot.current)){event.preventDefault();event.stopPropagation();closeSessionView('ui');}}}>
   <header className="ai-terminal-session-view-bar">
    <button type="button" className="ai-terminal-btn ai-terminal-session-view-back" data-testid="workroom-session-view-back" aria-label="워크룸 목록으로 돌아가기" title="워크룸 목록으로 돌아가기 · 세션은 계속 실행됩니다" onClick={()=>closeSessionView('ui')}><ArrowLeft size={16} aria-hidden="true"/><span>워크룸</span></button>
    <h2 id={viewTitleId} className="ai-terminal-session-view-title">{activeSession?<><span className="ai-terminal-tab-owner">{sessionOwner(activeSession.targetId)}</span><span className="ai-terminal-current-label">{sessionLabels.get(activeSession.id)}</span></>:'세션을 불러오는 중…'}</h2>
    {activeSession&&part&&<div className="ai-terminal-session-view-tools">
     {viewSwitchable.length>1&&<div className="ai-terminal-session-view-switcher"><select aria-label="세션 바꾸기" data-testid="workroom-session-switcher" className="ai-terminal-select" value={activeSession.id} disabled={busy} onChange={event=>{const next=sessions.find(s=>s.id===event.target.value);if(next)void openListedSession(next);}}>{viewSwitchable.map(s=><option key={s.id} value={s.id}>{sessionLabels.get(s.id)}{s.state==='running'?'':` · ${workroomSessionStateLabel(s)}`}</option>)}</select></div>}
     {part.viewControls}
    </div>}
   </header>
   {(error||connectionError||readError||(notice&&!error)||!phoneOnline||!!voiceCall)&&<div className="ai-terminal-session-view-status">{!phoneOnline&&<p className="ai-terminal-hint ai-terminal-session-view-offline" role="status" data-testid="workroom-session-view-offline">{phoneOfflineNotice()}</p>}
    {/* A voice call goes on under this view (a voice partner switch opens it, over the dock): it says so and can end it. */}
    {voiceCall&&<div className="ai-terminal-session-view-voice" role="group" aria-label="음성 대화" data-testid="workroom-session-view-voice"><span className="ai-terminal-dot ai-terminal-dot--running" aria-hidden="true"/><span className="ai-terminal-session-view-voice-text" role="status">음성 대화가 계속됩니다 · {voiceCall.partner}</span>
     <button type="button" className="ai-terminal-btn" onClick={()=>closeSessionView('ui')}>음성 창 보기</button><button type="button" className="ai-terminal-btn" onClick={()=>void voiceMediaClient.stop()}>음성 종료</button></div>}
    {errorLine}{noticeLine}</div>}
   {activeSession&&part?<div className="ai-terminal-session-view-body">
    <div className="ai-terminal-session-view-scroll" data-testid="workroom-session-view-scroll">
     {part.restartLine}
     {part.surface}
     {activeSession.state==='running'&&<div className="ai-terminal-session-view-more" data-testid="workroom-command-more">
      {/* The composer's @/# and IME notes sit behind one 「?」 (w11, S4.5). */}
      <div className="ai-terminal-session-view-help"><span className="ai-terminal-label">입력 도움말</span><button type="button" className="ai-terminal-btn ai-terminal-btn--icon" data-testid="workroom-command-help" aria-expanded={commandHelp} aria-label={commandHelp?'입력 도움말 닫기':'입력 도움말 보기'} onClick={()=>setCommandHelp(open=>!open)}>?</button></div>
      {commandHelp&&<div className="ai-terminal-session-view-hints" data-testid="workroom-command-hints"><p className="ai-terminal-hint">{part.usage}</p>{part.imeHint}</div>}
      {part.submissionHint}{part.draftQueue}{part.voiceReceipt}
     </div>}
     {part.exitedQueue}
     {part.slashBar}{part.slashPad}{part.shell}{part.footer}
    </div>
    <div ref={viewDock} className="ai-terminal-session-view-dock" data-testid="workroom-session-view-dock">
     {activeSession.state==='running'?<div className="ai-terminal-command ai-terminal-command--docked" data-testid="workroom-command-composer">
      {(!!routeTarget||referenceChips.length>0)&&<div className="ai-terminal-command-head">{part.commandChips}</div>}
      {part.recovery}{part.appPlan}{part.appReceipt}{part.routePlan}{part.routeReceipt}{part.refsUnsupported}{part.crossDevice}{part.deviceLoading}{part.deviceError}{part.natural}
      {part.remoteChips}{part.commandField}{part.images}{part.mentionMenu}{part.slashMenu}
     </div>:<>{part.exitedHint}{part.dismiss}</>}
     {activeSession.state==='running'&&part.keys}
    </div>
   </div>:<p className="ai-terminal-hint ai-terminal-session-view-loading" role="status">세션을 불러오는 중…</p>}
  </div>,document.body)}
  {viewDrop}{sheetDrop}{inlineCommandDrop}{inlinePromptDrop}
  {visible&&useConversation&&<WorkroomUseConversation key={useConversation.scope} {...useConversation} drafts={useDrafts.current} recipients={useRecipients.current} onDraftChange={()=>setUseDraftDirty([...useDrafts.current.values()].some(Boolean))} onClose={()=>setUseConversation(null)} onAccepted={()=>{if(terminalDraftLive.current===useConversation.draft){setTerminalDraft('');setTerminalCursor(0);setReferenceChips([]);}}}/>}
  {memoryStatus&&(popout?<details className="ai-terminal-memory-drawer" data-testid="workroom-memory-drawer"><summary>기억 저장 상태·설정</summary>{memoryStatus}</details>:memoryStatus)}
  {!remote&&connections.length>0&&<details className="ai-terminal-access"><summary>이 기기의 워크룸 작업 허용</summary><p>선택한 프로젝트에서 CLI 입력과 출력을 허용합니다. 테스터는 아래에서 별도로 허용합니다. 실행 허용 해제·연결 폐기는 진행 중인 원격 검사를 중단합니다. 일시적인 통신 단절에는 검사를 계속합니다. 연결의 남은 유효기간 동안 최대 30일 유지되며, 화면 잠금이나 앱 재시작 후에도 다시 승인하지 않습니다. 터미널에 표시되는 경로·계정 정보도 전송될 수 있습니다.</p><label>허용 범위<select value={grantRoot} onChange={e=>setGrantRoot(e.target.value)}><option value="">선택 프로젝트: {targetProject?.label??'프로젝트를 먼저 선택하세요'}</option>{grantRoots.map(r=><option key={r.workspaceRootId} value={r.workspaceRootId}>{r.name} · 이 기기가 새로 만든 프로젝트</option>)}</select></label><fieldset><legend>이 프로젝트에서 함께 허용할 모바일 기능</legend>{([['account.select','CLI 계정 선택'],['voice.use','음성 입력·실시간 대화'],['records.read','내가 한 말 조회'],['memory.save','세션 기억 저장'],['duty.manage','승인된 대직 방 관리'],['worktree.manage','병합된 워크트리 정리'],['tester.read','테스트 결과 조회'],['tester.run','테스트 실행·이 기기의 검사 취소']] as const).map(([scope,label])=><label key={scope}><input type="checkbox" checked={workspaceScopes.includes(scope)} onChange={e=>setWorkspaceScopes(current=>e.target.checked?[...new Set([...current,scope,...(scope==='tester.run'?['tester.read' as const]:[])])]:current.filter(s=>s!==scope&&(scope!=='tester.read'||s!=='tester.run')))}/>{label}</label>)}</fieldset>{connections.map(c=><label key={c.id}><input type="checkbox" checked={c.allowed} disabled={!grantRoot&&!targetProject&&!c.allowed} onChange={async e=>{try{const {result:r,historyCarried,historyScopeChanged}=await saveWorkroomAccess(accessRequest,{owner:c.id,enabled:e.target.checked,workspaceScopes,scope:grantRoot?{workspaceRootIds:[grantRoot]}:{targetIds:target?[target]:[]}});setConnections(r.connections);const dropped=e.target.checked?workroomHistoryDropNotice(c.historyScopes,historyCarried,historyScopeChanged):null;if(dropped)setError(dropped)}catch(e){setError(String(e))}}}/>{c.label}{c.durable&&c.expiresAt&&<span> · {new Date(c.expiresAt).toLocaleDateString()}까지</span>}<span> · 계정 선택 {c.workspaceScopes?.includes('account.select')?'허용':'미허용'} · 음성 {c.workspaceScopes?.includes('voice.use')?'허용':'미허용'} · 기록 {c.workspaceScopes?.includes('records.read')?'허용':'미허용'} · 저장 {c.workspaceScopes?.includes('memory.save')?'허용':'미허용'} · 대직 {c.workspaceScopes?.includes('duty.manage')?'허용':'미허용'} · 테스트 {c.workspaceScopes?.includes('tester.run')?'실행 허용':c.workspaceScopes?.includes('tester.read')?'조회만':'미허용'}</span><button type="button" disabled={!grantRoot&&!targetProject} onClick={async()=>{try{const {result:r,historyCarried,historyScopeChanged}=await saveWorkroomAccess(accessRequest,{owner:c.id,enabled:true,workspaceScopes,scope:grantRoot?{workspaceRootIds:[grantRoot]}:{targetIds:target?[target]:[]}});setConnections(r.connections);const dropped=workroomHistoryDropNotice(c.historyScopes,historyCarried,historyScopeChanged);if(dropped)setError(dropped)}catch(e){setError(String(e))}}}>선택한 범위·권한 적용</button></label>)}</details>}
 </section>;
}
