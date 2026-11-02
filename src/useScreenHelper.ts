import {useCallback,useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import type {ScreenHelperStatus} from './workModeScreenHelper';

/**
 * AgentsToZ Screen as the desktop app sees it, for every place that offers to open it (the work-mode panel, the QR
 * remote-control dialog). Read while the caller is mounted and every few seconds after, never in the background;
 * nothing in a browser, where there is no helper to ask. `open` is 3-state: a failure says why (`error`), an open the
 * helper was not yet seen to answer says where to look (`unverified`).
 */
export function useScreenHelper(unverified:string){
  const native=isTauri(),busy=useRef(false),readRevision=useRef(0),appliedRevision=useRef(0);
  const [status,setStatus]=useState<ScreenHelperStatus|null>(null),[opening,setOpening]=useState(false),[statusFailed,setStatusFailed]=useState(false),[note,setNote]=useState(''),[error,setError]=useState('');
  // A pending newer query proves nothing: retain a rejection unless a newer outcome was already applied.
  const refresh=useCallback(()=>{if(!native||document.hidden)return;const revision=++readRevision.current;void invoke<ScreenHelperStatus>('get_screen_helper')
    .then(value=>{if(revision!==readRevision.current)return;appliedRevision.current=revision;setStatus(value??null);setStatusFailed(false);})
    .catch(()=>{if(revision<=appliedRevision.current)return;appliedRevision.current=revision;setStatusFailed(true);setStatus(value=>value?{...value,instanceStatusUnknown:true}:null);});},[native]);
  useEffect(()=>{if(!native)return;refresh();const timer=window.setInterval(refresh,5000);return()=>{clearInterval(timer);appliedRevision.current=++readRevision.current;};},[native,refresh]);
  const open=useCallback(async()=>{
    if(busy.current)return;busy.current=true;setOpening(true);setError('');setNote('');
    try{if(!(await invoke<{verified:boolean}>('open_screen_helper')).verified)setNote(unverified);}
    catch(e){setError(String(e));}finally{busy.current=false;setOpening(false);refresh();}
  },[unverified,refresh]);
  return {status,opening,statusFailed,note,error,open};
}
