import {confirmAction} from './confirmAction';
import {hasUnselectedProjectCall} from './workroomThreadGroup';
import {aiTerminalAgentLabel} from './aiTerminalAgentLabel';
import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,AtSign,Bot,ChevronDown,Hash,Info,Loader2,MessageSquare,Monitor,Plus,RefreshCw,Send,UserRound,X} from 'lucide-react';
import type {WorkroomTransport} from './WorkroomSessionFooter';
import type {WorkroomMentionProject} from './workroomProjectMention';
import {normalizeMobileWorkspaceResult} from './mobileWorkspaceProtocol';
import {normalizeWorkroomThreadResult,workroomThreadStateLabel,workroomThreadText,type WorkroomThreadAction,type WorkroomThreadRequest,type WorkroomThreadResult,type WorkroomThreadSummary} from './workroomThreadProtocol';
import {phoneDateTime} from './phoneTime';
import {CommunityThreadMemory} from './CommunityThreadMemory';
import {workroomMentionCandidates,workroomMentionQuery,selectWorkroomMention} from './workroomProjectMention';
import './CommunityWorkspace.css';
import {commonMemoryUuid as requestUuid} from './commonMemoryCrypto';
import {normalizeServiceUseCall} from './serviceUseProtocol';
import {ServiceUseOperationFields,serviceUseInput,type ServiceUseFields} from './ServiceUseOperationFields';
import {parseProjectExecutionRole} from './conversationTargetAlias';
import {projectMentionChoices, projectMentionKey} from './projectUseMention';
import {ProjectStateBundlePreview} from './ProjectStateBundlePreview';
import {ReadToolBundlePanel} from './ReadToolBundlePanel';
import type {ReadToolBatchRequester} from './readToolBatchClient';
import type {WorkPackClient} from './workPackClient';
import type {ProjectStatePrepared,ProjectStateRequester,ProjectStateSectionId,ProjectStateSelectionReference} from './projectStateBundleClient';
import {projectStateCopy} from './i18n';
import {useAppLanguage} from './useAppLanguage';
import type {WorkroomUseCatalog} from './workroomThreadProtocol';
import {validateAppUseAction} from './appUseCatalog';

