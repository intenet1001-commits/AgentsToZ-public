import Foundation
import CryptoKit
import Security

public enum CommunityAutomaticKey {
    /// Only the authenticated issuer can turn this public key into device authority. Existing biometric keys
    /// remain unchanged. The wrapped key is stored only in the signed helper's private Keychain account.
    public static func make() throws -> Data {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, &error) else {
            throw ScreenCommunityError.malformed
        }
        return try SecureEnclave.P256.Signing.PrivateKey(accessControl: access).dataRepresentation
    }
}
public struct CommunityAccessJournal: Codable, Sendable {
    public let id: String
    public let operation: String
    public let actor: String?
    public let envelope: ScreenCommunityEnvelope
}
/// One durable unknown-result fence per registration/account. It never persists a mobile use-session key.
/// A verified reply is acknowledged only after the caller validates its exact subject and commits the result.
public actor CommunityAccessCoordinator {
    public typealias Exchange = @Sendable (ScreenCommunityEnvelope, String) async throws -> CommunityAccessReply
    private let authority: ScreenCommunityAuthority
    private let exchange: Exchange
    private let save: @Sendable (CommunityAccessJournal?) throws -> Void
    private var pending: CommunityAccessJournal?
    private var busy = false
    public init(authority: ScreenCommunityAuthority, pending: CommunityAccessJournal?, save: @escaping @Sendable (CommunityAccessJournal?) throws -> Void, exchange: Exchange? = nil) {
        self.authority = authority; self.pending = pending; self.save = save
        self.exchange = exchange ?? { try await CommunityAccessHTTP(authority: authority).send($0, requestId: $1) }
    }
    public func snapshot() -> CommunityAccessJournal? { pending }
    public func request(_ operation: CommunityAccessRequest.Operation, actor: String?, argumentsJSON: Data,
                        signer: any TranscriptSigner, mutation: Bool = false, observedAt: Date = Date()) async throws -> CommunityAccessReply {
        guard !busy else { throw ScreenCommunityError.service("BUSY") }
        guard !mutation || pending == nil else { throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST") }
        busy = true; defer { busy = false }
        let request = try CommunityAccessRequest(operation: operation, actor: actor, argumentsJSON: argumentsJSON, now: observedAt)
        let envelope = try await request.signed(by: signer)
        if mutation {
            let intent = CommunityAccessJournal(id: request.id, operation: operation.rawValue, actor: actor, envelope: envelope)
            try save(intent); pending = intent
        }
        do { return try await exchange(envelope, request.id) }
        catch ScreenCommunityError.service(let code) where !["UNAVAILABLE", "SERVICE_UNAVAILABLE", "REQUEST_CONFLICT"].contains(code) {
            if mutation { try save(nil); pending = nil }
            throw ScreenCommunityError.service(code)
        }
    }
    public func acknowledge(_ requestId: String) throws {
        guard let pending, pending.id == requestId else { throw ScreenCommunityError.wrongRequest }
        try save(nil); self.pending = nil
    }
    public func recover(using host: any TranscriptSigner) async throws -> CommunityAccessReply {
        guard !busy, let original = pending else { throw ScreenCommunityError.service("NO_PENDING_REQUEST") }
        busy = true; defer { busy = false }
        let args = try JSONSerialization.data(withJSONObject: [original.id])
        let request = try CommunityAccessRequest(operation: .receipt, actor: original.actor, argumentsJSON: args)
        let outer = try await exchange(request.signed(by: host), request.id)
        guard outer.kind == "receipt" else { throw ScreenCommunityError.wrongRequest }
        let object = try AccessValue.object(outer.value, ["originalRequestId", "result"])
        guard object["originalRequestId"] as? String == original.id else { throw ScreenCommunityError.wrongRequest }
        let envelope = try JSONDecoder().decode(ScreenCommunityEnvelope.self, from: JSONSerialization.data(withJSONObject: object["result"] as Any))
        let result = try CommunityAccessReply.verify(envelope, authority: authority)
        let expected: [String: String] = ["prepare": "prepared", "approve": "authorization", "session-open": "session", "activity": "session", "session-close": "session-closed"]
        guard result.requestId == original.id, result.kind == expected[original.operation] else { throw ScreenCommunityError.wrongRequest }
        return result // Caller validates and commits the exact result, then acknowledges the original ID.
    }
}
