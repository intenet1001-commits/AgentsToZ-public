import type {WorkroomTransport} from './WorkroomSessionFooter';
import React,{useEffect,useId,useRef,useState,useSyncExternalStore} from 'react';
import {Mic} from 'lucide-react';
import {voiceMediaClient} from './voiceMediaClient';
import {openPreferredBrowser} from './openPreferredBrowser';
import {VOICE_API_KEY_PAGES} from './voiceApiKeyLinks';
import {localVoiceTransport,remoteVoiceTransport,type VoiceTransport} from './voiceSessionClient';
import {VOICE_SENT_NOTICE} from './voiceSessionProtocol';
import type {VoiceMode,VoiceProvider,VoiceResponse,VoiceTarget} from './voiceSessionProtocol';
import {readVoiceConsent,readVoiceProvider,readVoiceRecord,voicePreferenceStorage,writeVoiceConsent,writeVoiceProvider,writeVoiceRecord,type VoiceCaptionMode} from './voicePreferences';
import {clientSecretStoreLabel,thisMachineLabel} from './clientPlatform';
import './VoiceSessionPanel.css';

/** Opens the OPS voice panel from elsewhere (the voice dock, the phone's OPS section). */
export const OPEN_OPS_VOICE_EVENT='agentstoz:open-ops-voice';
export const CLOSE_OPS_VOICE_EVENT='agentstoz:close-ops-voice';
/**
 * Under a workroom's input box: what 아젠투지 just typed into this workroom by voice or dock text
 * (VOC 2026-09-30 — the person should see the instruction land where they would have typed it).
 * Read from the host's own notice, so no new wire field is needed.
 */
export function VoiceSentReceipt({sessionId}:{sessionId:string}){
  const state=useSyncExternalStore(voiceMediaClient.subscribe,voiceMediaClient.snapshot,voiceMediaClient.snapshot);
  const session=state.owner==='voice-ops'&&['listening','review'].includes(state.phase)?state.session:null;
  if(!session||session.activeTarget?.kind!=='workroom'||session.activeTarget.sessionId!==sessionId||!session.notice.startsWith(VOICE_SENT_NOTICE))return null;
  return <p className="ai-terminal-hint" role="status" data-testid="workroom-voice-sent">🎙 {session.notice}</p>;
}
/** The voice runtime keeps its internal target label; the screen says 아젠투지 (docs/ui-glossary.md). */
export const voiceTargetDisplayLabel=(label:string)=>label==='AgentsToZ OPS'?'아젠투지':label;

