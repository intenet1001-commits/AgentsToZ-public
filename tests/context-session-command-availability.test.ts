import {expect,test} from 'bun:test';
import {contextCommandAvailability,contextCommandButtonState,contextCommandManualGuide} from '../src/contextSessionCommandAvailability';
import {dockContextCommandMessages} from '../src/i18n';
const binding={providerSessionId:'provider-001',sessionId:'workroom-001',targetId:'project-001',inputRevision:0};
test('only the exact Claude binding enables automatic commands',()=>{
  expect(contextCommandAvailability({sourceAgent:'claude',sessionId:'provider-001',surfaceKind:'terminal'},binding).available).toBe(true);
  expect(contextCommandAvailability({sourceAgent:'claude',sessionId:'provider-002',surfaceKind:'terminal'},binding).available).toBe(false);
  expect(contextCommandAvailability({sourceAgent:'claude',sessionId:'provider-001',surfaceKind:'terminal'}).available).toBe(false);
});
test('a Codex desktop row never mistakes a provider ID or navigation for command authority',()=>{
  const result=contextCommandAvailability({sourceAgent:'codex',sessionId:'provider-001',surfaceKind:'desktop-app'},binding);
  expect(result.available).toBe(false);
  expect(result.reason).toContain('Codex 앱에서 직접 실행');
  const guide=contextCommandManualGuide({sourceAgent:'codex'});
  expect(guide).toContain('/compact');expect(guide).toContain('새 대화');expect(guide).not.toContain('/clear');
});
test('every surface gets its own standing reason; only Workroom and a live Orca terminal send automatically',()=>{
  const claude=(surfaceKind:string,surfacePresence?:'live'|'gone'|'unverified'|'not-applicable')=>contextCommandAvailability({sourceAgent:'claude',sessionId:'provider-009',surfaceKind,surfacePresence});
  expect(contextCommandAvailability({sourceAgent:'claude',sessionId:'provider-001',surfaceKind:'unknown'},binding)).toMatchObject({available:true,mode:'workroom'});
  expect(claude('orca-worktree','live')).toMatchObject({available:true,mode:'orca'});
  expect(claude('orca-floating','live')).toMatchObject({available:true,mode:'orca'});
  for(const presence of ['unverified','not-applicable',undefined] as const)expect(claude('orca-worktree',presence)).toMatchObject({available:false,mode:'manual',reason:expect.stringContaining('하나로 확인하지 못해')});
  // A closed window says so, on any surface and even with a stale binding: nothing can reach it.
  for(const kind of ['orca-worktree','unknown'])expect(claude(kind,'gone')).toMatchObject({available:false,mode:'manual',reason:expect.stringContaining('세션 창이 닫혀')});
  expect(contextCommandAvailability({sourceAgent:'claude',sessionId:'provider-001',surfaceKind:'unknown',surfacePresence:'gone'},binding)).toMatchObject({available:false,reason:expect.stringContaining('세션 창이 닫혀')});
  expect(claude('terminal').reason).toContain('Terminal.app');expect(claude('iterm').reason).toContain('iTerm');
  expect(claude('vscode').reason).toContain('VS Code');expect(claude('cmux').reason).toContain('cmux');
  expect(claude('claude-bg-agent').reason).toContain('백그라운드');expect(claude('unknown').reason).toContain('워크룸이나 창');
  // A Codex CLI inside Orca is still Codex: never sent from the dock.
  expect(contextCommandAvailability({sourceAgent:'codex',sessionId:'provider-009',surfaceKind:'orca-floating',surfacePresence:'live'})).toMatchObject({available:false,reason:'Codex에서 직접 실행해야 합니다.'});
  // No reason is a temporary 「later」 state.
  for(const kind of ['terminal','iterm','vscode','cmux','claude-bg-agent','unknown','orca-worktree'])expect(claude(kind).reason).not.toMatch(/잠시|나중|later/);
  // Localized through the dock copy.
  expect(contextCommandAvailability({sourceAgent:'claude',sessionId:'provider-009',surfaceKind:'iterm'},undefined,dockContextCommandMessages.en).reason).toContain('Claude in iTerm');
});
test('the button state names the memory when only the memory blocks a supported row, including after Sync',()=>{
  const orca=contextCommandAvailability({sourceAgent:'claude',sessionId:'provider-009',surfaceKind:'orca-worktree',surfacePresence:'live'});
  const workroom=contextCommandAvailability({sourceAgent:'claude',sessionId:'provider-001',surfaceKind:'unknown'},binding);
  const base={busy:false,saving:false,canSync:true,pending:false,memorySaved:false,memoryReason:'Supabase 백업이 필요합니다'};
  // Before Sync: the Workroom path saves and syncs itself; an Orca terminal must already be saved and synced.
  expect(contextCommandButtonState({...base,support:workroom})).toEqual({enabled:true,reason:workroom.reason});
  expect(contextCommandButtonState({...base,support:orca})).toEqual({enabled:false,reason:'Supabase 백업이 필요합니다 · 먼저 「지금 저장」·「동기화」를 마치세요.'});
  // After a successful Sync the row reads `saved`.
  expect(contextCommandButtonState({...base,support:orca,memorySaved:true,memoryReason:'장기기억 최신'})).toEqual({enabled:true,reason:orca.reason});
  // After a Sync that still leaves new activity to remember.
  expect(contextCommandButtonState({...base,support:orca,memoryReason:'저장할 새 활동이 있습니다'}).reason).toStartWith('저장할 새 활동이 있습니다');
  // A conflict cannot be synced from the dock: both paths say so.
  expect(contextCommandButtonState({...base,canSync:false,support:workroom,memoryReason:'로컬·Supabase가 모두 바뀌었습니다'})).toMatchObject({enabled:false,reason:expect.stringContaining('모두 바뀌었습니다')});
  expect(contextCommandButtonState({...base,pending:true,memorySaved:true,support:orca})).toEqual({enabled:false,reason:'이전 명령의 전송 결과를 먼저 확인하세요.'});
  expect(contextCommandButtonState({...base,busy:true,memorySaved:true,support:orca}).enabled).toBe(false);
  expect(contextCommandButtonState({...base,saving:true,support:workroom}).enabled).toBe(false);
  // An unsupported row keeps its surface reason, whatever the memory says.
  const manual=contextCommandAvailability({sourceAgent:'codex',sessionId:'provider-001',surfaceKind:'desktop-app'});
  expect(contextCommandButtonState({...base,memorySaved:true,support:manual})).toEqual({enabled:false,reason:manual.reason});
});
test('after Clear, a Workroom\'s new conversation says it is unbound there instead of 「unknown」',()=>{
  const workroomId='0b6f1c3e-7d2a-4e8b-9c41-5a2d7e9f1b30',cleared='4c9d2e71-1a3b-4f6e-8d05-b7c8e9f0a1d2';
  const row=(sessionId:string,surfaceKind='unknown')=>({sourceAgent:'claude' as const,sessionId,surfaceKind,workroomSessionId:workroomId});
  const unbound=contextCommandAvailability(row(cleared));
  expect(unbound).toEqual({available:false,mode:'manual',reason:dockContextCommandMessages.ko.workroomUnbound});
  expect(unbound.reason).toBe('Clear 뒤 새 대화는 워크룸 화면에서 직접 실행하세요. 워크룸이 이 대화를 정확히 연결하지 않아 여기서는 보내지 않습니다.');
  expect(unbound.reason).not.toBe(dockContextCommandMessages.ko.unknown);
  // The marker is a hint for copy, never authority: even an Orca-looking surface does not send.
  expect(contextCommandAvailability(row(cleared,'orca-worktree'),undefined)).toMatchObject({available:false,reason:dockContextCommandMessages.ko.workroomUnbound});
  // Only the exact binding sends. The Workroom's own launch conversation without one — the Workroom ended, as an app
  // restart ends them all — says its Workroom is not connected, not that a window could not be found (3호, 2026-10-31).
  expect(contextCommandAvailability(row(workroomId),{...binding,providerSessionId:workroomId,sessionId:workroomId})).toMatchObject({available:true,mode:'workroom'});
  expect(contextCommandAvailability(row(workroomId))).toEqual({available:false,mode:'manual',reason:dockContextCommandMessages.ko.workroomNotBound});
  expect(contextCommandAvailability(row(workroomId)).reason).not.toBe(dockContextCommandMessages.ko.unknown);
  expect(contextCommandAvailability(row(workroomId),undefined,dockContextCommandMessages.de).reason).toBe(dockContextCommandMessages.de.workroomNotBound);
  // A window the list saw close still says closed.
  expect(contextCommandAvailability({...row(workroomId),surfacePresence:'gone'}).reason).toBe(dockContextCommandMessages.ko.closed);
  for(const copy of Object.values(dockContextCommandMessages))expect(copy.workroomNotBound).not.toMatch(/잠시|나중|later/);
  expect(contextCommandAvailability(row(cleared),undefined,dockContextCommandMessages.en).reason).toBe(dockContextCommandMessages.en.workroomUnbound);
  for(const copy of Object.values(dockContextCommandMessages))expect(copy.workroomUnbound.length).toBeGreaterThan(10);
});
