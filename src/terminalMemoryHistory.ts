import type {TerminalMemoryState} from './terminalMemoryQueue';
export type MemoryHistoryJob={sessionId:string;state:TerminalMemoryState};
export const TERMINAL_MEMORY_HISTORY_KEY='agentstoz-workroom-previous-receipts-v1';
export const memoryHistoryKey=(job:MemoryHistoryJob)=>`${job.sessionId}:${job.state}`;
export const canMoveMemoryToHistory=(job:MemoryHistoryJob)=>['saved','unchanged','failed','unavailable','recovery-required'].includes(job.state);
export function readMemoryHistory(value:string|null):string[]{
 try{const parsed=JSON.parse(value??'[]');return Array.isArray(parsed)?parsed.filter((key):key is string=>typeof key==='string'&&key.length<=160).slice(-2048):[];}catch{return [];}
}
export function moveMemoryToHistory(previous:readonly string[],jobs:readonly MemoryHistoryJob[]):string[]{
 return [...new Set([...previous,...jobs.filter(canMoveMemoryToHistory).map(memoryHistoryKey)])].slice(-2048);
}

/** A repeated status poll must not repaint dozens of unchanged receipt rows. */
export function reuseUnchangedMemoryJobs<T extends {sessionId:string;targetId:string;state:TerminalMemoryState}>(previous:readonly T[],incoming:readonly T[]):T[]{
 return previous.length===incoming.length&&incoming.every((job,index)=>job.sessionId===previous[index]?.sessionId
  &&job.targetId===previous[index]?.targetId&&job.state===previous[index]?.state)?previous as T[]:[...incoming];
}