export function VoiceButton({target,label,transport=localVoiceTransport,remote=false,disabled=false,visible=true,hideTrigger=false,openOnEvent=false}:{
  target:VoiceTarget;label:string;transport?:VoiceTransport;remote?:boolean;disabled?:boolean;visible?:boolean;
  /** Keep the panel (and, for a workroom-target voice, its mini bar) but let another control open it. The app mounts
   * only the OPS panel now; the workroom branch stays for the host's workroom-target voice and its UI tests. */
  hideTrigger?:boolean;
  /** Open on {@link OPEN_OPS_VOICE_EVENT}; exactly one mounted OPS button should listen. */
  openOnEvent?:boolean;
}){
  // 아젠투지 (OPS) voice is one conversation per surface that outlives tabs and pages — the voice dock
  // (components/AgentsToZVoiceDock.tsx) starts and shows it; on a phone too (VOC 2026-09-29).
  const componentOwner=useId(),persistentOps=target.kind==='ops',owner=persistentOps?'voice-ops':componentOwner,binding=JSON.stringify(target),state=useSyncExternalStore(voiceMediaClient.subscribe,voiceMediaClient.snapshot);
  const [open,setOpen]=useState(false),[mode,setMode]=useState<VoiceMode>(target.kind==='ops'?'conversation':'dictation');
  // One provider for OPS and every Workroom: only one voice conversation runs at a time.
  const [provider,setProviderState]=useState<VoiceProvider>(()=>readVoiceProvider(voicePreferenceStorage())??'openai');
  const selectedProvider=useRef(provider),providerSelectionRevision=useRef(0);
  const [settings,setSettings]=useState<VoiceResponse|null>(null),[key,setKey]=useState(''),[model,setModel]=useState('gpt-realtime-2.1');
  const editedModelProvider=useRef<VoiceProvider|null>(null),editedKeyProvider=useRef<VoiceProvider|null>(null);
  const setProvider=(next:VoiceProvider)=>{selectedProvider.current=next;providerSelectionRevision.current++;editedModelProvider.current=null;editedKeyProvider.current=null;setKey('');setProviderState(next);writeVoiceProvider(voicePreferenceStorage(),next);};
  // The saving choice is remembered, so the dock's one-tap start follows it (review 2026-09-30).
  const [recordConsent,setRecordConsentState]=useState(()=>readVoiceRecord(voicePreferenceStorage()));
  const setRecordConsent=(on:boolean)=>{setRecordConsentState(on);writeVoiceRecord(voicePreferenceStorage(),on);};
  const [consent,setConsentState]=useState(()=>readVoiceConsent(voicePreferenceStorage(),readVoiceProvider(voicePreferenceStorage())??'openai')),[ready,setReady]=useState(false),[draft,setDraft]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [saving,setSaving]=useState(false),[settingsNotice,setSettingsNotice]=useState('');
  const [settingsOpen,setSettingsOpen]=useState(false),[editingKey,setEditingKey]=useState(false);
  const feedback=useRef<HTMLDivElement>(null),settingsFeedback=useRef<HTMLDivElement>(null),pending=useRef(false);
  const dirtyDraft=useRef(false),alive=useRef(true),currentTransport=useRef(transport);currentTransport.current=transport;
  const owns=state.owner===owner,active=owns&&['preparing','listening','review'].includes(state.phase),session=owns?state.session:null;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(!persistentOps&&voiceMediaClient.snapshot().owner===owner)void voiceMediaClient.stop();};},[owner,binding,persistentOps]);
  useEffect(()=>{if(!persistentOps&&(!visible||disabled)&&voiceMediaClient.snapshot().owner===owner)void voiceMediaClient.stop();},[visible,disabled,owner,persistentOps]);
  useEffect(()=>{if(!open)return;let valid=true;const selectionRevision=providerSelectionRevision.current;setError('');void currentTransport.current({action:'capabilities',requestId:crypto.randomUUID()}).then(r=>{if(valid){const openai=r.providers?.openai??{configured:!!r.configured,model:r.model??'gpt-realtime-2.1',keySource:r.keySource};const saved=readVoiceProvider(voicePreferenceStorage());const next=providerSelectionRevision.current!==selectionRevision?selectedProvider.current:saved&&(r.providers?.[saved]?.configured??(saved==='openai'&&r.configured))?saved:!openai.configured&&r.providers?.gemini?.configured?'gemini':provider;selectedProvider.current=next;setProviderState(next);setSettings(r);if(!(r.providers?.[next]?.configured??(next==='openai'&&r.configured)))setSettingsOpen(true);if(editedModelProvider.current!==next)setModel(r.providers?.[next]?.model??(next==='openai'?r.model:'gemini-3.8-live')??'gpt-realtime-2.1');}}).catch(e=>{if(valid)setError(e.message)});return()=>{valid=false;};},[open,binding]);
  useEffect(()=>{if(session?.draft){if(!dirtyDraft.current)setDraft(session.draft.text);setReady(false);}else{setDraft('');dirtyDraft.current=false;}},[session?.draft?.id]);
  const run=async(action:()=>Promise<unknown>)=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await action();}catch(e){if(alive.current)setError(e instanceof Error?e.message:typeof e==='string'?e:'음성 요청을 확인하세요.');}finally{pending.current=false;if(alive.current)setBusy(false);}};
  const providerSettings=settings?.providers?.[provider]??(provider==='openai'&&settings?{configured:!!settings.configured,model:settings.model??'gpt-realtime-2.1',keySource:settings.keySource}:undefined);
  const providerName=provider==='openai'?'OpenAI':'Gemini',keyDraft=!!key.trim(),modelDraft=!!providerSettings&&model.trim()!==providerSettings.model;
  useEffect(()=>{if(providerSettings){if(editedModelProvider.current!==provider)setModel(providerSettings.model);if(editedKeyProvider.current!==provider)setKey('');setEditingKey(editedKeyProvider.current===provider&&providerSettings.configured);setSettingsNotice('');}if(provider==='gemini')setMode('conversation');},[provider,providerSettings?.model]);
  useEffect(()=>{if(open&&(error||settingsNotice))(error?feedback:settingsFeedback).current?.scrollIntoView({block:'nearest'});},[open,error,settingsNotice]);
  const saveSettings=()=>run(async()=>{
    if(providerSettings?.configured&&!keyDraft&&!modelDraft)return;
    setSettingsNotice('');setSaving(true);
    try{
      const submittedModel=model.trim();
      if(!providerSettings?.configured&&!keyDraft)throw Error(`${providerName} API 키를 입력한 뒤 저장하세요.`);
      const saved=await transport({action:'configure',requestId:crypto.randomUUID(),provider,model:submittedModel,...(keyDraft?{apiKey:key.trim()}:{})});
      if(!(saved.providers?.[provider]?.configured??(provider==='openai'&&saved.configured)))throw Error('키 저장 완료를 확인하지 못했습니다. 입력한 키는 유지했습니다.');
      const confirmed=await transport({action:'capabilities',requestId:crypto.randomUUID()});
      setSettings(confirmed);
      const receipt=confirmed.providers?.[provider]??(provider==='openai'?{configured:!!confirmed.configured,model:confirmed.model}:undefined);
      if(!receipt?.configured||receipt.model!==submittedModel)throw Error('저장된 설정을 다시 확인하지 못했습니다. 입력한 키는 유지했습니다.');
      editedModelProvider.current=null;editedKeyProvider.current=null;setKey('');setEditingKey(false);setModel(receipt.model!);setSettingsNotice(`${providerName} 설정 저장 완료. 저장된 키로 음성을 시작할 수 있습니다. 실제 연결은 시작할 때 확인합니다.`);
    }finally{setSaving(false);}
  });
  // Consent is asked once per provider and remembered on this device; it can be withdrawn here.
  // A check made in this panel survives switching providers back and forth; it is stored only on start.
  const sessionConsent=useRef<Partial<Record<VoiceProvider,boolean>>>({});
  const setConsent=(checked:boolean)=>{setConsentState(checked);sessionConsent.current[provider]=checked;if(!checked)writeVoiceConsent(voicePreferenceStorage(),provider,false);};
  useEffect(()=>{setConsentState(sessionConsent.current[provider]??readVoiceConsent(voicePreferenceStorage(),provider));},[provider]);
  const rememberedConsent=readVoiceConsent(voicePreferenceStorage(),provider);
  useEffect(()=>{if(!openOnEvent)return;const openPanel=()=>setOpen(true);window.addEventListener(OPEN_OPS_VOICE_EVENT,openPanel);return()=>window.removeEventListener(OPEN_OPS_VOICE_EVENT,openPanel);},[openOnEvent]);
  useEffect(()=>{if(!openOnEvent)return;const closePanel=()=>setOpen(false);window.addEventListener(CLOSE_OPS_VOICE_EVENT,closePanel);return()=>window.removeEventListener(CLOSE_OPS_VOICE_EVENT,closePanel);},[openOnEvent]);
  const titleId=owner+'-voice-title';
  return <>
    {!hideTrigger&&<button type="button" className="voice-launch" data-testid={target.kind==='ops'?'ops-voice-button':'workroom-voice-button'} disabled={disabled} aria-label={label+(active?' · 음성 대화 창 열기':' · 음성 시작')} onClick={()=>setOpen(true)}><Mic size={15}/>{active?'음성 대화 중':target.kind==='ops'?'아젠투지 호출':'음성'}</button>}
    {/* 아젠투지 (OPS) voice shows in the always-on dock; only a workroom-fixed voice keeps this mini bar. */}
    {target.kind!=='ops'&&!disabled&&visible&&!open&&active&&<aside className="voice-mini" aria-label="진행 중인 음성 대화"><span><strong>{state.microphone?'● 마이크 켜짐':state.phase==='review'?'마이크 꺼짐 · 대화 유지':'음성 연결 중'}</strong><small>{voiceTargetDisplayLabel(session?.label??label)}</small></span>{!state.microphone&&state.phase==='review'&&<button type="button" onClick={()=>void voiceMediaClient.resumeInput()}>마이크 켜기</button>}<button type="button" onClick={()=>setOpen(true)}>음성 창 열기</button><button type="button" onClick={()=>void voiceMediaClient.stop()}>음성 종료</button></aside>}
    {open&&<section role="dialog" aria-modal="false" aria-labelledby={titleId} className="voice-panel" data-testid="voice-panel">
      <header><div><h2 id={titleId}>{voiceTargetDisplayLabel(label)} · 음성 대화</h2><p>{target.kind==='ops'?'음성 연결을 유지하며 아젠투지와 프로젝트 담당 AI를 전환할 수 있습니다.':'이 프로젝트 워크룸에 고정된 음성 대화입니다.'}</p></div><button type="button" aria-label={active?'음성 창 내리기':'음성 패널 닫기'} title={active?'창만 내립니다. 음성 대화는 계속됩니다.':undefined} onClick={()=>{editedKeyProvider.current=null;setKey('');setEditingKey(false);setOpen(false);}}>{active?'내리기':'닫기'}</button></header>
      <p className="voice-status" role="status">{owns&&state.microphone?'● 마이크 켜짐':active?'마이크 꺼짐':'마이크 대기'} · {owns&&state.phase==='preparing'?'연결 준비 중':voiceTargetDisplayLabel(session?.label??label)}</p>
      {session?.activeTarget&&<p className="voice-caption" role="status"><strong>현재 담당</strong> · {voiceTargetDisplayLabel(session.activeTarget.label)}{session.activeTarget.kind==='workroom'?` · ${session.activeTarget.agent}`:''}</p>}
      {!active&&<label>음성 제공자 <small className="voice-shared-note">아젠투지·워크룸 공통 · 이 기기에 저장</small><select aria-label="음성 제공자" value={provider} onChange={e=>setProvider(e.target.value as VoiceProvider)}><option value="openai">OpenAI Realtime</option><option value="gemini">Gemini Live</option></select></label>}
      {!remote&&!active&&<details open={settingsOpen} onToggle={e=>setSettingsOpen(e.currentTarget.open)}><summary>음성 제공자 설정 · {providerName}</summary>
        <p className="voice-key-state" role="status">{saving?'키 저장 중…':providerSettings?.configured?`✓ ${thisMachineLabel()}에 ${providerName} 키가 저장되어 있습니다.`:settings?`${providerName} 키 미등록 · 입력 후 키 저장을 눌러 주세요.`:'저장 상태 확인 중…'}</p>
        <form onSubmit={e=>{e.preventDefault();void saveSettings();}}>
        <label>{provider==='openai'?'Realtime':'Live'} 모델<input aria-label={`${providerName} 음성 모델`} disabled={busy} value={model} onChange={e=>{editedModelProvider.current=provider;setModel(e.target.value);}} maxLength={110} autoComplete="off"/></label>
        {providerSettings?.configured&&!editingKey?<div className="voice-key-field"><span>{providerName} API 키</span><div className="voice-saved-key"><span role="status">✓ 키 저장됨</span><button type="button" disabled={busy} onClick={()=>{setEditingKey(true);setSettingsNotice('');}}>키 변경</button></div></div>:<label>{providerName} API 키<input aria-label={`${providerName} API 키`} type="password" disabled={busy} value={key} onChange={e=>{editedKeyProvider.current=provider;setKey(e.target.value);}} autoComplete="new-password" placeholder={providerSettings?.configured?'변경할 API 키 입력':`${providerName} API 키`} maxLength={provider==='openai'?512:2048}/></label>}
        <button type="button" className="voice-key-help" onClick={()=>void openPreferredBrowser(VOICE_API_KEY_PAGES[provider]).catch(e=>setError(e instanceof Error?e.message:'공식 API 키 발급 페이지를 열지 못했습니다.'))}>{providerName} 공식 API 키 발급 페이지 열기 ↗</button>
        {keyDraft&&<p className="voice-unsaved-key">입력한 키는 아직 저장 전입니다. ‘키 저장’을 누르거나 Enter를 누르세요.</p>}
        <p>키는 {thisMachineLabel()}의 {clientSecretStoreLabel()}에 저장합니다. 음성 API 사용량은 기존 워크룸 AI와 별도입니다.</p>
        <button type="submit" className="voice-primary" disabled={busy||!settings||(!keyDraft&&!modelDraft)||(!providerSettings?.configured&&!keyDraft)}>{saving?'저장 중…':keyDraft?'키 저장':modelDraft?'설정 저장':providerSettings?.configured?'저장됨':'키 저장'}</button>
        {editingKey&&providerSettings?.configured&&<button type="button" disabled={busy} onClick={()=>{editedKeyProvider.current=null;setKey('');setEditingKey(false);setError('');}}>변경 취소</button>}
        <div ref={settingsFeedback}>{settingsNotice&&<p role="status" className="voice-settings-notice">{settingsNotice}</p>}</div>
        </form>
        {providerSettings?.configured&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{setSettings(await transport({action:'configure',requestId:crypto.randomUUID(),provider,removeKey:true}));setKey('');setSettingsNotice(`저장한 ${providerName} 키를 삭제했습니다.`);})}>저장한 키 삭제</button>}
      </details>}
      {/* 휴대폰에서 보는 문구다 — 호스트가 Mac인지 Windows인지 이 화면은 알 수 없으므로
          기기 종류를 단정하지 않는다. 예전 문구는 Windows 호스트에 연결한 사용자를
          있지도 않은 Mac으로 보냈다. */}
      {remote&&providerSettings?.configured===false&&<p>연결한 데스크톱의 아젠투지 음성 설정에서 {providerName} API 키를 연결하세요.</p>}
      <label>자막<select aria-label="자막" data-testid="voice-caption-mode" value={state.captionMode} onChange={e=>voiceMediaClient.setCaptionMode(e.target.value as VoiceCaptionMode)}><option value="bilingual">원문 + 통역 (한↔영)</option><option value="original">원문만</option><option value="off">끄기</option></select></label>
      {!active&&<><p>인식 언어: 자동 · 한국어/영어 혼용</p>{settings?.historySupported&&<label className="voice-check"><input type="checkbox" checked={recordConsent} onChange={e=>setRecordConsent(e.target.checked)}/>발언과 AI 답변을 연결된 Mac의 ‘내가 한 말 · 음성 세션’에 암호화해 저장합니다. 워크룸 대화는 기존 세션 기억하기·자동 기억 설정의 정리 대상에 포함됩니다. OPS 운영 기억은 후보를 검토해 저장합니다.</label>}{target.kind==='ops'||provider==='gemini'?<div className="voice-fixed-mode"><span>입력 방식</span><p>실시간 대화 · 지시 전 확인</p></div>:<label>입력 방식<select value={mode} onChange={e=>setMode(e.target.value as VoiceMode)}><option value="dictation">말해서 입력</option><option value="conversation">실시간 대화 · 지시 전 확인</option></select></label>}
        {rememberedConsent&&consent?<p className="voice-consent-remembered" data-testid="voice-consent-remembered">✓ {providerName} 전송에 동의함 · 이 기기에서 기억 중 <button type="button" onClick={()=>setConsent(false)}>동의 철회</button></p>:<label className="voice-check"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>이 대화의 음성, 필요한 OPS 기억·워크룸 출력을 {providerName}로 전송합니다. 원음 파일은 앱에 저장하지 않습니다. 한 번 동의하면 이 기기에서 기억합니다.</label>}
        <button className="voice-primary" disabled={busy||!consent||!providerSettings?.configured||keyDraft||modelDraft} onClick={()=>{writeVoiceProvider(voicePreferenceStorage(),provider);writeVoiceConsent(voicePreferenceStorage(),provider,true);void run(()=>voiceMediaClient.start(owner,target,mode,transport,!!settings?.historySupported&&recordConsent,provider));}}>마이크 켜고 시작</button>
      </>}
      {active&&<div className="voice-actions">{state.microphone&&<button onClick={()=>voiceMediaClient.finishInput()}>{mode==='dictation'?'입력 끝내기':'마이크 끄기'}</button>}{!state.microphone&&owns&&state.phase==='review'&&<button className="voice-primary" data-testid="voice-resume-microphone" onClick={()=>void voiceMediaClient.resumeInput()}>마이크 다시 켜고 이어하기</button>}<button onClick={()=>voiceMediaClient.toggleSpeaker()}>{state.muted?'답변 소리 켜기':'답변 소리 끄기'}</button><button onClick={()=>void voiceMediaClient.stop()}>음성 종료</button></div>}
      {active&&state.microphone&&<div className="voice-input-monitor">
        <span>{state.device||'마이크 준비 중'}</span>
        <meter aria-label="마이크 입력 크기" min={0} max={1} value={state.level??0}/>
        <p role="status">{state.phase==='preparing'?'연결 준비 중 · 연결 후 말씀해 주세요':state.inputState==='speaking'?'발화 감지 · 듣고 있어요':state.inputState==='transcribing'?'발화 종료 · 인식 중':state.inputState==='recognized'?'발화 인식 완료':state.level===null?'입력량 측정 불가 · 말씀하면 인식 결과가 표시됩니다':state.level>0.015?'마이크 소리 입력 중 · 발화 감지 대기':'말씀해 주세요 · 소리가 없으면 Mac 사운드 입력 설정을 확인하세요'}</p>
      </div>}
      {owns&&state.caption&&<p className="voice-transcript"><strong>나</strong> {state.caption}</p>}
      {owns&&state.answer&&<p className="voice-transcript"><strong>음성 도우미</strong> {state.answer}</p>}
      {session?.draft&&active&&<div className="voice-draft"><h3>{session.draft.label}에 보낼 초안</h3><textarea aria-label="음성 지시 초안" value={draft} onChange={e=>{dirtyDraft.current=true;if(state.microphone)voiceMediaClient.finishInput();setDraft(e.target.value);}} disabled={busy}/>
        <label className="voice-check"><input type="checkbox" checked={ready} onChange={e=>setReady(e.target.checked)}/>워크룸에 로그인·승인·선택 화면이 없고 입력칸이 비어 있는 것을 확인했습니다.</label>
        <p>여러 줄은 한 문장으로 이어서 전송합니다.</p><button disabled={busy||!ready||!draft.trim()} onClick={()=>void run(()=>voiceMediaClient.submit(draft,ready))}>이 워크룸에 보내기</button><button disabled={busy} onClick={()=>void run(()=>voiceMediaClient.discard())}>초안 버리기</button>
      </div>}
      {session?.recording&&<p role={session.recording.state==='failed'?'alert':'status'} className={session.recording.state==='failed'?'voice-error':'voice-caption'}>{session.recording.state==='saving'?'음성 기록 저장 중…':session.recording.message} · {session.recording.savedTurns}개 발언 저장</p>}
      {/* 아젠투지 voice: the dock right below already shows its errors, the end reason and 「…에 보냄」; say them once. */}
      {session?.notice&&!(persistentOps&&(state.phase==='ended'||/에 보냄/.test(session.notice)))&&<p role="status">{session.notice}</p>}
      <div ref={feedback}>{(error||!persistentOps&&owns&&state.error)&&<p role="alert" className="voice-error">{error||state.error}</p>}</div>
      <p className="voice-caption">음성을 종료해도 워크룸 작업은 계속됩니다. 터미널 입력 접수는 작업 완료가 아닙니다.</p>
    </section>}
  </>;
}

