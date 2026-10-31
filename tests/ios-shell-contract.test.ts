// iPhone app shell (mobile/ios/App), production audit 2026-10-16 (track w5-ios). The app target is compiled by the
// unsigned simulator build (verify.yml native-ios), not by bun, and its pure rules live in AgentsToZCore
// (`bun run test:ios`). This file pins how the app wires them. Behaviour that needs WebKit itself is proven by the
// macOS probe of WorkroomStoreWipe.swift (see the w5-ios report): the old order left localStorage and IndexedDB on
// disk; the new one removes the store ~0.1 s after the view goes, and still clears every record when it does not.
// IOS_SHELL_SOURCE_DIR points this at another checkout (used to show the checks failing on the previous code).
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.IOS_SHELL_SOURCE_DIR ?? join(import.meta.dir, '..');
const read = (path: string) => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : '';
const workroom = read('mobile/ios/App/LANWorkroomView.swift');
const home = read('mobile/ios/App/RemoteHomeView.swift');
const model = read('mobile/ios/App/RemoteModel.swift');
const scheme = read('mobile/ios/App/PortalSchemeHandler.swift');
const between = (text: string, start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start) + start.length));

describe('「이 앱의 연결 정보 지우기」 deletes for real and says what happened', () => {
  test('the store error is no longer thrown away', () => {
    expect(workroom).not.toContain('{ _ in continuation.resume() }');
    expect(read('mobile/ios/App/WorkroomStoreWipe.swift')).toContain('try await WKWebsiteDataStore.remove(forIdentifier: identifier)');
  });
  test('the page is asked within a bound, the live store is cleared, then the store is removed', () => {
    const body = between(workroom, '    func disconnect() async {', '    /// The host page owns the session');
    const order = ['askPageToDisconnect()', 'Self.savedWorkspaces.forget(workspace)', 'endAndClearLiveStore()', 'WorkroomStoreWipe.remove(identifier)', 'wipeReport = WorkroomWipeReport('];
    for (const step of order) expect(body).toContain(step);
    expect(order.map(step => body.indexOf(step))).toEqual([...order.map(step => body.indexOf(step))].sort((a, b) => a - b));
    expect(workroom).toContain('try? await Task.sleep(for: Self.pageDisconnectTimeout)');
    const clear = between(workroom, '    private func endAndClearLiveStore()', '    func retry()');
    expect(clear.indexOf('end(.disconnected)')).toBeLessThan(clear.indexOf('WorkroomStoreWipe.clearLive(store)'));
  });
  test('the sheet shows progress, and the first screen shows the real outcome', () => {
    expect(workroom).toContain('if let stage = session.wipeStage {');
    expect(home).toContain('if let report = session.wipeReport { model.notice = report.message }');
    expect(home).not.toContain('이 iPhone의 연결 정보는 지웠습니다');
  });
  test('a store that could not be removed is not revived and goes at the next launch', () => {
    expect(workroom).toContain('WorkroomStoreWipe.isPending(identifier) ? .nonPersistent()');
    expect(home).toContain('if workroom == nil { await WorkroomStoreWipe.purgePending() }');
  });
});

