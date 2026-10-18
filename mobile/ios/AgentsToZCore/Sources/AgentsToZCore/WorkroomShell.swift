import Foundation

/// A link the person tapped inside the portal page that leaves the workspace. The web view never loads it;
/// the app hands it to the system browser. Before this, popups returned nil and every other navigation was
/// cancelled, so bookmarks, deploy/GitHub links and the voice key pages did nothing in the app.
///
/// - `request`: only what WebKit's popup gate lets through leaves (see `Request`). Every portal link that leaves is a
///   `target=_blank` link or a `window.open`, so a main-frame link to another site is cancelled, as before.
/// - `sealed`: the same-network page. Anything on that network could have served it, so it opens nothing.
public enum WorkroomExternalLink {
    public static let maxLength = 8192

    /// How the page asked to leave.
    public enum Request: Sendable, Equatable {
        /// `createWebViewWith` (`window.open`). The app sets `javaScriptCanOpenWindowsAutomatically = false`, so WebKit
        /// asks only on a user gesture.
        case popup
        /// `decidePolicyFor`. `newWindow`: the navigation has no target frame (a `target=_blank` link); WebKit's popup gate
        /// covers it — a scripted click on such a link reaches neither delegate (macOS WebKit probe, 2026-10-16).
        /// A main-frame link is `.linkActivated` even for a scripted `a.click()` with no gesture (same probe), so
        /// `linkActivated` alone is not a tap.
        case navigation(linkActivated: Bool, newWindow: Bool)

        var mayLeave: Bool {
            switch self {
            case .popup: true
            case .navigation(let linkActivated, let newWindow): linkActivated && newWindow
            }
        }
    }

    public static func target(_ url: URL, origin: String, request: Request, sealed: Bool) -> URL? {
        guard request.mayLeave, !sealed, url.absoluteString.utf8.count <= maxLength,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
              parts.user == nil, parts.password == nil, let host = parts.host, !host.isEmpty,
              !WorkroomAddress.allowsResponse(url, origin: origin) else { return nil }
        return url
    }
}

/// Where the app keeps the saved workspaces (UserDefaults in the app; a dictionary in tests).
public protocol WorkroomPreferenceStore: AnyObject {
    func string(forKey key: String) -> String?
    func data(forKey key: String) -> Data?
    func set(_ value: Any?, forKey key: String)
    func removeObject(forKey key: String)
}

extension UserDefaults: WorkroomPreferenceStore {}

public enum SavedWorkspace: Sendable, Equatable {
    /// The portal bundled in the app, for the Supabase project a link or QR named.
    case bundled(BundledPortalConfig)
    /// A personal portal opened on the web.
    case web(origin: String)
    /// A Mac's same-network page.
    case lan(origin: String)

    public var isLAN: Bool { if case .lan = self { true } else { false } }

    /// What the first screen and the connection sheet show under its button: the hosts that tell two workspaces apart.
    public var hostLabel: String {
        switch self {
        case .bundled(let config): config.portalHost + " · " + config.supabaseHost
        case .web(let origin): String(origin.dropFirst("https://".count))
        case .lan(let origin): String(origin.dropFirst("http://".count))
        }
    }
}

/// The workspaces this phone can reopen. One internet workspace (bundled or web) and, beside it, one
/// same-network workspace — a same-network QR used to replace the internet workspace for good, and off
/// that Wi‑Fi every launch reopened a dead page. A connection is saved only after its page loaded
/// (`commit`), so an unusable scan or a cancelled connection never destroys the previous one.
public struct WorkroomSavedWorkspaces {
    /// Before this build: the one pointer, a web OR LAN origin.
    static let originKey = "agentstoz.workroom.origin"
    static let bundledKey = "agentstoz.workroom.bundled"
    static let lanKey = "agentstoz.workroom.lan"
    /// Which of the two was saved last: `internet` or `lan`. Absent → internet first.
    static let lastKey = "agentstoz.workroom.last"

    private let store: WorkroomPreferenceStore
    public init(store: WorkroomPreferenceStore) { self.store = store }

