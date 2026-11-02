import Foundation
import CryptoKit
import os

/// A peer derived from a current issuer-signed directory, never a fabricated legacy pairing/attestation row.
public struct ScreenCommunityPeerAdmission: Sendable {
    public let key: P256.Signing.PublicKey
    public let member: ScreenCommunityMember
    public let receivingGrant: ScreenCommunityGrant
    public let expiresAt: Date
}

public final class ScreenCommunityLeaseCache: Sendable {
    private struct State { var directory: ScreenCommunityDirectory?; var hostKey: Data?; var held = false }
    private let state = OSAllocatedUnfairLock(initialState: State())
    public init() { }
    public func update(_ directory: ScreenCommunityDirectory?, ownHostKey: Data?, held: Bool = false) {
        state.withLock { current in
            guard let directory, let ownHostKey, directory.isCurrent(at: Date()),
                  let own = directory.members.first(where: { $0.enrollmentID == directory.selfEnrollmentID }),
                  own.hostKey == ownHostKey, own.platform == "mac" else {
                current.directory = nil; current.hostKey = nil; current.held = held; return
            }
            if let old = current.directory, old.communityID != directory.communityID || old.revision > directory.revision { return }
            current.directory = directory; current.hostKey = ownHostKey; current.held = held
        }
    }
    public func setHeld(_ held: Bool) { state.withLock { $0.held = held } }
    public func peer(for fingerprint: Data, at now: Date = Date()) -> ScreenCommunityPeerAdmission? {
        state.withLock { state in
            guard !state.held, let directory = state.directory, directory.isCurrent(at: now),
                  let own = directory.members.first(where: { $0.enrollmentID == directory.selfEnrollmentID }),
                  own.hostKey == state.hostKey, own.grant != .none else { return nil }
            for member in directory.members where member.enrollmentID != own.enrollmentID {
                guard let key = try? P256.Signing.PublicKey(x963Representation: member.viewerKey),
                      ScreenControlIdentity.fingerprint(of: key) == fingerprint else { continue }
                return ScreenCommunityPeerAdmission(key: key, member: member, receivingGrant: own.grant, expiresAt: directory.expiresAt)
            }
            return nil
        }
    }
}

public extension ScreenCommunityDirectory {
    /// Ephemeral targets share this device's one biometric key. They are not written as pairwise registrations.
    func viewerTargets(controllerKeyBlob: Data, controllerPublicKey: P256.Signing.PublicKey, now: Date = Date()) throws -> [ViewerTarget] {
        guard isCurrent(at: now), let own = members.first(where: { $0.enrollmentID == selfEnrollmentID }),
              own.viewerKey == controllerPublicKey.x963Representation else { throw ScreenCommunityError.wrongCommunity }
        return try members.filter { $0.enrollmentID != selfEnrollmentID && $0.platform == "mac" && $0.grant != .none }.map { member in
            try ViewerTarget(hostPublicKey: P256.Signing.PublicKey(x963Representation: member.hostKey), name: member.name,
                controllerKeyBlob: controllerKeyBlob, controllerPublicKey: controllerPublicKey,
                privateNetwork: member.route.flatMap { try? ScreenPrivateNetworkRoute(address: $0) }, state: .confirmed, pairedAt: member.joinedAt)
        }
    }
}