describe('tapped external links open in the system browser', () => {
  test('popups and link taps reach the system browser through one rule; the view never opens a second page', () => {
    expect(workroom).toContain('UIApplication.shared.open(target)');
    expect(workroom).toContain('WorkroomExternalLink.target(url, origin: origin, request: request, sealed: !usesInternet)');
    const create = between(workroom, 'createWebViewWith configuration: WKWebViewConfiguration,', '    /// WebKit asks about a given tap');
    expect(create).toContain('openExternally(navigationAction, request: .popup)');
    expect(create).toContain('return nil');
    expect(workroom).toContain('configuration.preferences.javaScriptCanOpenWindowsAutomatically = false');
  });
  // Review 2026-10-16: WebKit reports a scripted `a.click()` on a main-frame anchor as `.linkActivated` (macOS WebKit probe),
  // so `.linkActivated` alone let page script launch Safari or a universal-link app with no tap. Only new-window links
  // (WebKit's popup gate: a scripted `_blank` click reaches neither delegate) may leave from decidePolicyFor.
  test('a main-frame link activation never leaves — only a new-window link or a popup does', () => {
    const policy = between(workroom, 'decidePolicyFor navigationAction: WKNavigationAction,', 'decidePolicyFor navigationResponse');
    expect(policy).toContain('openExternally(navigationAction, request: .navigation(linkActivated: navigationAction.navigationType == .linkActivated, newWindow: navigationAction.targetFrame == nil))');
    expect(workroom).not.toContain('userActivated:');
    expect(read('mobile/ios/AgentsToZCore/Sources/AgentsToZCore/WorkroomShell.swift')).not.toContain('Script-driven navigations stay cancelled');
  });
  test('the portal is told it can open links; the LAN page is not', () => {
    const internetOnly = between(workroom, 'if origin.hasPrefix("https://") || bundled != nil {', 'configuration.preferences.javaScriptCanOpenWindowsAutomatically');
    expect(internetOnly).toContain("agentstozNativeExternalLinks");
    expect(workroom.split('agentstozNativeExternalLinks').length).toBe(2); // only there
  });
});

describe('the saved workspace survives a new connection until that one loads', () => {
  test('nothing is saved when a connection is created; the first finished load commits it', () => {
    const init = between(workroom, '    private init(origin: String, bootstrapURL: URL', '    /// A stable UUID per origin.');
    expect(init).not.toContain('UserDefaults.standard.set(');
    expect(between(workroom, 'didFinish navigation: WKNavigation!)', 'didFailProvisionalNavigation')).toContain('if !hasLoadedDocument { Self.savedWorkspaces.commit(workspace) }');
  });
  test('the first screen offers the saved workspace, and a failed LAN page offers the internet one', () => {
    expect(home).toContain('.accessibilityIdentifier("openSavedWorkspace")');
    expect(workroom).toContain('.accessibilityIdentifier("workroomOpenInternetWorkspace")');
    expect(home).toContain('if let other = openAfterWorkroom { openAfterWorkroom = nil; workroom = LANWorkroomSession.open(other) }');
  });
  // Review 2026-10-16: a live workroom had no way to the other saved workspace. On the same Wi‑Fi the LAN page loads and
  // becomes the one reopened (relaunch, foreground, a cancelled 「다른 연결 QR 스캔」), and 「내 작업 공간(인터넷) 열기」 appeared
  // only when the LAN page failed — so the saved internet workspace was unreachable while it was still stored.
  test('a live workroom can switch to the other saved workspace from 연결 설정', () => {
    const sheet = between(workroom, '.sheet(isPresented: $showingConnection', '.onChange(of: scenePhase)');
    expect(sheet).toContain('LANWorkroomSession.alternativeWorkspaces(to: session.workspace)');
    expect(sheet).toContain('.accessibilityIdentifier("workroomOpenOtherSavedWorkspace")');
    // The sheet closes first; the cover closes next and the other workspace opens once it has (home's onDismiss).
    expect(sheet).toContain('if let other = openAfterSheet { openAfterSheet = nil; onOpenSaved?(other) }');
    expect(home).toContain('session.end(.disconnected); openAfterWorkroom = other; workroom = nil');
    // Both places name a saved workspace by the same hosts.
    expect(sheet).toContain('other.hostLabel');
    expect(home).toContain('workspace.hostLabel');
  });
  test('the ended-LAN line is said only when one ended, and old notices clear when a workspace opens', () => {
    expect(model).toContain('notice = hadSession ? "연결을 종료했습니다.');
    expect(home).toContain('.onAppear { model.notice = nil }');
  });
  test('an older web connection is offered only when its existing store is not pending deletion', () => {
    const discover = between(workroom, '    static func alternativeWorkspaces(to workspace:', '    /// Reopen the workspace');
    expect(discover).toContain('saved.legacyWebCandidate(for: workspace)');
    expect(discover).toContain('!WorkroomStoreWipe.isPending(identifier)');
    expect(discover).toContain('WKWebsiteDataStore.allDataStoreIdentifiers.contains(identifier)');
    expect(discover).not.toContain('WKWebsiteDataStore(forIdentifier:');
    expect(discover).not.toContain('evaluateJavaScript');
    expect(discover).not.toContain('commit(');
    expect(workroom).toContain('case .web(let origin), .lan(let origin):');
    expect(workroom).toContain('return LANWorkroomSession(resuming: origin)');
  });
});

