#if os(macOS)
import Foundation
import CryptoKit

/// Ephemeral display projection only. The common operation key stays in its dedicated account; no pairwise ledger write.
public enum CommunityViewerTarget {
    public static func make(peer: CommunityAuthorization, own: CommunityAuthorization, operationBlob: Data) throws -> ViewerTarget {
        guard own.isCurrent(), peer.isCurrent(), own.body.deviceKind == .desktop, peer.body.deviceKind == .desktop,
              own.body.communityId == peer.body.communityId, own.body.profileId == peer.body.profileId,
              own.body.enrollmentId != peer.body.enrollmentId, own.body.deviceId != peer.body.deviceId,
              own.body.capabilities.contains(.screenView), peer.body.capabilities.contains(.receiveView) else { throw ScreenCommunityError.wrongCommunity }
        let operation = try SecureEnclaveTranscriptSigner(dataRepresentation: operationBlob)
        guard ScreenCommunityRequest.base64(operation.publicKey.x963Representation) == own.body.publicKey else { throw ScreenCommunityError.wrongCommunity }
        let host = try P256.Signing.PublicKey(x963Representation: ScreenCommunityRequest.decodeBase64(peer.body.hostPublicKey, max: 87))
        return try ViewerTarget(hostPublicKey: host, name: peer.body.name, controllerKeyBlob: operationBlob,
            controllerPublicKey: operation.publicKey, state: .confirmed, pairedAt: Date(timeIntervalSince1970: Double(peer.body.issuedAt) / 1000))
    }
}
#endif
