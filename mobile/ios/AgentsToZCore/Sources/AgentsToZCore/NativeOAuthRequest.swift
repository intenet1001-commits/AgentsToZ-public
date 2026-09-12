import Foundation

/// Code-only PKCE handoff. The verifier and authenticated session never enter native code.
public struct NativeOAuthRequest: Sendable {
    public let authorizationURL: URL
    public let state: String
    public static let callbackScheme = "agentstoz-mobile"
    public static func callback(state: String) -> String { "agentstoz-mobile://auth/callback?state=" + state }

    public init(authorizationURL: String, state: String) throws {
        guard Self.isToken(state, minimum: 32, maximum: 128), authorizationURL.utf8.count <= 8192,
              !authorizationURL.contains(where: { $0.isWhitespace }), !authorizationURL.contains("\\"),
              let parts = URLComponents(string: authorizationURL), parts.scheme == "https",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              let host = parts.host, host.hasSuffix(".supabase.co"),
              host.dropLast(".supabase.co".count).allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }),
              host.count > ".supabase.co".count,
              parts.percentEncodedPath == "/auth/v1/authorize", let items = parts.queryItems,
              Set(items.map(\.name)).count == items.count else { throw RemoteFailure.invalidQR }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        let allowed: Set<String> = ["provider", "redirect_to", "code_challenge", "code_challenge_method", "scopes", "skip_http_redirect", "access_type", "prompt"]
        guard Set(values.keys).isSubset(of: allowed), values["provider"] == "google",
              values["redirect_to"] == Self.callback(state: state),
              values["code_challenge_method"]?.lowercased() == "s256",
              Self.isToken(values["code_challenge"] ?? "", minimum: 43, maximum: 43),
              let url = parts.url else { throw RemoteFailure.invalidQR }
        self.authorizationURL = url; self.state = state
    }

    public func authorizationCode(from url: URL) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == Self.callbackScheme, parts.host == "auth", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.percentEncodedPath == "/callback",
              (parts.percentEncodedFragment == nil || parts.percentEncodedFragment == ""), let items = parts.queryItems, items.count == 2,
              Set(items.map(\.name)) == ["state", "code"] else { throw RemoteFailure.invalidQR }
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard values["state"] == state, let code = values["code"], Self.isToken(code, minimum: 8, maximum: 2048) else { throw RemoteFailure.invalidQR }
        return code
    }

    private static func isToken(_ value: String, minimum: Int, maximum: Int) -> Bool {
        (minimum...maximum).contains(value.utf8.count) && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }
}

/// The native sheet ends before the web's 300-second listener timeout. A late
/// callback cannot complete a subsequent attempt, even when cancellation races.
public struct NativeOAuthAttempt: Sendable {
    public static let timeout: TimeInterval = 295
    public let id: UUID
    public let expiresAt: Date
    private var active = true
    public init(now: Date = Date(), id: UUID = UUID()) {
        self.id = id; expiresAt = now.addingTimeInterval(Self.timeout)
    }
    public mutating func consume(id: UUID, now: Date = Date()) -> Bool {
        guard active, self.id == id else { return false }
        guard now < expiresAt else { active = false; return false }
        active = false
        return true
    }
    public mutating func cancel() { active = false }
}
