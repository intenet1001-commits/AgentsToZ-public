import {useCallback,useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import type {workModeCopy} from './i18n';

/**
 * Mirrors src-tauri/src/screen_helper.rs `ViewerHelperStatus`: AgentsToZ Viewer, the app on this Mac that shows another
 * Mac (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.4). The Viewer writes no status file, so the main app never knows
 * whether it is connected or to which Mac. `bundled`: this app carries a Viewer, so opening can (re)try installing it.
 * `updatePending`: a newer Viewer waits for this app to quit (SR-35). Other-path or unobserved instances block opening;
 * neither is proof that the selected installation is running or updated.
 */
export interface ViewerHelperStatus {supported:boolean;installed:boolean;bundled:boolean;running:boolean;updatePending:boolean;otherInstanceRunning:boolean;instanceStatusUnknown:boolean}
type Copy=ReturnType<typeof workModeCopy>;

/**
 * The work-mode panel's 「다른 Mac 화면 보기」 lines, or nothing when there is no Viewer to install or open (a build that
 * does not carry one yet): a button that could only fail is not offered.
 */
export function viewerHelperLines(status:ViewerHelperStatus|null|undefined,copy:Copy):{line:string;notes:string[]}|null {
  if(!status?.supported||!(status.installed||status.bundled||status.running||status.otherInstanceRunning||status.instanceStatusUnknown))return null;
  const line=status.instanceStatusUnknown?copy.viewerInstanceUnknown:status.otherInstanceRunning?copy.viewerOtherInstance
    :status.running?copy.viewerRunning:status.installed?copy.viewerStopped:copy.viewerMissing;
  return {line,notes:status.updatePending?[copy.viewerUpdatePending]:[]};
}

/**
 * AgentsToZ Viewer as the desktop app sees it. Read while the caller is mounted and every few seconds after, never in
 * the background; nothing in a browser. `open` takes no arguments and is 3-state like Screen's: a failure says why
 * (`error`), an open not yet seen running says where to look (`unverified`). Choosing a Mac and connecting stay in the
 * Viewer, behind Touch ID; nothing here can start a session (SR-23).
 */
export function useViewerHelper(unverified:string){
  const native=isTauri(),busy=useRef(false),readRevision=useRef(0),appliedRevision=useRef(0);
  const [status,setStatus]=useState<ViewerHelperStatus|null>(null),[opening,setOpening]=useState(false),[statusFailed,setStatusFailed]=useState(false),[note,setNote]=useState(''),[error,setError]=useState('');
  // A pending newer query proves nothing: retain a rejection unless a newer outcome was already applied.
  const refresh=useCallback(()=>{if(!native||document.hidden)return;const revision=++readRevision.current;void invoke<ViewerHelperStatus>('get_viewer_helper')
    .then(value=>{if(revision!==readRevision.current)return;appliedRevision.current=revision;setStatus(value??null);setStatusFailed(false);})
    .catch(()=>{if(revision<=appliedRevision.current)return;appliedRevision.current=revision;setStatusFailed(true);setStatus(value=>value?{...value,instanceStatusUnknown:true}:null);});},[native]);
  useEffect(()=>{if(!native)return;refresh();const timer=window.setInterval(refresh,5000);return()=>{clearInterval(timer);appliedRevision.current=++readRevision.current;};},[native,refresh]);
  const open=useCallback(async()=>{
    if(busy.current)return;busy.current=true;setOpening(true);setError('');setNote('');
    try{if(!(await invoke<{verified:boolean}>('open_viewer_helper'))?.verified)setNote(unverified);}
    catch(e){setError(String(e));}finally{busy.current=false;setOpening(false);refresh();}
  },[unverified,refresh]);
  return {status,opening,statusFailed,note,error,open};
}