    public var internet: SavedWorkspace? {
        if let data = store.data(forKey: Self.bundledKey), let saved = try? JSONDecoder().decode(BundledPortalConfig.self, from: data),
           let config = BundledPortalConfig(portalOrigin: saved.portalOrigin, supabaseUrl: saved.supabaseUrl, supabaseAnonKey: saved.supabaseAnonKey) {
            return .bundled(config)
        }
        if let value = store.string(forKey: Self.originKey), Self.isWebOrigin(value) { return .web(origin: value) }
        return nil
    }

    public var lan: SavedWorkspace? {
        for key in [Self.lanKey, Self.originKey] {
            if let value = store.string(forKey: key), LANClient.resumableOrigin(value) { return .lan(origin: value) }
        }
        return nil
    }

    /// The workspace the app reopens by itself: the one saved last.
    public var resumeTarget: SavedWorkspace? {
        store.string(forKey: Self.lastKey) == "lan" ? (lan ?? internet) : (internet ?? lan)
    }

    /// The other saved workspace, offered when this one cannot be used.
    public func alternative(to workspace: SavedWorkspace) -> SavedWorkspace? {
        workspace.isLAN ? internet : lan
    }

    public func commit(_ workspace: SavedWorkspace) {
        switch workspace {
        case .bundled(let config):
            guard let data = try? JSONEncoder().encode(config) else { return }
            store.set(data, forKey: Self.bundledKey)
            if store.string(forKey: Self.originKey).map(Self.isWebOrigin) == true { store.removeObject(forKey: Self.originKey) }
            store.set("internet", forKey: Self.lastKey)
        case .web(let origin):
            store.removeObject(forKey: Self.bundledKey)
            store.set(origin, forKey: Self.originKey)
            store.set("internet", forKey: Self.lastKey)
        case .lan(let origin):
            store.set(origin, forKey: Self.lanKey)
            if store.string(forKey: Self.originKey).map(LANClient.resumableOrigin) == true { store.removeObject(forKey: Self.originKey) }
            store.set("lan", forKey: Self.lastKey)
        }
    }

    /// Forget exactly this workspace; the other one stays.
    public func forget(_ workspace: SavedWorkspace) {
        switch workspace {
        case .bundled(let config):
            if case .bundled(let saved) = internet, saved == config { store.removeObject(forKey: Self.bundledKey) }
        case .web(let origin):
            if case .web(let saved) = internet, saved == origin { store.removeObject(forKey: Self.originKey) }
        case .lan(let origin):
            if store.string(forKey: Self.lanKey) == origin { store.removeObject(forKey: Self.lanKey) }
            if store.string(forKey: Self.originKey) == origin { store.removeObject(forKey: Self.originKey) }
        }
        if resumeTarget == nil { store.removeObject(forKey: Self.lastKey) }
        else if workspace.isLAN { store.set("internet", forKey: Self.lastKey) }
        else if lan != nil, internet == nil { store.set("lan", forKey: Self.lastKey) }
    }

    /// A portal address typed into the first screen opens the web deployment, which has its own store: a person
    /// who connected that portal with a link or QR looked signed out and had to pair every Mac again. A typed
    /// address with no QR payload reuses the bundled configuration already saved for the same portal.
    public func bundledReuse(for address: InternetWorkroomAddress) -> BundledPortalConfig? {
        guard address.bundledPortal == nil, address.url.fragment == nil,
              case .bundled(let config) = internet, config.portalOrigin == address.origin else { return nil }
        return config
    }

    static func isWebOrigin(_ value: String) -> Bool {
        (try? InternetWorkroomAddress(scanned: value + "/remote/"))?.origin == value
    }
}

/// iOS reclaims the page's WebContent process after an app switch. Reload by itself, at most once a minute,
/// before admitting a failure; a page that keeps dying is reported as such, without network advice.
public enum WorkroomContentRecovery {
    public static let minimumInterval: TimeInterval = 60

