import {useCallback, useEffect, useRef, useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {AI_TERMINAL_PREFIX} from './aiTerminalProtocol';
import {invoke} from '@tauri-apps/api/core';
import {isTauri} from './lib/env';
import {EFFORT_MODE_CHANGED,isDesktopEffortMode,isWorkroomEffortMode, type DesktopEffortMode,type WorkroomEffortMode} from './workroomEffortMode';

export type LaunchEffortRequest = (mode?: WorkroomEffortMode) => Promise<WorkroomEffortMode>;
export type DesktopEffortRequest = (mode?: DesktopEffortMode) => Promise<DesktopEffortMode>;
export const requestDesktopEffort: DesktopEffortRequest = async desktopMode => {
  if (isTauri()) {
    const observed=await invoke<unknown>('desktop_effort_mode',{mode:desktopMode??null});
    if (!isDesktopEffortMode(observed)) throw Error('앱 에포트 추천 설정을 확인하지 못했습니다.');
    return observed;
  }
  const result = await terminalLocalRequest(AI_TERMINAL_PREFIX, {
    operation:'effort',desktopEffortModes:true,...(desktopMode ? {desktopMode} : {}),
  });
  if (!isDesktopEffortMode(result?.effort?.desktopMode)) throw Error('앱 에포트 추천 설정을 확인하지 못했습니다. 실행 호스트를 업데이트하세요.');
  return result.effort.desktopMode;
};
export const requestLaunchEffort: LaunchEffortRequest = async mode => {
  const result = await terminalLocalRequest(AI_TERMINAL_PREFIX, {
    operation: 'effort', effortModes: true, ...(mode ? {mode} : {}),
  });
  if (!isWorkroomEffortMode(result?.effort?.mode)) throw Error('에포트 설정을 확인하지 못했습니다. 실행 호스트를 업데이트한 뒤 다시 시도하세요.');
  return result.effort.mode;
};

/** The preference belongs to this execution host, independently of terminal selection. */
export function LaunchEffortControls({lang = 'ko', request = requestLaunchEffort, requestDesktop = requestDesktopEffort}: {
  lang?: 'ko' | 'en'; request?: LaunchEffortRequest; requestDesktop?: DesktopEffortRequest;
}) {
  const [mode, setMode] = useState<WorkroomEffortMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0), pending = useRef(false), mounted = useRef(false);
  const read = useCallback(async () => {
    if (pending.current) return;
    const stamp = revision.current;
    try {
      const observed = await request();
      if (mounted.current && stamp === revision.current) {setMode(observed); setError('');}
    } catch (e) {
      if (mounted.current && stamp === revision.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    void read();
    const refresh = () => {if (document.visibilityState !== 'hidden') void read();};
    window.addEventListener('focus', refresh);
    window.addEventListener(EFFORT_MODE_CHANGED, refresh);
    return () => {mounted.current = false; revision.current++; window.removeEventListener('focus', refresh); window.removeEventListener(EFFORT_MODE_CHANGED, refresh);};
  }, [read]);
  const change = async (next: WorkroomEffortMode) => {
    if (pending.current || mode === null) return;
    pending.current = true; revision.current++; setBusy(true); setError('');
    try {
      const observed = await request(next);
      if (mounted.current) {setMode(observed); window.dispatchEvent(new Event(EFFORT_MODE_CHANGED));}
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {pending.current = false; if (mounted.current) setBusy(false);}
  };
  const ko = lang === 'ko';
  return <div className="launch-effort-controls" data-testid="launch-effort-controls" style={{whiteSpace:'normal',overflowWrap:'anywhere',minWidth:0,width:'100%'}}>
    <div className="workspace-tools-section">{ko ? 'CLI 에포트 · 자동 / 추천 / OFF' : 'CLI effort · Auto / Recommend / OFF'}</div>
    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
      <button type="button" role="switch" aria-checked={mode === 'auto'} aria-label={ko ? '에포트 자동 조절' : 'Automatic effort'}
        data-testid="launch-effort-toggle" disabled={mode === null || busy} onClick={() => void change(mode === 'auto' ? 'off' : 'auto')}
        style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:'1px solid',fontFamily:'inherit',cursor:mode === null || busy ? 'wait' : 'pointer',
          borderColor:mode === 'auto' ? 'var(--violet)' : 'var(--border-subtle)',background:mode === 'auto' ? 'var(--bg-purple)' : 'transparent',color:'var(--text-primary)'}}>
        {mode === null ? (ko ? '설정 확인 중' : 'Loading') : mode === 'auto' ? (ko ? '자동 ON · 기본' : 'Auto ON · default') : mode === 'recommend' ? (ko ? '자동 OFF · 추천만' : 'Auto OFF · advice only') : (ko ? '자동 OFF' : 'Auto OFF')}
      </button>
      <button type="button" disabled={mode === null || busy} aria-pressed={mode === 'recommend'} onClick={() => void change('recommend')}
        style={{padding:'4px 6px',fontSize:11,border:0,background:'transparent',color:'var(--text-secondary)',fontFamily:'inherit',cursor:'pointer'}}>{ko ? '추천만 받기' : 'Advice only'}</button>
      <button type="button" disabled={mode === null || busy} aria-pressed={mode === 'off'} onClick={() => void change('off')}
        data-testid="launch-effort-off" style={{padding:'4px 6px',fontSize:11,border:0,background:'transparent',color:'var(--text-secondary)',fontFamily:'inherit',cursor:'pointer'}}>OFF</button>
    </div>
    <p style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5,margin:'6px 0'}}>{ko
      ? '이 기기의 공통 설정입니다. 워크룸·cmux·Orca·iTerm·Terminal에서 연동된 CLI가 같은 설정을 따릅니다. 자동 ON은 요청과 작업 맥락에 따라 강도를 다시 조절하도록 허용합니다. 고정하려면 자동 OFF를 선택하세요.'
      : 'Shared by connected CLIs on this host in Workroom, cmux, Orca, iTerm and Terminal. Auto ON authorizes contextual adjustments. Turn Auto OFF to keep a fixed effort.'}</p>
    <p style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5,margin:'6px 0'}}>{ko
      ? 'macOS 외부 CLI는 업데이트 후 새로 연 창에서 적용됩니다. Codex는 확인 가능한 여러 줄 입력도 보존하며 조절합니다. Claude·Hermes는 한 줄 요청을 지원하며 승인 화면·확인되지 않은 입력은 현재 강도를 유지합니다.'
      : 'Applies to new external CLI windows opened after this update on macOS. Codex preserves verified multiline drafts. Claude and Hermes support single-line requests. Approvals and unverified input keep their current effort.'}</p>
    <p style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5,margin:'6px 0'}}>{ko
      ? 'CLI 자동 설정은 외부 앱의 모델·에포트 설정을 변경하지 않습니다.'
      : 'CLI Auto does not change model or effort settings in separate desktop apps.'}</p>
    {error && <div role="alert" style={{fontSize:11,color:'var(--ink-fbbf24)'}}>{error} <button type="button" onClick={() => void read()}>{ko ? '다시 확인' : 'Retry'}</button></div>}
    <DesktopEffortAdviceControls lang={lang} request={requestDesktop}/>
  </div>;
}

