import {afterEach,expect,test} from 'bun:test';
import {closeSync,mkdtempSync,openSync,readFileSync,readSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CLAUDE_COMPACTION_MARKER,claudeCompactionFromRow,claudeTerminalKey,lastClaudeCompaction,nextClaudeConversations,scanClaudeCompactionRange} from '../src/contextCommandEvidence';
import {parseClaudeSessionMetadata} from '../src/contextSessionMetadata';
import {claudeSnapshotUsedTokens,measuredContextPercent} from '../src/contextUsageReading';
import {claudeWorkroomContext} from '../src/workroomSessionStatus';

const cleanup:(()=>void)[]=[];afterEach(()=>{for(const c of cleanup.splice(0))c();});
const SID='1be647da-fc89-4cab-af6f-1187db4c0af8';
/** The shape Claude Code wrote on 2026-10-31 for a manual /compact (keys in its order; ids and paths replaced). */
const boundary=(timestamp:string,meta:Record<string,unknown>={trigger:'manual',preTokens:46668,postTokens:45786,durationMs:60888},extra:Record<string,unknown>={})=>JSON.stringify({
  parentUuid:null,logicalParentUuid:'00000000-0000-4000-8000-000000000001',isSidechain:false,type:'system',subtype:'compact_boundary',
  content:'Conversation compacted',level:'info',compactMetadata:meta,uuid:'00000000-0000-4000-8000-000000000002',timestamp,
  userType:'external',entrypoint:'cli',cwd:'/Users/fixture/project',sessionId:SID,version:'2.1.314',...extra});
const user=(text:string)=>JSON.stringify({type:'user',message:{role:'user',content:text},timestamp:'2026-10-31T16:13:40.439Z',sessionId:SID});
const filler=(bytes:number)=>JSON.stringify({type:'attachment',attachment:{content:'x'.repeat(bytes)}});

test('a compaction row is read for its time, trigger and token counts only',()=>{
  expect(claudeCompactionFromRow(boundary('2026-10-31T16:14:42.304Z'))).toEqual({at:'2026-10-31T16:14:42.304Z',trigger:'manual',preTokens:46668,postTokens:45786});
  // An older Claude wrote no postTokens for an auto compaction.
  expect(claudeCompactionFromRow(boundary('2026-10-31T14:37:40.529Z',{trigger:'auto',preTokens:346272}))).toEqual({at:'2026-10-31T14:37:40.529Z',trigger:'auto',preTokens:346272,postTokens:null});
  // A message quoting the marker is a JSON string (escaped quotes): never matched. Nor a sidechain or a row without a time.
  expect(claudeCompactionFromRow(user(`look: {${CLAUDE_COMPACTION_MARKER}}`))).toBeNull();
  expect(user(CLAUDE_COMPACTION_MARKER).includes(CLAUDE_COMPACTION_MARKER)).toBe(false);
  expect(claudeCompactionFromRow(boundary('2026-10-31T16:14:42.304Z',undefined,{isSidechain:true}))).toBeNull();
  expect(claudeCompactionFromRow(boundary('not a time'))).toBeNull();
  expect(claudeCompactionFromRow(boundary('2026-10-31T16:14:42.304Z').slice(0,200))).toBeNull();
});

test('the newest compaction in a tail wins, and the metadata parser reports it only when there is one',()=>{
  const text=[boundary('2026-10-31T14:37:40.529Z',{trigger:'auto',preTokens:346272,postTokens:46668}),user('hi'),boundary('2026-10-31T16:14:42.304Z'),filler(100)].join('\n');
  expect(lastClaudeCompaction(text)?.at).toBe('2026-10-31T16:14:42.304Z');
  // A bounded tail that starts mid-row loses only that row.
  expect(lastClaudeCompaction(text.slice(text.indexOf(CLAUDE_COMPACTION_MARKER)+5))?.at).toBe('2026-10-31T16:14:42.304Z');
  expect(parseClaudeSessionMetadata(text).lastCompaction?.postTokens).toBe(45786);
  expect('lastCompaction' in parseClaudeSessionMetadata(user('no compaction here'))).toBe(false);
});

test('a compaction row pushed out of the 512 KB tail by its own summary is found in the appended bytes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'compaction-scan-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,`${SID}.jsonl`),before=[user('a'),filler(300_000)].join('\n')+'\n';
  writeFileSync(file,before);
  const readSize=statSync(file).size;
  // Measured: 418 KB after the row; make it more than the tail.
  writeFileSync(file,before+[boundary('2026-10-31T16:14:42.304Z'),filler(700_000),user('next')].join('\n')+'\n');
  const size=statSync(file).size,TAIL=512*1024,tailStart=size-TAIL;
  const tail=readFileSync(file).subarray(tailStart).toString('utf8');
  expect(lastClaudeCompaction(tail)).toBeNull();
  const readAt=(position:number,length:number)=>{const b=Buffer.alloc(length),fd=openSync(file,'r');try{return b.subarray(0,readSync(fd,b,0,length,position));}finally{closeSync(fd);}};
  expect(scanClaudeCompactionRange(readAt,readSize,tailStart,size)).toEqual({at:'2026-10-31T16:14:42.304Z',trigger:'manual',preTokens:46668,postTokens:45786});
  // The range's margin reads a row that straddles its end whole.
  const rowAt=before.length;
  expect(scanClaudeCompactionRange(readAt,readSize,rowAt+10,size)?.preTokens).toBe(46668);
  // Nothing appended, or a range before the row: no answer, never a guess.
  expect(scanClaudeCompactionRange(readAt,size,size,size)).toBeNull();
  expect(scanClaudeCompactionRange(readAt,0,1000,size)).toBeNull();
  // Only `limit` bytes nearest the end (plus the row margin) are read when far more was appended.
  let read=0;
  expect(scanClaudeCompactionRange((p,l)=>{read+=l;return readAt(p,l);},0,size,size,64*1024)).toBeNull();
  expect(read).toBeLessThanOrEqual(64*1024+256*1024);
});

