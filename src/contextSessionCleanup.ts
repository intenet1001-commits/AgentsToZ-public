import {useSyncExternalStore} from 'react';
import type {ContextSession} from './contextSessionMemoryPath';

/** Only display snapshots are dismissed. Provider conversations and memory stay intact. */
export const CONTEXT_DISMISSALS_KEY='agentstoz:context-sessions:dismissed:v1';
const LIMIT=256;
type Snapshot=Pick<ContextSession,'sourceAgent'|'sessionId'|'capturedAt'>;

export function contextSnapshotKey(session:Snapshot):string|null {
  if(!session.sessionId||!session.capturedAt||!Number.isFinite(Date.parse(session.capturedAt)))return null;
  return JSON.stringify([session.sourceAgent,session.sessionId,session.capturedAt]);
}
export function parseContextDismissals(raw:string|null):string[]{
  try{const value=JSON.parse(raw??'[]');return Array.isArray(value)?[...new Set(value.filter((v):v is string=>typeof v==='string'&&v.length<=512))].slice(-LIMIT):[];}catch{return [];}
}
const readRaw=()=>{try{return localStorage.getItem(CONTEXT_DISMISSALS_KEY)??'[]';}catch{return '[]';}};
const listeners=new Set<()=>void>();
const changed=()=>{for(const listener of listeners)listener();};
const synced=(event:StorageEvent)=>{if(event.key===CONTEXT_DISMISSALS_KEY||event.key===null)changed();};
function subscribe(listener:()=>void){
  if(!listeners.size)window.addEventListener('storage',synced);
  listeners.add(listener);
  return()=>{listeners.delete(listener);if(!listeners.size)window.removeEventListener('storage',synced);};
}
export function useContextDismissals(){return parseContextDismissals(useSyncExternalStore(subscribe,readRaw,()=> '[]'));}
export const readContextDismissals=()=>parseContextDismissals(readRaw());
export function withoutDismissedContextSessions<T extends Snapshot>(sessions:readonly T[],dismissed:readonly string[]):T[]{
  const keys=new Set(dismissed);
  return sessions.filter(s=>{const key=contextSnapshotKey(s);return !key||!keys.has(key);});
}
/** Fresh activity has a new capturedAt and automatically reappears, even at the same context %. */
export function dismissContextSessions(sessions:readonly Snapshot[]):string[]{
  const previous=readContextDismissals(),known=new Set(previous);
  const added=[...new Set(sessions.map(contextSnapshotKey).filter((v):v is string=>!!v&&!known.has(v)))];
  localStorage.setItem(CONTEXT_DISMISSALS_KEY,JSON.stringify([...previous,...added].slice(-LIMIT)));
  changed();return added;
}
export function restoreContextSessions(keys:readonly string[]){
  const restored=new Set(keys);
  localStorage.setItem(CONTEXT_DISMISSALS_KEY,JSON.stringify(readContextDismissals().filter(key=>!restored.has(key))));
  changed();
}
/** Never bulk-dismiss a currently active reading or a verified live surface. */
export const canBulkDismissContextSession=(s:ContextSession)=>s.state==='idle'&&s.surfacePresence!=='live'&&!!contextSnapshotKey(s);