function DesktopEffortAdviceControls({lang,request}: {lang:'ko'|'en';request:DesktopEffortRequest}) {
  const [mode,setMode] = useState<DesktopEffortMode | null>(null),[busy,setBusy] = useState(false),[error,setError] = useState('');
  const mounted = useRef(false),revision = useRef(0),pending = useRef(false);
  const read = useCallback(async () => {
    if (pending.current) return;
    const stamp=revision.current;
    try {const observed=await request();if(mounted.current && stamp===revision.current){setMode(observed);setError('');}}
    catch(e){if(mounted.current && stamp===revision.current)setError(e instanceof Error ? e.message : String(e));}
  },[request]);
  useEffect(()=>{
    mounted.current=true;void read();
    const refresh=()=>{if(document.visibilityState!=='hidden')void read();};
    window.addEventListener('focus',refresh);window.addEventListener(EFFORT_MODE_CHANGED,refresh);
    return ()=>{mounted.current=false;revision.current++;window.removeEventListener('focus',refresh);window.removeEventListener(EFFORT_MODE_CHANGED,refresh);};
  },[read]);
  const change=async(next:DesktopEffortMode)=>{
    if(pending.current || mode===null || next===mode)return;
    pending.current=true;revision.current++;setBusy(true);setError('');
    try{const observed=await request(next);if(mounted.current){setMode(observed);window.dispatchEvent(new Event(EFFORT_MODE_CHANGED));}}
    catch(e){if(mounted.current)setError(e instanceof Error ? e.message : String(e));}
    finally{pending.current=false;if(mounted.current)setBusy(false);}
  };
  const ko=lang==='ko';
  return <div data-testid="desktop-effort-controls">
    <div className="workspace-tools-section">{ko ? '외부 앱 에포트 · 추천 / OFF' : 'Desktop app effort · Recommend / OFF'}</div>
    <div role="radiogroup" aria-label={ko ? '외부 앱 에포트' : 'Desktop app effort'} style={{display:'flex',gap:8,flexWrap:'wrap'}}>
      {(['recommend','off'] as const).map(value=><button type="button" role="radio" aria-checked={mode===value} key={value}
        data-testid={'desktop-effort-'+value} disabled={mode===null || busy} onClick={()=>void change(value)}
        style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:'1px solid',fontFamily:'inherit',cursor:mode===null || busy ? 'wait' : 'pointer',
          borderColor:mode===value ? 'var(--violet)' : 'var(--border-subtle)',background:mode===value ? 'var(--bg-purple)' : 'transparent',color:'var(--text-primary)'}}>
        {value==='recommend' ? (ko ? '추천 · 기본' : 'Recommend · default') : 'OFF'}
      </button>)}
    </div>
    <p style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5,margin:'6px 0'}}>{ko
      ? 'Codex·Claude·Antigravity·Hermes 등 프로젝트 장기기억·공통 지침을 읽는 앱에서 작업 맥락에 맞게 추천합니다. 앱의 실제 설정은 직접 선택합니다. OFF는 추천을 중지하며 CLI 설정과 별도로 저장됩니다. 이미 열린 대화에는 지침 다시 읽기가 필요할 수 있습니다.'
      : 'Apps that read project memory and shared instructions, including Codex, Claude, Antigravity and Hermes, can recommend effort from task context. Choose native settings yourself. OFF stops advice, independently of CLI settings. Existing conversations may need to reload their instructions.'}</p>
    {error && <div role="alert" style={{fontSize:11,color:'var(--ink-fbbf24)'}}>{error} <button type="button" onClick={()=>void read()}>{ko ? '다시 확인' : 'Retry'}</button></div>}
  </div>;
}
