import React,{useCallback,useEffect,useId,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {Coffee,MonitorSmartphone,X} from 'lucide-react';
import {appLocale,workModeCopy,type Lang} from './i18n';
import {useAppLanguage} from './useAppLanguage';
import {screenHelperLines} from './workModeScreenHelper';
import {useScreenHelper} from './useScreenHelper';
import './WorkModeControl.css';

/** Closed-lid work (Mac): `state` mirrors work_mode.rs — lowBattery means nearly empty, hot stops it for the session. */
export interface WorkModeLid {supported:boolean;granted:boolean;state:'off'|'active'|'lowBattery'|'hot'|'external';error?:string|null}
export interface WorkModeStatus {supported:boolean;revision:number;endsAt:number|null;keepDisplayOn:boolean;alwaysOn?:boolean;lid?:WorkModeLid}
const presets=[30,60,120,240,480,1440];
/** No end time: held until 「지금 퇴근」 or the app exits; never restored on restart. */
const ALWAYS='always';
function fill(text:string,values:Record<string,string|number>):string {
  return text.replace(/\{(\w+)\}/g,(token,name)=>Object.hasOwn(values,name)?String(values[name]):token);
}
/** A whole-minute duration in the app language, e.g. 「1시간 30분」 or 「1 hr 30 min」. */
export function workModeDuration(minutes:number,lang:Lang='ko'):string {
  const copy=workModeCopy(lang),number=new Intl.NumberFormat(appLocale(lang));
  if(minutes<60)return fill(copy.minutes,{n:number.format(minutes)});
  const hours=Math.floor(minutes/60),rest=minutes%60;
  return rest?fill(copy.hoursMinutes,{h:number.format(hours),m:number.format(rest)}):fill(copy.hours,{n:number.format(hours)});
}
/** Remaining work time, rounded up to the minute. Korean stays the default for existing callers. */
export function workModeRemaining(endsAt:number,now:number,lang:Lang='ko'){
  return workModeDuration(Math.max(0,Math.ceil((endsAt-now)/60000)),lang);
}

/**
 * 「아이폰·아이패드로 이 Mac 보기」 (DESIGN 「덮개 닫힘」): where AgentsToZ Screen is and a button that opens it. Mounted
 * only while the panel is open, so the helper's status is read then and every few seconds after, never in the background.
 * Switching it on and adding a device stay in the helper, behind Touch ID.
 */
function ScreenHelperPanel({copy}:{copy:ReturnType<typeof workModeCopy>}){
  const {status,opening,note,error,open}=useScreenHelper(copy.screenUnverified);
  if(!status?.supported)return null;
  const {line,notes,canOpen}=screenHelperLines(status,copy);
  return <div className="work-mode__screen" data-testid="work-mode-screen">
    <strong><MonitorSmartphone size={14} aria-hidden="true"/>{copy.screenHeading}</strong>
    <p className="work-mode__status" data-testid="work-mode-screen-status">{line}</p>
    {notes.map(text=><p key={text} className="work-mode__hint">{text}</p>)}
    {canOpen&&<button type="button" data-testid="work-mode-screen-open" disabled={opening} onClick={()=>void open()}>{opening?copy.screenOpening:copy.screenOpen}</button>}
    {note&&<p className="work-mode__hint" role="status">{note}</p>}
    {error&&<p role="alert">{error}</p>}
    {canOpen&&<p className="work-mode__hint">{copy.screenHint}</p>}
  </div>;
}

export function WorkModeControl({compact=false}:{compact?:boolean}){
  const [lang]=useAppLanguage(),copy=workModeCopy(lang);
  const native=isTauri(),id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLElement>(null);
  const [status,setStatus]=useState<WorkModeStatus|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[granting,setGranting]=useState(false),[error,setError]=useState('');
  const [minutes,setMinutes]=useState('60'),[display,setDisplay]=useState(false),[closedLid,setClosedLid]=useState(false),[now,setNow]=useState(Date.now());
  const apply=useCallback((value:WorkModeStatus)=>{
    setStatus(current=>!current||value.revision>=current.revision?value:current);
    setNow(Date.now());
  },[]);
  useEffect(()=>{
    if(!native)return;
    let stopped=false,off:(()=>void)|undefined;
    const refresh=()=>{if(!document.hidden)void invoke<WorkModeStatus>('get_work_mode').then(s=>{if(!stopped)apply(s);}).catch(e=>{if(!stopped)setError(String(e));});};
    // Subscribe before reading so a concurrent change in the other window cannot be missed.
    void listen<WorkModeStatus>('work-mode:changed',e=>{if(!stopped)apply(e.payload);})
      .then(unlisten=>{if(stopped){unlisten();return;}off=unlisten;refresh();})
      .catch(e=>{if(!stopped)setError(String(e));});
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{stopped=true;off?.();window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[native,apply]);
  useEffect(()=>{
    if(!native||!status?.endsAt)return;
    const timer=window.setInterval(()=>{
      if(document.hidden)return;setNow(Date.now());
      void invoke<WorkModeStatus>('get_work_mode').then(apply).catch(e=>setError(String(e)));
    },30000);
    return()=>clearInterval(timer);
  },[native,status?.endsAt,apply]);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  useEffect(()=>{
    if(!open)return;panel.current?.focus();
    const outside=(e:PointerEvent)=>{const target=e.target as Node;if(!panel.current?.contains(target)&&!trigger.current?.contains(target))setOpen(false);};
    document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  if(!native)return null;
  const alwaysOn=status?.alwaysOn===true,active=alwaysOn||!!status?.endsAt&&status.endsAt>now;
  const remaining=active&&!alwaysOn?workModeRemaining(status!.endsAt!,now,lang):'';
  const lid=status?.lid,lidOn=closedLid&&!!lid?.supported,needsGrant=lidOn&&!lid?.granted;
  const lidText={active:copy.lidActive,lowBattery:copy.lidLowBattery,hot:copy.lidHot,external:copy.lidExternal,off:''}[lid?.state??'off'];
  const screenOn=(status?.keepDisplayOn?` · ${copy.displayOn}`:'')+(active&&lidText?` · ${lidText}`:'');
  const change=async(value:number,always=false)=>{
    if(busy)return;setBusy(true);setError('');
    // closedLid is sent only when chosen, so the plain request keeps its original shape.
    const lidArg=lidOn&&(always||value>0)?{closedLid:true}:{};
    try{const next=await invoke<WorkModeStatus>('set_work_mode',always?{minutes:0,keepDisplayOn:display,alwaysOn:true,...lidArg}:{minutes:value,keepDisplayOn:value>0&&display,...lidArg});apply(next);}
    catch(e){setError(String(e));}finally{setBusy(false);}
  };
  /** One macOS password sheet; its line is the localized prompt, the password never reaches the app. */
  const changeGrant=async(allow:boolean)=>{
    if(busy||granting)return;setGranting(true);setError('');
    try{apply(await invoke<WorkModeStatus>('set_closed_lid_grant',{granted:allow,prompt:allow?copy.grantPrompt:copy.revokePrompt}));}
    catch(e){setError(String(e));}finally{setGranting(false);}
  };
  return <div className={`work-mode${compact?' work-mode--compact':''}`} data-active={active}>
    <button ref={trigger} type="button" className="work-mode__trigger" data-testid="work-mode-open" aria-expanded={open} aria-controls={id}
      title={alwaysOn?copy.titleAlways:active?fill(copy.titleTimed,{time:remaining}):copy.titleIdle}
      aria-label={active?copy.ariaActive:copy.ariaOpen} onClick={()=>{setOpen(v=>!v);setDisplay(status?.keepDisplayOn??false);setClosedLid(!!status?.lid&&status.lid.state!=='off');if(alwaysOn)setMinutes(ALWAYS);}}>
      <Coffee size={15} aria-hidden="true"/><span>{alwaysOn?copy.triggerAlways:active?fill(copy.triggerTimed,{time:remaining}):copy.mode}</span>
    </button>
    {open&&<section ref={panel} tabIndex={-1} id={id} className="work-mode__panel" aria-label={copy.panel} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();close();}}}>
      <div className="work-mode__heading"><strong>{copy.heading}</strong><button type="button" aria-label={copy.closePanel} onClick={close}><X size={15}/></button></div>
      <p>{copy.intro}</p>
      <p className="work-mode__status" role="status">{!status?copy.checking:!status.supported?copy.unsupported:alwaysOn?`${copy.statusAlways}${screenOn}`:active?`${fill(copy.statusTimed,{time:remaining,end:new Date(status.endsAt!).toLocaleTimeString(appLocale(lang),{hour:'2-digit',minute:'2-digit'})})}${screenOn}`:copy.idle}</p>
      <div className="work-mode__presets" aria-label={copy.presets}>{presets.map(value=><button key={value} type="button" aria-pressed={minutes===String(value)} onClick={()=>setMinutes(String(value))}>{workModeDuration(value,lang)}</button>)}
        <button type="button" className="work-mode__always" aria-pressed={minutes===ALWAYS} onClick={()=>setMinutes(ALWAYS)}>{copy.always}</button></div>
      <form onSubmit={e=>{e.preventDefault();if(minutes===ALWAYS){void change(0,true);return;}const value=Number(minutes);if(Number.isInteger(value)&&value>=1&&value<=1440)void change(value);}}>
        {minutes===ALWAYS?<p className="work-mode__hint">{copy.alwaysHint}</p>
          :<label className="work-mode__duration">{copy.custom} <input aria-label={copy.durationAria} type="number" min="1" max="1440" step="1" required value={minutes} onChange={e=>setMinutes(e.target.value)}/> {copy.unit}</label>}
        <label className="work-mode__display"><input type="checkbox" checked={display} onChange={e=>setDisplay(e.target.checked)}/>{copy.keepDisplay}</label>
        {lid?.supported&&<label className="work-mode__display"><input type="checkbox" checked={closedLid} onChange={e=>setClosedLid(e.target.checked)}/>{copy.closedLid}</label>}
        {lidOn&&<div className="work-mode__lid"><p className="work-mode__hint">{copy.closedLidHint}</p>
          {!lid?.granted?<button type="button" disabled={busy||granting} onClick={()=>void changeGrant(true)}>{granting?copy.granting:copy.grant}</button>
            :lid.state==='off'&&<button type="button" className="work-mode__revoke" disabled={busy||granting} onClick={()=>void changeGrant(false)}>{granting?copy.granting:copy.revoke}</button>}</div>}
        <div className="work-mode__actions"><button type="submit" disabled={busy||granting||needsGrant||!status?.supported}>{busy?copy.applying:minutes===ALWAYS?(alwaysOn?copy.reapply:copy.startAlways):active?copy.restart:copy.start}</button>{active&&<button type="button" disabled={busy} onClick={()=>void change(0)}>{copy.stop}</button>}</div>
      </form>
      {error&&<p role="alert">{error}</p>}
      {lid?.error&&<p role="alert">{lid.error}</p>}
      <small>{copy.note}</small>
      <ScreenHelperPanel copy={copy}/>
    </section>}
  </div>;
}
