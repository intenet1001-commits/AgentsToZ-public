#if !CORE_CHECKS
import XCTest
import Foundation
import CryptoKit
import os
@testable import ScreenControlCore

private struct CommunitySoftwareSigner: TranscriptSigner {
    let key = P256.Signing.PrivateKey()
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for: data) }
}
private struct FirstHostSigner: TranscriptSigner {
    let signer: CommunitySoftwareSigner
    let provisioned: OSAllocatedUnfairLock<Bool>
    var publicKey: P256.Signing.PublicKey { signer.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
        let domain = Data("agentstoz.screen-community.request/v1\0".utf8)
        let fields = try JSONSerialization.jsonObject(with: data.dropFirst(domain.count)) as? [Any]
        if let fields, !(fields[5] is NSNull), !provisioned.withLock({ $0 }) { throw ScreenCommunityError.service("NOT_ENROLLED") }
        return try await signer.signature(for: data)
    }
}
private actor FirstHostFixture {
    let issuer = P256.Signing.PrivateKey(), community = UUID().uuidString.lowercased(), enrollment = UUID().uuidString.lowercased()
    let host: CommunitySoftwareSigner, viewer: CommunitySoftwareSigner, profile: String, device: String, now: Date
    var original: ScreenCommunityEnvelope?
    var operations: [String] = []
    init(host: CommunitySoftwareSigner, viewer: CommunitySoftwareSigner, profile: String, device: String, now: Date) {
        self.host = host; self.viewer = viewer; self.profile = profile; self.device = device; self.now = now
    }
    func publicIssuer() -> P256.Signing.PublicKey { issuer.publicKey }
    func envelope(_ fields: [Any]) throws -> ScreenCommunityEnvelope {
        let bytes = try JSONSerialization.data(withJSONObject: fields)
        return ScreenCommunityEnvelope(payload: ScreenCommunityRequest.base64(bytes), signature: ScreenCommunityRequest.base64(try issuer.signature(for: Data("agentstoz.screen-community.response/v1\0".utf8) + bytes).rawRepresentation))
    }
    func exchange(_ value: ScreenCommunityEnvelope, id: String) throws -> ScreenCommunityResponse {
        let bytes = try ScreenCommunityRequest.decodeBase64(value.payload)
        let fields = try XCTUnwrap(try JSONSerialization.jsonObject(with: bytes) as? [Any])
        let op = try XCTUnwrap(fields[1] as? String), at = Int64(now.timeIntervalSince1970 * 1000)
        let key = op == "bootstrap" ? viewer.publicKey : host.publicKey
        guard key.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: ScreenCommunityRequest.decodeBase64(value.signature)), for: Data("agentstoz.screen-community.request/v1\0".utf8) + bytes) else { throw ScreenCommunityError.invalidSignature }
        operations.append(op)
        let row: [Any] = [enrollment, device, "Mac3", ScreenCommunityRequest.key(host), ScreenCommunityRequest.key(viewer), "control", true, 1, at, NSNull(), "mac"]
        if op == "bootstrap" {
            guard let proof = value.hostSignature, host.publicKey.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: ScreenCommunityRequest.decodeBase64(proof)), for: Data("agentstoz.screen-community.request/v1\0".utf8) + bytes) else { throw ScreenCommunityError.invalidSignature }
            original = try envelope([1, "member", id, at, community, profile] + row + [at + 2_592_000_000])
            throw URLError(.networkConnectionLost)
        }
        let answer: ScreenCommunityEnvelope
        if op == "receipt", let original {
            let originalID = try XCTUnwrap((fields[6] as? [String])?.first)
            answer = try envelope([1, "receipt", id, at, originalID, ["payload": original.payload, "signature": original.signature]])
        } else if op == "directory" {
            answer = try envelope([1, "directory", id, at, community, profile, "Community", 1, at + 90_000, enrollment, [row]])
        } else { throw ScreenCommunityError.malformed }
        return try ScreenCommunityResponse.verify(answer, issuer: issuer.publicKey, expectedRequestID: id, now: now)
    }
}
private actor CommunityClientFixture {
    let issuer = P256.Signing.PrivateKey()
    let host: CommunitySoftwareSigner
    let viewer: CommunitySoftwareSigner
    let profile: String
    let device: String
    let community = UUID().uuidString.lowercased()
    let enrollment = UUID().uuidString.lowercased()
    let now: Date
    var operations: [String] = []
    var revision: Int64 = 2
    var lostLeave: ScreenCommunityEnvelope?
    var wrongReceipt = false
    func mismatchReceipt() { wrongReceipt = true }
    func clearReceiptMismatch() { wrongReceipt = false }
    init(host: CommunitySoftwareSigner, viewer: CommunitySoftwareSigner, profile: String, device: String, now: Date) {
        self.host = host; self.viewer = viewer; self.profile = profile; self.device = device; self.now = now
    }
    func publicIssuer() -> P256.Signing.PublicKey { issuer.publicKey }
    func lowerRevision() { revision = 1 }
    func exchange(_ envelope: ScreenCommunityEnvelope, id: String) throws -> ScreenCommunityResponse {
        let bytes = try ScreenCommunityRequest.decodeBase64(envelope.payload)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: ScreenCommunityRequest.decodeBase64(envelope.signature))
        guard host.publicKey.isValidSignature(signature, for: Data("agentstoz.screen-community.request/v1\0".utf8) + bytes),
              let request = try JSONSerialization.jsonObject(with: bytes) as? [Any], request[2] as? String == id,
              let op = request[1] as? String else { throw ScreenCommunityError.invalidSignature }
        operations.append(op)
        if op == "entry" { throw URLError(.networkConnectionLost) } // The request may already have committed.
        let at = Int64(now.timeIntervalSince1970 * 1000)
        let row: [Any] = [enrollment, device, "iPad", ScreenCommunityRequest.key(host), ScreenCommunityRequest.key(viewer), "none", true, 1, at, NSNull(), "ios"]
        let fields: [Any]
        if op == "leave" {
            let payload = try JSONSerialization.data(withJSONObject: [1, "revoked", id, at, community, revision + 1, enrollment])
            lostLeave = ScreenCommunityEnvelope(payload: ScreenCommunityRequest.base64(payload), signature: ScreenCommunityRequest.base64(try issuer.signature(for: Data("agentstoz.screen-community.response/v1\0".utf8) + payload).rawRepresentation))
            throw URLError(.networkConnectionLost)
        }
        if op == "receipt", let lostLeave {
            let originalID = (request[6] as? [String])?.first ?? ""
            fields = [1, "receipt", id, at, wrongReceipt ? UUID().uuidString.lowercased() : originalID,
                      ["payload": lostLeave.payload, "signature": lostLeave.signature]]
        }
        else if op == "receipt" || op == "recover" { fields = [1, "member", id, at, community, profile] + row + [at + 2_592_000_000] }
        else if op == "directory" { fields = [1, "directory", id, at, community, profile, "Community", revision, at + 90_000, enrollment, [row]] }
        else { throw ScreenCommunityError.malformed }
        let payload = try JSONSerialization.data(withJSONObject: fields)
        let signed = try issuer.signature(for: Data("agentstoz.screen-community.response/v1\0".utf8) + payload)
        return try ScreenCommunityResponse.verify(ScreenCommunityEnvelope(payload: ScreenCommunityRequest.base64(payload), signature: ScreenCommunityRequest.base64(signed.rawRepresentation)),
                                                  issuer: issuer.publicKey, expectedRequestID: id, now: now)
    }
}
final class ScreenCommunityClientChecks: XCTestCase {
    func testFirstAdministratorLostReplyRecoversAndProvisionsBeforeDirectorySignature() async throws {
        let host = CommunitySoftwareSigner(), viewer = CommunitySoftwareSigner(), now = Date()
        let profile = UUID().uuidString.lowercased(), device = UUID().uuidString.lowercased()
        let provisioned = OSAllocatedUnfairLock(initialState: false)
        let remote = FirstHostFixture(host: host, viewer: viewer, profile: profile, device: device, now: now)
        let authority = try ScreenCommunityAuthority(origin: URL(string: "https://fixture.workers.dev")!, issuer: await remote.publicIssuer(), profileID: profile)
        let saved = OSAllocatedUnfairLock<ScreenCommunityEnrollmentState?>(initialState: nil)
        let model = try ScreenCommunityEnrollment(authority: authority, device: ScreenCommunityDevice(id: device, name: "Mac3", platform: "mac", grant: .control),
            identity: FirstHostSigner(signer: host, provisioned: provisioned), viewerKey: viewer.publicKey.x963Representation, state: nil,
            save: { value in saved.withLock { $0 = value } }, exchange: { try await remote.exchange($0, id: $1) }, now: { now })
        do { try await model.createCommunity(name: "Community", approvedSigner: viewer); XCTFail("the committed reply was lost") } catch {}
        let pending = try XCTUnwrap(saved.withLock { $0 }); XCTAssertTrue(pending.uncertainMutation)
        try await model.recover()
        let restored = await model.snapshot(); XCTAssertFalse(restored.uncertainMutation); XCTAssertNotNil(restored.certificate)
        do { _ = try await model.directory(); XCTFail("the host has not been provisioned") } catch {}
        let lease = try await model.directory(prepareHost: { certificate in
            XCTAssertEqual(certificate.member.deviceID, device)
            provisioned.withLock { $0 = true }
        })
        XCTAssertEqual(lease.members.count, 1)
        let operations = await remote.operations
        XCTAssertEqual(operations, ["bootstrap", "receipt", "directory"])
    }
    func testKeyPreparationAloneDoesNotPollAndUnknownReceiptPollingHasABound() async throws {
        let host = CommunitySoftwareSigner(), viewer = CommunitySoftwareSigner(), now = Date()
        var state = ScreenCommunityEnrollmentState(deviceID: UUID().uuidString.lowercased(), hostKey: host.publicKey.x963Representation, viewerKey: viewer.publicKey.x963Representation)
        XCTAssertNil(state.automaticRefreshInterval(at: now))
        let request = try ScreenCommunityRequest(operation: .entry, actor: nil, arguments: [], now: now)
        state.submittedID = request.id; state.submittedEnvelope = try await request.signed(by: host); state.uncertainMutation = true
        XCTAssertEqual(state.automaticRefreshInterval(at: now), 3)
        XCTAssertNil(state.automaticRefreshInterval(at: now.addingTimeInterval(601)))
        XCTAssertTrue(state.uncertainMutation); XCTAssertEqual(state.submittedID, request.id)
    }
    func testLeavePersistsLocalStopAndRecoversOriginalRevocationWithoutReexecution() async throws {
        let host = CommunitySoftwareSigner(), viewer = CommunitySoftwareSigner(), profile = UUID().uuidString.lowercased(), device = UUID().uuidString.lowercased(), now = Date()
        let remote = CommunityClientFixture(host: host, viewer: viewer, profile: profile, device: device, now: now)
        let authority = try ScreenCommunityAuthority(origin: URL(string: "https://fixture.workers.dev")!, issuer: await remote.publicIssuer(), profileID: profile)
        let saved = OSAllocatedUnfairLock<ScreenCommunityEnrollmentState?>(initialState: nil)
        let model = try ScreenCommunityEnrollment(authority: authority, device: ScreenCommunityDevice(id: device, name: "iPad", platform: "ios", grant: .none),
            identity: host, viewerKey: viewer.publicKey.x963Representation, state: nil, save: { state in saved.withLock { $0 = state } },
            exchange: { try await remote.exchange($0, id: $1) }, now: { now })
        try await model.recover()
        do { try await model.leave(); XCTFail("lost leave reply") } catch {}
        let state = await model.snapshot(); XCTAssertTrue(state.locallyLeft == true); XCTAssertTrue(state.uncertainMutation)
        do { _ = try await model.certificate(); XCTFail("local outgoing access must stay off") } catch {}
        await remote.mismatchReceipt()
        do { try await model.recover(); XCTFail("wrong original ID") } catch {}
        let fenced = await model.snapshot(); XCTAssertTrue(fenced.uncertainMutation)
        // A new process uses the same durable request and exact identity; it does not issue another leave.
        let restored = try ScreenCommunityEnrollment(authority: authority, device: ScreenCommunityDevice(id: device, name: "iPad", platform: "ios", grant: .none),
            identity: host, viewerKey: viewer.publicKey.x963Representation, state: fenced, save: { state in saved.withLock { $0 = state } },
            exchange: { try await remote.exchange($0, id: $1) }, now: { now })
        await remote.clearReceiptMismatch()
        try await restored.recover()
        let recovered = await restored.snapshot(); XCTAssertNil(recovered.certificate); XCTAssertFalse(recovered.uncertainMutation); XCTAssertTrue(recovered.locallyLeft == true)
        let operations = await remote.operations; XCTAssertEqual(operations.filter { $0 == "leave" }.count, 1)
    }
    func testLostReplyIsPersistedAndRecoveredWithoutASecondEntry() async throws {
        let host = CommunitySoftwareSigner(), viewer = CommunitySoftwareSigner(), profile = UUID().uuidString.lowercased(), device = UUID().uuidString.lowercased(), now = Date()
        let remote = CommunityClientFixture(host: host, viewer: viewer, profile: profile, device: device, now: now)
        let authority = try ScreenCommunityAuthority(origin: URL(string: "https://fixture.workers.dev")!, issuer: await remote.publicIssuer(), profileID: profile)
        let saved = OSAllocatedUnfairLock<ScreenCommunityEnrollmentState?>(initialState: nil)
        let model = try ScreenCommunityEnrollment(authority: authority, device: ScreenCommunityDevice(id: device, name: "iPad", platform: "ios", grant: .none),
            identity: host, viewerKey: viewer.publicKey.x963Representation, state: nil, save: { state in saved.withLock { $0 = state } },
            exchange: { try await remote.exchange($0, id: $1) }, now: { now })
        do { try await model.join(communityID: await remote.community); XCTFail("lost transport") } catch {}
        let persisted = try XCTUnwrap(saved.withLock { $0 })
        XCTAssertTrue(persisted.uncertainMutation); XCTAssertNotNil(persisted.submittedEnvelope)
        do { try await model.join(communityID: await remote.community); XCTFail("must not create a new request") } catch {}
        let operationsBefore = await remote.operations; XCTAssertEqual(operationsBefore, ["entry"])
        // Simulate a process restart with exactly the persisted account and keys.
        let restored = try ScreenCommunityEnrollment(authority: authority, device: ScreenCommunityDevice(id: device, name: "iPad", platform: "ios", grant: .none),
            identity: host, viewerKey: viewer.publicKey.x963Representation, state: persisted, save: { state in saved.withLock { $0 = state } },
            exchange: { try await remote.exchange($0, id: $1) }, now: { now })
        try await restored.recover()
        let operations = await remote.operations; XCTAssertEqual(operations, ["entry", "receipt"])
        let certificate = try await restored.certificate(); XCTAssertEqual(certificate.member.platform, "ios")
        let state = await restored.snapshot(); XCTAssertFalse(state.uncertainMutation); XCTAssertEqual(state.submittedID, persisted.submittedID)
        _ = try await restored.directory()
        await remote.lowerRevision()
        do { _ = try await restored.directory(); XCTFail("a lower membership revision must not replace the current view") } catch {}
    }
    func testFailedPreDispatchPersistenceSendsNothingAndDoesNotFenceAnUnsentRequest() async throws {
        enum StorageError: Error { case unavailable }
        let host = CommunitySoftwareSigner(), viewer = CommunitySoftwareSigner(), profile = UUID().uuidString.lowercased(), device = UUID().uuidString.lowercased()
        let sends = OSAllocatedUnfairLock(initialState: 0)
        let authority = try ScreenCommunityAuthority(origin: URL(string: "https://fixture.workers.dev")!, issuer: P256.Signing.PrivateKey().publicKey, profileID: profile)
        let model = try ScreenCommunityEnrollment(authority: authority, device: ScreenCommunityDevice(id: device, name: "iPad", platform: "ios", grant: .none), identity: host,
            viewerKey: viewer.publicKey.x963Representation, state: nil, save: { _ in throw StorageError.unavailable }, exchange: { _, _ in
                sends.withLock { $0 += 1 }; throw ScreenCommunityError.malformed
            })
        do { try await model.join(communityID: UUID().uuidString.lowercased()); XCTFail("storage failed") } catch {}
        XCTAssertEqual(sends.withLock { $0 }, 0)
        let state = await model.snapshot(); XCTAssertFalse(state.uncertainMutation); XCTAssertNil(state.submittedID)
    }
}
#endif
