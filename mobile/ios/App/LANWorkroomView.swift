import SwiftUI
import WebKit
import CryptoKit
import AuthenticationServices
import AgentsToZCore

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
    var usesInternet: Bool { origin.hasPrefix("https://") }
    var connectionGuidance: String {
        usesInternet
            ? "외부 인터넷 연결 · 5G와 다른 Wi-Fi에서도 사용할 수 있습니다. 인터넷 상태와 개인 포털 주소를 확인하세요. 원격 작업에는 등록한 컴퓨터가 켜져 있어야 합니다."
            : "같은 네트워크용 QR로 연결했습니다. 이 주소는 일반적인 5G·외부 Wi-Fi에서 접속할 수 없습니다. 컴퓨터에서 외부 인터넷 연결 QR을 열고 아래 ‘인터넷 QR 스캔’을 눌러 주세요."
    }
    var failureMessage: String {
        [EndReason.failed.message, failureDetail, connectionGuidance,
         hasLoadedDocument ? "실행 중이던 작업은 자동으로 중지하거나 다시 실행하지 않습니다. 재연결 후 결과를 확인하세요." : ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
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
    @Published var authenticationIssue: String?
    private var authenticationSession: ASWebAuthenticationSession?
    private var authenticationAttempt: NativeOAuthAttempt?
    private var authenticationTimeout: Task<Void, Never>?
    private static let originKey = "agentstoz.workroom.origin"

    static var savedOrigin: String? {
        guard let value = UserDefaults.standard.string(forKey: originKey), Self.supportedOrigin(value) else { return nil }
        return value
    }

    convenience init(pairing: LANPairing) {
        let address = WorkroomAddress(pairing: pairing)
        self.init(origin: address.origin, bootstrapURL: address.bootstrapURL)
    }

    convenience init(internet address: InternetWorkroomAddress) {
        self.init(origin: address.origin, bootstrapURL: address.url)
    }

    private static func supportedOrigin(_ value: String) -> Bool {
        LANClient.resumableOrigin(value) || (try? InternetWorkroomAddress(scanned: value + "/remote/"))?.origin == value
    }

    convenience init?(resuming origin: String) {
        guard Self.supportedOrigin(origin), let url = URL(string: origin + "/remote/") else { return nil }
        self.init(origin: origin, bootstrapURL: url)
    }

    private init(origin: String, bootstrapURL: URL) {
        self.origin = origin
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
        configuration.websiteDataStore = Self.store(for: origin) ?? .nonPersistent()
        if origin.hasPrefix("https://") {
            configuration.userContentController.add(WorkroomOAuthHandler(owner: self), name: "agentstozOAuth")
            configuration.userContentController.addUserScript(WKUserScript(source: "Object.defineProperty(window,'agentstozNativeOAuth',{value:true,writable:false});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.allowsBackForwardNavigationGestures = false
        web.navigationDelegate = self
        web.uiDelegate = self
        webView = web
        UserDefaults.standard.set(origin, forKey: Self.originKey)
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

    static func store(for origin: String) -> WKWebsiteDataStore? {
        WKWebsiteDataStore(forIdentifier: storeIdentifier(for: origin))
    }

    /// Ending on purpose must take the stored session with it, or "연결 해제" would leave a token
    /// on this phone that the next connection silently resumes.
    static func forget(origin: String) async {
        await withCheckedContinuation { continuation in
            WKWebsiteDataStore.remove(forIdentifier: storeIdentifier(for: origin)) { _ in continuation.resume() }
        }
    }

    func selectTab(_ value: String) {
        guard ["home", "projects", "workroom", "bookmarks", "records"].contains(value) else { return }
        // Fixed UI action only; no native command/path/token bridge.
        webView?.evaluateJavaScript("document.querySelector('button[data-workspace-tab=\"" + value + "\"]')?.click()", completionHandler: nil)
    }

    func disconnect() async {
        // The host page owns the session. It performs its own narrow protocol revocation.
        let acknowledgement = try? await webView?.callAsyncJavaScript(
            "if (typeof window.agentstozDisconnect === 'function') return await window.agentstozDisconnect(); document.querySelector('[data-workspace-disconnect]')?.click(); return false;",
            arguments: [:], in: nil, contentWorld: .page)
        disconnectConfirmed = acknowledgement as? Bool == true
        UserDefaults.standard.removeObject(forKey: Self.originKey)
        end(.disconnected)
        await Self.forget(origin: origin)
    }

    func retry() {
        guard ended != .disconnected, let web = webView else { return }
        ended = nil; loading = true; initialURL = nil; failureDetail = ""
        web.load(URLRequest(url: URL(string: origin + "/remote/")!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20))
    }

    func end(_ reason: EndReason) {
        // Keep the single document, selected target and draft across screen lock. WebKit may
        // suspend networking; the host page resumes its own socket without replaying mutations.
        if reason == .background { return }
        guard ended == nil || reason == .disconnected else { return }
        if reason == .failed { authenticationAttempt = nil; authenticationTimeout?.cancel(); authenticationTimeout = nil; authenticationSession?.cancel(); authenticationSession = nil; ended = reason; loading = false; initialURL = nil; return }
        authenticationAttempt = nil; authenticationTimeout?.cancel(); authenticationTimeout = nil; authenticationSession?.cancel(); authenticationSession = nil
        ended = reason; loading = false; initialURL = nil
        let previous = webView
        webView = nil
        previous?.navigationDelegate = nil
        previous?.uiDelegate = nil
        previous?.stopLoading()
        // Destroy the document/WebSocket. Never issue terminal close, input or Ctrl+C.
        previous?.loadHTMLString("", baseURL: nil)
    }

    fileprivate func receiveOAuth(_ message: WKScriptMessage) {
        guard origin.hasPrefix("https://"), message.frameInfo.isMainFrame,
              let expected = URLComponents(string: origin),
              message.frameInfo.securityOrigin.protocol == "https",
              message.frameInfo.securityOrigin.host == expected.host,
              [0, expected.port ?? 443].contains(message.frameInfo.securityOrigin.port),
              let body = message.body as? [String: String], Set(body.keys) == ["authorizeURL", "state"],
              let url = body["authorizeURL"], let state = body["state"],
              let request = try? NativeOAuthRequest(authorizationURL: url, state: state) else { return }
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

    private func publishOAuth(state: String, code: String?) {
        let detail: [String: String] = code.map { ["state": state, "code": $0] } ?? ["state": state, "error": "NATIVE_AUTH_CANCELLED_OR_INVALID"]
        guard let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('agentstoz-oauth-result',{detail:" + json + "}))", completionHandler: nil)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        webView?.window ?? ASPresentationAnchor()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard ended == nil, let url = navigationAction.request.url,
              WorkroomAddress.allowsDocument(url, origin: origin, initialURL: initialURL,
                                             mainFrame: navigationAction.targetFrame?.isMainFrame == true) else {
            decisionHandler(.cancel)
            if loading { fail("허용된 작업 공간 밖으로의 페이지 이동을 차단했습니다.") }
            return
        }
        initialURL = nil // A reload cannot silently replay a consumed QR.
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        guard ended == nil, navigationResponse.isForMainFrame,
              let response = navigationResponse.response as? HTTPURLResponse,
              response.statusCode == 200, response.mimeType == "text/html",
              let url = response.url,
              WorkroomAddress.allowsResponse(url, origin: origin) else {
            decisionHandler(.cancel); fail("작업 공간의 서버 응답 또는 페이지 주소를 확인하지 못했습니다."); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard ended == nil else { return }
        loading = false
        hasLoadedDocument = true

    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failNavigation(error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failNavigation(error)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("작업 공간 화면 프로세스가 종료되었습니다. 다시 연결해 주세요.") }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) {
        // The shared workspace opens QR capture only on user action. Keep the
        // OS prompt and bind it to this connection's HTTPS main frame.
        guard type == .camera, frame.isMainFrame,
              let expected = URL(string: self.origin), expected.scheme == "https",
              origin.protocol == expected.scheme, origin.host == expected.host,
              (origin.port == 0 ? 443 : origin.port) == (expected.port ?? 443) else {
            decisionHandler(.deny)
            return
        }
        decisionHandler(.prompt)
    }
}

/// WK retains handlers, so keep its reference to the connection owner weak.
private final class WorkroomOAuthHandler: NSObject, WKScriptMessageHandler {
    weak var owner: LANWorkroomSession?
    init(owner: LANWorkroomSession) { self.owner = owner }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receiveOAuth(message)
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
    @State private var confirmingDisconnect = false
    @State private var disconnecting = false
    let onReconnect: () -> Void
    let onDone: () -> Void
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
                Button("연결 설정", systemImage: "slider.horizontal.3") { showingConnection = true }
                    .accessibilityIdentifier("workroomConnectionSettings")
            }
            .sheet(isPresented: $showingConnection) {
                NavigationStack {
                    List {
                        Section("현재 작업 공간") {
                            Text(session.origin).font(.callout).textSelection(.enabled)
                            Text("탭 이동이나 앱을 잠시 닫아도 연결 정보와 실행 중인 작업은 유지됩니다.").font(.subheadline).foregroundStyle(.secondary)
                        }
                        Section {
                            Text("다른 작업 기기는 작업 공간의 ‘기기 연결 · QR 스캔’에서 추가하세요. 기기별 작업 권한은 해당 컴퓨터에서 관리합니다.").font(.subheadline)
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
                        Text("현재 작업 공간의 로그인·기기 연결 정보가 이 앱에서 삭제됩니다. 일반적인 화면 닫기에는 필요하지 않습니다.")
                    }
                }.presentationDetents([.medium, .large]).interactiveDismissDisabled(disconnecting)
            }
            .onChange(of: scenePhase) { _, phase in if phase == .background { session.end(.background) } }

        }.interactiveDismissDisabled()
    }
}
