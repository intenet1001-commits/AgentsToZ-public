import Foundation

/// Only a validated, one-use LAN QR can bootstrap a Workroom. Never log the URL.
public struct WorkroomAddress: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let origin: String
    private let bootstrap: URL
    public init(pairing: LANPairing) {
        origin = pairing.origin
        bootstrap = URL(string: origin + "/remote/#pair=" + pairing.token)!
    }
    public var description: String { "WorkroomAddress(\(origin), token: redacted)" }
    public var debugDescription: String { description }
    /// For a single WKWebView load only; keep it in memory and discard after that load.
    public var bootstrapURL: URL { bootstrap }

    /// WebKit may retain the request fragment in HTTPURLResponse.url even though
    /// fragments never went over HTTP. Response identity is origin + path + query.
    public static func allowsResponse(_ url: URL, origin: String) -> Bool {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        parts.fragment = nil
        guard let document = parts.url else { return false }
        return allowsDocument(document, origin: origin, mainFrame: true)
    }

    public static func allowsDocument(_ url: URL, origin: String, initialURL: URL? = nil, mainFrame: Bool) -> Bool {
        guard mainFrame else { return false }
        if let initialURL, url.absoluteString == initialURL.absoluteString { return true }
        // Exact strings reject parser normalization, credentials, queries and fragments.
        return url.absoluteString == origin + "/remote/" || url.absoluteString == origin + "/remote/index.html"
    }
}

/// Internet authentication stays in the user's browser. This validates the handoff
/// surface only; the portal validates its QR bootstrap and requires Mac SAS approval.
public struct InternetWorkroomAddress: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let origin: String
    public let url: URL
    public var description: String { "InternetWorkroomAddress(\(origin), fragment: redacted)" }
    public var debugDescription: String { description }
    /// Address-field convenience only. QR and navigation validation stay exact.
    /// A personal portal home opens the shared workspace, without requiring host pairing.
    public init(portalInput: String) throws {
        if let parts = URLComponents(string: portalInput),
           parts.percentEncodedQuery == nil, parts.percentEncodedFragment == nil,
           ["", "/", "/portal.html"].contains(parts.percentEncodedPath) {
            let origin = String(portalInput.dropLast(parts.percentEncodedPath.count))
            try self.init(scanned: origin + "/remote/")
        } else {
            try self.init(scanned: portalInput)
        }
    }
    public init(scanned: String) throws {
        guard scanned.utf8.count <= 4096, !scanned.contains(where: { $0.isWhitespace }), !scanned.contains("\\"),
              let parts = URLComponents(string: scanned), parts.scheme == "https",
              parts.user == nil, parts.password == nil, let host = parts.host,
              !host.isEmpty, !host.contains(":"), host.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 }),
              parts.port == nil || parts.port == 443,
              parts.percentEncodedPath == "/remote/", parts.percentEncodedQuery == nil else { throw RemoteFailure.invalidQR }
        if let fragment = parts.percentEncodedFragment {
            guard fragment.hasPrefix("pair="), fragment.count > 5,
                  fragment.dropFirst(5).utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { throw RemoteFailure.invalidQR }
        }
        origin = "https://" + host + (parts.port == 443 ? ":443" : "")
        let expected = origin + "/remote/" + (parts.percentEncodedFragment.map { "#" + $0 } ?? "")
        guard scanned == expected, let url = URL(string: scanned) else { throw RemoteFailure.invalidQR }
        self.url = url
        bundledPortal = parts.percentEncodedFragment.flatMap { BundledPortalConfig(pairFragment: $0, portalOrigin: origin) }
    }

    /// Present when the Mac put its Supabase project in the QR: the app can then open its
    /// bundled portal instead of the web deployment. Absent on QRs from older Macs.
    public private(set) var bundledPortal: BundledPortalConfig? = nil
}

/// What the bundled portal needs, taken from the QR. The anon key is the public key already
/// shipped in every web portal build; sign-in and RLS protect the data.
public struct BundledPortalConfig: Sendable, Equatable, Codable {
    public static let scheme = "agentstoz-app"
    /// Not "localhost": the portal treats loopback hosts as local development and would route
    /// Supabase through a desktop proxy that does not exist on a phone.
    public static let host = "portal"
    public static let pageOrigin = scheme + "://" + host
    public let portalOrigin: String
    public let supabaseUrl: String
    public let supabaseAnonKey: String

    public init?(portalOrigin: String, supabaseUrl: String, supabaseAnonKey: String) {
        guard Self.isHTTPSOrigin(portalOrigin), Self.isHTTPSOrigin(supabaseUrl), Self.isPublicKey(supabaseAnonKey) else { return nil }
        self.portalOrigin = portalOrigin; self.supabaseUrl = supabaseUrl; self.supabaseAnonKey = supabaseAnonKey
    }

    init?(pairFragment: String, portalOrigin: String) {
        guard pairFragment.hasPrefix("pair="), let data = Self.base64URLDecode(String(pairFragment.dropFirst(5))), data.count <= 2048,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let supabase = object["supabase"] as? [String: Any], Set(supabase.keys) == ["url", "anonKey"],
              let url = supabase["url"] as? String, let key = supabase["anonKey"] as? String else { return nil }
        self.init(portalOrigin: portalOrigin, supabaseUrl: url, supabaseAnonKey: key)
    }

    /// The page the app loads: the same `/remote/#pair=…` path as the web, on the app's own origin.
    public func pageURL(fragment: String?) -> URL? {
        URL(string: Self.pageOrigin + "/remote/" + (fragment.map { "#" + $0 } ?? ""))
    }

    static func isHTTPSOrigin(_ value: String) -> Bool {
        guard value.utf8.count <= 256, let parts = URLComponents(string: value), parts.scheme == "https",
              parts.user == nil, parts.password == nil, let host = parts.host, !host.isEmpty,
              host.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 }),
              parts.percentEncodedPath.isEmpty, parts.percentEncodedQuery == nil, parts.percentEncodedFragment == nil,
              parts.port == nil else { return false }
        return value == "https://" + host
    }

    static func isPublicKey(_ value: String) -> Bool {
        guard (20...1024).contains(value.utf8.count) else { return false }
        let allowed = { (c: UInt8) in (65...90).contains(c) || (97...122).contains(c) || (48...57).contains(c) || c == 45 || c == 95 }
        if value.hasPrefix("sb_publishable_") { return value.utf8.allSatisfy(allowed) }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 3 && parts.allSatisfy { !$0.isEmpty && $0.utf8.allSatisfy(allowed) }
    }

    static func base64URLDecode(_ value: String) -> Data? {
        guard !value.isEmpty, value.utf8.count <= 4096 else { return nil }
        var text = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while text.count % 4 != 0 { text += "=" }
        return Data(base64Encoded: text)
    }
}