/** The host-derived role identifies the exact Control binding; users never guess it from names. */
export function remoteOpsVoiceProject<P extends {id:string;role?:string;kind?:string}>(projects:P[]):P|undefined{return projects.find(p=>p.role==='ops'&&p.kind==='main');}

/**
 * The OPS section's entry on a phone. The one voice panel and the always-on dock live at the portal
 * root (RemoteOpsVoiceHost) so a conversation outlives tabs; this opens that same panel.
 */
export function RemoteOpsVoiceEntry({projects}:{projects:{id:string;label:string;role?:string;kind?:string}[]}){
  const ops=remoteOpsVoiceProject(projects);
  return <div className="remote-ops-voice">
    <p>{ops?`${ops.label}에 연결된 Mac의 아젠투지를 사용합니다.`:'이 Mac의 아젠투지 연결을 확인하거나 프로젝트 목록을 새로고침하세요.'}</p>
    <button type="button" className="voice-launch" data-testid="ops-voice-button" disabled={!ops} onClick={()=>window.dispatchEvent(new Event(OPEN_OPS_VOICE_EVENT))}><Mic size={15}/>아젠투지 음성 창</button>
    <p>Mac에서 허용한 프로젝트 범위 안에서 아젠투지가 조회·지시합니다. 화면 아래 「아젠투지 호출」로 바로 말할 수 있습니다.</p></div>;
}

/** Phone root: the one OPS voice panel (opened by the dock or the OPS section) for the selected Mac. */
export function RemoteOpsVoiceHost({projects,transport}:{projects:{id:string;label:string;role?:string;kind?:string}[];transport:WorkroomTransport}){
  const ops=remoteOpsVoiceProject(projects);
  const voice=React.useMemo(()=>remoteVoiceTransport(transport,ops?.id??'ops-unavailable'),[transport,ops?.id]);
  return <VoiceButton key={ops?.id??'ops-unavailable'} target={{kind:'ops'}} label="아젠투지" remote hideTrigger openOnEvent disabled={!ops} transport={voice}/>;
}
