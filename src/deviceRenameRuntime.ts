import {invoke} from '@tauri-apps/api/core';
import {isTauri} from './lib/env';
import {getSupabaseClient} from './lib/supabaseClient';
import {internetRemoteControlApi} from './internetRemoteControlClient';
import {qrRemoteControlApi} from './qrRemoteControlClient';
import type {RemoteRenameOutcome,RenameThisDeviceDeps} from './deviceName';

async function synchronizeRemoteHostLabels():Promise<void> {
  // Status reads also refresh the display-only host label inside an already-running sidecar.
  // Failure here cannot invalidate the authoritative portal.json save.
  await Promise.allSettled([qrRemoteControlApi.status(),internetRemoteControlApi.status()]);
}

async function loadPortal():Promise<Record<string,unknown>> {
  if(isTauri()){const value=await invoke<Record<string,unknown>|null>('load_portal');return value&&typeof value==='object'?value:{};}
  const response=await fetch('/api/portal');if(!response.ok)throw new Error(`로컬 API가 HTTP ${response.status}로 응답했습니다.`);
  const value=await response.json();return value&&typeof value==='object'?value:{};
}

async function savePortal(next:Record<string,unknown>):Promise<void> {
  if(isTauri())await invoke('save_portal',{data:next});
  else {
    const response=await fetch('/api/portal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});
    if(!response.ok)throw new Error(`로컬 API가 HTTP ${response.status}로 응답했습니다.`);
  }
  try{
    const creds=localStorage.getItem('portalCreds');if(creds)localStorage.setItem('portalCreds',JSON.stringify({...JSON.parse(creds),deviceName:next.deviceName}));
    const full=localStorage.getItem('portalData');if(full)localStorage.setItem('portalData',JSON.stringify({...JSON.parse(full),deviceName:next.deviceName}));
  }catch{/* Local fallback copies are best effort. */}
  await synchronizeRemoteHostLabels();
}

async function updateRemoteName(portal:Record<string,unknown>,deviceId:string,name:string):Promise<Exclude<RemoteRenameOutcome,'failed'>> {
  const url=typeof portal.supabaseUrl==='string'?portal.supabaseUrl.trim():'';
  const key=typeof portal.supabaseAnonKey==='string'?portal.supabaseAnonKey.trim():'';
  if(!url||!key)return 'skipped';
  const {data,error}=await getSupabaseClient(url,key).from('portmgr_devices').update({name}).eq('id',deviceId).select('id');
  if(error)throw new Error(error.message);
  return Array.isArray(data)&&data.length>0?'updated':'not-registered';
}

export function portalDeviceRenameDeps():RenameThisDeviceDeps{return {loadPortal,savePortal,updateRemoteName};}
