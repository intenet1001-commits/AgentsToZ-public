#if os(macOS)
import Foundation
import CryptoKit

/// Metadata from an audit-token-verified Screen socket. It never selects the HTTPS authority.
public struct ScreenCommunityHostIdentity: Sendable {
    public let profileID: String
    public let deviceID: String
    public let name: String
    public let publicKey: P256.Signing.PublicKey
    public let boundViewerKey: Data?
    public static func load() async throws -> Self {
        let a = try await ScreenCommunityCommand(.identity).call().values
        guard a.count == 5, let profile = a[0].string, let device = a[1].string, let name = a[2].string,
              let host = a[3].string, UUID(uuidString: profile)?.uuidString.lowercased() == profile,
              UUID(uuidString: device)?.uuidString.lowercased() == device, RegistrationInvite.isShowableName(name) else { throw ScreenCommunityError.malformed }
        let key = try P256.Signing.PublicKey(x963Representation: ScreenCommunityRequest.decodeBase64(host, max: 87))
        let viewer = try a[4].string.map { try ScreenCommunityRequest.decodeBase64($0, max: 87) }
        if let viewer { _ = try P256.Signing.PublicKey(x963Representation: viewer) }
        return Self(profileID: profile, deviceID: device, name: name, publicKey: key, boundViewerKey: viewer)
    }
    public var signer: any TranscriptSigner { HostProxy(publicKey: publicKey) }
    private struct HostProxy: TranscriptSigner {
        let publicKey: P256.Signing.PublicKey
        func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
            let values = try await ScreenCommunityCommand(.prepare, [.string(ScreenCommunityRequest.base64(data))]).call().values
            guard values.count == 1, let raw = values[0].string else { throw ScreenCommunityError.malformed }
            let signature = try P256.Signing.ECDSASignature(rawRepresentation: ScreenCommunityRequest.decodeBase64(raw, max: 86))
            guard publicKey.isValidSignature(signature, for: data) else { throw ScreenCommunityError.invalidSignature }; return signature
        }
    }
}
#endif
