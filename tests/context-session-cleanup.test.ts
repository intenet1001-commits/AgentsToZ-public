import {expect,test} from 'bun:test';
import {contextSnapshotKey,parseContextDismissals,withoutDismissedContextSessions,canBulkDismissContextSession} from '../src/contextSessionCleanup';
import {visibleContextSessions,contextSessionHistory} from '../src/contextSessionVisibility';
import type {ContextSession} from '../src/contextSessionMemoryPath';
const session=(over:Partial<ContextSession>={})=>({sourceAgent:'codex',sessionId:'session-user-001',capturedAt:'2026-10-26T01:00:00Z',state:'idle',surfacePresence:'not-applicable',...over}) as ContextSession;
test('internal reviews and workers never appear as user sessions or history; titles do not decide',()=>{
  const user=session({threadTitle:'Guardian review',threadSource:'user'}),guardian=session({threadSource:'guardian_review'}),worker=session({threadSource:'subagent'});
  expect(visibleContextSessions([user,guardian,worker])).toEqual([user]);
  expect(contextSessionHistory([{...guardian,state:'stale'},worker])).toEqual([]);
});
test('cleanup hides only the exact observation; fresh activity with the same context count reappears',()=>{
  const s=session(),keys=[contextSnapshotKey(s)!],newer=session({capturedAt:'2026-10-26T02:00:00Z'});
  expect(withoutDismissedContextSessions([s,newer],keys)).toEqual([newer]);
  expect(withoutDismissedContextSessions([session({sourceAgent:'claude'}),session({capturedAt:undefined})],keys)).toHaveLength(2);
});
test('bulk cleanup preserves active, verified live and unstamped records',()=>{
  expect(canBulkDismissContextSession(session())).toBe(true);
  for(const s of [session({state:'active'}),session({surfacePresence:'live'}),session({capturedAt:undefined})])expect(canBulkDismissContextSession(s)).toBe(false);
});
test('damaged and oversized display storage is bounded and safely ignored',()=>{
  expect(parseContextDismissals('{broken')).toEqual([]);
  expect(parseContextDismissals(JSON.stringify(Array.from({length:1000},(_,i)=>String(i))))).toHaveLength(256);
  expect(parseContextDismissals(JSON.stringify([null,1,'x','x','a'.repeat(513)]))).toEqual(['x']);
});
