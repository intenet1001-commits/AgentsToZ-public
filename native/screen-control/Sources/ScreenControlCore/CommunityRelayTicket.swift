import Foundation
import CryptoKit

public enum CommunityRelayPurpose: String, Codable, Sendable {
    case screen, agent, teams, agentSettings = "agent-settings", browser
    case mobileAgent = "mobile-agent", mobileTeams = "mobile-teams", mobileAgentSettings = "mobile-agent-settings", mobileBrowser = "mobile-browser"
}
public enum CommunityRelayRole: String, Codable, Sendable { case host, client }
public struct CommunityRelayTicket: Sendable {
    public struct Body: Codable, Equatable, Sendable {
        public let version: Int
        public let ticketId: String, communityId: String, enrollmentId: String, deviceId: String
        public let deviceKind: CommunityDeviceKind
        public let connectionId: String, publicKey: String
        public let purpose: CommunityRelayPurpose
        public let role: CommunityRelayRole
        public let sessionId: String?
        public let revision: Int64, issuedAt: Int64, expiresAt: Int64, leaseExpiresAt: Int64
    }
    public let body: Body
    public let envelope: ScreenCommunityEnvelope
}
extension CommunityAccessReply {
    public func relayTicket(for authorization: CommunityAuthorization, session: CommunityUseSession? = nil,
                            connectionId: String, purpose: CommunityRelayPurpose, role: CommunityRelayRole, now: Date = Date()) throws -> CommunityRelayTicket {
        guard kind == "ticket", authorization.isCurrent(at: now) else { throw ScreenCommunityError.expired }
        let object = try AccessValue.object(value, ["version", "ticketId", "communityId", "enrollmentId", "deviceId", "deviceKind", "connectionId", "publicKey", "purpose", "role", "sessionId", "revision", "issuedAt", "expiresAt", "leaseExpiresAt"])
        let body = try JSONDecoder().decode(CommunityRelayTicket.Body.self, from: JSONSerialization.data(withJSONObject: object))
        for v in [body.ticketId, body.communityId, body.enrollmentId, body.deviceId, body.connectionId] { _ = try AccessValue.id(v) }
        _ = try AccessValue.key(body.publicKey)
        let auth = authorization.body, clock = Int64(now.timeIntervalSince1970 * 1000)
        let key = purpose == .screen ? (role == .host ? auth.hostPublicKey : session?.body.publicKey ?? auth.publicKey) : auth.deviceKind == .desktop ? auth.controlKey ?? "" : session?.body.publicKey ?? ""
        guard body.version == 1, body.ticketId == requestId, body.communityId == auth.communityId, body.enrollmentId == auth.enrollmentId,
              body.deviceId == auth.deviceId, body.deviceKind == auth.deviceKind, body.connectionId == connectionId, body.purpose == purpose, body.role == role,
              body.publicKey == key, body.sessionId == session?.body.sessionId, body.revision == auth.revision, body.issuedAt == issuedAt,
              body.expiresAt > clock, body.expiresAt <= body.issuedAt + 30_000, body.expiresAt <= body.leaseExpiresAt,
              body.leaseExpiresAt > clock, body.leaseExpiresAt <= body.issuedAt + 90_000 else { throw ScreenCommunityError.wrongCommunity }
        if auth.deviceKind == .mobile {
            guard role == .client, let session, body.leaseExpiresAt <= session.body.idleExpiresAt,
                  session.body.revision == auth.revision, session.body.enrollmentId == auth.enrollmentId else { throw ScreenCommunityError.expired }
        }
        return CommunityRelayTicket(body: body, envelope: envelope)
    }
}
public struct CommunityRelayBindProof: Sendable {
    public let ticket: CommunityRelayTicket
    public let transcript: Data
    public init(ticket: CommunityRelayTicket, challenge: String, now: Date = Date()) throws {
        guard ticket.body.expiresAt > Int64(now.timeIntervalSince1970 * 1000),
              try ScreenCommunityRequest.decodeBase64(challenge, max: 43).count == 32 else { throw ScreenCommunityError.expired }
        self.ticket = ticket
        transcript = try JSONSerialization.data(withJSONObject: ["agentstoz.relay.bind/v2", ticket.body.ticketId, ticket.body.connectionId, challenge], options: .withoutEscapingSlashes)
    }
    public func signed(by signer: any TranscriptSigner) async throws -> Data {
        guard ScreenCommunityRequest.base64(signer.publicKey.x963Representation) == ticket.body.publicKey else { throw ScreenCommunityError.wrongCommunity }
        return try await signer.signature(for: transcript).rawRepresentation
    }
}
