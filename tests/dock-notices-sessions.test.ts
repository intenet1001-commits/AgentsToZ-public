import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {noticeTime} from '../src/AutomaticSaveNotice';
import {dockSessionsMessages} from '../src/i18n';

// 「아젠투지 호출」 dock extras (VOC 2026-10-24). Behaviour runs in scripts/check-voice-dock-sessions.ts (Chromium·WebKit);
// these pin the wiring that a browser fixture cannot see.
const read=(path:string)=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const app=read('src/App.tsx'),dock=read('src/components/AgentsToZVoiceDock.tsx'),popout=read('src/VoicePopoutApp.tsx'),launcher=read('src/NativeVoiceLauncher.tsx');
const notice=read('src/AutomaticSaveNotice.tsx'),panel=read('src/components/DockSessionsPanel.tsx'),portal=read('src/remote-control-portal-main.tsx');
const unsaved=read('src/unsavedSessionMemory.ts');

test('saved notices moved from a page banner to the dock: browser dock, voice window, and the main window only while that window is closed',()=>{
  expect(app).not.toMatch(/\{!isLoading&&!isDeployedWeb\(\)&&<AutomaticSaveNotice\/>\}/);
  expect(app).toContain('notifications={!isLoading&&!isDeployedWeb()?<AutomaticSaveNotice placement="dock"/>:undefined}');
  expect(popout).toContain('notifications={<AutomaticSaveNotice placement="dock"/>} localSessions');
  expect(launcher).toContain('<AutomaticSaveNotice placement="floating"/>');
  expect(launcher.indexOf('if(!offerReopen)return null;')).toBeLessThan(launcher.indexOf('<AutomaticSaveNotice placement="floating"/>'));
  // A phone has no local API for either.
  expect(portal).not.toContain('AutomaticSaveNotice');expect(portal).not.toMatch(/<AgentsToZVoiceDock[^>]*localSessions/);
});

test('dismissals are shared by the voice window and the main window (separate webviews, separate sessionStorage)',()=>{
  expect(notice).toContain("localStorage.setItem(storageKey");expect(notice).not.toMatch(/sessionStorage\.(get|set)Item/);
  expect(notice).toContain("window.addEventListener('storage',synced)");
});

test('the session list loads lazily and polls only while expanded',()=>{
  // A static import would pull the project-memory client into the main bundle through the always-loaded dock.
  expect(dock).toContain("const DockSessionsPanel=lazy(()=>import('./DockSessionsPanel')");
  expect(dock).not.toMatch(/^import[^;]*from '\.\/DockSessionsPanel'/m);
  expect(dock).toContain('{localSessions&&sessionsOpen&&<Suspense');
  expect(panel).toContain("fetch(`${apiBase()}/api/context-usage`");expect(panel).toContain('clearInterval(timer)');
});

test('without Claude context capture the list says how to get Claude rows (the statusline hook writes them)',()=>{
  expect(panel).toContain('setCaptureInstalled(json.captureInstalled!==false)');
  expect(panel).toContain('{!captureInstalled&&<p className="az-sessions__hint" data-testid="voice-dock-sessions-capture">{copy.captureMissing}</p>}');
  expect(dockSessionsMessages.ko.captureMissing).toBe('Claude 세션은 위의 Claude 「사용량 연결」을 켠 뒤 다음 Claude 활동부터 이 목록에 보입니다.');
  for(const copy of Object.values(dockSessionsMessages))expect(copy.captureMissing.length).toBeGreaterThan(10);
});

test('save and sync follow the existing memory rules: own agent, preferred agent kept, conflicts never overwritten',()=>{
  expect(panel).toContain('sessionMemoryAction(folder,state)');
  expect(panel).toContain('agent:s.sourceAgent');expect(unsaved).toContain('preservePreferredAgent:true');
  // A conflicted row offers no save; the host's own preflight refuses one that turns conflicted meanwhile.
  expect(panel).toContain("action!=='conflict'");expect(unsaved.includes('memorySaveProblem(data)')).toBe(true);
  expect(panel).toContain('voiceProjectMemoryIsBlocked(s)');
  // A new memory only for a registered project or its worktree, never a stray folder.
  expect(panel).toContain("const canSave=action==='start'?registered:");expect(panel).toContain("allowStart:action==='start'&&registered");
  expect(unsaved).toContain("if(!memory.exists&&!item.allowStart)return {status:'skipped'");
});

test('a conflicted row can be resolved from the dock: 「비교·해결」 lives in the lazy list, under the row lock, one request per choice',()=>{
  const review=read('src/components/DockMemoryConflictReview.tsx');
  expect(panel).toContain("import {DockMemoryConflictReview} from './DockMemoryConflictReview';");
  // Only the lazy list may pull the comparison and the project-memory client in.
  for(const source of [dock,unsaved,notice])expect(source).not.toContain('DockMemoryConflictReview');
  expect(panel).toContain('data-testid="voice-dock-session-conflict-review"');expect(panel).toContain('onLock={lockFor(s)}');
  // Comparing is a read-only preview; a choice goes once to the existing resolver with the compared hashes and is never resent.
  expect(review).toContain('projectMemoryApi.conflictPreview({folderPath:folder})');
  expect(review).toContain('expectedLocalHash:preview.localContentHash,expectedRemoteRevisionId:preview.remoteRevisionId,expectedRemoteContentHash:preview.remoteContentHash');
  expect(review.match(/\/api\/project-memory\/resolve-conflict/g)?.length).toBe(1);expect(review).not.toContain('memoryRequest');
  expect(review).toContain("if(outcome.state==='unknown'){setUnknown(true);");
});

test('unsaved work reaches the folded dock without the lazy project-memory client',()=>{
  // The store uses plain fetch and the light session helpers, so the dock may import it statically.
  expect(dock).toContain("import {useUnsavedSessionMemory} from '../unsavedSessionMemory';");
  expect(unsaved).not.toMatch(/from '\.\/(ProjectMemoryPanel|components\/AiUsagePanel|components\/DockSessionsPanel)'/);
  // One checker: the notice stack. The dock badge only reads; the phone dock has no stack and so no check.
  expect(notice).toContain('useUnsavedSessionMemory({check:true})');expect(dock).toContain('useUnsavedSessionMemory({check:false})');
  expect(dock).toContain('{unsavedCount>0&&<span className="az-voice-dock__badge"');
  // While the list is open it publishes what it read instead of a second probe of the same folders.
  expect(panel).toContain('useEffect(()=>pauseBackgroundCheck(),[]);');expect(panel).toContain('publishUnsaved(');
  // Saves run in the store, one at a time, and an unknown outcome is never resent.
  expect(panel).toContain('void saveTargets([');expect(panel).not.toContain('projectMemoryApi.sessionEnd(');
  expect(unsaved).toContain("if(outcome.status==='unknown'){");
});

test('a notice shows only the time when it is from today, the date otherwise',()=>{
  const now=new Date(2026,9,24,15,0).getTime();
  expect(noticeTime(new Date(2026,9,24,9,5).toISOString(),now)).toBe('09:05');
  expect(noticeTime(new Date(2026,9,23,23,59).toISOString(),now)).toBe('10월 23일 23:59');
  expect(noticeTime(new Date(2025,11,31,8,0).toISOString(),now)).toBe('2025년 12월 31일 08:00');
  expect(noticeTime('not a date',now)).toBe('');
});
