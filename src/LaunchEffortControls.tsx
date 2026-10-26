import {t,type Lang} from './i18n';
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
  lang?: Lang; request?: LaunchEffortRequest; requestDesktop?: DesktopEffortRequest;
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
  return <div className="launch-effort-controls" data-testid="launch-effort-controls" style={{whiteSpace:'normal',overflowWrap:'anywhere',minWidth:0,width:'100%'}}>
    <div className="workspace-tools-section">{t(lang,'launchEffortTitle')}</div>
    <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
      <button type="button" role="switch" aria-checked={mode === 'auto'} aria-label={t(lang,'automaticEffort')}
        data-testid="launch-effort-toggle" disabled={mode === null || busy} onClick={() => void change(mode === 'auto' ? 'off' : 'auto')}
        style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:'1px solid',fontFamily:'inherit',cursor:mode === null || busy ? 'wait' : 'pointer',
          borderColor:mode === 'auto' ? 'var(--violet)' : 'var(--border-subtle)',background:mode === 'auto' ? 'var(--bg-purple)' : 'transparent',color:'var(--text-primary)'}}>
        {mode === null ? (t(lang,'loadingSettings')) : mode === 'auto' ? (t(lang,'effortAutoDefault')) : mode === 'recommend' ? (t(lang,'effortAdviceOnly')) : (t(lang,'effortAutoOff'))}
      </button>
      <button type="button" disabled={mode === null || busy} aria-pressed={mode === 'recommend'} onClick={() => void change('recommend')}
        style={{padding:'4px 6px',fontSize:11,border:0,background:'transparent',color:'var(--text-secondary)',fontFamily:'inherit',cursor:'pointer'}}>{t(lang,'adviceOnly')}</button>
      <button type="button" disabled={mode === null || busy} aria-pressed={mode === 'off'} onClick={() => void change('off')}
        data-testid="launch-effort-off" style={{padding:'4px 6px',fontSize:11,border:0,background:'transparent',color:'var(--text-secondary)',fontFamily:'inherit',cursor:'pointer'}}>{t(lang,'off')}</button>
    </div>
    <p style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5,margin:'6px 0'}}>{t(lang,'effortHostHelp')}</p>
    <p style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5,margin:'6px 0'}}>{t(lang,'effortMacHelp')}</p>
    <p style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5,margin:'6px 0'}}>{t(lang,'effortDesktopBoundary')}</p>
    {error && <div role="alert" style={{fontSize:11,color:'var(--ink-fbbf24)'}}>{error} <button type="button" onClick={() => void read()}>{t(lang,'checkAgain')}</button></div>}
    <DesktopEffortAdviceControls lang={lang} request={requestDesktop}/>
  </div>;
}

function DesktopEffortAdviceControls({lang,request}: {lang:Lang;request:DesktopEffortRequest}) {
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
  return <div data-testid="desktop-effort-controls">
    <div className="workspace-tools-section">{t(lang,'desktopEffortTitle')}</div>
    <div role="radiogroup" aria-label={t(lang,'desktopEffort')} style={{display:'flex',gap:8,flexWrap:'wrap'}}>
      {(['recommend','off'] as const).map(value=><button type="button" role="radio" aria-checked={mode===value} key={value}
        data-testid={'desktop-effort-'+value} disabled={mode===null || busy} onClick={()=>void change(value)}
        style={{padding:'6px 10px',fontSize:12,borderRadius:6,border:'1px solid',fontFamily:'inherit',cursor:mode===null || busy ? 'wait' : 'pointer',
          borderColor:mode===value ? 'var(--violet)' : 'var(--border-subtle)',background:mode===value ? 'var(--bg-purple)' : 'transparent',color:'var(--text-primary)'}}>
        {value==='recommend' ? (t(lang,'effortRecommendDefault')) : (t(lang,'off'))}
      </button>)}
    </div>
    <p style={{fontSize:11,color:'var(--text-muted)',lineHeight:1.5,margin:'6px 0'}}>{t(lang,'desktopEffortHelp')}</p>
    {error && <div role="alert" style={{fontSize:11,color:'var(--ink-fbbf24)'}}>{error} <button type="button" onClick={()=>void read()}>{t(lang,'checkAgain')}</button></div>}
  </div>;
}
