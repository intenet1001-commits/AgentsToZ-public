#if !CORE_CHECKS
import XCTest
import Foundation
import CryptoKit
@testable import ScreenControlCore

private final class AccessJournalBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: CommunityAccessJournal?
    func save(_ journal: CommunityAccessJournal?) { lock.withLock { value = journal } }
    func read() -> CommunityAccessJournal? { lock.withLock { value } }
}
private actor LostAccessReply {
    let issuer: P256.Signing.PrivateKey
    let authority: ScreenCommunityAuthority
    var original: ScreenCommunityEnvelope?
    var originalId: String?
    var mutationCount = 0
    init(issuer: P256.Signing.PrivateKey, authority: ScreenCommunityAuthority) { self.issuer = issuer; self.authority = authority }
    private func reply(_ id: String, _ kind: String, _ value: Any) throws -> ScreenCommunityEnvelope {
        let bytes = try JSONSerialization.data(withJSONObject: [2, kind, id, Int64(Date().timeIntervalSince1970 * 1000), value])
        let sig = try issuer.signature(for: Data("agentstoz.community-access.response/v2\0".utf8) + bytes)
        return .init(payload: ScreenCommunityRequest.base64(bytes), signature: ScreenCommunityRequest.base64(sig.rawRepresentation))
    }
    func send(_ envelope: ScreenCommunityEnvelope, _ id: String) throws -> CommunityAccessReply {
        let fields = try JSONSerialization.jsonObject(with: ScreenCommunityRequest.decodeBase64(envelope.payload)) as! [Any]
        if fields[1] as? String == "prepare" {
            mutationCount += 1; originalId = id
            original = try reply(id, "prepared", ["planId": id, "communityId": UUID().uuidString.lowercased(), "digest": String(repeating: "a", count: 64), "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 600_000])
            throw URLError(.timedOut)
        }
        guard fields[1] as? String == "receipt", let original, let originalId else { throw ScreenCommunityError.malformed }
        let encoded: [String: Any] = ["payload": original.payload, "signature": original.signature]
        return try .verify(reply(id, "receipt", ["originalRequestId": originalId, "result": encoded]), authority: authority, requestId: id)
    }
}
final class CommunityAccessRecoveryChecks: XCTestCase {
    func testLostReplySurvivesRestartAndCannotBeReexecutedBeforeExactAcknowledgement() async throws {
        let issuer = P256.Signing.PrivateKey(), signer = SoftwareSigner(), box = AccessJournalBox()
        let authority = try ScreenCommunityAuthority(origin: URL(string: "https://fixture.workers.dev")!, issuer: issuer.publicKey, profileID: UUID().uuidString.lowercased())
        let service = LostAccessReply(issuer: issuer, authority: authority)
        let exchange: CommunityAccessCoordinator.Exchange = { try await service.send($0, $1) }
        let coordinator = CommunityAccessCoordinator(authority: authority, pending: nil, save: box.save, exchange: exchange)
        do { _ = try await coordinator.request(.prepare, actor: nil, argumentsJSON: Data("[]".utf8), signer: signer, mutation: true); XCTFail("reply should be lost") }
        catch is URLError { }
        let pending = try XCTUnwrap(box.read())
        let restarted = CommunityAccessCoordinator(authority: authority, pending: pending, save: box.save, exchange: exchange)
        do { _ = try await restarted.request(.prepare, actor: nil, argumentsJSON: Data("[]".utf8), signer: signer, mutation: true); XCTFail("must recover first") }
        catch ScreenCommunityError.service(let code) { XCTAssertEqual(code, "RECOVER_EXISTING_REQUEST") }
        let recovered = try await restarted.recover(using: signer)
        XCTAssertEqual(recovered.requestId, pending.id); XCTAssertEqual(recovered.kind, "prepared")
        XCTAssertNotNil(box.read(), "a response alone cannot commit registration")
        do { try await restarted.acknowledge(UUID().uuidString.lowercased()); XCTFail("wrong request ID") }
        catch ScreenCommunityError.wrongRequest { }
        try await restarted.acknowledge(pending.id)
        XCTAssertNil(box.read())
        let mutations = await service.mutationCount; XCTAssertEqual(mutations, 1)
    }
    func testAutomaticHostProofCannotApproveOrSubstituteAnotherDevice() throws {
        let host = P256.Signing.PrivateKey(), bio = P256.Signing.PrivateKey(), operation = P256.Signing.PrivateKey()
        let profile = UUID().uuidString.lowercased(), device = UUID().uuidString.lowercased()
        let plan = try CommunityAccessPlan(profileId: profile, deviceId: device, name: "Mac 3", kind: .desktop,
            hostKey: host.publicKey.x963Representation, biometricKey: bio.publicKey.x963Representation, operationKey: operation.publicKey.x963Representation, capabilities: [.screenView])
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan))
        func transcript(_ operation: CommunityAccessRequest.Operation, _ args: [Any]) throws -> Data {
            Data("agentstoz.community-access.request/v2\0".utf8) + (try CommunityAccessRequest(operation: operation, actor: nil, argumentsJSON: JSONSerialization.data(withJSONObject: args))).bytes
        }
        func validate(_ data: Data, _ ownDevice: String = device) throws {
            try CommunityAccessRequest.validateHostProof(data, profileId: profile, deviceId: ownDevice, hostKey: host.publicKey.x963Representation, biometricKey: bio.publicKey.x963Representation, certificate: nil)
        }
        try validate(transcript(.prepare, [object]))
        XCTAssertThrowsError(try validate(transcript(.prepare, [object]), UUID().uuidString.lowercased()))
        for op: CommunityAccessRequest.Operation in [.approve, .authorization, .sessionOpen, .relayTicket] {
            XCTAssertThrowsError(try validate(transcript(op, [])))
        }
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan)) as! [String: Any]
        XCTAssertTrue(encoded["controlKey"] is NSNull, "wire digest includes explicit absent component key")
    }
}
#endif
