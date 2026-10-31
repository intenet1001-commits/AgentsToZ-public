/**
 * Evidence that a /compact or /clear sent from the dock (src/components/DockSessionsPanel.tsx) took effect, read on the
 * host for `/api/context-usage`. Numbers, times and session IDs only — never a message body.
 *
 * - **Compaction**: when a compaction finishes, Claude Code appends one row
 *   `{"type":"system","subtype":"compact_boundary",…,"compactMetadata":{"trigger","preTokens","postTokens",…}}` to the
 *   conversation's transcript. Measured 2026-10-31 (Orca Claude, Agentsforequity): /compact received 16:13:40, the row at
 *   16:14:42, 46,668 → 45,786 tokens. Its statusline does NOT show the smaller number until the next reply — right after a
 *   start, resume or compaction it reports 0 tokens (src/contextUsageReading.ts), and that time it did not re-render at
 *   all — so this row, not the context %, is what says a compaction happened.
 *   The summary and re-attached files are written right after the row (418 KB that time), so between two reads the row
 *   can fall out of a bounded transcript tail: `scanClaudeCompactionRange` reads the appended bytes the tail missed.
 * - **Clear**: Claude starts a new conversation (a new session ID) in the same process, so the same terminal's statusline
 *   capture — the same Workroom ID, or the same Orca worktree + pane — appears under the new ID (`nextClaudeConversations`).
 */
export interface ClaudeCompaction {at:string;trigger:'manual'|'auto'|null;preTokens:number|null;postTokens:number|null}
export interface NextClaudeConversation {sessionId:string;capturedAt:string;usedPercent:number|null;usedTokens:number|null}

/** Unescaped, so it never matches inside a JSON string value (a message that merely mentions it). */
export const CLAUDE_COMPACTION_MARKER='"type":"system","subtype":"compact_boundary"';
/** A boundary row is about 0.7–1.5 KB; anything far larger is not one. Also the margin read around a scanned range. */
const MAX_ROW_BYTES=256*1024;
export const CLAUDE_COMPACTION_GAP_SCAN_BYTES=8*1024*1024;

const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const count=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const newer=(a:ClaudeCompaction|null,b:ClaudeCompaction|null)=>!a?b:!b?a:Date.parse(b.at)>=Date.parse(a.at)?b:a;

export function claudeCompactionFromRow(line:string):ClaudeCompaction|null{
  if(line.length>MAX_ROW_BYTES||!line.includes(CLAUDE_COMPACTION_MARKER))return null;
  let row:Record<string,unknown>|null;
  try{row=object(JSON.parse(line));}catch{return null;}
  if(!row||row.type!=='system'||row.subtype!=='compact_boundary'||row.isSidechain===true||typeof row.timestamp!=='string')return null;
  const at=Date.parse(row.timestamp);
  if(!Number.isFinite(at))return null;
  const meta=object(row.compactMetadata)??{};
  return {at:new Date(at).toISOString(),trigger:meta.trigger==='manual'||meta.trigger==='auto'?meta.trigger:null,
    preTokens:count(meta.preTokens),postTokens:count(meta.postTokens)};
}

/** The newest compaction row in a chunk of transcript text. A bounded tail may begin or end mid-row; those rows are skipped. */
export function lastClaudeCompaction(text:string):ClaudeCompaction|null{
  let last:ClaudeCompaction|null=null;
  for(let i=text.indexOf(CLAUDE_COMPACTION_MARKER);i>=0;i=text.indexOf(CLAUDE_COMPACTION_MARKER,i+CLAUDE_COMPACTION_MARKER.length)){
    const end=text.indexOf('\n',i);
    last=newer(last,claudeCompactionFromRow(text.slice(text.lastIndexOf('\n',i)+1,end<0?text.length:end)));
  }
  return last;
}

/**
 * Bytes [start,end) of a transcript that was `size` bytes long, searched for compaction rows only: at most `limit` bytes
 * nearest `end`, plus a margin on both sides so a row straddling either edge is still read whole. Only matching rows are
 * decoded.
 */
export function scanClaudeCompactionRange(readAt:(position:number,length:number)=>Uint8Array,start:number,end:number,size:number,limit=CLAUDE_COMPACTION_GAP_SCAN_BYTES):ClaudeCompaction|null{
  end=Math.min(end,size);
  if(!(end>start)||start<0)return null;
  const from=Math.max(start,end-limit),lo=Math.max(0,from-MAX_ROW_BYTES),hi=Math.min(size,end+MAX_ROW_BYTES);
  const raw=readAt(lo,hi-lo),bytes=Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength);
  let last:ClaudeCompaction|null=null;
  for(let i=bytes.indexOf(CLAUDE_COMPACTION_MARKER);i>=0;i=bytes.indexOf(CLAUDE_COMPACTION_MARKER,i+CLAUDE_COMPACTION_MARKER.length)){
    const rowStart=bytes.lastIndexOf(0x0a,i)+1,newline=bytes.indexOf(0x0a,i),rowEnd=newline<0?bytes.length:newline;
    if(rowEnd-rowStart>MAX_ROW_BYTES)continue;
    last=newer(last,claudeCompactionFromRow(bytes.toString('utf8',rowStart,rowEnd)));
  }
  return last;
}

/** The terminal a Claude statusline capture came from — only the two surfaces the dock can send /clear to. */
export function claudeTerminalKey(launchContext:unknown):string|null{
  const context=object(launchContext);
  if(!context)return null;
  const id=(value:unknown)=>typeof value==='string'&&value.trim()&&value.length<=4096&&!/[\0\r\n]/.test(value)?value:null;
  const workroom=id(context.agentstozWorkroomSessionId);
  if(workroom)return `workroom\n${workroom}`;
  const worktree=id(context.orcaWorktreeId),pane=id(context.orcaPaneKey);
  return worktree&&pane?`orca\n${worktree}\n${pane}`:null;
}

/**
 * For each conversation, the first other conversation captured later in the same terminal. After /clear that is the new
 * conversation. A capture's time is its latest statusline render, and a terminal runs one Claude at a time, so the
 * earliest later capture is the direct successor even after more /clear's.
 */
export function nextClaudeConversations(rows:readonly {sessionId:string;capturedAt:string;usedPercent:number|null;usedTokens:number|null;launchContext:unknown}[]):Map<string,NextClaudeConversation>{
  const groups=new Map<string,{row:(typeof rows)[number];at:number}[]>();
  for(const row of rows){
    const key=claudeTerminalKey(row.launchContext),at=Date.parse(row.capturedAt);
    if(!key||!Number.isFinite(at)||!row.sessionId)continue;
    groups.set(key,[...groups.get(key)??[],{row,at}]);
  }
  const next=new Map<string,NextClaudeConversation>();
  for(const group of groups.values()){
    group.sort((a,b)=>a.at-b.at);
    group.forEach(({row,at},index)=>{
      const later=group.slice(index+1).find(other=>other.at>at&&other.row.sessionId!==row.sessionId)?.row;
      if(later)next.set(row.sessionId,{sessionId:later.sessionId,capturedAt:later.capturedAt,usedPercent:later.usedPercent,usedTokens:later.usedTokens});
    });
  }
  return next;
}