describe('smaller shell fixes', () => {
  test('camera permission already given to the app is not asked again by WebKit', () => {
    const media = between(workroom, 'requestMediaCapturePermissionFor origin: WKSecurityOrigin', '/// Resumes once');
    expect(media).toContain('if type == .camera, AVCaptureDevice.authorizationStatus(for: .video) == .authorized {');
  });
  test('a reclaimed page reloads by itself, bounded, before any failure screen', () => {
    const terminated = between(workroom, 'func webViewWebContentProcessDidTerminate', 'createWebViewWith configuration');
    expect(terminated).toContain('WorkroomContentRecovery.mayReload(lastReload: lastContentReload, now: now)');
    expect(terminated).toContain('reloadAfterContentProcess()');
    expect(terminated).toContain('failureIsContentProcess = true');
    expect(workroom).toContain('if phase == .active { session.foreground() }');
  });
  // Review 2026-10-16: the first termination of a page that never loaded used the "repeatedly … same connection" text.
  test('the content-process failure text depends on whether the page had loaded', () => {
    expect(workroom).toContain('WorkroomContentRecovery.failureMessage(loaded: hasLoadedDocument)');
  });
  // Review 2026-10-16: the automatic reload skipped what end(.failed) used to release, so a confirm shown before the app switch
  // stayed over the reloaded page (and blocked its dialogs), and a sign-in in flight answered a page that no longer waited.
  test('a reload after a reclaimed process first lets go of what the dead page held', () => {
    const terminated = between(workroom, 'func webViewWebContentProcessDidTerminate', 'createWebViewWith configuration');
    const release = 'releaseDocumentBoundState(signInNotice: WorkroomContentRecovery.signInCancelledMessage)';
    expect(terminated).toContain(release);
    expect(terminated.indexOf(release)).toBeLessThan(terminated.indexOf('reloadAfterContentProcess()'));
    expect(terminated.indexOf(release)).toBeLessThan(terminated.indexOf('contentReloadPending = true'));
    const helper = between(workroom, '    private func releaseDocumentBoundState(', '    fileprivate func receiveOAuth');
    for (const step of ['completeJavaScriptDialog(dialog.id, response: nil)', 'resetVocShare()', 'authenticationSession?.cancel()',
      'authenticationAttempt = nil', 'authenticationTimeout?.cancel()', 'authenticationIssue = signInNotice']) expect(helper).toContain(step);
    // end() keeps releasing the same things, through the same helper.
    expect(between(workroom, '    func end(_ reason: EndReason) {', '    private func releaseDocumentBoundState(')).toContain('releaseDocumentBoundState(signInNotice: nil)');
  });
  test('connection settings name the portal and the Supabase project, not the internal page origin', () => {
    expect(workroom).toContain('ForEach(session.connectionSummary, id: \\.self)');
    expect(workroom).not.toContain('Text(session.origin)');
  });
  test('a self-hosted Supabase project is served and signed in to, and a refused sign-in answers at once', () => {
    expect(scheme).toContain('data = Data(config.servedHTML(page).utf8)');
    expect(workroom).toContain('NativeOAuthRequest(authorizationURL: url, state: state, projectHost: bundled?.supabaseHost)');
    const refused = between(workroom, 'projectHost: bundled?.supabaseHost) else {', '        guard authenticationSession == nil');
    expect(refused).toContain('publishOAuth(state: state, code: nil)');
  });
  test('every build of the app compiles the new file', () => {
    const project = read('mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj');
    expect(project).toContain('path = "WorkroomStoreWipe.swift"');
    expect(project).toMatch(/PBXSourcesBuildPhase;[^}]*D40000000000000000000002/);
    for (const script of ['mobile/ios/scripts/check-workroom.ts', 'mobile/ios/scripts/check-common-memory-device.ts']) {
      expect(read(script)).toContain("mobile/ios/App/WorkroomStoreWipe.swift");
    }
  });
});

