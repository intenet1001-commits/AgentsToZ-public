import {ControlProfileError,type ControlProfileStatus} from './controlProfileContract';
import {parseProjectMemoryEntries} from './projectMemoryRecall';

/**
 * Read-only view of the saved OPS operating memory for 아젠투지 설정 — the Mac panel only. It is never part of
 * the remote `ops.status` DTO or any phone/relay result (their normalizers reject unknown keys).
 * Titles come first and one body on request, both bounded. Saving still goes through a candidate, which only
 * appends: there is no edit path here, so nothing in this view offers one.
 */
export const CONTROL_MEMORY_LIST_LIMIT=200;
export const CONTROL_MEMORY_TITLE_LIMIT=200;
export const CONTROL_MEMORY_BODY_LIMIT=12_000;
export type ControlMemoryEntryTitle={entryId:string;section:string;title:string};
export type ControlMemoryEntryList=
  | {ready:true;revision:string|null;total:number;entries:ControlMemoryEntryTitle[]}
  | {ready:false;problem:string;total:0;entries:[]};
export type ControlMemoryEntryBody=ControlMemoryEntryTitle&{revision:string|null;body:string;truncated:boolean};
type Reader={read():{status:ControlProfileStatus;snapshot:{document:string}}};
const ENTRY_ID=/^[0-9a-f]{24}$/;

/** Cut by code point so a clipped title or body never ends in half a surrogate pair. */
function clip(text:string,max:number):{text:string;truncated:boolean}{
  if(text.length<=max)return {text,truncated:false};
  const points=Array.from(text);
  return points.length<=max?{text,truncated:false}:{text:points.slice(0,max).join(''),truncated:true};
}
const title=(entry:{entryId:string;section:string;title:string}):ControlMemoryEntryTitle=>
  ({entryId:entry.entryId,section:clip(entry.section,CONTROL_MEMORY_TITLE_LIMIT).text,title:clip(entry.title,CONTROL_MEMORY_TITLE_LIMIT).text});

/** Newest first (entries are appended). A profile that is not ready answers with its problem instead of throwing. */
export function listControlMemoryEntries(store:Reader):ControlMemoryEntryList{
  let read;
  try{read=store.read();}
  catch(error){
    if(error instanceof ControlProfileError&&error.code==='CONTROL_PROFILE_NOT_READY')return {ready:false,problem:error.message,total:0,entries:[]};
    throw error;
  }
  const all=parseProjectMemoryEntries(read.snapshot.document).reverse();
  return {ready:true,revision:read.status.revision,total:all.length,entries:all.slice(0,CONTROL_MEMORY_LIST_LIMIT).map(title)};
}

export function readControlMemoryEntry(store:Reader,entryId:unknown):ControlMemoryEntryBody{
  if(typeof entryId!=='string'||!ENTRY_ID.test(entryId))throw new ControlProfileError('CONTROL_MEMORY_ENTRY_INVALID','운영 기억 항목을 다시 선택하세요.',400);
  const {status,snapshot}=store.read();
  const entry=parseProjectMemoryEntries(snapshot.document).find(item=>item.entryId===entryId);
  if(!entry)throw new ControlProfileError('CONTROL_MEMORY_ENTRY_MISSING','운영 기억이 바뀌었습니다. 「상태 다시 확인」으로 목록을 다시 불러오세요.',404);
  const body=clip(entry.body,CONTROL_MEMORY_BODY_LIMIT);
  return {...title(entry),revision:status.revision,body:body.text,truncated:body.truncated};
}
