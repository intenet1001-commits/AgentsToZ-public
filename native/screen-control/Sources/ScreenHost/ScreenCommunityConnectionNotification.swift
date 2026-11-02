#if os(macOS)
import CryptoKit
import Foundation
import ScreenControlCore

/// A projection of a completed protocol-6 admission, never a registration, grant, endpoint or SAS substitute.
/// H10 already accepts a host-signed actor fingerprint; recipients remain this Screen's current owner phones.
struct ScreenCommunityConnectionNotification: Sendable {
    let kind: ScreenEventKind
    let actorKey: P256.Signing.PublicKey
    let actorName: String
    let coalescingKey: String
    private let receivingKey: Data
    init?(admission: CommunityScreenAdmission, receivingKey: P256.Signing.PublicKey, at now: Date) {
        let controller = admission.controller.body, receiver = admission.receiver.body
        guard admission.expiresAt > now, admission.controller.isCurrent(at:now), admission.receiver.isCurrent(at:now),
              receiver.deviceKind == .desktop, controller.deviceId != receiver.deviceId,
              controller.communityId == receiver.communityId, controller.profileId == receiver.profileId,
              receiver.hostPublicKey == ScreenCommunityRequest.base64(receivingKey.x963Representation),
              receiver.capabilities.contains(.receiveView), controller.capabilities.contains(.screenView) else { return nil }
        let publicKey: String
        if controller.deviceKind == .mobile {
            guard let use = admission.useSession?.body, use.communityId == controller.communityId,
                  use.enrollmentId == controller.enrollmentId, use.revision == controller.revision,
                  use.expiresAt > Int64(now.timeIntervalSince1970 * 1000), use.idleExpiresAt > Int64(now.timeIntervalSince1970 * 1000),
                  use.capabilities.contains(.screenView) else { return nil }
            publicKey = use.publicKey; kind = .connected
        } else {
            guard admission.useSession == nil else { return nil }
            publicKey = controller.publicKey; kind = .controllerConnected
        }
        guard let bytes = try? ScreenCommunityRequest.decodeBase64(publicKey,max:87),
              ScreenCommunityRequest.base64(bytes) == publicKey,
              let key = try? P256.Signing.PublicKey(x963Representation:bytes) else { return nil }
        actorKey = key; self.receivingKey = receivingKey.x963Representation
        actorName = Self.displayName(controller.name,fallback:controller.deviceKind == .mobile ? "커뮤니티 모바일":"커뮤니티 Mac")
        coalescingKey = ["unified",controller.profileId,controller.communityId,controller.enrollmentId,
            String(controller.revision),String(controller.keyEpoch),ScreenCommunityRequest.base64(ScreenControlIdentity.fingerprint(of:key))].joined(separator:":")
    }
    /// V2 names can be 120 UTF-8 bytes; the unchanged H10 field accepts 64 bytes/32 NFC characters.
    /// Only the display label is shortened. The event actor is always the actual authenticated session key.
    static func displayName(_ source: String, fallback: String) -> String {
        let normalized = source.precomposedStringWithCanonicalMapping
        var result = ""
        for character in normalized {
            let candidate = result + String(character)
            guard candidate.utf8.count <= RegistrationRecord.maxTextBytes, candidate.count <= 32 else { break }
            result = candidate
        }
        if result != normalized {
            while !result.isEmpty && ((result+"…").utf8.count > RegistrationRecord.maxTextBytes || (result+"…").count > 32) { result.removeLast() }
            if !result.isEmpty { result += "…" }
        }
        return RegistrationInvite.isShowableName(result) ? result:fallback
    }
    @MainActor func event(macKey: P256.Signing.PublicKey, macName: String, devices: [RegisteredDevice], at now: Date) -> ScreenEvent? {
        guard macKey.x963Representation == receivingKey else { return nil }
        let actor = ScreenControlIdentity.fingerprint(of:actorKey)
        let recipients = ScreenEvent.recipients(registered:ScreenPush.inUse(devices,at:now),actor:actor)
        guard !recipients.isEmpty else { return nil }
        return try? ScreenEvent(macKey:macKey,kind:kind,at:now,macName:Self.displayName(macName,fallback:"Mac"),
            actorID:actor,actorName:actorName,recipients:recipients,issuedAt:now)
    }
}
#endif
