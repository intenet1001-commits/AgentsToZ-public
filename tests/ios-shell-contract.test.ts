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
