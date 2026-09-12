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
    }
}
