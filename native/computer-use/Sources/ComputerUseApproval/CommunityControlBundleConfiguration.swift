import Foundation
import CryptoKit

/// Only the signed bundle's sealed Info dictionary selects public trust. No defaults, environment or files.
public struct CommunityControlBundleConfiguration: Sendable {
    public static let infoKey = "AgentsToZCommunityConfigurationV1"
    public let origin: URL
    public let issuer: P256.Signing.PublicKey
    public let profileID: String
    public static func parse(info: [String: Any]) -> Self? {
        guard let fields = info[infoKey] as? [String: Any], Set(fields.keys) == ["origin", "issuerPublicKey", "profileId"],
              let rawOrigin = fields["origin"] as? String, let rawKey = fields["issuerPublicKey"] as? String,
              let profile = fields["profileId"] as? String,
              UUID(uuidString: profile)?.uuidString.lowercased() == profile,
              rawKey.utf8.count == 87, rawKey.range(of: "^[A-Za-z0-9_-]{87}$", options: .regularExpression) != nil,
              let origin = URL(string: rawOrigin), let host = origin.host,
              rawOrigin == "https://" + host, host == host.lowercased(), host.utf8.count <= 253, host.hasSuffix(".workers.dev") else { return nil }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ $0.utf8.count <= 63 && $0.range(of: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", options: .regularExpression) != nil }) else { return nil }
        let base = rawKey.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "="
        guard let bytes = Data(base64Encoded: base), bytes.count == 65, bytes.first == 4,
              bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == rawKey,
              let issuer = try? P256.Signing.PublicKey(x963Representation: bytes) else { return nil }
        return Self(origin: origin, issuer: issuer, profileID: profile)
    }
}
