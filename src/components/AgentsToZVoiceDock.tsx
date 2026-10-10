import {voiceInputHintText} from '../voiceInputStats';
import React,{useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {ChevronDown,ChevronUp,Maximize2,Mic,MicOff,Minimize2,Send,Settings2,Square,VolumeX} from 'lucide-react';
import {voiceMediaClient} from '../voiceMediaClient';
import type {VoiceTransport} from '../voiceSessionClient';
import {workroomMentionQuery} from '../workroomProjectMention';
import {voiceMentionReferences} from '../voiceMentionReferences';
import {VOICE_AGENT_NAMES,type VoiceActiveTarget,type VoiceProjectChoice,type VoiceProvider} from '../voiceSessionProtocol';
import {CLOSE_OPS_VOICE_EVENT,OPEN_OPS_VOICE_EVENT} from '../VoiceSessionPanel';
import {readVoiceConsent,readVoiceProvider,readVoiceRecord,voicePreferenceStorage,writeVoiceProvider,type VoiceCaptionMode} from '../voicePreferences';
import {validateDeviceName} from '../deviceName';
import {AgentsToZMascot} from './AgentsToZMascot';
import './AgentsToZVoiceDock.css';

/** The persistent 아젠투지 voice owner shared with the OPS panel (VoiceSessionPanel). */
export const OPS_VOICE_OWNER='voice-ops';
const partnerKey=(p:VoiceActiveTarget)=>p.kind==='ops'?'ops':p.targetId+':'+p.sessionId;
/** OPS is the 총괄; a project partner carries its own device name. */
export function voicePartnerName(p:VoiceActiveTarget,deviceName?:string){
  const checked=validateDeviceName(deviceName);
  if(p.kind!=='ops')return `${p.label} · ${VOICE_AGENT_NAMES[p.agent]??p.agent}${checked.ok?` · ${checked.value}`:''}`;
  return checked.ok?`총괄(${checked.value})`:'총괄';
}
/** The status line under 「아젠투지 호출」 (VOC 2026-09-29): who is answering right now. */
export function voiceDockStatus(p:VoiceActiveTarget|undefined,deviceName?:string){return !p||p.kind==='ops'?`${voicePartnerName({kind:'ops',label:''},deviceName)} 응답중`:`${voicePartnerName(p,deviceName)} 담당자 응답중`;}

/**
 * 아젠투지 voice dock — always on screen, on every page (VOC 2026-09-29). A tap calls 아젠투지 at once
 * (the first time asks for consent in the panel); while a conversation runs it says who is answering
 * — the 총괄, or a project's AI talked to directly — and a tap on a partner switches exactly like the
 * voice command. Subtitles show each finished line with its translation.
 */
/** A phone without the OPS project talks to one of its open workrooms instead (the voice it had before the dock). */
export interface VoiceWorkroomFallback {list():Promise<{targetId:string;sessionId:string;label:string}[]>;transport(targetId:string):VoiceTransport}
export function AgentsToZVoiceDock({transport,remote=false,deviceName,unavailableReason,unavailableStatus,onOpenOpsWorkroom,opsDevices,onOpenDeviceWorkroom,opsMissing=false,workroomFallback}:{transport:VoiceTransport;remote?:boolean;deviceName?:string;
  /** This device may not reach the OPS project; with `workroomFallback` a tap talks to an open workroom's AI. */
  opsMissing?:boolean;workroomFallback?:VoiceWorkroomFallback;
  /** The short status line when voice cannot start (e.g. 「Mac 연결 끊김」); the reason is shown on a tap. */
  unavailableStatus?:string;
  /** Mac: the OPS Workroom the old header chip opened, now in the dock menu. */
  onOpenOpsWorkroom?:()=>void;
  /** 커뮤니티에 들어와 있는 다른 아젠투지 — 「워크룸 열기」가 기기 목록이 된다(VOC 2026-10-05).
   *  음성으로 다른 호를 모는 것은 두 홉이라 느려서 넣지 않았다. 여는 것은 요청 한 번이다. */
  opsDevices?:readonly {key:string;name:string}[];
  onOpenDeviceWorkroom?:(key:string)=>void;
  /** Why 아젠투지 voice cannot start here (e.g. no OPS on this Mac); the dock still shows and explains. */
  unavailableReason?:string}){
  const state=useSyncExternalStore(voiceMediaClient.subscribe,voiceMediaClient.snapshot,voiceMediaClient.snapshot);
  const owns=state.owner===OPS_VOICE_OWNER,active=owns&&['preparing','listening','review'].includes(state.phase);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[menu,setMenu]=useState(false);
  // ⋯: pick any allowed project (and optionally its AI) — the same switch as 「<프로젝트> 담당자 불러」.
  const [picker,setPicker]=useState(false),[query,setQuery]=useState(''),[choices,setChoices]=useState<VoiceProjectChoice[]|null>(null),[agent,setAgent]=useState<''|'codex'|'claude'|'hermes'|'agy'>('');
  const [projectPage,setProjectPage]=useState<{total:number;nextOffset:number|null;legacy?:boolean}|null>(null);
  const [pickerError,setPickerError]=useState(''),[loadingMore,setLoadingMore]=useState(false);
  const pickerSeq=useRef(0);
  const [provider,setProviderState]=useState<VoiceProvider>(()=>readVoiceProvider(voicePreferenceStorage())??'openai');
  const dock=useRef<HTMLElement>(null);
  const [typed,setTyped]=useState('');
  // # 언급 (VOC 2026-09-30): 「#이름」 names a registered project — the 총괄 gets its exact id, a workroom its folder.
  const [route,setRoute]=useState<VoiceProjectChoice|null>(null);
  const [mentions,setMentions]=useState<VoiceProjectChoice[]>([]),[mentionChoices,setMentionChoices]=useState<VoiceProjectChoice[]|null>(null);
  const typedInput=useRef<HTMLInputElement>(null),mentionSeq=useRef(0),mentionTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const mentionKind=workroomMentionQuery(typed,typedInput.current?.selectionStart??typed.length)?.kind;
  const onType=(value:string,cursor:number)=>{
    setTyped(value);clearTimeout(mentionTimer.current);const seq=++mentionSeq.current;
    const q=workroomMentionQuery(value,cursor);if(!q){setMentionChoices(null);return;}
    // One search per pause, not per key: a phone's reads share a per-minute budget.
    mentionTimer.current=setTimeout(()=>void voiceMediaClient.searchProjects(q.query).then(list=>{if(seq===mentionSeq.current)setMentionChoices(list?.length?list:null);},()=>{if(seq===mentionSeq.current)setMentionChoices(null);}),200);
  };
  const chooseMention=(p:VoiceProjectChoice)=>{
    const input=typedInput.current,cursor=input?.selectionStart??typed.length,q=workroomMentionQuery(typed,cursor);if(!q)return;
    // @ 호출 becomes the chip (who gets this one message); # 언급 stays in the words as 「#이름」.
    const insert=q.kind==='route'?'':'#'+p.label+' ',at=q.start+insert.length;
    const next=typed.slice(0,q.start)+insert+typed.slice(cursor);
    setTyped(next);setMentionChoices(null);++mentionSeq.current;clearTimeout(mentionTimer.current);
    if(q.kind==='route')setRoute(p);else setMentions(list=>list.some(m=>m.id===p.id)?list:[...list,p].slice(-8));
    // Only if nothing was typed since: moving the caret under fast typing scrambled the words (「줘빌드해」).
    requestAnimationFrame(()=>{if(!input||input.value!==next)return;input.focus();input.setSelectionRange(at,at);});
  };
  const [rooms,setRooms]=useState<{targetId:string;sessionId:string;label:string}[]|null>(null);
  // Folded to one row so it does not cover a workroom's keys (VOC 2026-09-30); remembered on this device.
  const [folded,setFoldedState]=useState(()=>{try{return localStorage.getItem('agentstoz-voice-dock-folded')==='1';}catch{return false;}});
  const setFolded=(next:boolean)=>{setFoldedState(next);try{localStorage.setItem('agentstoz-voice-dock-folded',next?'1':'0');}catch{/* per-device convenience only */}};
  const [viewMode,setViewMode]=useState<'normal'|'compact'|'captions'>('normal');
  const captionList=useRef<HTMLOListElement>(null);
  const showView=(next:'normal'|'compact'|'captions')=>{
    setViewMode(next);setMenu(false);setPicker(false);setRooms(null);
    if(next!=='normal')window.dispatchEvent(new Event(CLOSE_OPS_VOICE_EVENT));
  };

  // The OPS panel sits above the dock instead of covering it.
  useLayoutEffect(()=>{
    const node=dock.current;if(!node||typeof ResizeObserver==='undefined')return;
    const root=document.documentElement,apply=()=>root.style.setProperty('--voice-dock-offset',viewMode==='captions'?'0px':Math.ceil(node.getBoundingClientRect().height+12)+'px');
    apply();const observer=new ResizeObserver(apply);observer.observe(node);
    return()=>{observer.disconnect();root.style.removeProperty('--voice-dock-offset');};
  },[viewMode]);
  useEffect(()=>{if(!active){setMenu(false);setPicker(false);setRoute(null);setMentions([]);setMentionChoices(null);}},[active]);
  useEffect(()=>{if(!active)setViewMode('normal');},[active]);
  useEffect(()=>{if(viewMode==='captions'&&captionList.current)captionList.current.scrollTop=captionList.current.scrollHeight;},[viewMode,state.captions.length]);
  // Pop-ups close like pop-ups (VOC 2026-09-30): outside click, Escape, or a new partner (voice or tap).
  useEffect(()=>{
    if(!menu&&!picker&&!rooms)return;
    const outside=(event:PointerEvent)=>{if(dock.current&&!dock.current.contains(event.target as Node)){setMenu(false);setPicker(false);setRooms(null);}};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMenu(false);setPicker(false);setRooms(null);}};
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape);};
  },[menu,picker,rooms]);
  const partnerNow=owns&&state.session?.activeTarget?JSON.stringify(state.session.activeTarget):'';
  useEffect(()=>{setPicker(false);},[partnerNow]);
  useEffect(()=>{
    const sequence=++pickerSeq.current;
    if(!picker||!active)return;
    setChoices(null);setProjectPage(null);setPickerError('');setLoadingMore(false);
    const timer=setTimeout(()=>{voiceMediaClient.searchProjectsPage(query).then(found=>{if(sequence!==pickerSeq.current)return;
      // An older Mac cannot list projects: open the voice panel instead, where voice can still name one.
      if(found===null){setPicker(false);openPanel();return;}
      setChoices(found.projects);setProjectPage(found);
    }).catch(e=>{if(sequence===pickerSeq.current)setPickerError(e instanceof Error?e.message:'프로젝트 목록을 불러오지 못했습니다.');});},query?250:0);
    return()=>{clearTimeout(timer);};
  },[picker,query,active]);
  const loadMore=async()=>{
    const offset=projectPage?.nextOffset;if(offset===null||offset===undefined||loadingMore)return;
    const sequence=pickerSeq.current;setLoadingMore(true);setPickerError('');
    try{
      const page=await voiceMediaClient.searchProjectsPage(query,offset);
      if(sequence!==pickerSeq.current)return;
      if(!page||page.legacy||page.nextOffset!==null&&page.nextOffset<=offset)throw Error('프로젝트 목록이 바뀌었습니다. 검색을 다시 해 주세요.');
      setChoices(previous=>[...(previous??[]),...page.projects.filter(choice=>!previous?.some(existing=>existing.id===choice.id))]);
      setProjectPage(page);
    }catch(e){if(sequence===pickerSeq.current)setPickerError(e instanceof Error?e.message:'프로젝트 목록을 더 불러오지 못했습니다.');}
    finally{if(sequence===pickerSeq.current)setLoadingMore(false);}
  };
  // A phone that switches to another Mac remounts the dock; the old Mac's conversation ends with it.
  useEffect(()=>()=>{if(remote&&voiceMediaClient.snapshot().owner===OPS_VOICE_OWNER)void voiceMediaClient.stop();},[remote]);
  const openPanel=()=>window.dispatchEvent(new Event(OPEN_OPS_VOICE_EVENT));
  // A phone never granted the OPS project gets told what to change instead of a generic scope error.
  const explain=(message:string)=>remote&&/프로젝트 범위를 허용/.test(message)?'이 기기에는 아젠투지(OPS) 프로젝트가 허용되지 않았습니다. Mac의 외부 인터넷 QR 원격제어에서 이 기기의 프로젝트 범위에 OPS를 추가하세요.':message;
  const run=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(e){setError(explain(e instanceof Error?e.message:'음성 요청을 확인하세요.'));}finally{setBusy(false);}};
  // The draft card has its own in-flight flag (VOC 2026-10-01: 보내기·버리기 looked live but did nothing while a typed
  // message or a partner switch was still on its way over the phone relay). It edits in place: the panel's editor sits
  // behind a tall dock on a phone, so 「고쳐서 보내기」 opening it looked like a dead button.
  const [draftBusy,setDraftBusy]=useState(false),[editText,setEditText]=useState<string|null>(null);
  const draftId=state.session?.draft?.id??null;
  useEffect(()=>{setEditText(null);},[draftId]);
  const runDraft=async(action:()=>Promise<unknown>)=>{if(draftBusy)return;setDraftBusy(true);setError('');try{await action();setEditText(null);}catch(e){setError(explain(e instanceof Error?e.message:'음성 요청을 확인하세요.'));}finally{setDraftBusy(false);}};
  /** Same consent/configured rules as 아젠투지 voice, on one workroom's own voice (phone without OPS). */
  const startWorkroom=async(room:{targetId:string;sessionId:string})=>{
    const via=workroomFallback!.transport(room.targetId),chosen=readVoiceProvider(voicePreferenceStorage())??'openai';
    if(!readVoiceConsent(voicePreferenceStorage(),chosen)){openPanel();return false;}
    const caps=await via({action:'capabilities',requestId:crypto.randomUUID()});
    if(!(caps.providers?.[chosen]?.configured??(chosen==='openai'&&!!caps.configured)))throw Error(`Mac의 ${chosen==='gemini'?'Gemini':'OpenAI'} 음성 설정에서 API 키를 연결하세요.`);
    setRooms(null);
    await voiceMediaClient.start(OPS_VOICE_OWNER,{kind:'workroom',targetId:room.targetId,sessionId:room.sessionId},'conversation',via,!!caps.historySupported&&readVoiceRecord(voicePreferenceStorage()),chosen);
    return true;
  };
  const startFallback=async()=>{
    const open=await workroomFallback!.list();
    if(!open.length)throw Error('이 기기에는 아젠투지(OPS)가 허용되지 않았습니다. 원격 작업에서 워크룸을 연 뒤 누르면 그 워크룸 AI와 음성으로 대화합니다.');
    if(open.length===1)return startWorkroom(open[0]!);
    setRooms(open);return false;
  };
  const start=async()=>{
    if(unavailableReason)throw Error(unavailableReason);
    if(opsMissing&&workroomFallback)return startFallback();
    const chosen=readVoiceProvider(voicePreferenceStorage())??'openai';
    // Consent is asked once, in the panel, and remembered on this device.
    if(!readVoiceConsent(voicePreferenceStorage(),chosen)){openPanel();return false;}
    const caps=await transport({action:'capabilities',requestId:crypto.randomUUID()});
    const configured=caps.providers?.[chosen]?.configured??(chosen==='openai'&&!!caps.configured);
    if(!configured){openPanel();return false;}
    await voiceMediaClient.start(OPS_VOICE_OWNER,{kind:'ops'},'conversation',transport,!!caps.historySupported&&readVoiceRecord(voicePreferenceStorage()),chosen);
    return true;
  };
  const call=()=>run(async()=>{
    if(active){openPanel();return;}
    await start();return;
  });
  const current=owns?state.session?.activeTarget:undefined;
  const listed=active&&state.partners?state.partners:[];
  // The one answering is always in the row, even before the list catches up with a voice switch.
  const partners=current?.kind==='workroom'&&listed.length&&!listed.some(p=>partnerKey(p)===partnerKey(current))?[listed[0]!,current,...listed.slice(1)]:listed;
  const draftPending=!!(owns&&state.session?.draft);
  // The hint promises what the host does: only when this Mac relays (never guessed from the partner alone).
  const relay=active&&state.relaySupported===true&&current?.kind==='workroom'?current:null;
  const status=!owns||state.phase==='idle'||state.phase==='ended'||state.phase==='failed'?(unavailableReason?unavailableStatus??'OPS 연결 필요':opsMissing&&workroomFallback?'눌러서 말하기 · 워크룸':'눌러서 말하기')
    :state.phase==='preparing'?'연결 중…':voiceDockStatus(current,deviceName)+(state.microphone?'':' · 마이크 꺼짐');
  // Subtitles step aside while a list is open, so nothing stacks up to the top of the screen.
  const lines=active&&state.captionMode!=='off'&&!picker&&!menu?state.captions.slice(folded?-1:-2):[];
  // Every voice error shows here (the panel is usually closed): a mic that will not resume, a muted reply, a failure.
  const shownError=error||(owns?explain(state.error):'');
  // Why it ended, or what was sent somewhere other than the current partner's box.
  const notice=owns&&state.session&&!shownError?state.session.notice:'';
  // Why a conversation ended is said once, for a few seconds — left up, it covered the page under the dock
  // (2026-10-02 iPhone 17: the Mac status line and 새로고침 sat behind 「음성 대화를 종료했습니다」 for an hour).
  const endedSessionId=state.phase==='ended'?state.session?.id??null:null;
  const [endedShown,setEndedShown]=useState<string|null>(null);
  useEffect(()=>{if(!endedSessionId)return;setEndedShown(endedSessionId);const t=setTimeout(()=>setEndedShown(current=>current===endedSessionId?null:current),8000);return()=>clearTimeout(t);},[endedSessionId]);
  const showNotice=!!notice&&(state.phase==='ended'&&endedShown===endedSessionId||active&&/에 보냄|전달하지 못함|입력하지 않았|입력하는 중|종료되어 총괄로/.test(notice));
  const setProvider=(next:VoiceProvider)=>{setProviderState(next);writeVoiceProvider(voicePreferenceStorage(),next);};
  if(active&&viewMode==='compact')return <aside ref={dock} className="az-voice-dock az-voice-dock--compact" data-testid="voice-dock" data-active="true" data-remote={remote?'true':'false'} aria-label="아젠투지 음성 · 대화 중">
    <button type="button" className="az-voice-dock__compact-button" data-testid="voice-dock-restore" aria-label="음성 창 펼치기 · 대화 계속 중" title="대화는 계속됩니다 · 음성 창 펼치기" onClick={()=>showView('normal')}><AgentsToZMascot size={28}/><span className="az-voice-dock__live-dot"/><span className="az-voice-dock__sr-only">{draftPending?'보낼 지시 초안 대기 중':status}</span></button>
  </aside>;
  if(active&&viewMode==='captions')return <aside ref={dock} className="az-voice-dock az-voice-dock--fullscreen" data-testid="voice-dock" data-active="true" data-remote={remote?'true':'false'} aria-label="아젠투지 자막 전체 화면">
    <section className="az-voice-dock__fullscreen-panel" role="dialog" aria-modal="true" aria-label="아젠투지 자막 전체 화면" data-testid="voice-dock-fullscreen">
      <header className="az-voice-dock__fullscreen-header"><div><strong>아젠투지 자막</strong><small>{status}</small></div><div className="az-voice-dock__fullscreen-actions">
        <button type="button" data-testid="voice-dock-fullscreen-minimize" onClick={()=>showView('compact')}>창 내리기</button>
        <button type="button" data-testid="voice-dock-fullscreen-close" onClick={()=>showView('normal')}>작게 보기</button>
      </div></header>
      <ol ref={captionList} className="az-voice-dock__fullscreen-captions" data-testid="voice-dock-fullscreen-captions" aria-live="polite">
        {state.captionMode==='off'?<li className="az-voice-dock__fullscreen-empty">자막이 꺼져 있습니다. 아래에서 자막을 켜세요.</li>:state.captions.length?state.captions.map(line=><li key={line.id} data-role={line.role}><b>{line.role==='user'?'나':'아젠투지'}</b><span>{line.text}</span>{state.captionMode==='bilingual'&&<small data-state={line.state}>{line.translation??(line.state==='translating'?'통역 중…':'')}</small>}</li>):<li className="az-voice-dock__fullscreen-empty">말씀하시면 자막이 여기에 표시됩니다.</li>}
      </ol>
      <footer className="az-voice-dock__fullscreen-footer"><label>자막 <select aria-label="전체 화면 자막" value={state.captionMode} onChange={e=>voiceMediaClient.setCaptionMode(e.target.value as VoiceCaptionMode)}><option value="bilingual">원문 + 통역</option><option value="original">원문만</option><option value="off">끄기</option></select></label>
        <button type="button" onClick={()=>state.microphone?voiceMediaClient.finishInput():void run(()=>voiceMediaClient.resumeInput())} disabled={!state.microphone&&state.phase!=='review'}>{state.microphone?'마이크 끄기':'마이크 켜기'}</button>
        <button type="button" onClick={()=>void voiceMediaClient.stop()}>음성 종료</button></footer>
    </section>
  </aside>;
  return <aside ref={dock} className="az-voice-dock" data-testid="voice-dock" data-active={active?'true':'false'} data-remote={remote?'true':'false'} aria-label="아젠투지 음성">
    {lines.length>0&&<ol className="az-voice-dock__captions" data-testid="voice-dock-captions" aria-live="polite">
      {lines.map(line=><li key={line.id} data-role={line.role}>
        <span className="az-voice-dock__said"><b>{line.role==='user'?'나':'아젠투지'}</b>{line.text}</span>
        {state.captionMode==='bilingual'&&<span className="az-voice-dock__translation" data-state={line.state}>{line.translation??(line.state==='translating'?'통역 중…':'')}</span>}
      </li>)}
    </ol>}
    {/* Things that come and go sit above the character so it stays put; the partners sit under it. */}
    {rooms&&!active&&<div className="az-voice-dock__picker" data-testid="voice-dock-rooms">
      <p className="az-voice-dock__hint">이 기기에는 아젠투지(OPS)가 허용되지 않아, 열린 워크룸의 AI와 음성으로 대화합니다. 어느 워크룸과 말할까요?</p>
      <ul>{rooms.map(room=><li key={room.sessionId}><button type="button" data-testid="voice-dock-room" disabled={busy} onClick={()=>void run(()=>startWorkroom(room))}>{room.label}</button></li>)}</ul>
      <button type="button" className="az-voice-dock__text-button" onClick={()=>setRooms(null)}>닫기</button>
    </div>}
    {picker&&active&&<div className="az-voice-dock__picker" data-testid="voice-dock-picker">
      <input type="search" aria-label="이 기기 프로젝트 검색" placeholder="이 기기 프로젝트 이름·별명·초성 검색" value={query} autoFocus onChange={e=>{++pickerSeq.current;setChoices(null);setProjectPage(null);setQuery(e.target.value);}} maxLength={300}/>
      <label>담당 AI<select aria-label="담당 AI" data-testid="voice-dock-picker-agent" value={agent} onChange={e=>setAgent(e.target.value as typeof agent)}>
        <option value="">실행 중인 AI · 없으면 Codex</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="hermes">Hermes</option><option value="agy">Antigravity</option></select></label>
      {draftPending&&<p className="az-voice-dock__hint" data-testid="voice-dock-picker-locked">초안을 보내거나 버린 뒤 대화 상대를 바꿀 수 있습니다.</p>}
      {pickerError&&<p className="az-voice-dock__error" role="alert">{pickerError}</p>}
      {choices===null?(!pickerError&&<p className="az-voice-dock__hint" role="status">불러오는 중…</p>):choices.length===0?<p className="az-voice-dock__hint">찾는 프로젝트가 없습니다.</p>:<>
        <p className="az-voice-dock__hint" role="status" data-testid="voice-dock-picker-count">{projectPage?.legacy?`현재 ${choices.length}개 표시 · 다른 프로젝트는 검색하세요`:`선택 가능한 ${projectPage?.total??choices.length}개 중 ${choices.length}개 표시`}{choices.length>6?' · 목록 스크롤':''}</p>
        <ul aria-label="검색된 프로젝트">{choices.map(choice=><li key={choice.id}><button type="button" data-testid="voice-dock-pick" disabled={busy||draftPending} title={draftPending?'초안을 보내거나 버린 뒤 대화 상대를 바꿀 수 있습니다':undefined}
          onClick={()=>void run(async()=>{await voiceMediaClient.switchPartner({kind:'project',targetId:choice.id,...(agent?{agent}:{})});setPicker(false);})}>{choice.label}{validateDeviceName(deviceName).ok?` · ${deviceName!.trim()}`:''}</button></li>)}</ul>
        {projectPage?.nextOffset!==null&&projectPage?.nextOffset!==undefined&&<button type="button" className="az-voice-dock__text-button" data-testid="voice-dock-picker-more" disabled={loadingMore} onClick={()=>void loadMore()}>{loadingMore?'더 불러오는 중…':'더 보기'}</button>}
      </>}
    </div>}
    {menu&&<div className="az-voice-dock__menu" data-testid="voice-dock-menu">
      {/* Always changeable (VOC 2026-09-30: a locked picker read as broken). A running conversation keeps its provider. */}
      <label>음성 제공자<select aria-label="음성 제공자" data-testid="voice-dock-provider" value={provider} onChange={e=>setProvider(e.target.value as VoiceProvider)}><option value="openai">OpenAI Realtime</option><option value="gemini">Gemini Live</option></select></label>
      {active&&state.session&&state.session.provider!==provider&&<p className="az-voice-dock__hint" data-testid="voice-dock-provider-next">지금 대화는 {state.session.provider==='openai'?'OpenAI':'Gemini'}로 계속되고, 다음 대화부터 {provider==='openai'?'OpenAI':'Gemini'}를 씁니다.</p>}
      <label>자막<select aria-label="자막" data-testid="voice-dock-caption-mode" value={state.captionMode} onChange={e=>voiceMediaClient.setCaptionMode(e.target.value as VoiceCaptionMode)}>
        <option value="bilingual">원문 + 통역 (한↔영)</option><option value="original">원문만</option><option value="off">끄기</option></select></label>
      <button type="button" onClick={()=>{setMenu(false);openPanel();}}>{remote||active?'음성 창 열기':'모델·키·기록 설정 열기'}</button>
      {onOpenOpsWorkroom&&<button type="button" data-testid="voice-dock-open-ops-workroom" onClick={()=>{setMenu(false);onOpenOpsWorkroom();}}>{opsDevices?.length?`OPS 워크룸 열기 · ${deviceName?.trim()||'이 기기'}`:'OPS 워크룸 열기'}</button>}
      {onOpenDeviceWorkroom&&(opsDevices??[]).map(device=><button key={device.key} type="button"
        data-testid={'voice-dock-open-device-workroom-'+device.key}
        title={`${device.name}의 OPS 워크룸을 워크룸 화면에서 엽니다.`}
        onClick={()=>{setMenu(false);onOpenDeviceWorkroom(device.key);}}>OPS 워크룸 열기 · {device.name}</button>)}
    </div>}
    {/* A draft 아젠투지 made waits for the person; the dock must say so, or it looks like nothing happened. */}
    {active&&state.session?.draft&&<div className="az-voice-dock__draft" data-testid="voice-dock-draft" role="group" aria-label="보낼 지시 초안">
      {editText===null
        ?<p><b>📝 {state.session.draft.label}에 보낼 초안</b>{state.session.draft.text}</p>
        :<label><b>📝 {state.session.draft.label}에 보낼 초안 고치기</b><textarea data-testid="voice-dock-draft-edit" aria-label="보낼 지시 고치기" value={editText} rows={4} maxLength={4000} disabled={draftBusy} onChange={e=>setEditText(e.target.value)}/></label>}
      <p className="az-voice-dock__hint">{draftBusy?'보내는 중… Mac의 답을 기다립니다.':editText===null?'「보내」라고 말하거나 아래 버튼을 누르세요. 보내거나 버린 뒤 대화 상대를 바꿀 수 있습니다. 워크룸이 질문을 기다리면 Mac이 보내지 않고 알려 줍니다.':'고친 내용을 보내면 이 글이 그대로 워크룸에 입력됩니다.'}</p>
      <div><button type="button" className="az-voice-dock__send" data-testid="voice-dock-draft-send" disabled={draftBusy||editText!==null&&!editText.trim()} onClick={()=>{const text=editText??state.session!.draft!.text;void runDraft(()=>voiceMediaClient.submit(text,true));}}>{draftBusy?'초안 보내는 중…':editText===null?'초안 보내기':'고친 내용 보내기'}</button>
        <button type="button" data-testid="voice-dock-draft-discard" disabled={draftBusy} onClick={()=>void runDraft(()=>voiceMediaClient.discard())}>버리기</button>
        <button type="button" data-testid="voice-dock-draft-edit-toggle" disabled={draftBusy} onClick={()=>setEditText(editText===null?state.session!.draft!.text:null)}>{editText===null?'고쳐서 보내기':'고치기 취소'}</button></div>
    </div>}
    {showNotice&&<p className="az-voice-dock__notice" role="status" data-testid="voice-dock-notice">{notice.replace('AgentsToZ OPS','아젠투지')}</p>}
    {shownError&&<p className="az-voice-dock__error" role="alert" data-testid="voice-dock-error">{shownError}</p>}
    {owns&&active&&!shownError&&state.inputHint&&<p className="az-voice-dock__notice" role="status" data-testid="voice-dock-input-hint" data-hint={state.inputHint}>{voiceInputHintText(state.inputHint,state.device)}</p>}
    <div className="az-voice-dock__main">
      <button type="button" className="az-voice-dock__call" data-testid="voice-dock-call" disabled={busy} onClick={()=>void call()}
        aria-label={active?`아젠투지 · ${status} · 음성 창 열기`:'아젠투지 호출 · 음성 시작'} title={active?'음성 창 열기':'아젠투지를 불러 바로 말합니다'}>
        <AgentsToZMascot size={34}/>
        <span><strong>아젠투지 호출</strong><small data-testid="voice-dock-status" data-plain={!active&&status==='눌러서 말하기'?'true':undefined}>{status}</small></span>
      </button>
      {active&&<div className="az-voice-dock__controls">
        {state.microphone
          ?<button type="button" data-testid="voice-dock-mic" aria-label="마이크 끄기" title="마이크 끄기" onClick={()=>voiceMediaClient.finishInput()}><Mic size={15}/></button>
          :<button type="button" data-testid="voice-dock-mic" aria-label="마이크 켜기" title="마이크 켜기" disabled={state.phase!=='review'} onClick={()=>void run(()=>voiceMediaClient.resumeInput())}><MicOff size={15}/></button>}
        {state.muted&&<button type="button" data-testid="voice-dock-speaker" aria-label="답변 소리 켜기" title="답변 소리 켜기" onClick={()=>voiceMediaClient.toggleSpeaker()}><VolumeX size={15}/></button>}
        <button type="button" data-testid="voice-dock-stop" aria-label="음성 종료" title="음성 종료" onClick={()=>void voiceMediaClient.stop()}><Square size={13}/></button>
        <button type="button" data-testid="voice-dock-fold" aria-label={folded?'대화 상대·입력칸 펼치기':'한 줄로 접기'} aria-expanded={!folded} title={folded?'대화 상대·입력칸 펼치기':'한 줄로 접기 · 화면을 덜 가립니다'} onClick={()=>{if(folded)void voiceMediaClient.refreshPartners().catch(()=>{});setFolded(!folded);setPicker(false);}}>{folded?<ChevronUp size={15}/>:<ChevronDown size={15}/>}</button>
        <button type="button" data-testid="voice-dock-fullscreen-open" aria-label="자막 전체 화면" title="자막 전체 화면" onClick={()=>showView('captions')}><Maximize2 size={15}/></button>
        <button type="button" data-testid="voice-dock-minimize" aria-label="작은 아이콘으로 내리기" title="대화를 유지하며 작은 아이콘으로 내리기" onClick={()=>showView('compact')}><Minimize2 size={15}/></button>
      </div>}
      <button type="button" className="az-voice-dock__settings" data-testid="voice-dock-settings" aria-label="음성 설정" aria-expanded={menu} title="음성 제공자·자막 설정" onClick={()=>{setProviderState(readVoiceProvider(voicePreferenceStorage())??'openai');setMenu(v=>!v);setPicker(false);}}><Settings2 size={15}/></button>
    </div>
    {active&&!folded&&state.partnersSupported!==false&&partners.length>0&&<div className="az-voice-dock__partners" role="group" aria-label="대화 상대" data-testid="voice-dock-partners">
      {partners.map(p=>{const selected=!!current&&partnerKey(current)===partnerKey(p)||!current&&p.kind==='ops';
        return <button type="button" key={partnerKey(p)} aria-pressed={selected} data-testid={p.kind==='ops'?'voice-dock-partner-ops':'voice-dock-partner'} disabled={busy||selected||draftPending} title={draftPending&&!selected?'초안을 보내거나 버린 뒤 대화 상대를 바꿀 수 있습니다':undefined}
          onClick={()=>void run(()=>voiceMediaClient.switchPartner(p.kind==='ops'?{kind:'ops'}:{kind:'workroom',targetId:p.targetId,sessionId:p.sessionId}))}>{selected?'✓ ':''}{voicePartnerName(p,deviceName)}</button>;})}
      <button type="button" data-testid="voice-dock-partner-more" aria-expanded={picker} aria-label="이 기기의 다른 프로젝트 담당자 고르기" title="이 기기의 다른 프로젝트 담당자 고르기 · 「<이름> 담당자 불러」라고 말해도 됩니다" onClick={()=>{setQuery('');setChoices(null);setPicker(v=>!v);setMenu(false);}}>⋯</button>
    </div>}
    {relay&&!folded&&<p className="az-voice-dock__hint az-voice-dock__relay" data-testid="voice-dock-relay">말하거나 입력하면 {voicePartnerName(relay,deviceName)} 워크룸에 그대로 들어갑니다 · 아젠투지에게는 「아젠투지, …」</p>}
    {active&&!folded&&mentionChoices&&<div className="az-voice-dock__mentions" role="listbox" aria-label={mentionKind==='route'?'호출할 프로젝트 선택':'언급할 프로젝트 선택'} data-testid="voice-dock-mentions">
      {mentionChoices.map((p,index)=><button type="button" role="option" aria-selected={index===0} key={p.id} onMouseDown={e=>e.preventDefault()} onClick={()=>chooseMention(p)}>{mentionKind==='route'?'@':'#'} {p.label}{validateDeviceName(deviceName).ok?` · ${deviceName!.trim()}`:''}</button>)}
    </div>}
    {active&&!folded&&<form className="az-voice-dock__type" data-testid="voice-dock-type" onSubmit={e=>{e.preventDefault();const text=typed;if(!text.trim())return;const refs=voiceMentionReferences(text,mentions);void run(async()=>{await voiceMediaClient.sendText(text,refs,route?.id);setTyped('');setMentions([]);setMentionChoices(null);setRoute(null);});}}>
      {/* This box talks to the 아젠투지 voice AI, not the workroom's CLI (VOC 2026-09-30: 「…· Codex에게」 read as typing into Codex). */}
      {/* While talking to a project AI the words go into its workroom as-is (relay); otherwise to 아젠투지. */}
      {route&&<button type="button" className="az-voice-dock__route" data-testid="voice-dock-route" title="이 한 번의 입력만 그 프로젝트 워크룸에 넣습니다. 대화 상대는 바뀌지 않습니다. 눌러서 취소" onClick={()=>setRoute(null)}>@ {route.label}{validateDeviceName(deviceName).ok?` · ${deviceName!.trim()}`:''} ×</button>}
      <input aria-label={route?`${route.label} 워크룸에 맡길 내용`:relay?`${voicePartnerName(relay,deviceName)} 워크룸에 입력`:'아젠투지에게 입력'} placeholder={route?`${route.label}에 맡길 내용 · 대화 상대는 그대로`:(relay?`${voicePartnerName(relay,deviceName)}에 그대로 입력 · @@아젠투지 로 총괄에게`:'아젠투지에게 입력')+(state.partnersSupported?' · @ 호출 · # 언급':'')} title={relay?`말하거나 입력하면 ${voicePartnerName(relay,deviceName)} 워크룸에 「현재 세션에 전송」처럼 그대로 들어가고, 결과를 아젠투지가 읽어 줍니다. 아젠투지에게 말하려면 「아젠투지, …」로 시작하세요.`:'총괄 아젠투지에게 글로 말합니다. 답은 음성으로 옵니다.'} ref={typedInput} value={typed} maxLength={1300} disabled={busy} onChange={e=>onType(e.target.value,e.target.selectionStart??e.target.value.length)}
        onKeyDown={e=>{if(e.nativeEvent.isComposing||!mentionChoices)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setMentionChoices(null);}else if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();chooseMention(mentionChoices[0]!);}}}/>
      <button type="submit" aria-label="입력한 글 보내기" title="입력한 글 보내기 (Enter)" disabled={busy||!typed.trim()}><Send size={14}/></button>
    </form>}
  </aside>;
}
