import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {openPreferredBrowser} from './openPreferredBrowser';
import {VOICE_API_KEY_PAGES} from './voiceApiKeyLinks';
import {DEFAULT_GEMINI_LIVE_MODEL,GEMINI_VOICE_SETTINGS_PATH,MAX_GEMINI_API_KEY_LENGTH,type GeminiVoiceSettingsRequest,type GeminiVoiceSettingsStatus} from './geminiVoiceSettings';
import {clientSecretStoreLabel,localAppLabel,thisMachineLabel} from './clientPlatform';

type SettingsTransport=(request:GeminiVoiceSettingsRequest)=>Promise<GeminiVoiceSettingsStatus>;
const localSettings:SettingsTransport=request=>terminalLocalRequest(GEMINI_VOICE_SETTINGS_PATH,request);

export function GeminiVoiceSettings({transport=localSettings}:{transport?:SettingsTransport}){
 const [open,setOpen]=useState(false),[key,setKey]=useState(''),[model,setModel]=useState(DEFAULT_GEMINI_LIVE_MODEL);
 const [status,setStatus]=useState<GeminiVoiceSettingsStatus|null>(null),[busy,setBusy]=useState<GeminiVoiceSettingsRequest['operation']|null>(null);
 const [notice,setNotice]=useState<{kind:'success'|'error';text:string}|null>(null);
 const mounted=useRef(true),pending=useRef(false),modelEdited=useRef(false),noticeRef=useRef<HTMLDivElement>(null);
 const sectionId=useId();
 const run=useCallback(async(request:GeminiVoiceSettingsRequest)=>{
  if(pending.current)return;
  pending.current=true;setBusy(request.operation);
  if(request.operation!=='status')setNotice(null);
  try{
   let result=await transport(request);
   if(!result||typeof result.configured!=='boolean'||typeof result.supported!=='boolean')throw Error('설정 상태를 확인하지 못했습니다. 상태 새로고침을 눌러 주세요.');
   // A save click is not a receipt. Read persisted state again before clearing the draft.
   if(request.operation==='save'){
    if(!result.configured)throw Error('키 저장 완료를 확인하지 못했습니다. 입력한 키는 유지했습니다.');
    result=await transport({operation:'status'});
    if(!result.configured||result.model!==request.model)throw Error('저장 후 다시 읽기에서 키를 확인하지 못했습니다. 입력한 키는 유지했습니다.');
   }
   if(!mounted.current)return;
   setStatus(result);
   if(request.operation!=='status'||!modelEdited.current)setModel(result.model);
   if(request.operation==='save'){
    setKey('');modelEdited.current=false;
    setNotice({kind:'success',text:'API 키 저장 완료 · 저장된 설정을 다시 읽어 확인했습니다. 이제 Live 연결 검사를 누르세요.'});
   }else if(request.operation==='delete'){
    setKey('');modelEdited.current=false;
    setNotice({kind:'success',text:'저장된 Gemini API 키를 삭제했습니다.'});
   }else if(request.operation==='test'){
    modelEdited.current=false;
    setNotice({kind:'success',text:'Live 연결 확인 완료 · Google의 세션 준비 응답을 받았습니다.'});
   }
  }catch(error){
   if(mounted.current)setNotice({kind:'error',text:error instanceof Error?error.message:'음성 설정 요청을 완료하지 못했습니다. 상태 새로고침을 눌러 주세요.'});
  }finally{pending.current=false;if(mounted.current)setBusy(null);}
 },[transport]);
 useEffect(()=>{mounted.current=true;void run({operation:'status'});return()=>{mounted.current=false;};},[run]);
 useEffect(()=>{if(open&&notice)noticeRef.current?.scrollIntoView({block:'nearest'});},[open,notice]);
 const verified=!!status?.configured&&!!status.checkedAt&&status.checkedModel===status.model;
 // 「이 Mac」을 Windows에서 그대로 보여 주면 이 기능이 다른 컴퓨터 것으로 읽힌다.
 const machine=thisMachineLabel(),localApp=localAppLabel();
 const badge=busy==='save'?'저장 중…':busy==='test'?'연결 검사 중…':busy==='delete'?'삭제 중…':!status?(notice?'상태 확인 필요':'상태 확인 중…'):!status.supported?`${localApp}에서 설정`:status.configured?(verified?'연결 확인됨':'키 저장됨'):'키 미등록';
 return <div className="gemini-voice-settings">
  <button className="ai-terminal-btn gemini-voice-toggle" aria-expanded={open} aria-controls={sectionId} disabled={!!busy&&busy!=='status'} onClick={()=>setOpen(value=>!value)}>
   Gemini 음성 설정 <span className="gemini-voice-badge" data-ready={status?.configured?'true':'false'}>{badge}</span>
  </button>
  {open&&<section id={sectionId} aria-label="Gemini 음성 설정" className="ai-terminal-options-content gemini-voice-content">
   <div className="gemini-voice-heading"><strong>Gemini Live 연결 준비</strong><button className="ai-terminal-btn" disabled={!!busy} onClick={()=>void run({operation:'status'})}>상태 새로고침</button></div>
   <div className="gemini-voice-state" role="status" data-ready={status?.configured?'true':'false'}>
    <strong>{status?.configured?`✓ API 키가 ${machine}에 저장되어 있습니다.`:status?.supported?'API 키가 아직 저장되지 않았습니다.':status?`설치된 ${localApp}에서 설정하세요.`:'저장 상태를 확인하고 있습니다.'}</strong>
    {status?.configured&&<span>{verified?'Live 연결 확인 완료':'키 저장 완료 · Live 연결 확인은 아직 필요합니다.'} 저장된 키는 다시 입력하지 않아도 됩니다.</span>}
   </div>
   {notice&&<div ref={noticeRef} className="gemini-voice-notice" data-kind={notice.kind} role={notice.kind==='error'?'alert':'status'}>{notice.text}</div>}
   <p className="ai-terminal-hint">{machine}의 {clientSecretStoreLabel()} 키로 암호화해 보관합니다. 모바일은 별도 키 입력 없이 {machine}을 통해 Gemini Live 음성 대화를 사용합니다. OPS·워크룸 문맥과 도구 실행은 {machine}의 기존 권한·검토 경계를 따릅니다.</p>
   <form onSubmit={event=>{event.preventDefault();if(key.trim()&&!busy&&status?.supported)void run({operation:'save',apiKey:key.trim(),model:model.trim()});}}>
    <label>{status?.configured?'API 키 교체 (필요한 경우만)':'Gemini API 키'}<input aria-label="Gemini API 키" type="password" value={key} onChange={e=>setKey(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={MAX_GEMINI_API_KEY_LENGTH} placeholder={status?.configured?'저장된 키 사용 중 · 교체할 때만 새 키 입력':'Google AI Studio에서 발급한 키 붙여넣기'} disabled={!!busy||!status?.supported}/></label>
    <button type="button" className="ai-terminal-btn gemini-voice-key-link" onClick={()=>void openPreferredBrowser(VOICE_API_KEY_PAGES.gemini).catch(error=>setNotice({kind:'error',text:error instanceof Error?error.message:'공식 API 키 발급 페이지를 열지 못했습니다.'}))}>Gemini 공식 API 키 발급 페이지 열기 ↗</button>
    {key&&<p className="gemini-voice-draft">입력한 키는 아직 저장 전입니다. 아래 ‘{status?.configured?'키 교체·저장':'키 저장'}’을 누르세요.</p>}
    <label>Live 모델 ID<input aria-label="Gemini Live 모델 ID" value={model} onChange={e=>{modelEdited.current=true;setModel(e.target.value);}} spellCheck={false} autoCapitalize="none" maxLength={110} disabled={!!busy}/></label>
    <div className="gemini-voice-actions">
     <button type="submit" className="ai-terminal-btn" disabled={!!busy||!status?.supported||!key.trim()}>{busy==='save'?'저장 중…':status?.configured?'키 교체·저장':'키 저장'}</button>
     <button type="button" className="ai-terminal-btn" disabled={!!busy||!status?.configured||!!key} onClick={()=>void run({operation:'test',model:model.trim()})}>{busy==='test'?'연결 검사 중…':verified?'Live 연결 다시 검사':'Live 연결 검사'}</button>
     <button type="button" className="ai-terminal-btn" disabled={!!busy||!status?.configured} onClick={()=>void run({operation:'delete'})}>저장된 키 삭제</button>
    </div>
   </form>
   <p className="ai-terminal-hint">연결 검사는 Google에 키와 모델 ID로 세션 준비를 한 번 요청합니다. 마이크·대화·프로젝트 내용은 보내지 않습니다. API 이용 조건에 따라 요금이 발생할 수 있습니다.</p>
   {status?.checkedAt&&<p className="ai-terminal-hint">최근 연결 성공: {status.checkedModel} · {new Date(status.checkedAt).toLocaleString()}</p>}
  </section>}
 </div>;
}
