import { createHash, type Hash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { canonicalSaveSource, saveInteger, saveToken, type MemorySaveSource } from './memorySaveContract';
import type { MemorySaveStore } from './memorySaveStore';
import { codexTranscriptMessage } from './sessionTranscript';

export const MEMORY_OBSERVATION_MAX_BYTES = 8 * 1024 * 1024;
export const MEMORY_OBSERVATION_MAX_RECORD_BYTES = 4 * 1024 * 1024;
export const MEMORY_OBSERVATION_MAX_TURNS = 128;
export interface MemoryObservationBinding {
  agent: 'codex' | 'claude';
  instanceId: string;
  sessionId: string;
  cwd: string;
  memoryId: string;
  policyEpoch: number;
}
export type MemoryObservationResult = { observed: number; complete: boolean; reason:
  'observed' | 'incomplete' | 'source-oversized' | 'source-invalid' | 'source-changed' | 'registration-changed' | 'unavailable' };
const timestamp = (value: unknown): number | null => {
  const time = typeof value==='string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(time) && time >= 0 ? time : null;
};

type ActiveTurn = { id:string; start:number; hash:Hash; hasUser:boolean; parent:string|null; startedAt:number };
/** A strict sequential adapter. Callers must feed contiguous complete JSONL records from byte zero.
 * Codex item completion is not turn completion. Claude tool results are not new human turns.
 * Records are hashed and discarded; only bounded completed metadata remain in memory. */
export class CompletedMemoryTurnReader {
  readonly sources: MemorySaveSource[] = [];
  invalid = false;
  incomplete = false;
  #position = 0;
  #meta = false;
  #active: ActiveTurn | null = null;
  #safeOffset = 0;
  constructor(readonly binding: MemoryObservationBinding) {}
  get hasOpenTurn() { return this.#active !== null; }
  get safeOffset() { return this.#safeOffset; }
  /** Host-only continuation after source header, identity and cursor anchor verification. */
  resumeAt(offset:number): void {
    if (!saveInteger(offset) || offset<this.#position || this.invalid) { this.reject(); return; }
    this.#position=offset;this.#safeOffset=offset;this.#active=null;this.incomplete=false;
  }
  reject(): void { this.invalid=true; this.#active=null; }
  record(bytes: Buffer, start: number): void {
    if (this.invalid) return;
    if (start!==this.#position || bytes.at(-1)!==10) { this.reject(); return; }
    this.#position += bytes.length;
    let row:any;
    try { row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
    catch { this.reject(); return; }
    if (!row || typeof row!=='object' || Array.isArray(row)) { this.reject(); return; }
    if (this.binding.agent==='codex') this.#codex(row,bytes,start);
    else this.#claude(row,bytes,start);
    if (!this.invalid && !this.incomplete && !this.#active) this.#safeOffset=this.#position;
  }
  #owned(cwd:unknown):boolean { return typeof cwd==='string' && isAbsolute(cwd) && resolve(cwd)===resolve(this.binding.cwd); }
  #start(id:string, bytes:Buffer, start:number, startedAt:number, hasUser:boolean, parent:string|null) {
    if (this.#active) this.incomplete=true;
    this.#active={id,start,startedAt,hasUser,parent,hash:createHash('sha256').update(bytes)};
  }
  #finish(completedAt:number) {
    const active=this.#active;
    if (!active || !active.hasUser || completedAt<active.startedAt) { this.reject(); return; }
    if (this.sources.length>=MEMORY_OBSERVATION_MAX_TURNS) { this.incomplete=true; this.#active=null; return; }
    this.sources.push(canonicalSaveSource({agent:this.binding.agent,instanceId:this.binding.instanceId,
      sessionId:this.binding.sessionId,turnId:active.id,startByte:active.start,endByte:this.#position,
      sourceDigest:active.hash.digest('hex'),memoryId:this.binding.memoryId,policyEpoch:this.binding.policyEpoch,
      completedAt,coverageKind:'complete-turn'}));
    this.#active=null;
  }
  #codex(row:any, bytes:Buffer, start:number) {
    const payload=row.payload;
    if (start===0) {
      if (row.type!=='session_meta' || payload?.id!==this.binding.sessionId
        || (payload.session_id!==undefined && payload.session_id!==this.binding.sessionId)
        || !this.#owned(payload.cwd) || !['cli','vscode'].includes(payload.source)
        || (payload.thread_source && typeof payload.thread_source==='object')) { this.reject(); return; }
      this.#meta=true; return;
    }
    if (!this.#meta || row.type==='session_meta') { this.reject(); return; }
    if (row.type==='turn_context' && (!this.#owned(payload?.cwd)
      || (payload?.turn_id && this.#active && payload.turn_id!==this.#active.id))) { this.reject(); return; }
    if (row.type==='event_msg' && payload?.type==='task_started') {
      const time=timestamp(row.timestamp);
      if (!saveToken(payload.turn_id) || time===null) { this.reject(); return; }
      this.#start(payload.turn_id,bytes,start,time,false,null); return;
    }
    if (!this.#active) {
      if (row.type==='event_msg' && payload?.type==='task_complete') this.reject();
      return;
    }
    this.#active.hash.update(bytes);
    if (payload?.turn_id!==undefined && payload.turn_id!==this.#active.id) { this.reject(); return; }
    if (row.type==='event_msg' && ['turn_aborted','task_aborted'].includes(payload?.type)) {
      this.incomplete=true;this.#active=null;return;
    }
    const message=codexTranscriptMessage(row);
    if (message?.role==='user' && message.text.trim()) this.#active.hasUser=true;
    if (row.type==='event_msg' && payload?.type==='task_complete') {
      const time=timestamp(row.timestamp);
      if (time===null || payload.turn_id!==this.#active.id) { this.reject(); return; }
      this.#finish(time);
    }
  }
  #claude(row:any, bytes:Buffer, start:number) {
    const isMessage=row.type==='user'||row.type==='assistant';
    if ((row.sessionId!==undefined && row.sessionId!==this.binding.sessionId) || row.isSidechain===true
      || (row.cwd!==undefined && !this.#owned(row.cwd))) { this.reject(); return; }
    if ((isMessage || row.type==='attachment') && (row.sessionId!==this.binding.sessionId || !this.#owned(row.cwd)
      || !saveToken(row.uuid) || timestamp(row.timestamp)===null)) { this.reject(); return; }
    if (!isMessage) {
      if (this.#active) {
        // Current Claude inserts owned attachment nodes into the parent chain.
        if (row.type==='attachment') {
          if (row.parentUuid!==this.#active.parent) { this.reject(); return; }
          this.#active.parent=row.uuid;
        } else if (row.uuid!==undefined) { this.reject(); return; }
        this.#active.hash.update(bytes);
      }
      return;
    }
    const content=row.message?.content;
    const human=row.type==='user' && row.message?.role==='user' && !row.isMeta
      && (typeof content==='string' && content.trim().length>0 || Array.isArray(content)
        && content.some((part:any)=>part?.type==='text' && typeof part.text==='string' && part.text.trim())
        && !content.some((part:any)=>part?.type==='tool_result'));
    if (human) { this.#start(row.uuid,bytes,start,timestamp(row.timestamp)!,true,row.uuid); return; }
    if (!this.#active) { this.incomplete=true; return; }
    if (row.parentUuid!==this.#active.parent) { this.reject(); return; }
    this.#active.hash.update(bytes);
    this.#active.parent=row.uuid;
    if (row.type==='assistant' && row.message?.role==='assistant' && row.message.stop_reason==='end_turn') this.#finish(timestamp(row.timestamp)!);
  }
}

/** One bounded snapshot, deliberately no live scheduling or model execution.
 * Registered-source discovery supplies the path, allowed transcript root and fresh binding.
 * Large histories/partial records report incompleteness; they never advance a saved watermark.
 * Durable incremental cursor discovery is a separate integration gate. */
export async function observeCompletedMemoryTranscript(input: {
  path:string;
  transcriptRoot:string;
  binding:MemoryObservationBinding;
  validateRegistration:()=>Promise<boolean>;
  store:Pick<MemorySaveStore,'observe'>;
}):Promise<MemoryObservationResult> {
  const result=(reason:MemoryObservationResult['reason'],observed=0):MemoryObservationResult=>({observed,complete:reason==='observed',reason});
  const b={...input.binding};
  if (!['codex','claude'].includes(b.agent) || ![b.instanceId,b.sessionId,b.memoryId].every(saveToken)
    || !saveInteger(b.policyEpoch) || !isAbsolute(b.cwd)) return result('source-invalid');
  let file:Awaited<ReturnType<typeof open>>|undefined;
  const reader=new CompletedMemoryTurnReader(b);
  try {
    if (!await input.validateRegistration()) return result('registration-changed');
    const root=await realpath(input.transcriptRoot);
    const parent=await realpath(dirname(input.path));
    const child=relative(root,parent);
    if (child==='..'||child.startsWith('../')||isAbsolute(child)) return result('source-invalid');
    const canonicalCwd=await realpath(b.cwd);
    file=await open(input.path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before=await file.stat();
    if (!before.isFile()) return result('source-invalid');
    if (before.size>MEMORY_OBSERVATION_MAX_BYTES) return result('source-oversized');
    const buffer=Buffer.allocUnsafe(64*1024);
    let position=0,recordStart=0,length=0;
    let parts:Buffer[]=[];
    while(position<before.size && !reader.invalid) {
      const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,before.size-position),position);
      if (!bytesRead) return result('source-changed');
      position+=bytesRead;
      let offset=0;
      while(offset<bytesRead) {
        let newline=buffer.indexOf(10,offset);
        if (newline>=bytesRead) newline=-1;
        const end=newline<0 ? bytesRead : newline+1;
        const part=buffer.subarray(offset,end);
        length+=part.length;
        if (length>MEMORY_OBSERVATION_MAX_RECORD_BYTES) return result('source-oversized');
        parts.push(Buffer.from(part));
        offset=end;
        if(newline>=0) {
          reader.record(Buffer.concat(parts,length),recordStart);
          recordStart+=length;length=0;parts=[];
          if(reader.invalid)break;
        }
      }
    }
    if(reader.invalid)return result('source-invalid');
    if(!await input.validateRegistration())return result('registration-changed');
    const after=await file.stat();
    const current=await lstat(input.path);
    if(!current.isFile() || [after,current].some(s=>s.dev!==before.dev||s.ino!==before.ino||s.size!==before.size||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs)
      || await realpath(dirname(input.path))!==parent || await realpath(b.cwd)!==canonicalCwd) return result('source-changed');
    // Observations are synchronous after the fresh registration and file checks.
    for(const source of reader.sources)input.store.observe(source);
    return result(length||reader.hasOpenTurn||reader.incomplete ? 'incomplete':'observed',reader.sources.length);
  } catch(error) {
    // Store failures must reach the caller; silently swallowing one would hide durable admission failures.
    if(error && typeof error==='object' && 'code' in error && ['SOURCE_CONFLICT','STORAGE_UNAVAILABLE','UNSUPPORTED_VERSION'].includes(String(error.code)))throw error;
    return result('unavailable');
  } finally {await file?.close();}
}