// AgentsToZ Screen viewer (mobile/ios/App/ScreenViewerView.swift), review 2026-10-25. The viewer cannot be opened in the
// simulator (App Attest, Face ID), so this pins the layout that keeps the Mac's own signals out of the picture.
describe('AgentsToZ Screen: the Mac\'s signals sit outside its picture, and turning off says what it does', () => {
  const viewer = read('mobile/ios/App/ScreenViewerView.swift');
  const body = between(viewer, '    private var screenContent: some View {', '    private var runningContent: some View {');
  const band = between(viewer, '    private var macSignalBand: some View {', '    private var toolbar: some View {');
  const lockText = 'Mac이 잠겨 있습니다. 보안 입력 중에는 원격 조작이 제한될 수 있습니다.';
  const pauseText = 'Mac에서 조작을 잠시 멈췄습니다. Mac의 입력·권한 상태를 확인하세요.';
  // Before: both banners floated in the toolbar's overlay over a full-screen picture, so in landscape (an iPhone with a
  // 16:10 Mac) and at any zoom a fake lock strip drawn by a process on the Mac showed where the real banner would.
  test('the lock and pause banners are a band above the picture, never an overlay on it', () => {
    expect(band).toContain(lockText);
    expect(band).toContain(pauseText);
    expect(band).toContain("reason.viewerMessage");
    expect(viewer.split(lockText).length - 1).toBe(1);
    expect(viewer.split(pauseText).length - 1).toBe(1);
    const overlays = body.split('.overlay(').slice(1);
    expect(overlays.length).toBeGreaterThan(0);
    for (const overlay of overlays) {
      for (const word of ['macSignalBand', 'macState.locked', 'macState.inputPaused', lockText, pauseText]) expect(overlay).not.toContain(word);
    }
  });
  test('the band and the picture are stacked, so the picture is laid out below the band', () => {
    const stack = body.indexOf('VStack(spacing: 0) {');
    expect(stack).toBeGreaterThan(-1);
    expect(body.indexOf('macSignalBand')).toBeGreaterThan(stack);
    expect(body.indexOf('ScreenSurface(')).toBeGreaterThan(body.indexOf('macSignalBand'));
    // A zoomed picture is wider than its surface; the surface cuts it off at its own edges.
    expect(between(viewer, '        init(hosted: CALayer) {', '        required init?(coder: NSCoder)')).toContain('clipsToBounds = true');
  });
  test('even without lock or pause, a neutral app-owned slot excludes all Mac pixels', () => {
    expect(band.replace('private var macSignalBand: some View {', '').trimStart()).toMatch(/^VStack\(spacing: 0\) \{/);
    expect(band).toContain('.frame(minHeight: 44)');
    expect(band).toContain('Mac은 잠겨 있지 않습니다.');
    expect(band).toContain('Mac 잠김 상태를 확인하지 못했습니다.');
    const picture = between(body, '            ZStack {', '            // The phone');
    expect(picture).not.toContain('.ignoresSafeArea()');
    expect(picture).toContain('.clipped()');
  });
  test('turning off from the phone says screen control goes off and the Mac app stays in the menu bar', () => {
    const message = between(viewer, '.confirmationDialog("\\(mac.macName)의 화면 제어를 끌까요?"', '    /// Leaving the foreground ends the session at once');
    expect(message).not.toContain('AgentsToZ Screen이 꺼지고');
    expect(message).toContain('Mac의 화면 제어가 꺼지고 이 연결도 끝납니다.');
    expect(message).toContain('메뉴 막대');
  });
});
