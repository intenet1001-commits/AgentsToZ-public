import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {workModeCopy, workModeMessages} from '../src/i18n';
import {screenHelperLines, type ScreenHelperStatus} from '../src/workModeScreenHelper';
import {viewerHelperLines, type ViewerHelperStatus} from '../src/useViewerHelper';

const ko = workModeCopy('ko');
const screen = (patch: Partial<ScreenHelperStatus> = {}): ScreenHelperStatus => ({supported: true, installed: true, running: false, state: null, updatePending: false, otherInstanceRunning: false, instanceStatusUnknown: false, ...patch});
const running = (state: ScreenHelperStatus['state']): ScreenHelperStatus => screen({running: true, state});

test('the panel says where AgentsToZ Screen is before anything about its state', () => {
  expect(screenHelperLines(screen({installed: false}), ko)).toEqual({line: ko.screenMissing, notes: [], canOpen: true});
  expect(screenHelperLines(screen({supported: false, installed: false}), ko).canOpen).toBe(false);
  expect(screenHelperLines(screen(), ko)).toEqual({line: ko.screenStopped, notes: [], canOpen: true});
  // An expected process can outlive its bundle; an unreadable state is said as such.
  expect(screenHelperLines(screen({installed: false, running: true}), ko)).toEqual({line: ko.screenUnknown, notes: [], canOpen: true});
});

test('on, off and starting, with what still needs doing', () => {
  const base = {viewing: false, devices: 0, capture: true, control: true, loginItem: 'off'} as const;
  expect(screenHelperLines(running({...base, power: 'off'}), ko).line).toBe(ko.screenOff);
  expect(screenHelperLines(running({...base, power: 'starting'}), ko).line).toBe(ko.screenStarting);
  expect(screenHelperLines(running({...base, power: 'on'}), ko).line).toBe(ko.screenOnNone);
  expect(screenHelperLines(running({...base, power: 'on', devices: 3}), ko).line).toBe('화면 제어 켜짐 · 등록된 기기 3대');
  expect(screenHelperLines(running({...base, power: 'on', devices: 1, viewing: true, capture: false, control: false, loginItem: 'approval'}), ko).notes)
    .toEqual([ko.screenViewing, ko.screenNoCapture, ko.screenNoControl, ko.screenLoginApproval]);
});

test('on but off an approved network is not shown as ready for devices', () => {
  // 결정 4: AgentsToZ Screen accepts connections only on networks approved at the Mac. While it waits, registered
  // devices cannot connect, so the count of devices that "can connect" would mislead.
  const waiting = screenHelperLines(running({viewing: false, devices: 2, capture: true, control: true, loginItem: 'off', power: 'waiting'}), ko);
  expect(waiting.line).toBe(ko.screenWaiting);
  expect(waiting.line).not.toContain('2');
  for (const copy of Object.values(workModeMessages)) {
    expect(copy.screenWaiting).toContain('AgentsToZ Screen');
    expect(copy.screenWaiting).not.toBe(copy.screenOn);
  }
  // Neutral: waiting also means no network, a router not identified yet or a network without one that can never be
  // approved. AgentsToZ Screen says which; the status file does not carry the reason.
  expect(ko.screenWaiting).not.toContain('에서 승인');
  expect(workModeMessages.en.screenWaiting).not.toMatch(/approve it/i);
});

test('a deferred Screen update remains pending while running, closed or unreadable and never claims the new copy is ready', () => {
  for (const status of [screen({updatePending: true}), screen({updatePending: true, running: true}),
    {...running({power: 'on', viewing: true, devices: 2, capture: true, control: true, loginItem: 'off'}), updatePending: true}]) {
    const lines = screenHelperLines(status, ko);
    expect(lines.notes).toContain(ko.screenUpdatePending);
    expect(lines.canOpen).toBe(true);
  }
  expect(ko.screenUpdatePending).toContain('현재 연결을 마친 뒤');
  expect(ko.screenUpdatePending).toContain('앱을 완전히 종료');
  expect(ko.screenUpdatePending).toContain('여기서 다시');
  expect(ko.screenUpdatePending).not.toContain('창을 닫');
});

test('a different-path or unobserved Screen instance blocks opening without pretending the installed copy is ready', () => {
  const stale = running({power: 'on', viewing: true, devices: 2, capture: true, control: true, loginItem: 'off'});
  expect(screenHelperLines({...stale, otherInstanceRunning: true, updatePending: true}, ko))
    .toEqual({line: ko.screenOtherInstance, notes: [ko.screenUpdatePending, ko.screenViewing], canOpen: false});
  expect(screenHelperLines({...stale, instanceStatusUnknown: true}, ko))
    .toEqual({line: ko.screenInstanceUnknown, notes: [], canOpen: false});
  expect(ko.screenInstanceUnknown).not.toBe(ko.screenOtherInstance);
  expect(screenHelperLines(screen(), ko).canOpen).toBe(true);
});

test('every language has the device count slot and says where to tap on the phone', () => {
  for (const copy of Object.values(workModeMessages)) {
    expect(copy.screenOn).toContain('{n}');
    expect(copy.screenHint).toContain('Mac 화면');
    for (const text of [copy.screenUpdatePending, copy.screenOtherInstance, copy.screenInstanceUnknown]) expect(text).toContain('AgentsToZ Screen');
    for (const text of [copy.viewerOtherInstance, copy.viewerInstanceUnknown]) expect(text).toContain('AgentsToZ Viewer');
  }
});

