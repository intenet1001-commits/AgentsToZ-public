import SwiftUI
import WebKit
import CryptoKit
import AuthenticationServices
import AVFoundation
import AgentsToZCore
import ScreenControlCore

/// The page owns transport, credentials and CSP. The only native bridge starts a
/// validated system PKCE authentication session; it never accepts terminal commands.
@MainActor final class LANWorkroomSession: NSObject, ObservableObject, Identifiable, WKNavigationDelegate, WKUIDelegate, ASWebAuthenticationPresentationContextProviding {
    enum EndReason {
        case disconnected, background, failed
        var message: String {
            switch self {
            case .disconnected: "모바일 연결을 해제했습니다. Mac에서 실행 중인 AI는 계속 실행됩니다."
            case .background: "앱으로 돌아오면 같은 연결을 이어 사용합니다. 실행 중인 AI를 자동으로 중지하지 않습니다."
            case .failed: "작업 공간 페이지를 불러오지 못했습니다."
            }
        }
    }
    let id = UUID()
    let origin: String
    @Published private(set) var webView: WKWebView?
    @Published private(set) var ended: EndReason?
    @Published private(set) var loading = true
    @Published private(set) var disconnectConfirmed: Bool?
    @Published private(set) var failureDetail = ""
    private var hasLoadedDocument = false
    /// Set when this session runs the portal bundled in the app (QR carried the Supabase project).
    let bundled: BundledPortalConfig?
    var usesInternet: Bool { bundled != nil || origin.hasPrefix("https://") }
    /// The https portal this connection acts for; for a bundled session, the QR's portal.
    private var portalOrigin: String { bundled?.portalOrigin ?? origin }
    /// What the settings sheet names. The bundled page's own origin (`agentstoz-app://portal`) is internal: show the
    /// portal and the Supabase project, which is what tells two workspaces apart.
    var connectionSummary: [String] {
        guard let bundled else { return [origin] }
        return ["포털: " + bundled.portalHost, "Supabase 프로젝트: " + bundled.supabaseHost]
    }
    var connectionGuidance: String {
        usesInternet
            ? "외부 인터넷 연결 · 5G와 다른 Wi-Fi에서도 사용할 수 있습니다. 인터넷 상태와 개인 포털 주소를 확인하세요. 원격 작업에는 등록한 컴퓨터가 켜져 있어야 합니다."
            : "같은 네트워크용 QR로 연결했습니다. 이 주소는 일반적인 5G·외부 Wi-Fi에서 접속할 수 없습니다. 컴퓨터에서 외부 인터넷 연결 QR을 열고 아래 ‘인터넷 QR 스캔’을 눌러 주세요."
    }
    var failureMessage: String {
        // A page iOS reclaimed is not a network problem: no portal-address or 5G advice for it.
        [EndReason.failed.message, failureDetail, failureIsContentProcess ? WorkroomContentRecovery.failureMessage(loaded: hasLoadedDocument) : connectionGuidance,
         hasLoadedDocument ? "실행 중이던 작업은 자동으로 중지하거나 다시 실행하지 않습니다. 재연결 후 결과를 확인하세요." : ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
    private var failureIsContentProcess = false
    /// iOS reclaims the page's WebContent process after an app switch; the page reloads by itself, once a minute at most.
    private var lastContentReload: Date?
    private var contentReloadPending = false
    /// Which saved workspace this connection is. Saved only once its page loaded (`didFinish`), so a connection that
    /// never comes up does not replace the one the phone had.
    let workspace: SavedWorkspace
    enum WipeStage {
        case revoking, clearing
        var label: String { self == .revoking ? "연결된 Mac에 연결 해제를 알리는 중…" : "이 iPhone의 정보를 지우는 중…" }
    }
    /// Shown in the settings sheet while 「이 앱의 연결 정보 지우기」 runs (it can take ~10 s on a slow relay).
    @Published private(set) var wipeStage: WipeStage?
    /// What the wipe actually did; the first screen shows its sentence.
    private(set) var wipeReport: WorkroomWipeReport?
    private var lastExternalOpen: (url: URL, at: Date)?
    private func fail(_ detail: String) {
        guard ended == nil else { return }
        failureDetail = detail
        end(.failed)
    }
    private func failNavigation(_ error: Error) {
        let value = error as NSError
        guard value.domain != NSURLErrorDomain || value.code != NSURLErrorCancelled else { return }
        // Never display NSError descriptions/userInfo: they can include the QR fragment.
        let label: String
        switch value.domain == NSURLErrorDomain ? value.code : 0 {
        case NSURLErrorTimedOut: label = "페이지 응답 시간이 초과되었습니다."
        case NSURLErrorNotConnectedToInternet: label = "인터넷에 연결되어 있지 않습니다."
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: label = "연결 주소를 찾지 못했습니다."
        case NSURLErrorCannotConnectToHost: label = "연결 대상에 접속하지 못했습니다."
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted: label = "보안 연결을 확인하지 못했습니다."
        default: label = "페이지 연결이 중단되었습니다."
        }
        fail(label + " (코드 \(value.code))")
    }
    private var initialURL: URL?
    struct JavaScriptDialog: Identifiable {
        enum Kind { case alert, confirm, prompt }
        let id = UUID()
        let kind: Kind
        let message: String
    }
    private(set) var activeJavaScriptDialog: JavaScriptDialog?
    private var dialogController: UIAlertController?
    private var dialogCompletion: ((String?) -> Void)?
    var isJavaScriptDialogPresented: Bool {
        dialogController?.viewIfLoaded?.window != nil && dialogController?.isBeingPresented == false
    }
    @Published var authenticationIssue: String?
    private var authenticationSession: ASWebAuthenticationSession?
    private var authenticationAttempt: NativeOAuthAttempt?
    private var authenticationTimeout: Task<Void, Never>?
    /// Photos the share extension filed. Handed to the portal's VOC composer one at a time.
    private let vocOutbox = VocShareOutbox.shared()
    /// Set when the current document's composer said `ready`; a new document must say it again.
    private var vocShareReady = false
    /// The item handed to the page and not yet acknowledged.
    private var vocShareInFlight: String?
    private var vocShareTimeout: Task<Void, Never>?
    /// After an unacknowledged hand-off, wait for the next foreground instead of retrying in a loop.
    private var vocShareWaitsForForeground = false
    private var vocShareLoading = false
    /// Items this document was given. A late ack (after the 30 s wait) still counts, so the
    /// same photos are not handed over twice.
    private var vocShareDelivered: Set<String> = []
    static let vocShareAckTimeout: Duration = .seconds(30)

    /// The internet workspace (bundled or web) and, beside it, a same-network one. See `WorkroomSavedWorkspaces`.
    static var savedWorkspaces: WorkroomSavedWorkspaces { WorkroomSavedWorkspaces(store: UserDefaults.standard) }

    convenience init(pairing: LANPairing) {
        let address = WorkroomAddress(pairing: pairing)
        self.init(origin: address.origin, bootstrapURL: address.bootstrapURL)
    }

    /// A typed portal address reuses the bundled sign-in a link or QR already set up for that portal; otherwise the
    /// person looked signed out and had to pair every Mac again (`WorkroomSavedWorkspaces.bundledReuse`).
    convenience init(internet address: InternetWorkroomAddress) {
        if let config = address.bundledPortal ?? Self.savedWorkspaces.bundledReuse(for: address), PortalSchemeHandler.isAvailable,
           let page = config.pageURL(fragment: address.url.fragment) {
            self.init(origin: BundledPortalConfig.pageOrigin, bootstrapURL: page, bundled: config)
        } else {
            self.init(origin: address.origin, bootstrapURL: address.url)
        }
    }

    /// Step ① of onboarding: a 「폰 연결 링크」 opens the bundled portal for its Supabase project with
    /// no pairing at all — sign-in and synced data only. Control still needs a Mac QR + SAS approval.
    /// Same store key as a QR for the same portal, so a later QR reuses this sign-in.
    convenience init?(linked link: PhoneConnectLink) {
        guard PortalSchemeHandler.isAvailable, let config = link.bundledPortal, let page = config.pageURL(fragment: nil) else { return nil }
        self.init(origin: BundledPortalConfig.pageOrigin, bootstrapURL: page, bundled: config)
    }

    /// The bundled portal configuration this phone last used (from a link or a QR), if any.
    static var savedBundledConfig: BundledPortalConfig? {
        if case .bundled(let config) = savedWorkspaces.bundled { config } else { nil }
    }

    /// Discover only whether the old web store exists. Never read/copy its credentials, create
    /// a store while probing, or revive one explicitly scheduled for deletion.
    static func alternativeWorkspaces(to workspace: SavedWorkspace) async -> [SavedWorkspace] {
        let saved = savedWorkspaces
        var choices = saved.alternatives(to: workspace)
        if let candidate = saved.legacyWebCandidate(for: workspace), case .web(let origin) = candidate {
            let identifier = storeIdentifier(for: origin)
            if !WorkroomStoreWipe.isPending(identifier), await WKWebsiteDataStore.allDataStoreIdentifiers.contains(identifier) {
                choices.append(candidate)
            }
        }
        return choices
    }

    /// Reopen the workspace this phone saved last.
    static func resumeSaved() -> LANWorkroomSession? {
        savedWorkspaces.resumeTarget.flatMap(open)
    }

    static func open(_ workspace: SavedWorkspace) -> LANWorkroomSession? {
        switch workspace {
        case .bundled(let config):
            guard PortalSchemeHandler.isAvailable, let page = config.pageURL(fragment: nil) else { return nil }
            return LANWorkroomSession(origin: BundledPortalConfig.pageOrigin, bootstrapURL: page, bundled: config)
        case .web(let origin), .lan(let origin):
            return LANWorkroomSession(resuming: origin)
        }
    }

    private static func supportedOrigin(_ value: String) -> Bool {
        LANClient.resumableOrigin(value) || (try? InternetWorkroomAddress(scanned: value + "/remote/"))?.origin == value
    }

    convenience init?(resuming origin: String) {
        guard Self.supportedOrigin(origin), let url = URL(string: origin + "/remote/") else { return nil }
        self.init(origin: origin, bootstrapURL: url)
    }

    private init(origin: String, bootstrapURL: URL, bundled: BundledPortalConfig? = nil) {
        self.origin = origin
        self.bundled = bundled
        workspace = bundled.map { .bundled($0) } ?? (origin.hasPrefix("https://") ? .web(origin: origin) : .lan(origin: origin))
        initialURL = bootstrapURL
        super.init()
        let configuration = WKWebViewConfiguration()
        // A fresh in-memory store per connection meant the workroom threw away the session token
        // the Mac page keeps precisely so a locked phone can resume — every screen lock cost a
        // walk to the Mac for a new QR, because a consumed QR cannot be scanned twice.
        //
        // The replacement is still isolated, just durable: one store per Mac origin, derived
        // deterministically so the same Mac gets the same store and a different Mac never sees
        // it. Nothing is shared with Safari or with the app's other webviews. iOS 17 is the
        // deployment target, which is where `forIdentifier:` exists; if it ever refuses an
        // identifier, fall back to the previous behaviour rather than to a shared store.
        // A store whose wipe could not finish is not revived: in-memory until the next launch removes it.
        let identifier = Self.storeIdentifier(for: Self.storeKey(origin: origin, bundled: bundled))
        configuration.websiteDataStore = WorkroomStoreWipe.isPending(identifier) ? .nonPersistent() : WKWebsiteDataStore(forIdentifier: identifier)
        if let bundled, let handler = PortalSchemeHandler(config: bundled),
           let data = try? JSONSerialization.data(withJSONObject: ["portalOrigin": bundled.portalOrigin, "supabaseUrl": bundled.supabaseUrl, "supabaseAnonKey": bundled.supabaseAnonKey]),
           let json = String(data: data, encoding: .utf8) {
            configuration.setURLSchemeHandler(handler, forURLScheme: BundledPortalConfig.scheme)
            // Native user script: not subject to the page CSP, and read-only for the page.
            configuration.userContentController.addUserScript(WKUserScript(
                source: "Object.defineProperty(window,'agentstozBundledPortal',{value:Object.freeze(" + json + "),writable:false});",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // WKWebView otherwise treats duplex Realtime audio like ordinary media.
        // Explicit inline/autoplay support plus a voice-chat audio route prevents
        // the microphone track from ending as soon as remote audio is attached.
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.addUserScript(WKUserScript(
            source: "Object.defineProperty(window,'agentstozNativeWorkroom',{value:true,writable:false});",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        if origin.hasPrefix("https://") || bundled != nil {
            configuration.userContentController.add(WorkroomOAuthHandler(owner: self), name: "agentstozOAuth")
            configuration.userContentController.addUserScript(WKUserScript(source: "Object.defineProperty(window,'agentstozNativeOAuth',{value:true,writable:false});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
            // Photos shared from the Photos app reach the portal's VOC composer only through
            // this portal page; LAN pages never get the flag or the handler.
            configuration.userContentController.add(WorkroomVocShareHandler(owner: self), name: "agentstozVocShare")
            configuration.userContentController.addUserScript(WKUserScript(source: "Object.defineProperty(window,'agentstozNativeVocShare',{value:true,writable:false});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
            // Tells the portal that a tapped external link opens (in the system browser), so a bookmark counts a
            // visit only when something can open it. LAN pages stay sealed and never get it.
            configuration.userContentController.addUserScript(WKUserScript(source: "Object.defineProperty(window,'agentstozNativeExternalLinks',{value:true,writable:false});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // Popups reach `createWebViewWith` only from a tap; that is what makes it a user-activated external link.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = WKWebView(frame: .zero, configuration: configuration)
        // Real-device-only page bugs (a blank workroom terminal, 2026-10-02) need Safari Web Inspector.
        // Only the development/TestFlight channels, and only over a trusted cable; App Store builds stay closed.
        let channel = Bundle.main.object(forInfoDictionaryKey: "AgentsToZReleaseChannel") as? String
        web.isInspectable = WorkroomInspectionPolicy.permits(releaseChannel: channel)
        web.allowsBackForwardNavigationGestures = false
        web.navigationDelegate = self
        web.uiDelegate = self
        webView = web
        // Not saved here: an unusable scan or a page that never loads must not replace the saved workspace.
        // `didFinish` commits it once the page is up.
        web.load(URLRequest(url: bootstrapURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    /// A stable UUID per origin. Derived rather than stored so it cannot drift out of step with
    /// the address, and namespaced so one Mac's store is not reachable from another's address.
    static func storeIdentifier(for origin: String) -> UUID {
        var digest = SHA256()
        digest.update(data: Data("agentstoz.workroom.v1".utf8))
        digest.update(data: Data(origin.utf8))
        let bytes = Array(digest.finalize().prefix(16))
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    /// A bundled session keeps its own store per portal, apart from the same portal opened on the web.
    static func storeKey(origin: String, bundled: BundledPortalConfig?) -> String {
        bundled.map { "bundled:" + $0.portalOrigin } ?? origin
    }

    static func store(for origin: String) -> WKWebsiteDataStore? {
        WKWebsiteDataStore(forIdentifier: storeIdentifier(for: origin))
    }

    /// Ending on purpose must take the stored session with it, or "연결 해제" would leave a token
    /// on this phone that the next connection silently resumes. Same-network workroom only (the native LAN list);
    /// its saved pointer goes too, so a relaunch does not reopen what was just ended.
    static func forget(origin: String) async {
        savedWorkspaces.forget(.lan(origin: origin))
        let identifier = storeIdentifier(for: origin)
        if !(await WorkroomStoreWipe.remove(identifier)) { WorkroomStoreWipe.rememberPending(identifier) }
    }

    func selectTab(_ value: String) {
        guard ["home", "projects", "workroom", "bookmarks", "records"].contains(value) else { return }
        // Fixed UI action only; no native command/path/token bridge.
        webView?.evaluateJavaScript("document.querySelector('button[data-workspace-tab=\"" + value + "\"]')?.click()", completionHandler: nil)
    }

    /// The page gets this long to tell its Macs; a stalled relay must not hold the settings sheet.
    static let pageDisconnectTimeout: Duration = .seconds(10)

    /// 「이 앱의 연결 정보 지우기」: tell every paired Mac (the page does it, bounded), then delete this workspace's
    /// store for real and keep what actually happened in `wipeReport`.
    func disconnect() async {
        guard wipeStage == nil else { return }
        wipeStage = .revoking
        let acknowledgement = await askPageToDisconnect()
        disconnectConfirmed = acknowledgement == true
        wipeStage = .clearing
        Self.savedWorkspaces.forget(workspace)
        let identifier = Self.storeIdentifier(for: Self.storeKey(origin: origin, bundled: bundled))
        let remaining = await endAndClearLiveStore()
        // The view drops the web view once `webView` is nil; the removal waits for that (bounded retry).
        let removed = await WorkroomStoreWipe.remove(identifier)
        let local = WorkroomWipeReport.Local.from(removed: removed, remainingRecords: remaining)
        if local == .failed { WorkroomStoreWipe.rememberPending(identifier) }
        wipeReport = WorkroomWipeReport(local: local, macsConfirmed: acknowledgement)
        wipeStage = nil
    }

    /// The host page owns the session and performs its own narrow protocol revocation (every paired Mac in the
    /// portal). `nil`: no page, an error, or no answer within `pageDisconnectTimeout`.
    private func askPageToDisconnect() async -> Bool? {
        guard let web = webView else { return nil }
        let answer = PageAnswer()
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool?, Never>) in
            answer.continuation = continuation
            Task { @MainActor in
                let value = try? await web.callAsyncJavaScript(
                    "if (typeof window.agentstozDisconnect === 'function') return await window.agentstozDisconnect(); document.querySelector('[data-workspace-disconnect]')?.click(); return false;",
                    arguments: [:], in: nil, contentWorld: .page)
                answer.finish(value as? Bool)
            }
            Task { @MainActor in
                try? await Task.sleep(for: Self.pageDisconnectTimeout)
                answer.finish(nil)
            }
        }
    }

    /// Ends the page, then deletes every record of its store while this function still holds the store (deleting the
    /// live store works while WebKit keeps it). Returns the records left, or nil without a page. The store reference
    /// ends with this call, so the identifier can be removed afterwards.
    private func endAndClearLiveStore() async -> Int? {
        let store = webView?.configuration.websiteDataStore
        end(.disconnected)
        guard let store else { return nil }
        return await WorkroomStoreWipe.clearLive(store)
    }

    func retry() {
        guard ended != .disconnected, let web = webView else { return }
        ended = nil; loading = true; initialURL = nil; failureDetail = ""; failureIsContentProcess = false
        web.load(URLRequest(url: URL(string: origin + "/remote/")!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    /// The app came to the front: a share may be waiting, and a page iOS reclaimed in the background reloads now.
    func foreground() {
        vocShareForeground()
        if contentReloadPending { contentReloadPending = false; reloadAfterContentProcess() }
    }

    private func reloadAfterContentProcess() {
        guard ended == nil, let web = webView else { return }
        loading = true; initialURL = nil
        web.load(URLRequest(url: URL(string: origin + "/remote/")!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    func end(_ reason: EndReason) {
        // Keep the single document, selected target and draft across screen lock. WebKit may
        // suspend networking; the host page resumes its own socket without replaying mutations.
        if reason == .background { return }
        guard ended == nil || reason == .disconnected else { return }
        releaseDocumentBoundState(signInNotice: nil)
        if reason == .failed { ended = reason; loading = false; initialURL = nil; return }
        ended = reason; loading = false; initialURL = nil
        let previous = webView
        webView = nil
        previous?.navigationDelegate = nil
        previous?.uiDelegate = nil
        previous?.stopLoading()
        // Destroy the document/WebSocket. Never issue terminal close, input or Ctrl+C.
        previous?.loadHTMLString("", baseURL: nil)
    }

    /// What belongs to the current document: its open dialog, a sign-in waiting to answer it, the VOC hand-off. Released
    /// when the page ends, and when iOS reclaimed its process — the reloaded page is a new document that waits for none
    /// of them (a confirm left on screen answered nothing and blocked the new page's dialogs). `signInNotice`: what to
    /// tell the person when a sign-in was in flight.
    private func releaseDocumentBoundState(signInNotice: String?) {
        if let dialog = activeJavaScriptDialog { completeJavaScriptDialog(dialog.id, response: nil) }
        resetVocShare()
        let signingIn = authenticationAttempt != nil || authenticationSession != nil
        authenticationAttempt = nil; authenticationTimeout?.cancel(); authenticationTimeout = nil; authenticationSession?.cancel(); authenticationSession = nil
        if signingIn, let signInNotice { authenticationIssue = signInNotice }
    }

    fileprivate func receiveOAuth(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, pageOriginMatches(message.frameInfo.securityOrigin),
              let body = message.body as? [String: String], Set(body.keys) == ["authorizeURL", "state"],
              let url = body["authorizeURL"], let state = body["state"] else { return }
        // A bundled portal may use a self-hosted Supabase (the project its link or QR named).
        guard let request = try? NativeOAuthRequest(authorizationURL: url, state: state, projectHost: bundled?.supabaseHost) else {
            // Answer at once rather than leaving the page to wait out its 5-minute timeout.
            guard state.utf8.count <= 128, state.unicodeScalars.allSatisfy({ $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_") }) else { return }
            authenticationIssue = "이 로그인 요청은 연결된 Supabase 프로젝트의 형식이 아니어서 열지 않았습니다. (request-rejected)"
            publishOAuth(state: state, code: nil); return
        }
        guard authenticationSession == nil, webView?.window != nil else {
            authenticationIssue = "로그인 창을 표시할 준비가 되지 않았습니다. 앱 화면으로 돌아온 뒤 다시 시도하세요."
            publishOAuth(state: state, code: nil); return
        }
        authenticationIssue = nil
        let attempt = NativeOAuthAttempt(); authenticationAttempt = attempt
        let session = ASWebAuthenticationSession(url: request.authorizationURL, callbackURLScheme: NativeOAuthRequest.callbackScheme) { [weak self] callback, error in
            Task { @MainActor in
                guard let self, var current = self.authenticationAttempt, current.consume(id: attempt.id) else { return }
                self.authenticationAttempt = nil; self.authenticationTimeout?.cancel(); self.authenticationTimeout = nil; self.authenticationSession = nil
                let code = callback.flatMap { try? request.authorizationCode(from: $0) }
                if code == nil {
                    let nsError = error as NSError?
                    let parts = callback.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
                    let category: String
                    if let nsError, nsError.domain == ASWebAuthenticationSessionError.errorDomain {
                        category = "system-" + String(nsError.code)
                    } else if callback != nil {
                        category = "callback-rejected"
                    } else { category = "no-callback" }
                    // One bounded diagnostic, without URLs, codes, state values or NSError userInfo.
                    let fragmentKind = parts?.percentEncodedFragment.map { $0.isEmpty ? "empty" : "nonempty" } ?? "absent"
                    let diagnostic = category + ";fragment=" + fragmentKind
                        + ";code=" + String(parts?.queryItems?.contains(where: { $0.name == "code" }) == true)
                        + ";state=" + String(parts?.queryItems?.contains(where: { $0.name == "state" }) == true)
                        + ";error=" + String(parts?.queryItems?.contains(where: { $0.name == "error" }) == true)
                    UserDefaults.standard.set(diagnostic, forKey: "agentstoz.auth.lastFailure")
                    self.authenticationIssue = callback != nil
                        ? "Google 로그인 후 앱으로 돌아온 응답을 검증하지 못했습니다. Supabase의 앱 복귀 주소와 응답 형식을 확인해야 합니다. (" + diagnostic + ")"
                        : "iPhone 로그인 창에서 완료 응답을 받지 못했습니다. (" + category + ")"
                }
                self.publishOAuth(state: state, code: code)
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        authenticationSession = session
        guard session.start() else { authenticationAttempt = nil; authenticationSession = nil; authenticationIssue = "iPhone이 로그인 창을 시작하지 못했습니다. 앱을 앞에 둔 상태에서 다시 시도하세요. (start-failed)"; publishOAuth(state: state, code: nil); return }
        authenticationTimeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(NativeOAuthAttempt.timeout)) } catch { return }
            guard let self, self.authenticationAttempt?.id == attempt.id else { return }
            self.authenticationAttempt = nil; self.authenticationTimeout = nil
            let expiredSession = self.authenticationSession; self.authenticationSession = nil
            expiredSession?.cancel()
            self.authenticationIssue = "로그인 대기 시간이 만료되었습니다. 기존 QR 연결 정보는 유지됩니다."
            self.publishOAuth(state: state, code: nil)
        }
    }

    /// The OAuth bridge and camera/microphone are bound to this connection's page origin:
    /// its https portal, or the app's own bundled portal origin.
    private func pageOriginMatches(_ origin: WKSecurityOrigin) -> Bool {
        if bundled != nil {
            return origin.protocol == BundledPortalConfig.scheme && origin.host == BundledPortalConfig.host
        }
        guard self.origin.hasPrefix("https://"), let expected = URLComponents(string: self.origin) else { return false }
        return origin.protocol == "https" && origin.host == expected.host && [0, expected.port ?? 443].contains(origin.port)
    }

    // MARK: Shared photos → VOC composer
    //
    // Contract with the portal page (it implements the listener):
    //   page → native  agentstozVocShare {type:'ready'}            composer listener mounted
    //   native → page  CustomEvent 'agentstoz-voc-share' {detail:{id, createdAt, comment,
    //                  images:[{name, mime, dataBase64}]}}         one item at a time
    //   page → native  agentstozVocShare {type:'ack', id}          item taken; native deletes it
    // No ack within 30 s keeps the item for the next foreground.

    fileprivate func receiveVocShare(_ message: WKScriptMessage) {
        guard ended == nil, message.frameInfo.isMainFrame, pageOriginMatches(message.frameInfo.securityOrigin),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready" where body.count == 1:
            vocShareReady = true
            deliverNextVocShare()
        case "ack" where body.count == 2:
            guard let id = body["id"] as? String, id == vocShareInFlight || vocShareDelivered.contains(id) else { return }
            if id == vocShareInFlight { vocShareTimeout?.cancel(); vocShareTimeout = nil; vocShareInFlight = nil }
            vocOutbox?.remove(id: id)
            deliverNextVocShare()
        default: return
        }
    }

    /// Called when the app comes to the front: a new share may be waiting.
    func vocShareForeground() {
        vocShareWaitsForForeground = false
        deliverNextVocShare()
    }

    private func resetVocShare() {
        vocShareReady = false; vocShareInFlight = nil; vocShareLoading = false; vocShareDelivered = []
        vocShareTimeout?.cancel(); vocShareTimeout = nil
    }

    private func deliverNextVocShare() {
        guard ended == nil, vocShareReady, vocShareInFlight == nil, !vocShareLoading, !vocShareWaitsForForeground,
              let outbox = vocOutbox, let web = webView else { return }
        vocShareLoading = true
        Task { [weak self] in
            // Up to 12 MB of JPEG plus its base64 form: read and encode off the main thread.
            let prepared: (id: String, json: String)?? = await Task.detached(priority: .userInitiated) {
                guard let item = outbox.pending().first else { return nil }
                guard let detail = try? outbox.eventDetail(for: item),
                      let data = try? JSONSerialization.data(withJSONObject: detail),
                      let json = String(data: data, encoding: .utf8) else {
                    outbox.remove(id: item.id) // unreadable: drop it rather than block the queue
                    return .some(nil)
                }
                return .some((item.id, json))
            }.value
            guard let self else { return }
            self.vocShareLoading = false
            guard self.ended == nil, self.vocShareReady, self.webView === web, self.vocShareInFlight == nil else { return }
            guard let next = prepared else { return } // outbox empty
            guard let pair = next else { self.deliverNextVocShare(); return }
            let id = pair.id, json = pair.json
            self.vocShareDelivered.insert(id)
            self.vocShareInFlight = id
            self.vocShareTimeout = Task { [weak self] in
                do { try await Task.sleep(for: Self.vocShareAckTimeout) } catch { return }
                guard let self, self.vocShareInFlight == id else { return }
                self.vocShareInFlight = nil; self.vocShareTimeout = nil
                self.vocShareWaitsForForeground = true
            }
            self.dispatchVocShare(json, to: web)
        }
    }

    private func dispatchVocShare(_ json: String, to web: WKWebView) {
        // JSONSerialization output is a JavaScript object literal; user text is never spliced in.
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('agentstoz-voc-share',{detail:" + json + "}))", completionHandler: nil)
    }

    private func publishOAuth(state: String, code: String?) {
        let detail: [String: String] = code.map { ["state": state, "code": $0] } ?? ["state": state, "error": "NATIVE_AUTH_CANCELLED_OR_INVALID"]
        guard let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('agentstoz-oauth-result',{detail:" + json + "}))", completionHandler: nil)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        webView?.window ?? ASPresentationAnchor()
    }

    // WKWebView does not supply Safari's confirm/prompt UI. Without these
    // delegates, project creation and Git actions silently receive cancellation.
    private func presentJavaScriptDialog(_ kind: JavaScriptDialog.Kind, message: String,
                                         defaultText: String? = nil, web: WKWebView, frame: WKFrameInfo,
                                         completion: @escaping (String?) -> Void) {
        guard ended == nil, web === webView, frame.isMainFrame,
              let url = frame.request.url, WorkroomAddress.allowsResponse(url, origin: origin),
              activeJavaScriptDialog == nil, let window = web.window,
              let root = window.rootViewController else { completion(nil); return }
        var presenter = root
        while let next = presenter.presentedViewController { presenter = next }
        guard !(presenter is UIAlertController), !presenter.isBeingDismissed else { completion(nil); return }
        let dialog = JavaScriptDialog(kind: kind, message: String(message.prefix(8_000)))
        let alert = UIAlertController(title: kind == .confirm ? "작업 확인" : kind == .prompt ? "작업 내용 입력" : "작업 안내",
                                      message: dialog.message, preferredStyle: .alert)
        if kind == .prompt {
            alert.addTextField { field in
                field.text = String((defaultText ?? "").prefix(8_000))
                field.accessibilityIdentifier = "workroomJavaScriptInput"
                field.autocorrectionType = .no
                field.autocapitalizationType = .none
            }
        }
        if kind != .alert {
            let cancel = UIAlertAction(title: "취소", style: .cancel) { [weak self] _ in
                self?.completeJavaScriptDialog(dialog.id, response: nil)
            }
            alert.addAction(cancel)
        }
        let accept = UIAlertAction(title: "확인", style: .default) { [weak self, weak alert] _ in
            self?.completeJavaScriptDialog(dialog.id, response: kind == .prompt ? alert?.textFields?.first?.text ?? "" : "confirmed")
        }
        alert.addAction(accept)
        activeJavaScriptDialog = dialog; dialogController = alert; dialogCompletion = completion
        presenter.present(alert, animated: true)
    }

    func completeJavaScriptDialog(_ id: UUID, response: String?) {
        guard activeJavaScriptDialog?.id == id else { return }
        let completion = dialogCompletion, controller = dialogController
        activeJavaScriptDialog = nil; dialogCompletion = nil; dialogController = nil
        // A confirm can be followed immediately by a prompt in the same JS
        // action. Resume JavaScript after dismissal so the next dialog can open.
        if let controller, controller.presentingViewController != nil {
            controller.dismiss(animated: false) { completion?(response) }
        } else { completion?(response) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        presentJavaScriptDialog(.alert, message: message, web: webView, frame: frame) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        presentJavaScriptDialog(.confirm, message: message, web: webView, frame: frame) { completionHandler($0 != nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        presentJavaScriptDialog(.prompt, message: prompt, defaultText: defaultText, web: webView, frame: frame, completion: completionHandler)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard ended == nil, let url = navigationAction.request.url,
              WorkroomAddress.allowsDocument(url, origin: origin, initialURL: initialURL,
                                             mainFrame: navigationAction.targetFrame?.isMainFrame == true) else {
            decisionHandler(.cancel)
            // A tapped `target=_blank` link leaves for the system browser; the web view itself stays locked. A main-frame
            // link does not: WebKit reports a scripted `a.click()` as `.linkActivated` too (`WorkroomExternalLink.Request`).
            if ended == nil, openExternally(navigationAction, request: .navigation(linkActivated: navigationAction.navigationType == .linkActivated, newWindow: navigationAction.targetFrame == nil)) { return }
            if loading { fail("허용된 작업 공간 밖으로의 페이지 이동을 차단했습니다.") }
            return
        }
        initialURL = nil // A reload cannot silently replay a consumed QR.
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        // WebKit hands a custom-scheme response over as a plain URLResponse, without a status code.
        // Only the bundled session accepts that, and only for its own scheme; a missing bundled file
        // is served as text/plain 404 and still fails the text/html check.
        let response = navigationResponse.response
        let statusOK = (response as? HTTPURLResponse).map { $0.statusCode == 200 }
            ?? (bundled != nil && response.url?.scheme == BundledPortalConfig.scheme)
        guard ended == nil, navigationResponse.isForMainFrame,
              statusOK, response.mimeType == "text/html",
              let url = response.url,
              WorkroomAddress.allowsResponse(url, origin: origin) else {
            decisionHandler(.cancel); fail("작업 공간의 서버 응답 또는 페이지 주소를 확인하지 못했습니다."); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // A new document has to mount its composer and say `ready` again.
        resetVocShare()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard ended == nil else { return }
        loading = false
        // The connection proved itself: it becomes the saved workspace (a LAN one sits beside the internet one).
        if !hasLoadedDocument { Self.savedWorkspaces.commit(workspace) }
        hasLoadedDocument = true
        deliverNextVocShare()

    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failNavigation(error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failNavigation(error)
    }
    /// iOS often reclaims the page's process after an app switch. Reload by itself (once a minute at most; a page that
    /// has not loaded yet is not reloaded, it may still need its one-use QR) and only then admit a failure — one
    /// that says what happened instead of advising on the network.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard ended == nil, webView === self.webView else { return }
        let now = Date()
        guard hasLoadedDocument, WorkroomContentRecovery.mayReload(lastReload: lastContentReload, now: now) else {
            failureIsContentProcess = true
            fail("")
            return
        }
        lastContentReload = now
        // The dead document's dialog, sign-in and VOC hand-off go now, even when the reload waits for the foreground.
        releaseDocumentBoundState(signInNotice: WorkroomContentRecovery.signInCancelledMessage)
        if UIApplication.shared.applicationState == .active { reloadAfterContentProcess() } else { contentReloadPending = true }
    }
    /// Never a second web view. A popup comes only from a tap (`javaScriptCanOpenWindowsAutomatically` is off), so
    /// an external one (a bookmark, a deploy or GitHub link) opens in the system browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if ended == nil, webView === self.webView { _ = openExternally(navigationAction, request: .popup) }
        return nil
    }

    /// WebKit asks about a given tap through exactly one of the two delegates above (measured); the same address
    /// within a second is still opened once.
    private func openExternally(_ action: WKNavigationAction, request: WorkroomExternalLink.Request) -> Bool {
        let source: WKFrameInfo? = action.sourceFrame
        guard let source, source.isMainFrame, pageOriginMatches(source.securityOrigin), let url = action.request.url,
              let target = WorkroomExternalLink.target(url, origin: origin, request: request, sealed: !usesInternet) else { return false }
        let now = Date()
        if let last = lastExternalOpen, last.url == target, now.timeIntervalSince(last.at) < 1 { return true }
        lastExternalOpen = (target, now)
        UIApplication.shared.open(target)
        return true
    }
    /// Bluetooth headphones are heard, not spoken into (2026-10-08, AirPods Max: zero speech detected,
    /// the same voice without the headset worked). `.voiceChat` turns on Bluetooth HFP, which moves the
    /// microphone to the headset's narrowband call mic and the sound to call quality. With Bluetooth
    /// output connected, keep high-quality A2DP output and record from the iPhone's own microphone.
    /// Without it, nothing changes: `.voiceChat` keeps its echo cancellation for the speaker.
    static func configureVoiceAudioSession(_ audio: AVAudioSession) throws {
        let bluetooth: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
        let headphones = audio.currentRoute.outputs.contains { bluetooth.contains($0.portType) }
        if headphones {
            try audio.setCategory(.playAndRecord, mode: .default,
                                  options: [.defaultToSpeaker, .allowBluetoothA2DP])
        } else {
            try audio.setCategory(.playAndRecord, mode: .voiceChat,
                                  options: [.defaultToSpeaker, .allowBluetoothHFP])
        }
        try audio.setActive(true)
        if headphones, let builtIn = audio.availableInputs?.first(where: { $0.portType == .builtInMic }) {
            try? audio.setPreferredInput(builtIn)
        }
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) {
        // QR and voice capture start on user action, bound to this connection's HTTPS main frame.
        // `.prompt` makes WebKit ask again on every launch, so a microphone or camera the user already
        // allowed for this app is granted here; the OS prompt still guards the first use.
        guard (type == .camera || type == .microphone), frame.isMainFrame, pageOriginMatches(origin) else {
            decisionHandler(.deny)
            return
        }
        if type == .microphone {
            do {
                try Self.configureVoiceAudioSession(AVAudioSession.sharedInstance())
            } catch {
                decisionHandler(.deny)
                return
            }
            if AVAudioApplication.shared.recordPermission == .granted {
                decisionHandler(.grant)
                return
            }
        }
        // Same for the camera (the portal's 「작업 기기 연결 · QR 스캔」): granted to this app means granted here.
        if type == .camera, AVCaptureDevice.authorizationStatus(for: .video) == .authorized {
            decisionHandler(.grant)
            return
        }
        decisionHandler(.prompt)
    }
}

/// Resumes once: whichever of the page's answer and the timeout comes first.
@MainActor private final class PageAnswer {
    var continuation: CheckedContinuation<Bool?, Never>?
    func finish(_ value: Bool?) { continuation?.resume(returning: value); continuation = nil }
}

/// WK retains handlers, so keep its reference to the connection owner weak.
private final class WorkroomOAuthHandler: NSObject, WKScriptMessageHandler {
    weak var owner: LANWorkroomSession?
    init(owner: LANWorkroomSession) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receiveOAuth(message)
    }
}

private final class WorkroomVocShareHandler: NSObject, WKScriptMessageHandler {
    weak var owner: LANWorkroomSession?
    init(owner: LANWorkroomSession) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receiveVocShare(message)
    }
}

private struct WorkroomWebSurface: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

struct LANWorkroomView: View {
    @ObservedObject var session: LANWorkroomSession
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingConnection = false
    /// 「Mac 화면」 lives on the app's first screen, which this saved workspace covers as soon as the app opens.
    @State private var showingScreens = false
    @State private var confirmingDisconnect = false
    @State private var disconnecting = false
    /// 「다른 연결 QR 스캔」 closes this sheet first; the workroom closes once the sheet is gone.
    @State private var scanAfterSheet = false
    /// 「다른 작업 공간 열기」 closes this sheet first; the other saved workspace opens once the workroom has closed.
    @State private var openAfterSheet: SavedWorkspace?
    @State private var alternativeWorkspaces: [SavedWorkspace] = []
    let onReconnect: () -> Void
    let onDone: () -> Void
    /// Opens another saved workspace (a failed same-network page offers the internet one).
    var onOpenSaved: ((SavedWorkspace) -> Void)? = nil
    /// A Mac-screen registration QR the iPhone Camera opened the app with while this workspace was open. It is shown in
    /// this page's own 「Mac 화면」 sheet, which turns into the registration in place, so the workspace page and its
    /// draft stay as they are (closing the workroom would end the page).
    var screenInvite: Binding<String?> = .constant(nil)
    @State private var screenRegistration: RegistrationInvite?
    @State private var screenRegistrationBusy = false
    @State private var screenRejection: String?
    /// The registration QR arrived over 「연결 설정」: 「Mac 화면」 opens once that sheet has gone.
    @State private var screensAfterSheet = false
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let reason = session.ended {
                    ContentUnavailableView {
                        Label("연결 상태 확인", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(reason == .failed ? session.failureMessage : reason.message)
                    } actions: {
                        Button("다시 연결") { session.retry() }.buttonStyle(.borderedProminent)
                        Button(session.usesInternet ? "다른 연결 QR 스캔" : "인터넷 QR 스캔", action: onReconnect).buttonStyle(.borderedProminent).accessibilityIdentifier("workroomReconnect")
                        // Off that Wi‑Fi a same-network page cannot load; the internet workspace saved beside it can.
                        if reason == .failed, !session.usesInternet, let onOpenSaved,
                           let other = LANWorkroomSession.savedWorkspaces.alternative(to: session.workspace) {
                            Button("내 작업 공간(인터넷) 열기") { onOpenSaved(other) }.accessibilityIdentifier("workroomOpenInternetWorkspace")
                        }
                        Button("돌아가기", action: onDone)
                    }.accessibilityIdentifier("workroomEnded")
                } else if let web = session.webView {
                    if session.loading { ProgressView("작업 공간 여는 중").padding(8) }
                    WorkroomWebSurface(webView: web).accessibilityIdentifier("lanWorkroomWebView")
                }
            }
            .alert("로그인 연결 확인", isPresented: Binding(get: { session.authenticationIssue != nil }, set: { if !$0 { session.authenticationIssue = nil } })) {
                Button("확인") { session.authenticationIssue = nil }
            } message: { Text(session.authenticationIssue ?? "") }
            .navigationTitle("내 작업 공간").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button("Mac 화면", systemImage: "display") { showingScreens = true }
                    .accessibilityIdentifier("workroomScreenMacs")
                Button("연결 설정", systemImage: "slider.horizontal.3") { showingConnection = true }
                    .accessibilityIdentifier("workroomConnectionSettings")
            }
            .sheet(isPresented: $showingScreens, onDismiss: {
                screenRegistration = nil; screenRegistrationBusy = false; screenRejection = nil
            }) {
                if let invite = screenRegistration {
                    ScreenRegistrationSheet(invite: invite, busy: $screenRegistrationBusy) { saved in
                        _ = try ScreenMacStore.register(saved)
                    }
                    .id(invite.code.id)
                } else {
                    NavigationStack {
                        List {
                            if let screenRejection {
                                Section { Text(screenRejection).font(.subheadline).foregroundStyle(.secondary) }
                            }
                            ScreenMacsSection(scannedInvite: .constant(nil))
                        }
                            .navigationTitle("Mac 화면").navigationBarTitleDisplayMode(.inline)
                            .toolbar { Button("닫기") { showingScreens = false }.accessibilityIdentifier("screenMacsClose") }
                    }
                }
            }
            .onChange(of: screenInvite.wrappedValue, initial: true) { _, text in receiveScreenInvite(text) }
            .sheet(isPresented: $showingConnection, onDismiss: {
                if screensAfterSheet { screensAfterSheet = false; showingScreens = true }
                if scanAfterSheet { scanAfterSheet = false; onReconnect() }
                if let other = openAfterSheet { openAfterSheet = nil; onOpenSaved?(other) }
            }) {
                NavigationStack {
                    List {
                        if let stage = session.wipeStage {
                            Section { ProgressView(stage.label).accessibilityIdentifier("workroomWipeProgress") }
                        }
                        Section("현재 작업 공간") {
                            ForEach(session.connectionSummary, id: \.self) { Text($0).font(.callout).textSelection(.enabled) }
                            Text("탭 이동이나 앱을 잠시 닫아도 연결 정보와 실행 중인 작업은 유지됩니다.").font(.subheadline).foregroundStyle(.secondary)
                        }
                        // The workspace saved last is the one reopened, so on the same Wi‑Fi a live LAN page kept the saved
                        // internet workspace out of reach (and the other way round): switch here.
                        if onOpenSaved != nil, !alternativeWorkspaces.isEmpty {
                            Section {
                                ForEach(Array(alternativeWorkspaces.enumerated()), id: \.offset) { _, other in
                                    Button { openAfterSheet = other; showingConnection = false } label: {
                                        VStack(alignment: .leading, spacing: 2) {
                                            Label(other.openLabel, systemImage: other.isLAN ? "wifi" : "square.grid.2x2")
                                            Text(other.hostLabel).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    .disabled(disconnecting).accessibilityIdentifier("workroomOpenOtherSavedWorkspace")
                                }
                            } footer: {
                                Text("이 iPhone에 저장된 다른 작업 공간으로 바꿉니다. 현재 로그인·기기 연결 정보는 유지됩니다. 데이터 연결 뒤 QR 안내가 보이면 웹 포털의 저장된 연결을 먼저 확인하세요. 저장된 연결도 만료되었거나 Mac에서 해제했다면 다시 승인이 필요합니다.")
                            }
                        }
                        Section {
                            Text("같은 연결에 다른 작업 기기를 더하려면 작업 공간의 ‘원격 작업 → 연결 정보 → 다른 작업 기기 연결 · QR 스캔’을 쓰세요(연결된 기기가 없으면 작업 공간 홈에 바로 보입니다). 기기별 작업 권한은 해당 컴퓨터에서 관리합니다.").font(.subheadline)
                        }
                        // The bundled portal's own scanner refuses a QR for another Supabase project and points
                        // here. Without this the only way back to the app's scanner was deleting the sign-in:
                        // the workroom covers the first screen and a relaunch restores it. `onReconnect` only
                        // ends this page (`end(.disconnected)`); the saved workspace and its WK store stay.
                        Section {
                            Button("다른 연결 QR 스캔", systemImage: "qrcode.viewfinder") { scanAfterSheet = true; showingConnection = false }
                                .disabled(disconnecting).accessibilityIdentifier("workroomScanOtherQR")
                        } footer: {
                            Text("앱의 QR 스캐너를 엽니다. 다른 연결(다른 Supabase 프로젝트)의 QR이나 작업 공간 안 스캐너가 읽지 못한 QR을 찍을 때 씁니다. 이 작업 공간의 로그인·기기 연결 정보는 지우지 않고, 스캔을 취소하면 이 작업 공간으로 돌아옵니다.")
                        }
                        Section {
                            Button("이 앱의 연결 정보 지우기", role: .destructive) { confirmingDisconnect = true }
                                .disabled(disconnecting).accessibilityIdentifier("workroomDisconnect")
                        } footer: {
                            Text("다시 로그인하거나 QR로 연결해야 할 수 있습니다. 컴퓨터에서 실행 중인 AI 작업은 중지하지 않습니다.")
                        }
                    }
                    .navigationTitle("연결 설정").navigationBarTitleDisplayMode(.inline)
                    .toolbar { Button("완료") { showingConnection = false }.disabled(disconnecting).accessibilityIdentifier("workroomConnectionDone") }
                    .alert("이 앱의 연결 정보를 지울까요?", isPresented: $confirmingDisconnect) {
                        Button("연결 정보 지우기", role: .destructive) {
                            disconnecting = true
                            Task { await session.disconnect(); showingConnection = false; onDone() }
                        }.accessibilityIdentifier("workroomForgetConfirm")
                        Button("취소", role: .cancel) {}.accessibilityIdentifier("workroomForgetCancel")
                    } message: {
                        Text("현재 작업 공간의 로그인·기기 연결 정보가 이 앱에서 삭제되고, 연결된 Mac에도 연결 해제를 알립니다. 일반적인 화면 닫기에는 필요하지 않습니다.")
                    }
                }
                .task { alternativeWorkspaces = await LANWorkroomSession.alternativeWorkspaces(to: session.workspace) }
                .presentationDetents([.medium, .large]).interactiveDismissDisabled(disconnecting)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { session.foreground() }
                if phase == .background {
                    // A WebKit visibility change also occurs around native media
                    // permission UI. Use the real SwiftUI lifecycle to stop audio
                    // only when the app actually moves to the background.
                    session.webView?.evaluateJavaScript(
                        "window.dispatchEvent(new Event('agentstoz:native-background'))",
                        completionHandler: nil
                    )
                    try? AVAudioSession.sharedInstance().setActive(
                        false,
                        options: [.notifyOthersOnDeactivation]
                    )
                    session.end(.background)
                }
            }

        }.interactiveDismissDisabled()
    }

    /// Takes the QR off the binding at once (it is read exactly once) and opens 「Mac 화면」 on it: the registration when
    /// the QR is one, the list with the reason when it is not. A registration already under way keeps the sheet; its
    /// outcome is not known yet, so another QR never replaces it. Nothing reaches the Mac before 「이 기기 등록」.
    private func receiveScreenInvite(_ text: String?) {
        guard let text else { return }
        screenInvite.wrappedValue = nil
        do {
            let invite = try RegistrationInvite(deviceRegistrationText: text)
            if showingScreens, let current = screenRegistration, current.code.id == invite.code.id || screenRegistrationBusy { return }
            screenRegistration = invite; screenRejection = nil
        } catch {
            // A bad QR does not close a registration on screen; the list shows why when no registration is up.
            if showingScreens, screenRegistration != nil { return }
            screenRejection = ScreenMacsSection.rejection(for: error)
        }
        if showingConnection { screensAfterSheet = true; showingConnection = false } else { showingScreens = true }
    }
}