    /// `loaded`: the page had loaded, was reloaded once already and died again within the minute. Otherwise it died before
    /// its first load (once), and 「다시 연결」 opens the workspace address without a QR's one-use fragment.
    public static func failureMessage(loaded: Bool) -> String {
        loaded
            ? "작업 공간 화면이 짧은 시간에 반복해서 종료되었습니다(iOS가 앱의 메모리를 정리할 때 생길 수 있습니다). 「다시 연결」을 누르면 같은 연결로 다시 엽니다."
            : "작업 공간 화면이 열리기 전에 종료되었습니다(iOS가 앱의 메모리를 정리할 때 생길 수 있습니다). 「다시 연결」은 이 작업 공간 주소를 다시 엽니다. QR로 처음 연결하던 중이었다면 QR을 다시 스캔하세요."
    }

    /// A sign-in window was open when the page died: the reloaded page no longer waits for its answer.
    public static let signInCancelledMessage = "작업 공간 화면이 다시 열리면서 진행 중이던 로그인을 취소했습니다. 로그인을 다시 시도하세요."

    public static func mayReload(lastReload: Date?, now: Date) -> Bool {
        guard let lastReload else { return true }
        return now.timeIntervalSince(lastReload) >= minimumInterval
    }
}

/// What 「이 앱의 연결 정보 지우기」 actually did, in the sentence shown on the first screen.
public struct WorkroomWipeReport: Sendable, Equatable {
    public enum Local: Sendable, Equatable {
        /// The store is gone.
        case removed
        /// The store's identifier remained, but every record in it was deleted.
        case cleared
        /// Records may remain.
        case failed

        public static func from(removed: Bool, remainingRecords: Int?) -> Local {
            removed ? .removed : remainingRecords == 0 ? .cleared : .failed
        }
    }
    public let local: Local
    /// `true`: every paired Mac answered the revoke. `false`/`nil`: not all did, or the page did not answer in time.
    public let macsConfirmed: Bool?
    public init(local: Local, macsConfirmed: Bool?) { self.local = local; self.macsConfirmed = macsConfirmed }

    public var message: String {
        var lines: [String] = []
        switch local {
        case .removed, .cleared: lines.append("이 iPhone에서 이 작업 공간의 로그인·기기 연결 정보를 지웠습니다.")
        case .failed: lines.append("이 iPhone의 연결 정보를 다 지우지 못했습니다. 앱을 완전히 닫았다가 다시 열면 남은 정보를 지웁니다.")
        }
        if macsConfirmed != true {
            lines.append("Mac의 연결 해제 응답은 확인하지 못했습니다. 그 Mac의 원격제어 창에서 이 기기를 해제할 수 있습니다.")
        }
        return lines.joined(separator: " ")
    }
}

extension BundledPortalConfig {
    /// What the person can recognise, e.g. `portal.example.com` — never the app's internal page origin.
    public var portalHost: String { String(portalOrigin.dropFirst("https://".count)) }
    public var supabaseHost: String { String(supabaseUrl.dropFirst("https://".count)) }

    static let metaConnectSource = "connect-src 'self' https://*.supabase.co wss://*.supabase.co;"

    /// The bundled `remote/index.html` carries the web deployment's meta CSP, which allows only `*.supabase.co`.
    /// WebKit enforces it together with the served header policy, so a self-hosted project accepted by the link
    /// and QR could not be reached at all. Add this project to the meta policy's `connect-src`, exactly as the
    /// header policy already does; nothing else in the page changes (its inline script hash stays valid).
    public func servedHTML(_ html: String) -> String {
        guard !supabaseHost.hasSuffix(".supabase.co"),
              let meta = html.range(of: "<meta http-equiv=\"Content-Security-Policy\""),
              let end = html[meta.upperBound...].range(of: ">"),
              let source = html[meta.upperBound..<end.lowerBound].range(of: Self.metaConnectSource) else { return html }
        let widened = "connect-src 'self' https://*.supabase.co wss://*.supabase.co \(supabaseUrl) wss://\(supabaseHost);"
        return html.replacingCharacters(in: source, with: widened)
    }
}
