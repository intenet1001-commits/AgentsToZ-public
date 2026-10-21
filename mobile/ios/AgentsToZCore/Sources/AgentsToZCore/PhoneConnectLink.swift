import Foundation

/// 「폰 연결 링크」 — step ① of phone onboarding. It tells the app WHICH Supabase project to use so
/// the bundled portal can sign in and show synced data away from the Mac. It carries only public
/// values (portal origin, Supabase URL, anon/publishable key, a Mac label) and never a pairing
/// secret: a link can never grant control. Control stays the Mac QR + SAS approval.
///
///   agentstoz://connect#<base64url(JSON {v, portal, supabaseUrl, anonKey, hostName})>
///
/// Mirrors `src/phoneConnectLink.ts`; both read `tests/fixtures/phone-connect-link-golden.json`.
public struct PhoneConnectLink: Sendable, Equatable {
    public static let scheme = "agentstoz"
    public static let prefix = "agentstoz://connect#"
    public static let version = 1
    public let portalOrigin: String
    public let supabaseUrl: String
    public let anonKey: String
    public let hostName: String

    /// The portal configuration this link applies. Built through the same validating init as a QR's.
    public var bundledPortal: BundledPortalConfig? {
        BundledPortalConfig(portalOrigin: portalOrigin, supabaseUrl: supabaseUrl, supabaseAnonKey: anonKey)
    }
    /// What the confirmation names, e.g. `abcd.supabase.co`.
    public var supabaseHost: String { String(supabaseUrl.dropFirst("https://".count)) }
    public var portalHost: String { String(portalOrigin.dropFirst("https://".count)) }

    /// The first `agentstoz://connect#…` in pasted text (a chat message may wrap it in other words).
    public static func extract(from text: String) -> String? {
        guard text.utf16.count <= 16384, let range = text.range(of: prefix) else { return nil }
        let payload = text[range.upperBound...].unicodeScalars.prefix { isBase64URL($0) }
        return prefix + String(String.UnicodeScalarView(payload))
    }

    /// Strict parse of one exact link.
    public init(link: String) throws {
        guard link.hasPrefix(Self.prefix) else { throw RemoteFailure.invalidQR }
        let encoded = String(link.dropFirst(Self.prefix.count))
        guard !encoded.isEmpty, encoded.utf8.count <= 4096, encoded.unicodeScalars.allSatisfy(Self.isBase64URL),
              let data = BundledPortalConfig.base64URLDecode(encoded),
              let text = String(data: data, encoding: .utf8), let json = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              Set(object.keys) == ["v", "portal", "supabaseUrl", "anonKey", "hostName"],
              let v = object["v"] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), v == NSNumber(value: Self.version),
              let portal = object["portal"] as? String, let url = object["supabaseUrl"] as? String,
              let key = object["anonKey"] as? String, let host = object["hostName"] as? String,
              BundledPortalConfig.isHTTPSOrigin(portal), BundledPortalConfig.isHTTPSOrigin(url),
              Self.isPublicClientKey(key), Self.isAllowedHostName(host) else { throw RemoteFailure.invalidQR }
        portalOrigin = portal; supabaseUrl = url; anonKey = key; hostName = host
    }

    static func isBase64URL(_ c: Unicode.Scalar) -> Bool {
        (65...90).contains(c.value) || (97...122).contains(c.value) || (48...57).contains(c.value) || c == "-" || c == "_"
    }

    /// Same rule as the Mac's `isPublicSupabaseClientKey`: an `sb_publishable_` key, or an HS256 JWT
    /// whose role is `anon`. A service_role JWT or an `sb_secret_` key is refused.
    static func isPublicClientKey(_ value: String) -> Bool {
        guard (20...1024).contains(value.utf8.count), BundledPortalConfig.isPublicKey(value) else { return false }
        if value.hasPrefix("sb_publishable_") { return true }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        func decode(_ part: String) -> [String: Any]? {
            BundledPortalConfig.base64URLDecode(part).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
        guard parts.count == 3, let header = decode(parts[0]), let payload = decode(parts[1]) else { return false }
        return header["alg"] as? String == "HS256" && payload["role"] as? String == "anon"
    }

    /// Non-empty, trimmed, ≤ 128 UTF-8 bytes, no control or bidi-override characters: the label sits
    /// next to the Supabase host in a confirmation and must not be able to reorder or hide it.
    static func isAllowedHostName(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 128,
              value == value.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return !value.unicodeScalars.contains { s in
            s.value <= 0x1F || (0x7F...0x9F).contains(s.value) || s.value == 0x200E || s.value == 0x200F
                || (0x202A...0x202E).contains(s.value) || (0x2066...0x2069).contains(s.value)
        }
    }
}