// AgentsToZ Viewer (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.4): 「다른 Mac 화면 보기」 in the same panel.
const viewer = (patch: Partial<ViewerHelperStatus>): ViewerHelperStatus => ({supported: true, installed: true, bundled: true, running: false, updatePending: false, otherInstanceRunning: false, instanceStatusUnknown: false, ...patch});

test('the Viewer section says whether it is installed, closed or running, and is absent when there is nothing to open', () => {
  expect(viewerHelperLines(viewer({installed: false}), ko)).toEqual({line: ko.viewerMissing, notes: []});
  expect(viewerHelperLines(viewer({}), ko)).toEqual({line: ko.viewerStopped, notes: []});
  expect(viewerHelperLines(viewer({running: true}), ko)).toEqual({line: ko.viewerRunning, notes: []});
  // An expected instance whose bundle disappeared is still said to be running.
  expect(viewerHelperLines(viewer({installed: false, bundled: false, running: true}), ko)?.line).toBe(ko.viewerRunning);
  // A newer Viewer waits for this one to close (SR-35): said, not done behind the person's back.
  expect(viewerHelperLines(viewer({running: true, updatePending: true}), ko)).toEqual({line: ko.viewerRunning, notes: [ko.viewerUpdatePending]});
  // No button that can only fail: an app that carries no Viewer and has none installed offers nothing.
  expect(viewerHelperLines(viewer({installed: false, bundled: false}), ko)).toBeNull();
  expect(viewerHelperLines(viewer({supported: false}), ko)).toBeNull();
  expect(viewerHelperLines(null, ko)).toBeNull();
  expect(viewerHelperLines(undefined, ko)).toBeNull();
});

test('Viewer instances from other paths and unknown observations are separate from a running installed Viewer', () => {
  expect(viewerHelperLines(viewer({otherInstanceRunning: true, running: true, updatePending: true}), ko))
    .toEqual({line: ko.viewerOtherInstance, notes: [ko.viewerUpdatePending]});
  expect(viewerHelperLines(viewer({instanceStatusUnknown: true}), ko))
    .toEqual({line: ko.viewerInstanceUnknown, notes: []});
  // A conflicting instance is still explained if this Main carries no Viewer payload yet.
  expect(viewerHelperLines(viewer({installed: false, bundled: false, otherInstanceRunning: true}), ko)?.line).toBe(ko.viewerOtherInstance);
  expect(viewerHelperLines(viewer({installed: false, bundled: false, instanceStatusUnknown: true}), ko)?.line).toBe(ko.viewerInstanceUnknown);
  expect(ko.viewerInstanceUnknown).not.toBe(ko.viewerOtherInstance);
  expect(viewerHelperLines(viewer({running: true}), ko)?.line).toBe(ko.viewerRunning);
});

test('every language names the Viewer, its button and where connecting is confirmed', () => {
  expect(ko.viewerOpen).toBe('다른 Mac 화면 보기');
  for (const copy of Object.values(workModeMessages)) {
    for (const text of [copy.viewerMissing, copy.viewerStopped, copy.viewerRunning, copy.viewerUnverified]) expect(text).toContain('AgentsToZ Viewer');
    expect(copy.viewerHint).toContain('Touch ID');
    expect(copy.viewerHint).toContain('AgentsToZ Screen');
    expect(copy.viewerHint).toContain('다른 Mac 추가…');
    expect(copy.viewerUpdatePending).toContain('10');
    expect(copy.viewerOpen).not.toBe(copy.screenOpen);
  }
  // Only this panel's button updates before opening; the Dock, Launchpad or Finder open the installed Viewer as it is.
  expect(ko.viewerUpdatePending).toContain('여기서 열 때');
  expect(ko.viewerUpdatePending).toContain('앱을 완전히 종료');
  expect(ko.viewerUpdatePending).not.toContain('다음에 열 때');
  expect(workModeMessages.en.viewerUpdatePending).toContain('open it here');
  expect(workModeMessages.en.viewerUpdatePending).not.toMatch(/next time you open/i);
});

test('only the work-mode button opens the Viewer: no arguments, no HTTP route, MCP tool or voice command (SR-23)', () => {
  const root = join(import.meta.dir, '..');
  const sources = [...new Bun.Glob('src/**/*.{ts,tsx}').scanSync(root), ...new Bun.Glob('*.ts').scanSync(root)];
  const users = sources.filter(file => /(?:open|get)_viewer_helper/.test(readFileSync(join(root, file), 'utf8'))).sort();
  expect(users).toEqual(['src/useViewerHelper.ts']);
  const hook = readFileSync(join(root, 'src/useViewerHelper.ts'), 'utf8');
  expect(hook.match(/invoke<[^>]*>\('open_viewer_helper'\)/g)).toHaveLength(1);
  expect(hook).not.toMatch(/'open_viewer_helper',/);
  const rust = readFileSync(join(root, 'src-tauri/src/screen_helper.rs'), 'utf8');
  expect(rust).toContain('pub(crate) async fn open_viewer_helper() -> Result<OpenResult, String>');
  expect(rust).toContain('pub(crate) async fn get_viewer_helper() -> Result<ViewerHelperStatus, String>');
  const lib = readFileSync(join(root, 'src-tauri/src/lib.rs'), 'utf8');
  expect(lib).toContain('screen_helper::open_viewer_helper,');
  expect(lib).toContain('screen_helper::get_viewer_helper,');
});
