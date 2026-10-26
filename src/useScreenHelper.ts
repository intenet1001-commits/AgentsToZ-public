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
  const native=isTauri(),busy=useRef(false);
  const [status,setStatus]=useState<ScreenHelperStatus|null>(null),[opening,setOpening]=useState(false),[note,setNote]=useState(''),[error,setError]=useState('');
  const refresh=useCallback(()=>{if(native&&!document.hidden)void invoke<ScreenHelperStatus>('get_screen_helper').then(setStatus).catch(()=>{});},[native]);
  useEffect(()=>{if(!native)return;refresh();const timer=window.setInterval(refresh,5000);return()=>clearInterval(timer);},[native,refresh]);
  const open=useCallback(async()=>{
    if(busy.current)return;busy.current=true;setOpening(true);setError('');setNote('');
    try{if(!(await invoke<{verified:boolean}>('open_screen_helper')).verified)setNote(unverified);}
    catch(e){setError(String(e));}finally{busy.current=false;setOpening(false);refresh();}
  },[unverified,refresh]);
  return {status,opening,note,error,open};
}
