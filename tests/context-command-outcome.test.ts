import {afterEach,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {
  CONTEXT_CLEAR_WAIT_MS,CONTEXT_COMMAND_TRACKS_KEY,CONTEXT_COMPACT_WAIT_MS,CONTEXT_OUTCOME_VISIBLE_MS,
  advanceContextCommandTrack,contextCommandOutcomeView,contextCommandTrackHome,parseContextCommandTracks,pruneContextCommandTracks,
  readContextCommandTracks,startContextCommandTrack,writeContextCommandTracks,type ContextCommandRow,type ContextCommandTrack,
} from '../src/contextCommandOutcome';

const T0=Date.parse('2026-11-01T01:00:00Z'),iso=(ms:number)=>new Date(T0+ms).toISOString(),S='session-orca-0001',N='session-orca-0002';
const row=(patch:Partial<ContextCommandRow>={}):ContextCommandRow=>({sessionId:S,usedPercent:62,usedTokens:124_000,windowSize:200_000,capturedAt:iso(-60_000),surfacePresence:'live',...patch});
/** Pressed at T0, the host confirmed the write 3 s later. */
const track=(command:'compact'|'clear'='compact',patch:Partial<ContextCommandTrack>={})=>({...startContextCommandTrack({session:row(),sessionId:S,command,surface:'orca',startedAt:T0,sentAt:T0+3_000,id:'track-00000001'}),...patch});
const step=(t:ContextCommandTrack,rows:ContextCommandRow[],at:number)=>advanceContextCommandTrack(t,rows,T0+at);
const text=(t:ContextCommandTrack,at:number,rows:ContextCommandRow[]=[])=>contextCommandOutcomeView(t,T0+at,rows).text;

test('pending: nothing changed yet is 「waiting」 with the time since the send, and the reading before it is what the person saw',()=>{
  const t=track();
  expect(t.beforePercent).toBe(62);expect(t.windowSize).toBe(200_000);
  const waiting=step(t,[row()],40_000);
  expect(waiting.outcome).toBeUndefined();
  expect(contextCommandOutcomeView(waiting,T0+40_000)).toEqual({tone:'waiting',text:'요약 처리 중 — 컨텍스트 변화를 기다리는 중 · 37초'});
  expect(text(waiting,128_000)).toBe('요약 처리 중 — 컨텍스트 변화를 기다리는 중 · 2분 5초');
  expect(text(track('clear'),63_000)).toBe('새 대화로 비우는 중 — 같은 창의 새 대화를 기다리는 중 · 1분');
  // A reading taken before the press, or one that only grew, is not a result.
  expect(step(t,[row({capturedAt:iso(-1),usedPercent:10,usedTokens:20_000})],40_000).outcome).toBeUndefined();
  expect(step(t,[row({capturedAt:iso(30_000),usedPercent:64,usedTokens:128_000})],40_000).outcome).toBeUndefined();
});

test('compact: the transcript’s compaction row is the result, with tokens before → after',()=>{
  // Measured 2026-10-31: 46,668 → 45,786 tokens in a 1M window. The statusline never re-rendered (still the old 0 reading).
  const t=track('compact',{beforePercent:null,windowSize:1_000_000});
  const before=row({usedPercent:0,usedTokens:0,windowSize:1_000_000});
  expect(step(t,[{...before,lastCompaction:{at:iso(-600_000),trigger:'auto',preTokens:346_272,postTokens:46_668}}],70_000).outcome).toBeUndefined();
  const done=step(t,[{...before,lastCompaction:{at:iso(61_865),trigger:'manual',preTokens:46_668,postTokens:45_786}}],70_000);
  expect(done.outcome).toMatchObject({kind:'compacted',source:'record',fromTokens:46_668,toTokens:45_786});
  expect(contextCommandOutcomeView(done,T0+70_000)).toEqual({tone:'done',text:'요약 완료 · 컨텍스트 4.7% → 4.6% (46.7K → 45.8K 토큰)'});
  // Settled: later reads do not change it.
  expect(step(done,[before],CONTEXT_COMPACT_WAIT_MS*2)).toBe(done);
  // Without postTokens (older Claude) the smaller number comes with the next reply.
  const noAfter=step(track(),[row({lastCompaction:{at:iso(60_000),trigger:'manual',preTokens:124_000,postTokens:null}})],70_000);
  expect(text(noAfter,70_000)).toBe('요약 완료 · 컨텍스트 62% → 다음 응답 뒤 표시');
});

test('compact: a context reading that dropped after the press is the result',()=>{
  const done=step(track(),[row({capturedAt:iso(90_000),usedPercent:18,usedTokens:36_000})],95_000);
  expect(done.outcome).toMatchObject({kind:'compacted',source:'reading',fromPercent:62,toPercent:18});
  expect(text(done,95_000)).toBe('요약 완료 · 컨텍스트 62% → 18%');
  // A 1-point rounding step is not a compaction.
  expect(step(track(),[row({capturedAt:iso(90_000),usedPercent:61.5,usedTokens:123_000})],95_000).outcome).toBeUndefined();
});

test('compact: a reading that turned into Claude’s zero right after the press 「looks compacted」, and a later record or drop settles it',()=>{
  const reset=step(track(),[row({capturedAt:iso(80_000),usedPercent:0,usedTokens:0})],85_000);
  expect(reset.outcome).toMatchObject({kind:'compacted',source:'reset',fromPercent:62,toPercent:null});
  expect(text(reset,85_000)).toBe('요약된 것으로 보입니다 · 컨텍스트 62% → 다음 응답 뒤 표시 (Claude가 사용량 표시를 초기화했습니다)');
  expect(step(reset,[row({capturedAt:iso(80_000),usedPercent:0,usedTokens:0})],CONTEXT_COMPACT_WAIT_MS+60_000)).toBe(reset);
  const settled=step(reset,[row({capturedAt:iso(200_000),usedPercent:21,usedTokens:42_000})],205_000);
  expect(settled.outcome).toMatchObject({source:'reading',toPercent:21});
  // Unknown before, unknown after: nothing to compare, so no 「looks compacted」 either.
  expect(step(track('compact',{beforePercent:null}),[row({capturedAt:iso(80_000),usedPercent:0,usedTokens:0})],85_000).outcome).toBeUndefined();
});

test('compact: no evidence by the deadline says why — no reading, no refresh, or simply nothing',()=>{
  const late=CONTEXT_COMPACT_WAIT_MS+3_000;
  expect(step(track(),[row()],late-1).outcome).toBeUndefined();
  const notRefreshed=step(track(),[row()],late);
  expect(notRefreshed.outcome).toMatchObject({kind:'unconfirmed',reason:'not-refreshed'});
  expect(contextCommandOutcomeView(notRefreshed,T0+late)).toEqual({tone:'unconfirmed',
    text:'결과 확인 안 됨 · 5분 동안 요약 기록이 없고 컨텍스트 측정값도 갱신되지 않았습니다. Orca 화면에서 확인하세요. 명령은 다시 보내지 않았습니다.'});
  const refreshed=step(track(),[row({capturedAt:iso(200_000),usedPercent:63,usedTokens:126_000})],late);
  expect(refreshed.outcome).toMatchObject({reason:'timeout'});
  expect(text(refreshed,late)).toContain('5분 안에 요약 기록도, 컨텍스트 감소도 보이지 않았습니다');
  const unmeasured=step(track('compact',{beforePercent:null,surface:'workroom'}),[row({usedPercent:0,usedTokens:0})],late);
  expect(unmeasured.outcome).toMatchObject({reason:'no-reading'});
  expect(text(unmeasured,late)).toBe('결과 확인 안 됨 · 컨텍스트 측정값이 없고 요약 기록도 찾지 못했습니다. 워크룸 화면에서 확인하세요. 명령은 다시 보내지 않았습니다.');
  // Stronger evidence arriving while the result is still shown replaces it.
  expect(step(refreshed,[row({lastCompaction:{at:iso(310_000),trigger:'manual',preTokens:124_000,postTokens:30_000}})],late+20_000).outcome).toMatchObject({kind:'compacted',source:'record',toPercent:15});
});

test('compact: a closed session window ends the wait at once; a row that vanished ends it at the deadline',()=>{
  const closed=step(track(),[row({surfacePresence:'gone'})],20_000);
  expect(closed.outcome).toMatchObject({kind:'unconfirmed',reason:'closed'});
  expect(text(closed,20_000)).toContain('결과가 보이기 전에 세션 창이 닫혔습니다');
  // Evidence first: a record next to a closed window is still a result.
  expect(step(track(),[row({surfacePresence:'gone',lastCompaction:{at:iso(15_000),trigger:'manual',preTokens:1,postTokens:1}})],20_000).outcome?.kind).toBe('compacted');
  expect(step(track(),[],20_000).outcome).toBeUndefined();
  expect(step(track(),[],CONTEXT_COMPACT_WAIT_MS+3_000).outcome).toMatchObject({reason:'missing'});
});

test('clear: a new conversation in the same terminal is the result, and its reading shows once it has one',()=>{
  const t=track('clear');
  expect(step(t,[row({nextConversation:{sessionId:N,capturedAt:iso(-5_000),usedPercent:3,usedTokens:6_000}})],10_000).outcome).toBeUndefined();
  const done=step(t,[row({nextConversation:{sessionId:N,capturedAt:iso(4_000),usedPercent:0,usedTokens:0}})],10_000);
  expect(done.outcome).toMatchObject({kind:'cleared',nextSessionId:N,fromPercent:62,toPercent:null});
  expect(text(done,10_000)).toBe('새 대화로 비움 · 컨텍스트 62% → 첫 응답 뒤 표시');
  expect(text(done,90_000,[row({sessionId:N,usedPercent:3,usedTokens:6_000})])).toBe('새 대화로 비움 · 컨텍스트 62% → 3%');
  // A Workroom's new conversation listed on its own (an older host without `nextConversation`).
  const workroom=track('clear',{surface:'workroom',workroomSessionId:'workroom-0000001'});
  expect(step(workroom,[row(),row({sessionId:N,workroomSessionId:'workroom-0000001',capturedAt:iso(6_000),usedPercent:4,usedTokens:8_000})],10_000).outcome)
    .toMatchObject({kind:'cleared',nextSessionId:N,toPercent:4});
  expect(step(workroom,[row(),row({sessionId:N,workroomSessionId:'workroom-other01',capturedAt:iso(6_000)})],10_000).outcome).toBeUndefined();
});

test('clear: the old conversation leaving its window is expected, so it waits; no new one by the deadline says so',()=>{
  const gone=row({surfacePresence:'gone'});
  expect(step(track('clear'),[gone],60_000).outcome).toBeUndefined();
  const late=step(track('clear'),[gone],CONTEXT_CLEAR_WAIT_MS+3_000);
  expect(late.outcome).toMatchObject({kind:'unconfirmed',reason:'closed'});
  expect(text(late,CONTEXT_CLEAR_WAIT_MS+3_000)).toBe('결과 확인 안 됨 · 이 대화는 창에서 빠졌지만 새 대화가 아직 보이지 않습니다(새 대화는 첫 응답 뒤에 나타날 수 있습니다). Orca 화면에서 확인하세요. 명령은 다시 보내지 않았습니다.');
  expect(step(track('clear'),[row()],CONTEXT_CLEAR_WAIT_MS+3_000).outcome).toMatchObject({reason:'timeout'});
  expect(text(step(track('clear'),[row()],CONTEXT_CLEAR_WAIT_MS+3_000),CONTEXT_CLEAR_WAIT_MS+3_000)).toContain('2분 안에 같은 창의 새 대화가 보이지 않았습니다');
  // The new conversation appearing later still settles it.
  expect(step(late,[row({nextConversation:{sessionId:N,capturedAt:iso(150_000),usedPercent:null,usedTokens:null}})],160_000).outcome?.kind).toBe('cleared');
});

test('a confirmed clear is shown on the new conversation once that row is listed',()=>{
  const done=step(track('clear'),[row({nextConversation:{sessionId:N,capturedAt:iso(4_000),usedPercent:null,usedTokens:null}})],10_000);
  expect(contextCommandTrackHome(done,new Set([S]))).toBe(S);
  expect(contextCommandTrackHome(done,new Set([S,N]))).toBe(N);
  expect(contextCommandTrackHome(track('compact'),new Set([N]))).toBe(S);
});

test('the store keeps valid tracks only, at most 16, and a shown result for 10 minutes',()=>{
  const storage=new Map<string,string>(),real=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,writable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>void storage.set(k,String(v)),removeItem:(k:string)=>void storage.delete(k)}});
  cleanups.push(()=>{if(real)Object.defineProperty(globalThis,'localStorage',real);else delete (globalThis as {localStorage?:unknown}).localStorage;});
  const t=track(),done=step(t,[row({capturedAt:iso(90_000),usedPercent:18,usedTokens:36_000})],95_000);
  writeContextCommandTracks([t,done]);
  expect(readContextCommandTracks()).toEqual([t,done]);
  expect(JSON.parse(storage.get(CONTEXT_COMMAND_TRACKS_KEY)!)).toHaveLength(2);
  writeContextCommandTracks(Array.from({length:20},(_,i)=>({...t,id:`track-${String(i).padStart(8,'0')}`})));
  expect(readContextCommandTracks()).toHaveLength(16);
  for(const bad of [{...t,sessionId:'../x'},{...t,command:'reset'},{...t,surface:'iterm'},{...t,sentAt:'soon'},{...t,outcome:{kind:'compacted',at:1,source:'guess'}},{...t,outcome:{kind:'cleared',at:1,fromPercent:null,toPercent:null,nextSessionId:'x'}}])
    expect(parseContextCommandTracks(JSON.stringify([bad]))).toEqual([]);
  expect(parseContextCommandTracks('not json')).toEqual([]);
  storage.set(CONTEXT_COMMAND_TRACKS_KEY,'{');expect(readContextCommandTracks()).toEqual([]);
  // Waiting tracks stay; a result leaves after it was shown long enough; a send older than 6 hours leaves unshown.
  const shownAt=T0+95_000;
  expect(pruneContextCommandTracks([t,done],shownAt+CONTEXT_OUTCOME_VISIBLE_MS-1)).toEqual([t,done]);
  expect(pruneContextCommandTracks([t,done],shownAt+CONTEXT_OUTCOME_VISIBLE_MS)).toEqual([t]);
  expect(pruneContextCommandTracks([t],T0+6*60*60_000+3_000)).toEqual([]);
});