export interface CommunityWorkspaceChannel {
 id:string;label:string;projectRevision?:string;projects():Promise<WorkroomMentionProject[]>;transport:WorkroomTransport;projectState?:ProjectStateRequester;
 /** Local-only P2 read batch on an existing DEV thread; peer channels never receive it. */
 readToolBatch?:ReadToolBatchRequester;
 /** Local-only P3 work packs attached to this device's 규격 명령. */
 workPacks?:WorkPackClient;
}
interface ProjectStateAttachment {reference:ProjectStateSelectionReference;text:string;currentDraft:string;start:number;end:number;invalid:boolean;invalidReason?:'edited'|'context'}
/** Track the edited attachment span, retaining only the previous draft and current bounds. */
function movedStateRange(attachment:ProjectStateAttachment,next:string):{start:number;end:number} {
 const before=attachment.currentDraft;let prefix=0,suffix=0;
 while(prefix<before.length&&prefix<next.length&&before[prefix]===next[prefix])prefix++;
 while(suffix<before.length-prefix&&suffix<next.length-prefix&&before[before.length-suffix-1]===next[next.length-suffix-1])suffix++;
 const oldEnd=before.length-suffix,newEnd=next.length-suffix,delta=next.length-before.length;
 if(oldEnd<=attachment.start)return {start:attachment.start+delta,end:attachment.end+delta};
 if(prefix>=attachment.end)return {start:attachment.start,end:attachment.end};
 return {start:Math.min(attachment.start,prefix),end:attachment.end>=oldEnd?attachment.end+delta:newEnd};
}
interface Pending {id:string;threadId:string;kind:'create'|'reply'}
const pendingKey=(scope:string)=>'agentstoz:community-pending:'+scope;
function readPending(scope:string):Pending|null {try{const r=JSON.parse(sessionStorage.getItem(pendingKey(scope))??'null');return r&&typeof r.id==='string'&&typeof r.threadId==='string'&&['create','reply'].includes(r.kind)?r:null;}catch{return null;}}
function savePending(scope:string,value:Pending|null){try{value?sessionStorage.setItem(pendingKey(scope),JSON.stringify(value)):sessionStorage.removeItem(pendingKey(scope));}catch{/* The current view still fences this intent. */}}
/** The channel chooses a device; a project chip chooses exactly where its task and memory belong. */
export function CommunityWorkspace({channels,visible=true,online=true,onOpenWorkroom}:{channels:CommunityWorkspaceChannel[];visible?:boolean;online?:boolean;onOpenWorkroom:(channelId:string,targetId:string,thread:WorkroomThreadSummary)=>void}){
 const [selected,setSelected]=useState(channels[0]?.id??'');
 const channel=channels.find(c=>c.id===selected)??channels[0];
 const channelRef=useRef(channel);channelRef.current=channel;
 const [projects,setProjects]=useState<{id:string;rows:WorkroomMentionProject[]}|null>(null),[loadError,setLoadError]=useState(''),[retry,setRetry]=useState(0);
 const [targets,setTargets]=useState<Record<string,string>>({});
 const stateAttachments=useRef(new Map<string,ProjectStateAttachment>());
 const drafts=useRef(new Map<string,string>()),recipients=useRef(new Map<string,string[]>());
 const projectCache=useRef(new Map<string,{revision:string;retry:number;at:number;rows:WorkroomMentionProject[]}>());
 useEffect(()=>{if(!visible||!online||!channel)return;let alive=true;setLoadError('');
  const cached=projectCache.current.get(channel.id),revision=channel.projectRevision??'';
  setProjects(prior=>prior?.id===channel.id?prior:cached?{id:channel.id,rows:cached.rows}:null);
  if(cached&&cached.revision===revision&&cached.retry===retry&&Date.now()-cached.at<60000)return;
  void channel.projects().then(rows=>{if(alive){projectCache.current.set(channel.id,{revision,retry,at:Date.now(),rows});setProjects({id:channel.id,rows});setTargets(prior=>prior[channel.id]?prior:{...prior,[channel.id]:rows[0]?.targetId??''});}}).catch(e=>{if(alive)setLoadError(e instanceof Error?e.message:String(e));});
  return()=>{alive=false;};
 },[channel?.id,channel?.projectRevision,visible,online,retry]);
 const rows=projects&&projects.id===channel?.id?projectMentionChoices(projects.rows):[],target=targets[channel?.id??'']??rows[0]?.targetId??'';
 const choice=rows.find(p=>projectMentionKey(p)===target);
 return <section className="community-workspace" data-testid="community-workspace">
  <header className="community-heading"><div><span className="community-eyebrow">기기별 프로젝트 업무</span><h2>커뮤니티</h2><p>프로젝트에 업무를 맡기고, 질문과 결과를 한 스레드에서 이어가세요.</p></div><span className="community-channel-count"><Monitor size={15} aria-hidden="true"/>{channels.length}개 채널</span></header>
  <div className="community-layout">
   <aside className="community-sidebar">
    <div className="community-sidebar-heading"><Monitor size={14} aria-hidden="true"/>기기 채널</div>
    <nav className="community-channels" aria-label="아젠투지 채널">{channels.map(c=><button type="button" key={c.id} aria-label={'# '+c.label} aria-pressed={channel?.id===c.id} onClick={()=>setSelected(c.id)}><Hash size={16} aria-hidden="true"/><span>{c.label}</span></button>)}</nav>
    <p className="community-channel-hint">선택한 기기에서 업무를 실행합니다.</p>
   </aside>
   <div className="community-main">
   {!online?<p className="community-feedback" role="status">기기에 연결하면 업무 스레드를 확인할 수 있습니다.</p>:!channel?<p className="community-feedback">연결된 아젠투지가 없습니다.</p>:<>
   <div className="community-project-bar"><label className="community-project"><span>업무를 맡길 프로젝트</span><span className="community-select"><select aria-label="기준 프로젝트" value={target} onChange={e=>setTargets(prior=>({...prior,[channel.id]:e.target.value}))} disabled={!rows.length}><option value="">프로젝트 선택</option>{rows.map(p=><option key={projectMentionKey(p)} value={projectMentionKey(p)}>@{p.label}</option>)}</select><ChevronDown size={15} aria-hidden="true"/></span></label><span className="community-project-device"><Monitor size={14} aria-hidden="true"/>{channel.label}</span></div>
   {loadError?<p className="community-feedback community-error" role="alert">{loadError} <button type="button" onClick={()=>setRetry(v=>v+1)}>다시 확인</button></p>:projects?.id!==channel.id?<p className="community-feedback" role="status">채널의 프로젝트를 확인하고 있습니다…</p>:!rows.length?<p className="community-feedback">이 기기에 허용된 프로젝트가 없습니다.</p>:choice?<CommunityThreadView key={channel.id+':'+target} scope={channel.id+':'+target} targetId={choice.targetId} label={choice.label} initialRole={choice.executionRole} serviceKey={choice.serviceKey} transport={channel.transport} projectState={channel.projectState} readToolBatch={channel.readToolBatch} workPacks={channel.workPacks} stateAttachments={stateAttachments.current} visible={visible} drafts={drafts.current} recipients={recipients.current} projects={rows}
    onSelectTarget={(p,text)=>{const key=projectMentionKey(p);drafts.current.set(channel.id+':'+key+':new',text);setTargets(prior=>({...prior,[channel.id]:key}));}}
    onOpen={(thread,participantTarget)=>onOpenWorkroom(channel.id,participantTarget??choice.targetId,thread)}/>:<p role="status">선택했던 프로젝트가 현재 허용 목록에 없습니다. 위에서 프로젝트를 선택하세요.</p>}
   </>}
   </div>
  </div>
 </section>;
}
const emptyStateAttachments=new Map<string,ProjectStateAttachment>();
export function CommunityThreadView({scope,targetId,label,transport,visible,drafts,recipients,onOpen,projects,initialRole='dev',serviceKey='default',initialDraft='',onSelectTarget,onAccepted,onDraftChange,projectState,readToolBatch,workPacks,stateAttachments=emptyStateAttachments}:{scope:string;targetId:string;label:string;transport:WorkroomTransport;visible:boolean;drafts:Map<string,string>;recipients:Map<string,string[]>;projects:WorkroomMentionProject[];onOpen:(thread:WorkroomThreadSummary,targetId?:string)=>void;initialRole?:'dev'|'use';serviceKey?:string;initialDraft?:string;onSelectTarget?:(project:WorkroomMentionProject,text:string)=>void;onAccepted?:()=>void;onDraftChange?:()=>void;projectState?:ProjectStateRequester;readToolBatch?:ReadToolBatchRequester;workPacks?:WorkPackClient;stateAttachments?:Map<string,ProjectStateAttachment>}){
 const [language]=useAppLanguage(),stateCopy=projectStateCopy(language);
 const [,renderStateAttachment]=useState(0);
 const fixedUse=initialRole==='use'&&!onSelectTarget;
 const [beforeThread,setBeforeThread]=useState<string|undefined>(),[nextThread,setNextThread]=useState<string|null>(null),[beforeMessage,setBeforeMessage]=useState<number|undefined>();
 const [list,setList]=useState<WorkroomThreadSummary[]>([]),[selected,setSelected]=useState(''),[detail,setDetail]=useState<WorkroomThreadResult|null>(null);
 const [writingNew,setWritingNew]=useState(false);
 const [draftByThread,setDraftByThread]=useState<Record<string,string>>(()=>initialDraft&&!drafts.has(scope+':new')?{[scope+':new']:initialDraft}:{}),[agent,setAgent]=useState<'codex'|'claude'|'hermes'|'agy'>('codex');
 const [executionRole,setExecutionRole]=useState<'dev'|'use'>(initialRole);
 const [useFields,setUseFields]=useState<ServiceUseFields>({tool:'materials.generate',materialId:'',operationId:'',phoneId:''});
 const [useCatalog,setUseCatalog]=useState<{key:string;catalog?:WorkroomUseCatalog;error?:string}|null>(null),[catalogRetry,setCatalogRetry]=useState(0);
 const [called,setCalled]=useState(()=>recipients.get(scope)??[targetId]),[replyTarget,setReplyTarget]=useState('');
 const updateCalled=(ids:string[])=>{recipients.set(scope,ids);setCalled(ids);};
 const addCalled=(id:string)=>{if(called.includes(id))return;if(called.length>=8){setError('한 업무에는 프로젝트를 8개까지 호출할 수 있습니다.');return;}updateCalled([...called,id]);};
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[pending,setPending]=useState(()=>readPending(scope)),[loading,setLoading]=useState(false);
 const [support,setSupport]=useState<'checking'|'ready'|'unavailable'>('checking');
 const alive=useRef(true),epoch=useRef(0),mutating=useRef(false),reading=useRef(false),composing=useRef(false);
 const [caret,setCaret]=useState(0),field=useRef<HTMLTextAreaElement>(null);
 const fieldId=useId(),heading=useRef<HTMLHeadingElement>(null),rail=useRef<HTMLElement>(null);
 const selectedRef=useRef(selected);selectedRef.current=selected;
 const queryKey=JSON.stringify([selected,beforeThread,beforeMessage]),queryRef=useRef(queryKey);queryRef.current=queryKey;
 const latestTransport=useRef(transport);latestTransport.current=transport;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 const draftKey=scope+':'+(selected||'new'),draft=draftByThread[draftKey]??drafts.get(draftKey)??'';
 const setDraft=(text:string)=>{
  if((text||fixedUse)&&!drafts.has(draftKey)&&drafts.size>=64){setError('작성 중인 초안이 많습니다. 기존 초안을 보내거나 비운 뒤 새 초안을 작성하세요.');return false;}
  const attached=stateAttachments.get(draftKey);
  if(attached){
   if(!text)stateAttachments.delete(draftKey);
   else{const intact=text.includes(attached.text)&&text.indexOf(attached.text)===text.lastIndexOf(attached.text),range=intact?{start:text.indexOf(attached.text),end:text.indexOf(attached.text)+attached.text.length}:movedStateRange(attached,text);stateAttachments.set(draftKey,{...attached,...range,currentDraft:text,invalid:attached.invalidReason==='context'||!intact,invalidReason:attached.invalidReason==='context'?'context':intact?undefined:'edited'});}
   renderStateAttachment(value=>value+1);
  }
  if(text||fixedUse)drafts.set(draftKey,text);else drafts.delete(draftKey);setDraftByThread(old=>({...old,[draftKey]:text}));onDraftChange?.();return true;
 };
 const clearDraft=(key:string)=>{stateAttachments.delete(key);drafts.delete(key);setDraftByThread(old=>({...old,[key]:''}));onDraftChange?.();};
 const call=async(action:WorkroomThreadAction,thread:WorkroomThreadRequest,id=requestUuid())=>{
  const result=normalizeMobileWorkspaceResult(await latestTransport.current({operation:'workspace',requestId:id,targetId,workspace:{action,thread:action==='workroom.threads.list'?{...thread,requireMultiProject:true}:thread}}));
  const value=normalizeWorkroomThreadResult(result.threads,action);
  if(value.refusal&&value.refusal.requestId!==id||value.thread&&value.thread.id!==(action==='workroom.threads.create'?id:thread.threadId))throw Error('요청한 스레드의 응답이 아닙니다. 원래 전송 결과를 확인하세요.');
  if(fixedUse&&value.thread&&value.thread.execution?.serviceKey!==serviceKey)throw Error('USE 제품 운영 대화의 결과를 확인하세요.');
  return value;
 };
 const show=(r:WorkroomThreadResult)=>{setDetail(r);if(r.thread){setSelected(r.thread.id);setList(old=>[r.thread!,...old.filter(v=>v.id!==r.thread!.id)].slice(0,20));}};
 const refresh=async(force=false)=>{
  if(reading.current||mutating.current||composing.current||!visible||!force&&support==='unavailable')return;reading.current=true;const mine=epoch.current,id=selectedRef.current,key=queryRef.current;
  try{const r=id?await call('workroom.threads.read',{threadId:id,...(beforeMessage?{beforeSeq:beforeMessage}:{})}):await call('workroom.threads.list',beforeThread?{beforeThreadId:beforeThread}:{});if(!alive.current||mine!==epoch.current||id!==selectedRef.current||key!==queryRef.current)return;
   if(id){
    setDetail(r);
    // The visible rail is live too; opening one conversation must not freeze other task states.
    const overview=await call('workroom.threads.list',beforeThread?{beforeThreadId:beforeThread}:{});
    if(!alive.current||mine!==epoch.current||id!==selectedRef.current||key!==queryRef.current)return;
    setList(overview.threads??[]);setNextThread(overview.nextThreadId??null);
   }else{setList(r.threads??[]);setNextThread(r.nextThreadId??null);}setSupport('ready');setError('');
  }catch(e){if(alive.current&&mine===epoch.current&&key===queryRef.current){const message=e instanceof Error?e.message:String(e);if(/모바일 작업 요청 형식|커뮤니티 작업 스레드 형식|지원하지 않는 로컬 워크룸 요청|지원하지 않는 모바일 작업/.test(message)){setSupport('unavailable');setError('이 기기의 앱을 업데이트하면 커뮤니티 업무 스레드를 사용할 수 있습니다.');}else setError(message);}}finally{reading.current=false;if(alive.current&&(mine!==epoch.current||key!==queryRef.current))void refreshRef.current();}
 };
 const refreshRef=useRef(refresh);refreshRef.current=refresh;
 useEffect(()=>{if(!visible)return;void refreshRef.current();const timer=setInterval(()=>{if(!document.hidden)void refreshRef.current();},8000);return()=>clearInterval(timer);},[visible,selected,beforeThread,beforeMessage]);
 const open=async(id:string)=>{epoch.current++;setBeforeMessage(undefined);setSelected(id);selectedRef.current=id;setDetail(null);setError('');setLoading(true);const mine=epoch.current;
  try{const r=await call('workroom.threads.read',{threadId:id});if(alive.current&&mine===epoch.current){show(r);requestAnimationFrame(()=>{if(alive.current&&mine===epoch.current)heading.current?.focus({preventScroll:true});});}}catch(e){if(alive.current&&mine===epoch.current)setError(e instanceof Error?e.message:String(e));}finally{if(alive.current&&mine===epoch.current)setLoading(false);}};
 const remember=(p:Pending|null)=>{savePending(scope,p);setPending(p);};
 const send=async()=>{
  if(mutating.current||pending||!draft.trim()||support!=='ready')return;
  if(fixedUse&&executionRole!=='use'){setError('선택한 USE 제품 운영 대화에서 확인하세요.');return;}
  // Selecting a thread is never permission to turn a missing/loading reply into a new task.
  if(selected&&(loading||detail?.thread?.id!==selected||!canReply||beforeMessage))return;
  const attached=stateAttachments.get(draftKey);
  if(attached&&(attached.invalid||!draft.includes(attached.text)||!projectState||useMode||called.length!==1||!!thread?.participants)){setError(stateCopy.edited);return;}
  const projectStateContext=attached?{projectState:attached.reference}:{};
  try{workroomThreadText(draft);}catch(e){setError(e instanceof Error?e.message:String(e));return;}
  if(!selected&&hasUnselectedProjectCall(attached?draft.replace(attached.text,''):draft,called.flatMap(id=>projects.filter(p=>p.targetId===id).map(p=>p.label)))){setError('@프로젝트는 호출 후보에서 선택하세요. 표시된 호출 대상에만 업무를 보냅니다.');return;}
  if(!selected&&called.some(id=>!projects.some(p=>p.targetId===id))){setError('호출 대상의 현재 프로젝트 권한을 확인하세요.');return;}
  if(!selected&&mentionedRoles.some(role=>role!==executionRole)){setError('본문의 DEV/USE 역할과 선택한 실행 역할을 일치시키세요.');return;}
  if(!selected&&executionRole==='use'&&projectMentionChoices(projects).some(p=>p.executionRole==='use'&&called.includes(p.targetId)&&draft.includes('@'+p.label+' ')&&p.serviceKey!==serviceKey)){setError('본문의 USE 서비스와 선택한 호출 대상을 일치시키세요.');return;}
  let use;try{if(useMode){if(!selected&&called.length!==1)throw Error('USE는 한 제품의 실행 문맥을 선택하세요.');if(!catalog?.executionReady||!catalog.tools.includes(useFields.tool))throw Error('이 앱의 USE 연결과 허용된 동작을 확인하세요.');use=normalizeServiceUseCall({role:'use',serviceKey:detail?.thread?.execution?.serviceKey??serviceKey,tool:useFields.tool,input:serviceUseInput(useFields,draft)});if(use.tool==='app.invoke')validateAppUseAction(catalog.actions??[],use.input.actionId!,use.input.arguments);}}catch(e){setError(e instanceof Error?e.message:String(e));return;}
  mutating.current=true;setBusy(true);setError('');epoch.current++;
  const id=requestUuid(),current=detail?.thread,operation=current?'reply':'create',p:Pending={id,threadId:current?.id??id,kind:operation};remember(p);
  try{
   const r=operation==='create'?await call('workroom.threads.create',{agent,text:draft,...projectStateContext,...(use?{use}:{}),...(called.length>1?{targetIds:called}:{})},id):await call('workroom.threads.reply',{threadId:current!.id,text:draft,...projectStateContext,expectedRevision:current!.revision,...(use?{use}:{}),...(current!.participants?{recipientTargetId:replyMember!.targetId}:{})},id);
   if(!alive.current)return;if(r.refusal){if(r.thread)show(r);remember(null);if(attached){stateAttachments.set(draftKey,{...attached,invalid:true,invalidReason:'context'});renderStateAttachment(value=>value+1);}setError(r.refusal.message);return;}show(r);remember(null);stateAttachments.delete(draftKey);setDraft('');onAccepted?.();
  }catch(e){if(alive.current)setError((e instanceof Error?e.message:String(e))+' 전송 결과를 확인한 뒤 이어가세요.');}
  finally{mutating.current=false;if(alive.current)setBusy(false);}
 };
 const check=async()=>{if(!pending||mutating.current)return;mutating.current=true;setBusy(true);setError('');try{
  const r=await call('workroom.threads.read',{threadId:pending.threadId});if(!alive.current)return;show(r);
  if(pending.kind==='create'||r.messages?.some(m=>m.id===pending.id)){remember(null);clearDraft(scope+':'+(pending.kind==='create'?'new':pending.threadId));onAccepted?.();}
  else setError('이 답변의 접수를 확인하지 못했습니다. 워크룸에서 확인하세요. 같은 답변을 자동으로 다시 보내지 않습니다.');
 }catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{mutating.current=false;if(alive.current)setBusy(false);}};
 const thread=detail?.thread;
 const useMode=!!thread?.execution||!selected&&executionRole==='use';
 const catalogKey=targetId+'\0'+(thread?.execution?.serviceKey??serviceKey),catalog=useCatalog?.key===catalogKey?useCatalog.catalog:undefined;
 useEffect(()=>{
  if(!visible||!useMode)return;let active=true;
  setUseCatalog({key:catalogKey});
  void call('workroom.threads.catalog',{serviceKey:thread?.execution?.serviceKey??serviceKey}).then(r=>{
   if(!active)return;const c=r.catalog!;setUseCatalog({key:catalogKey,catalog:c});
   setUseFields(old=>{
    const tool=c.tools.includes(old.tool)?old.tool:c.tools[0]??old.tool;
    const actionId=c.actions?.some(a=>a.id===old.actionId)?old.actionId:c.actions?.[0]?.id;
    const action=c.actions?.find(a=>a.id===actionId);
    return {...old,tool,actionId,arguments:actionId===old.actionId?old.arguments:Object.fromEntries((action?.fields??[]).filter(f=>f.required&&f.type==='boolean').map(f=>[f.key,false]))};
   });
  }).catch(e=>{if(active)setUseCatalog({key:catalogKey,error:e instanceof Error?e.message:String(e)});});
  return()=>{active=false;};
 },[visible,useMode,catalogKey,catalogRetry]);
 const replyMember=thread?.participants?.find(m=>m.targetId===replyTarget)??thread?.participants?.find(m=>m.state==='needs-answer')??thread?.participants?.[0];
 const question=detail?.messages?.findLast(m=>m.kind==='question'&&(!replyMember||m.targetId===replyMember.targetId));
 const observedExit=detail?.messages?.some(m=>m.role==='system'&&m.kind==='notice'&&m.id===`exit_${replyMember?.sessionId??thread?.sessionId}`&&m.seq>(question?.seq??0));
 const nativeQuestion=(replyMember?.state??thread?.state)==='needs-answer'&&question?.role==='system'&&!observedExit,canReply=!!thread&&(thread.execution?['running','completed','failed','unknown']:['running','needs-answer','completed']).includes(replyMember?.state??thread.state)&&thread.state!=='closed'&&!nativeQuestion,bytes=useMemo(()=>new TextEncoder().encode(draft).length,[draft]);
 const textError=useMemo(()=>{if(!draft.trim())return '';try{workroomThreadText(draft);return '';}catch(e){return e instanceof Error?e.message:String(e);}},[draft]);
 const stateAttachment=stateAttachments.get(draftKey);
 const stateSupported=!!projectState&&!useMode&&executionRole==='dev'&&called.length===1&&!thread?.participants;
 // P2 receipts are appended to the exact selected single-project DEV thread only.
 const batchSupported=!!readToolBatch&&!!thread&&!useMode&&executionRole==='dev'&&!thread.participants&&!thread.execution;
 const attachState=(prepared:ProjectStatePrepared,sections:ProjectStateSectionId[])=>{
  const prior=stateAttachments.get(draftKey),base=prior?(draft.slice(0,prior.start)+draft.slice(prior.end)).trimEnd():draft;
  const text=base+(base?'\n\n':'')+prepared.text;
  try{workroomThreadText(text);}catch{throw Error('PROJECT_STATE_INPUT_LIMIT');}
  stateAttachments.delete(draftKey);if(!setDraft(text))throw Error('PROJECT_STATE_INPUT_LIMIT');stateAttachments.set(draftKey,{reference:{bundleId:prepared.bundleId,sections,selectionHash:prepared.selectionHash},text:prepared.text,currentDraft:text,start:text.length-prepared.text.length,end:text.length,invalid:false});renderStateAttachment(value=>value+1);field.current?.focus();
 };
 const removeState=()=>{const previous=stateAttachments.get(draftKey);if(!previous)return;stateAttachments.delete(draftKey);setDraft((draft.slice(0,previous.start)+draft.slice(previous.end)).trimEnd());setError('');renderStateAttachment(value=>value+1);field.current?.focus();};
 const candidates=!selected?workroomMentionCandidates(draft,projects,caret):[];
 const chooseMention=(project:WorkroomMentionProject)=>{const selection=selectWorkroomMention(draft,caret,project),query=workroomMentionQuery(draft,caret);if(selection.kind==='route'&&query){const token='@'+project.label+' ',text=draft.slice(0,query.start)+token+draft.slice(caret).replace(/^\s+/u,'');
   if(onSelectTarget&&((project.executionRole==='use')!==(executionRole==='use')||project.executionRole==='use'&&(project.targetId!==targetId||project.serviceKey!==serviceKey))){onSelectTarget(project,stateAttachment?(()=>{const range=movedStateRange(stateAttachment,text);return (text.slice(0,range.start)+text.slice(range.end)).trimEnd();})():text);return;}
   addCalled(project.targetId);setExecutionRole(project.executionRole??'dev');setDraft(text);setCaret(query.start+token.length);
  }else{setDraft(selection.value);setCaret(selection.cursor);}field.current?.focus();};
 // Explicit textual suffixes must agree with the selected execution role. Never infer a role from a channel.
 const mentionedRoles=projectMentionChoices(projects).filter(p=>called.includes(p.targetId)).flatMap(project=>{
  const content=stateAttachment?draft.replace(stateAttachment.text,''):draft,name=project.label,start=content.indexOf('@'+name+' ');if(start<0)return [];
  const suffix=content.slice(start+name.length+2).match(/^(DEV(?:\/개발)?|개발|USE(?:\/운영)?|운영|사용)(?=\s|$)/iu);
  return [suffix?parseProjectExecutionRole(name+' '+suffix[0]).executionRole!:project.executionRole??'dev'];
 });
 useEffect(()=>{if(!fixedUse&&!selected&&new Set(mentionedRoles).size===1&&!busy&&!pending)setExecutionRole(mentionedRoles[0]!);},[fixedUse,selected,mentionedRoles.join(','),busy,!!pending]);
 const leaveThread=(fresh:boolean)=>{const id=selected;epoch.current++;setWritingNew(fresh);setSelected('');selectedRef.current='';if(fresh)setBeforeThread(undefined);setBeforeMessage(undefined);setDetail(null);setLoading(false);setError('');requestAnimationFrame(()=>{if(fresh){field.current?.focus({preventScroll:true});field.current?.scrollIntoView({block:'center'});}else (Array.from(rail.current?.querySelectorAll<HTMLButtonElement>('[data-thread-id]')??[]).find(button=>button.dataset.threadId===id)??rail.current)?.focus();});};
 const displayed=list.filter(row=>!fixedUse||row.execution?.serviceKey===serviceKey).map(row=>row.id===thread?.id?thread:row);
 const composeVisible=!selected||thread?.id===selected&&canReply&&!beforeMessage;
 return <div className="community-thread-view" data-thread-selected={!!selected} data-writing-new={!selected&&writingNew}>
  <div className="community-thread-tools"><div><AtSign size={17} aria-hidden="true"/><strong>{label}</strong></div><div className="community-thread-actions"><button type="button" className="community-primary community-new-task" disabled={busy||!!pending} onClick={()=>leaveThread(true)}><Plus size={15} aria-hidden="true"/>새 업무</button><button type="button" className="community-icon-button" title="업무 새로고침" aria-label="새로고침" disabled={busy||loading} onClick={()=>void refresh(true)}><RefreshCw size={16} aria-hidden="true"/></button></div></div>
  <div className="community-thread-layout">
   <nav ref={rail} className="community-thread-rail" aria-label="업무 스레드 목록" tabIndex={-1}>
    <div className="community-thread-list-heading"><h3>업무 스레드 <span>{list.length}</span></h3></div>
    <div className="community-thread-list">{displayed.length?displayed.map(t=><button type="button" key={t.id} data-thread-id={t.id} aria-current={selected===t.id?'true':undefined} disabled={busy||!!pending} onClick={()=>void open(t.id)}><span className="community-thread-row-title">{t.title}</span><span className="community-thread-row-state"><span className="community-state" data-state={t.state}>{workroomThreadStateLabel(t.state)}</span><small>{t.execution?'USE · 제품 운영':aiTerminalAgentLabel(t.agent)}</small></span><time>{phoneDateTime(t.updatedAt)}</time></button>):support==='ready'?<div className="community-list-empty"><MessageSquare size={24} aria-hidden="true"/><p>아직 업무 스레드가 없습니다.</p><span>첫 업무를 보내면 여기에 모입니다.</span></div>:null}</div>
    <div className="community-thread-pages">{beforeThread&&<button type="button" disabled={busy||!!pending} onClick={()=>{leaveThread(false);setBeforeThread(undefined);}}>최근 업무</button>}{nextThread&&<button type="button" disabled={busy||!!pending} onClick={()=>{leaveThread(false);setBeforeThread(nextThread);}}>이전 업무</button>}</div>
   </nav>
   <section className="community-conversation" aria-label={selected?'선택한 업무 대화':'새 업무 작성'} aria-busy={loading}>
   {(!!selected||writingNew)&&<button type="button" className="community-back" disabled={busy||!!pending} onClick={()=>leaveThread(false)}><ArrowLeft size={15} aria-hidden="true"/>업무 목록</button>}
   {support==='checking'&&!error&&<p className="community-feedback" role="status"><Loader2 size={16} className="community-spinner" aria-hidden="true"/>업무 스레드를 확인하고 있습니다…</p>}
   {error&&<p role="alert" className="community-feedback community-error">{error}</p>}
   {pending&&<div role="status" className="community-feedback community-pending"><Info size={17} aria-hidden="true"/><div>보낸 요청의 결과를 확인해야 합니다. <button type="button" disabled={busy} onClick={()=>void check()}>전송 결과 확인</button></div></div>}
   {loading&&<p className="community-feedback" role="status"><Loader2 size={16} className="community-spinner" aria-hidden="true"/>스레드를 여는 중…</p>}
   {!selected&&<header className="community-new-heading"><span className="community-new-icon"><MessageSquare size={22} aria-hidden="true"/></span><h3>어떤 업무를 맡길까요?</h3><p>{useMode?'선택한 제품의 허용된 운영 도구를 실행합니다.':'호출한 프로젝트마다 워크룸이 열립니다.'}<br/>각 프로젝트의 질문과 결과는 이 업무 스레드에 모입니다.</p></header>}
   {!selected&&<div className="community-call-projects" role="group" aria-label="호출할 프로젝트">
    <div className="community-call-chips">{called.map(id=><span key={id} className="community-call-chip" data-project-call={id}><AtSign size={14} aria-hidden="true"/>{projects.find(p=>p.targetId===id&&(p.executionRole??'dev')===executionRole)?.label??'권한 확인 필요'}{id!==targetId&&<button type="button" aria-label={(projects.find(p=>p.targetId===id)?.label??'프로젝트')+' 호출 취소'} disabled={busy||!!pending} onClick={()=>updateCalled(called.filter(v=>v!==id))}><X size={13}/></button>}</span>)}</div>
    <select aria-label="호출할 프로젝트 추가" value="" disabled={busy||!!pending||called.length>=8||useMode} onChange={e=>addCalled(e.target.value)}><option value="">+ 프로젝트 추가</option>{projects.filter(p=>p.executionRole!=='use'&&!called.includes(p.targetId)).map(p=><option key={p.targetId} value={p.targetId}>@{p.label}</option>)}</select>
    <small>{useMode?'USE는 위 목록에서 고른 한 제품의 운영 문맥을 유지합니다.':'업무 내용을 공유하며 각 @프로젝트가 자기 담당 범위를 수행합니다. 기준 프로젝트는 위 목록에서 바꿀 수 있습니다.'}</small>
   </div>}
   {thread?.id===selected&&<article className="community-thread" data-testid="community-task-thread">
   <header><span className="community-state" data-state={thread.state} role="status">{workroomThreadStateLabel(thread.state)}</span><h3 ref={heading} tabIndex={-1}>{thread.title}</h3>{thread.sessionId&&<button type="button" className="community-open-workroom" onClick={()=>onOpen(thread)}>연결 워크룸 열기<ArrowUpRight size={15} aria-hidden="true"/></button>}</header>
   {thread.participants&&<div className="community-participants" aria-label="연결된 프로젝트 워크룸">{thread.participants.map(member=><div key={member.targetId}><strong>@{member.label}</strong><span className="community-state" data-state={member.state}>{workroomThreadStateLabel(member.state)}</span><button type="button" disabled={!member.sessionId} onClick={()=>onOpen({...thread,id:member.threadId,agent:member.agent,sessionId:member.sessionId,participants:undefined},member.targetId)}>@{member.label} 워크룸 열기<ArrowUpRight size={14}/></button></div>)}</div>}
   {beforeMessage&&<button type="button" onClick={()=>setBeforeMessage(undefined)}>최근 대화</button>}{detail?.nextBefore&&<button type="button" disabled={busy} onClick={()=>setBeforeMessage(detail.nextBefore!)}>이전 대화 보기</button>}
   <div className="community-thread-messages" aria-live="polite">{detail?.messages?.map(m=><article key={m.id} className={'community-message community-message--'+m.role} data-kind={m.kind}><span className="community-message-avatar" aria-hidden="true">{m.role==='user'?<UserRound size={16}/>:m.role==='assistant'?<Bot size={17}/>:<Info size={16}/>}</span><div className="community-message-content"><header><strong>{m.projectLabel?'@'+m.projectLabel+' · ':''}{m.role==='user'?'사용자':m.role==='assistant'?(thread.execution?'USE · 제품 운영':aiTerminalAgentLabel(thread.agent)):'상태'}{m.kind==='question'&&<span className="community-question-label">질문</span>}</strong><time>{phoneDateTime(m.at)}</time></header><p>{m.text}</p>{m.delivery==='unknown'&&<small>전달 결과 확인 필요 · 자동 재전송하지 않음</small>}</div></article>)}</div>
   {thread.participants&&<label className="community-reply-project">답변할 프로젝트<select aria-label="답변할 프로젝트" value={replyMember?.targetId??''} disabled={busy||!!pending} onChange={e=>setReplyTarget(e.target.value)}>{thread.participants.map(m=><option key={m.targetId} value={m.targetId}>@{m.label} · {workroomThreadStateLabel(m.state)}</option>)}</select></label>}
   {nativeQuestion&&<p role="status">CLI 승인·선택은 연결 워크룸에서 현재 선택지를 확인하고 답하세요.</p>}
   {thread.state==='unknown'&&<button type="button" disabled={busy} onClick={async ()=>{if(!(await confirmAction('워크룸과 작업 결과를 직접 확인했나요? 스레드를 종료 표시하고 새 업무를 시작할 수 있게 합니다. 워크룸은 닫지 않습니다.')))return;setBusy(true);void call('workroom.threads.close',{threadId:thread.id,expectedRevision:thread.revision,consent:true}).then(r=>{if(alive.current)show(r);}).catch(e=>setError(String(e))).finally(()=>{if(alive.current)setBusy(false);});}}>결과 확인 후 스레드 종료 표시</button>}
   {thread.sessionId&&<details className="community-memory-panel"><summary>프로젝트 기억·저장 관리</summary><p className="community-memory-note">연결 워크룸의 세션 기억하기·자동 저장 설정을 따릅니다.</p><CommunityThreadMemory key={thread.sessionId} scope={scope+':'+thread.id} targetId={targetId} sessionId={thread.sessionId} transport={transport} visible={visible}/></details>}
  </article>}
  {composeVisible&&<div className="community-compose">
   <div className="community-compose-heading"><label htmlFor={fieldId}>{thread?'스레드에 답변':'업무 내용'}</label>{!selected&&<><label>역할<select aria-label="업무 역할" className="min-h-11 bg-[var(--surface)]" value={executionRole} disabled={busy||!!pending||initialRole==='use'&&!onSelectTarget} onChange={e=>setExecutionRole(e.target.value as 'dev'|'use')}><option value="dev">DEV · 제품 개발</option><option value="use">USE · 제품 사용·운영</option></select></label>{!useMode&&<label className="community-agent">작업 AI<span className="community-select"><select aria-label="업무 AI" value={agent} disabled={busy||!!pending} onChange={e=>setAgent(e.target.value as typeof agent)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="hermes">Hermes</option><option value="agy">Antigravity</option></select><ChevronDown size={14} aria-hidden="true"/></span></label>}</>}</div>
   {thread?.execution&&<p role="status">USE · 제품 사용·운영 · {thread.execution.serviceKey} · 원래 실행 문맥 유지</p>}
   {useMode&&<><ServiceUseOperationFields value={useFields} onChange={setUseFields} disabled={busy||!!pending||!catalog?.executionReady} catalog={catalog}/>{useCatalog?.key===catalogKey&&useCatalog.error&&<p role="alert">앱의 USE 동작 목록을 확인하지 못했습니다. <button type="button" onClick={()=>setCatalogRetry(n=>n+1)}>동작 목록 다시 확인</button></p>}</>}
   <textarea id={fieldId} ref={field} aria-label={thread?'스레드 답변':'프로젝트에 맡길 업무'} aria-describedby={fieldId+'-hint'+(textError?' '+fieldId+'-error':'')} aria-invalid={!!textError} value={draft} onChange={e=>{setDraft(e.target.value);setCaret(e.target.selectionStart);}} onSelect={e=>setCaret(e.currentTarget.selectionStart)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.nativeEvent.isComposing&&!composing.current){e.preventDefault();void send();}}} disabled={busy||!!pending} rows={4} placeholder={thread?'답변이나 추가 요청을 남겨 주세요.':`무엇을 해야 하나요? @로 프로젝트를 추가 호출할 수 있습니다.`}/>
   <ProjectStateBundlePreview targetId={targetId} contextKey={scope+':'+draftKey+':'+executionRole+':'+called.join(',')+':'+(replyMember?.targetId??'')} visible={visible} supported={stateSupported} request={projectState} disabled={busy||!!pending} onAttach={attachState}/>
   {thread&&<ReadToolBundlePanel targetId={targetId} threadId={thread.id} visible={visible} supported={batchSupported} request={readToolBatch} packs={workPacks} disabled={busy||!!pending}/>}
   {stateAttachment&&<div className="project-state-attached" data-testid="project-state-attached" data-invalid={stateAttachment.invalid} role={stateAttachment.invalid?'alert':'status'}><span>{stateAttachment.invalid?(stateAttachment.invalidReason==='context'?stateCopy.invalid:stateCopy.edited):stateCopy.attached}</span><button type="button" disabled={busy||!!pending} onClick={removeState}>{stateCopy.remove}</button></div>}
   {candidates.length>0&&<div className="community-mentions" role="group" aria-label="프로젝트 호출·참고 후보">{candidates.map(project=><button type="button" key={projectMentionKey(project)} onClick={()=>chooseMention(project)}>{workroomMentionQuery(draft,caret)?.kind==='reference'?'#':'@'}{project.label}</button>)}</div>}
   {textError&&<p id={fieldId+'-error'} className="community-error">{textError}</p>}
   <div className="community-compose-footer"><small id={fieldId+'-hint'}>{useMode?'선택한 USE 도구만 서버 권한검사 후 실행합니다.':thread?'연결 워크룸에도 전달됩니다.':called.length>1?`${called.length}개 프로젝트가 각각 워크룸에서 실행합니다.`:'선택한 기기·프로젝트에서 실행합니다.'}<span>{bytes.toLocaleString()} / 6,000바이트 · ⌘/Ctrl + Enter</span></small><button type="button" className="community-primary" disabled={busy||!!pending||support!=='ready'||!draft.trim()||!!textError||!!stateAttachment?.invalid} onClick={()=>void send()}>{busy?<Loader2 size={15} className="community-spinner" aria-hidden="true"/>:<Send size={15} aria-hidden="true"/>}{busy?'보내는 중…':thread?'답변 보내기':'업무 맡기기'}</button></div>
  </div>}
   </section>
  </div>
 </div>;
}
