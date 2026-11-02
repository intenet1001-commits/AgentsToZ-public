import Foundation
import CryptoKit

/// Private native key adapter. Holding a certificate is insufficient: the caller must also possess its exact
/// key. The wrapper only signs the registered purpose's typed requests and screen/relay proofs, until its lease ends.
public struct CommunityPurposeSigner: TranscriptSigner {
    private let inner: any TranscriptSigner
    private let authorization: CommunityAuthorization
    private let session: CommunityUseSession?
    private let capability: CommunityCapability
    public var publicKey: P256.Signing.PublicKey { inner.publicKey }
    public init(inner: any TranscriptSigner, authorization: CommunityAuthorization, session: CommunityUseSession? = nil,
                capability: CommunityCapability, now: Date = Date()) throws {
        let body = authorization.body, key = ScreenCommunityRequest.base64(inner.publicKey.x963Representation)
        guard authorization.isCurrent(at: now), body.capabilities.contains(capability),
              key == (session?.body.publicKey ?? body.publicKey) else { throw ScreenCommunityError.wrongCommunity }
        if body.deviceKind == .mobile {
            guard let session, session.body.communityId == body.communityId, session.body.enrollmentId == body.enrollmentId,
                  session.body.revision == body.revision, session.body.expiresAt > Int64(now.timeIntervalSince1970 * 1000),
                  session.body.capabilities.contains(capability) else { throw ScreenCommunityError.expired }
        } else if session != nil { throw ScreenCommunityError.wrongCommunity }
        self.inner = inner; self.authorization = authorization; self.session = session; self.capability = capability
    }
    public func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
        try validate(data)
        return try await inner.signature(for: data)
    }
    private func validate(_ data: Data) throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000), body = authorization.body
        guard body.expiresAt > now, session == nil || (session!.body.expiresAt > now && session!.body.idleExpiresAt > now) else { throw ScreenCommunityError.expired }
        let screen = Data("agentstoz.screen-control/v6/device".utf8)
        if data.starts(with: screen) {
            guard [.screenView, .screenControl].contains(capability), data.count == screen.count + 32 else { throw ScreenCommunityError.malformed }
            return
        }
        let domain = Data("agentstoz.community-access.request/v2\0".utf8)
        if data.starts(with: domain) {
            guard data.count <= 24_100, let fields = try JSONSerialization.jsonObject(with: data.dropFirst(domain.count)) as? [Any], fields.count == 7,
                  try AccessValue.integer(fields[0]) == 2, let op = fields[1] as? String, let args = fields[6] as? [Any],
                  fields[5] as? String == body.enrollmentId, args.first as? String == body.communityId else { throw ScreenCommunityError.malformed }
            _ = try AccessValue.id(fields[2]); let at = try AccessValue.integer(fields[3])
            guard abs(Double(at - now)) <= 60_000, let nonce = fields[4] as? String,
                  try ScreenCommunityRequest.decodeBase64(nonce, max: 43).count == 32 else { throw ScreenCommunityError.expired }
            switch op {
            case "authorization": guard session == nil, args.count == 1 else { throw ScreenCommunityError.malformed }
            case "directory": guard args.count == 2, matchesSession(args[1]) else { throw ScreenCommunityError.malformed }
            case "session-status", "session-close": guard session != nil, args.count == 2, matchesSession(args[1]) else { throw ScreenCommunityError.malformed }
            case "activity":
                guard let session, args.count == 4, matchesSession(args[1]), try AccessValue.integer(args[2]) == session.body.sequence + 1,
                      let type = args[3] as? String, ["touch", "key", "action"].contains(type) else { throw ScreenCommunityError.malformed }
            case "relay-ticket":
                guard args.count == 5, let purpose = args[1] as? String, args[3] as? String == "client", matchesSession(args[4]), purpose == relayPurpose else { throw ScreenCommunityError.malformed }
                _ = try AccessValue.id(args[2])
            default: throw ScreenCommunityError.malformed
            }
            return
        }
        guard data.count <= 512, let fields = try JSONSerialization.jsonObject(with: data) as? [Any], fields.count == 4,
              fields[0] as? String == "agentstoz.relay.bind/v2", let nonce = fields[3] as? String,
              try ScreenCommunityRequest.decodeBase64(nonce, max: 43).count == 32 else { throw ScreenCommunityError.malformed }
        _ = try AccessValue.id(fields[1]); _ = try AccessValue.id(fields[2])
    }
    private func matchesSession(_ value: Any) -> Bool {
        if let session { return value as? String == session.body.sessionId }
        return value is NSNull
    }
    private var relayPurpose: String {
        switch capability {
        case .screenView, .screenControl: "screen"
        case .communicate: bodyIsMobile ? "mobile-agent" : "agent"
        case .teams: bodyIsMobile ? "mobile-teams" : "teams"
        case .agentSettings: bodyIsMobile ? "mobile-agent-settings" : "agent-settings"
        case .browser: bodyIsMobile ? "mobile-browser" : "browser"
        case .receiveView, .receiveControl: "invalid" // The separately signed host broker owns receiving.
        }
    }
    private var bodyIsMobile: Bool { authorization.body.deviceKind == .mobile }
}