test('the dock row wiring: followed on the 5s read, pinned while shown, nothing resent, unknown readings never 0%',()=>{
  const panel=readFileSync(new URL('../src/components/DockSessionsPanel.tsx',import.meta.url),'utf8');
  // Advanced on each successful read of the rows the panel already polls — no timer or request of its own.
  expect(panel).toContain('advanced=previous.map(t=>advanceContextCommandTrack(t,sessions,now))');
  expect(panel).toMatch(/useEffect\(\(\)=>\{\n\s*if\(!sessions\)return;[\s\S]*?\},\[sessions\]\);/);
  expect(panel.match(/setInterval\(/g)?.length).toBe(1);
  // Only a written send starts one; the outcome line names its state.
  expect(panel).toContain("startContextCommandTrack({session:s,sessionId:s.sessionId,command,");
  expect(panel).toContain('data-testid="voice-dock-session-command-outcome" data-outcome={view.tone}');
  // A clear no longer hides the old row on send — only once a new conversation is seen.
  expect(panel).not.toContain("if(command==='clear')clearRows([s]);");
  expect(panel).toContain("t.outcome?.kind==='cleared'&&previous[i]?.outcome?.kind!=='cleared'");
  expect(panel).toContain('const pinnedIds=new Set([...fencedIds,...tracks.map(trackHome)]);');
  // The context cell and its order use the measured reading.
  expect(panel).toContain('const pct=measuredContextPercent(s)');
  expect(panel).not.toContain("typeof s.usedPercent==='number'?Math.max(0,Math.min(100,s.usedPercent))");
  const client=readFileSync(new URL('../src/contextSessionCommandClient.ts',import.meta.url),'utf8');
  expect(client).not.toContain('처리 결과는 Orca에서 확인하세요');
});
const cleanups:(()=>void)[]=[];afterEach(()=>{for(const c of cleanups.splice(0))c();});