test('after /clear the same terminal’s capture under a new session ID is the next conversation',()=>{
  const workroom={agentstozWorkroomSessionId:'aaaaaaaa-0000-4000-8000-000000000000'},orca={orcaWorktreeId:'wt::/p',orcaPaneKey:'tab-1:leaf-1'};
  expect(claudeTerminalKey(workroom)).toBe('workroom\naaaaaaaa-0000-4000-8000-000000000000');
  expect(claudeTerminalKey(orca)).toBe('orca\nwt::/p\ntab-1:leaf-1');
  // cmux, a plain terminal, or half an Orca identity cannot receive a dock command: no key.
  for(const context of [null,{},{cmuxWorkspaceId:'w',cmuxSurfaceId:'s'},{orcaPaneKey:'tab-1:leaf-1'},{agentstozWorkroomSessionId:'a\nb'}])expect(claudeTerminalKey(context)).toBeNull();
  const row=(sessionId:string,capturedAt:string,launchContext:unknown,usedPercent:number|null=null,usedTokens:number|null=null)=>({sessionId,capturedAt,launchContext,usedPercent,usedTokens});
  const next=nextClaudeConversations([
    row('old-orca-1','2026-11-01T01:00:00Z',orca,62,124000),
    row('new-orca-2','2026-11-01T01:00:05Z',orca,0,0),        // the cleared conversation, before its first reply
    row('newer-orca-3','2026-11-01T01:30:00Z',orca,3,30000),  // a second /clear later
    row('other-pane-4','2026-11-01T01:00:02Z',{...orca,orcaPaneKey:'tab-2:leaf-9'},10,1),
    row('workroom-old-5','2026-11-01T02:00:00Z',workroom,40,1),
    row('workroom-new-6','2026-11-01T02:00:03Z',workroom,null,null),
    row('plain-7','2026-11-01T03:00:00Z',null,5,1),row('plain-8','2026-11-01T03:00:01Z',null,5,1),
  ]);
  expect(next.get('old-orca-1')).toEqual({sessionId:'new-orca-2',capturedAt:'2026-11-01T01:00:05Z',usedPercent:0,usedTokens:0});
  expect(next.get('new-orca-2')?.sessionId).toBe('newer-orca-3');
  expect(next.has('newer-orca-3')).toBe(false);
  expect(next.has('other-pane-4')).toBe(false);
  expect(next.get('workroom-old-5')?.sessionId).toBe('workroom-new-6');
  expect(next.has('plain-7')).toBe(false);
});

test('a zero Claude reading is 「not measured」, never 0% — in the dock rows and in the Workroom footer',()=>{
  // The Orca snapshot behind 「컨텍스트 0%」 (2026-10-31): zeros everywhere until Claude's next reply.
  const zero={context_window_size:1000000,used_percentage:0,remaining_percentage:100,total_input_tokens:0,current_usage:{input_tokens:0,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0}};
  expect(claudeSnapshotUsedTokens(zero)).toBe(0);
  expect(measuredContextPercent({usedPercent:0,usedTokens:0})).toBeNull();
  expect(measuredContextPercent({usedPercent:0,usedTokens:null})).toBeNull();
  expect(measuredContextPercent({usedPercent:null,usedTokens:null})).toBeNull();
  expect(measuredContextPercent({usedPercent:20,usedTokens:198710})).toBe(20);
  expect(measuredContextPercent({usedPercent:51})).toBe(51);
  expect(measuredContextPercent({usedPercent:0,usedTokens:4000})).toBe(0);
  expect(measuredContextPercent({usedPercent:140,usedTokens:1})).toBe(100);
  const session={id:'session-1234',cwd:'/fixture',createdAt:'2026-09-13T00:00:00Z'},now=Date.parse('2026-09-13T00:10:00Z');
  const snap={sessionId:session.id,cwd:session.cwd,capturedAt:'2026-09-13T00:05:00Z'};
  expect(claudeWorkroomContext(session,{...snap,contextWindow:zero},now)).toEqual({usedPercent:null,observedAt:null,source:'unavailable'});
  expect(claudeWorkroomContext(session,{...snap,contextWindow:{...zero,used_percentage:5,current_usage:{input_tokens:2,cache_read_input_tokens:49998}}},now).usedPercent).toBe(5);
});

test('the context list carries the evidence on Claude rows only, computed before rows without a reading are dropped',()=>{
  const api=readFileSync(new URL('../api-server.ts',import.meta.url),'utf8');
  const handler=api.slice(api.indexOf('url.pathname === "/api/context-usage"'));
  expect(handler.indexOf('nextClaudeConversations(claudeSnapshots')).toBeGreaterThan(0);
  expect(handler.indexOf('nextClaudeConversations(claudeSnapshots')).toBeLessThan(handler.indexOf('const claudeSnapshotRows = claudeSnapshots.filter(({ session }) => session.usedPercent !== null)'));
  expect(handler).toContain('...(metadata?.lastCompaction ? { lastCompaction: metadata.lastCompaction } : {})');
  expect(handler).toContain('...(nextConversation ? { nextConversation } : {})');
  // The gap scan reads only bytes appended since the last read of the same file that the tail did not cover.
  const reader=api.slice(api.indexOf('function readClaudeSessionMetadata('),api.indexOf('function isRuntimeUuid('));
  expect(reader).toContain('cached && cached.filePath === filePath && cached.stamp && stamp.size >= cached.stamp.size');
  expect(reader).toContain('scanClaudeCompactionRange(');
});
