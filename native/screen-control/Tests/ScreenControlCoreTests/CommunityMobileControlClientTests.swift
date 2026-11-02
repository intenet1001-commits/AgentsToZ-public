#if !CORE_CHECKS
import Foundation
import CryptoKit
import XCTest
@testable import ScreenControlCore

private struct MobileClientFixture: @unchecked Sendable {
    let raw: [String:Any], context: CommunityMobileControlContext
    init() throws {
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/community-mobile-control-v2.json")
        raw = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String:Any]
        let a = raw["authority"] as! [String:String], now = Date(), at = Int64(now.timeIntervalSince1970 * 1000)
        let authority = try ScreenCommunityAuthority(origin: URL(string: a["origin"]!)!, issuer: CommunityMobileControlBytes.key(a["issuerPublicKey"]!), profileID: a["profileId"]!)
        func signed(_ kind: String, _ original: [String:Any]) throws -> CommunityAccessReply {
            var body = original; body["issuedAt"] = at; body["expiresAt"] = at + 90_000
            if kind == "session" { body["lastHumanAt"] = at; body["idleExpiresAt"] = at + 3_600_000 }
            let bytes = try CommunityMobileControlBytes.json([2,kind,kind == "session" ? body["sessionId"]! : UUID().uuidString.lowercased(),at,body])
            var scalar = Data(repeating: 0, count: 32); scalar[31] = 11
            let key = try P256.Signing.PrivateKey(rawRepresentation: scalar)
            let envelope = ScreenCommunityEnvelope(payload: ScreenCommunityRequest.base64(bytes), signature: ScreenCommunityRequest.base64(try key.signature(for: Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
            return try CommunityAccessReply.verify(envelope, authority: authority, now: now)
        }
        let mobile = try signed("authorization", raw["mobileAuthorization"] as! [String:Any]).authorization(authority: authority, now: now)
        let receiver = try signed("authorization", raw["receiverAuthorization"] as! [String:Any]).authorization(authority: authority, now: now)
        let use = try signed("session",raw["useSession"] as! [String:Any]).session(for: mobile, now: now)
        context = try CommunityMobileControlContext(authority: authority, mobile: mobile, session: use, receiver: receiver, purpose: .agent)
    }
}
private final class MobileClientGate: @unchecked Sendable {
    private let lock = NSLock(); private var allowed = true, signs = 0
    let context: CommunityMobileControlContext
    init(_ context: CommunityMobileControlContext) { self.context = context }
    func close() { lock.withLock { allowed = false } }
    func snapshot() throws -> CommunityMobileControlContext { try lock.withLock { guard allowed else { throw ScreenCommunityError.expired }; return context } }
    func sign(_ proof: CommunityMobileControlProof) throws -> Data {
        let current = try snapshot(); try proof.validate(current: current)
        lock.withLock { signs += 1 }; var scalar = Data(repeating: 0, count: 32); scalar[31] = 3
        return try P256.Signing.PrivateKey(rawRepresentation: scalar).signature(for: proof.bytes).rawRepresentation
    }
    var signCount: Int { lock.withLock { signs } }
}
private actor MobileClientFixtureWire: CommunityMobileControlWire {
    nonisolated let connectionID = UUID().uuidString.lowercased()
    let f: MobileClientFixture, badConfirmation: Bool, dropEffect: Bool
    var frames: [CommunityMobileControlRoutedFrame] = [], waiter: CheckedContinuation<CommunityMobileControlRoutedFrame,Error>?
    var t: CommunityMobileControlTranscript?, cipher: CommunityMobileControlCipher?, keys: CommunityMobileControlKeys?, hostProof: Data?
    var closed = false, effects = 0, consumed = 0, responses: [String:Data] = [:]
    init(_ f: MobileClientFixture, badConfirmation: Bool = false, dropEffect: Bool = false) { self.f = f; self.badConfirmation = badConfirmation; self.dropEffect = dropEffect }
    func receive() async throws -> CommunityMobileControlRoutedFrame {
        guard !closed else { throw TransportError.closed }; if !frames.isEmpty { return frames.removeFirst() }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    private func push(_ payload: Data) { pushFrame(.data(deviceID: f.context.receiver.body.deviceId, connectionID: t!.receiverConnectionId, payload: payload)) }
    private func pushFrame(_ frame: CommunityMobileControlRoutedFrame) { if let waiter { self.waiter = nil; waiter.resume(returning: frame) } else { frames.append(frame) } }
    func send(to deviceID: String, payload: Data) async throws {
        guard !closed, deviceID == f.context.receiver.body.deviceId else { throw TransportError.closed }
        let value = try CommunityMobileControlJSON.object(payload, maximum: 40_000)
        switch value["type"] as? String {
        case "hello":
            XCTAssertTrue(value["receiverConnectionId"] is NSNull)
            var transcript = f.raw["transcript"] as! [String:Any]
            for field in ["channelId","senderConnectionId","senderEphemeral","senderNonce"] { transcript[field] = value[field] }
            let t = try CommunityMobileControlTranscript.decode(CommunityMobileControlBytes.json(transcript)); self.t = t
            try t.validate(authority: f.context.authority, mobile: f.context.mobile, session: f.context.session, receiver: f.context.receiver, purpose: .agent)
            var scalar = Data(repeating: 0, count: 32); scalar[31] = 2
            let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar)
            let cipher = try CommunityMobileControlCipher(privateKey: key, transcript: t, role: .host); self.cipher = cipher; keys = cipher.keys
            scalar[31] = 4; let proof = try P256.Signing.PrivateKey(rawRepresentation: scalar).signature(for: t.proofBytes(role: .host)).rawRepresentation; hostProof = proof
            push(try CommunityMobileControlBytes.json(["v":2,"type":"challenge","transcript":transcript,"receiverAuthorization":JSONSerialization.jsonObject(with: JSONEncoder().encode(f.context.receiver.envelope)),"hostProof":ScreenCommunityRequest.base64(proof),"hostConfirmation":ScreenCommunityRequest.base64(badConfirmation ? Data(repeating:0,count:32) : keys!.confirmation(role:.host,signature:proof))]))
        case "finish":
            let proof = try CommunityMobileControlBytes.decode(value["clientProof"] as! String, bytes: 64)
            XCTAssertTrue(try CommunityMobileControlBytes.key(f.context.session.body.publicKey).isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: proof), for: t!.proofBytes(role: .client)))
            XCTAssertTrue(try keys!.verifiesConfirmation(CommunityMobileControlBytes.decode(value["clientConfirmation"] as! String, bytes:32), role:.client,signature:proof))
            push(try CommunityMobileControlBytes.json(["v":2,"type":"ready","channelId":t!.channelId,"confirmation":ScreenCommunityRequest.base64(keys!.ready(clientSignature:proof,hostSignature:hostProof!))]))
        case "record":
            var cipher = self.cipher!; let opened = try cipher.open(payload, fromConnectionID: connectionID)
            let packet = try CommunityMobileControlJSON.object(opened.plaintext, maximum: 24_000), mode = packet["mode"] as! String
            let result: Data
            if mode == "effect" {
                effects += 1; result = try CommunityMobileControlBytes.json(["outcome":"accepted","operationId":packet["operationId"]!]); responses[packet["operationId"] as! String] = result
                if dropEffect { self.cipher = cipher; pushFrame(.ended(deviceID: f.context.receiver.body.deviceId, connectionID:t!.receiverConnectionId)); return }
            } else if mode == "consumed" { consumed += 1; result = try CommunityMobileControlBytes.json(["outcome":"consumed"]) }
            else if mode == "receipt" { result = try responses[packet["operationId"] as! String] ?? CommunityMobileControlBytes.json(["outcome":"unseen"]) }
            else { result = try CommunityMobileControlBytes.json(["outcome":"capabilities","purpose":"mobile-agent","commands":[["op":"targets","mode":"query","label":"대상 목록"]]]) }
            let bytes = try CommunityMobileControlBytes.json(["v":1,"kind":"response","requestId":opened.requestID,"result":ScreenCommunityRequest.base64(result),"resultDigest":CommunityMobileControlBytes.hex(CommunityMobileControlBytes.hash(result))])
            let sealed = try cipher.seal(bytes, requestID: opened.requestID); self.cipher = cipher; push(sealed)
        default: throw TransportError.badFrame
        }
    }
    func close() { closed = true; waiter?.resume(throwing: TransportError.closed); waiter = nil; frames = []; cipher?.destroy(); cipher = nil }
}

final class CommunityMobileControlClientTests: XCTestCase {
    func testFullRealKeyConfirmationRecordAndExplicitDurableConsumedPath() async throws {
        let f = try MobileClientFixture(), gate = MobileClientGate(f.context), wire = MobileClientFixtureWire(f)
        let client = try await CommunityMobileControlClient.connect(context:f.context,wire:wire,current:{try gate.snapshot()},signer:{try gate.sign($0)})
        let caps = try await client.request(.capabilities(purpose:.agent)); XCTAssertTrue(String(decoding:caps.result,as:UTF8.self).contains("capabilities"))
        let op = try CommunityMobileControlOperation.make(), command = try CommunityMobileControlBytes.json(["kind":"agent","op":"submit"])
        let result = try await client.request(.effect(purpose:.agent,operation:op,command:command))
        let before = await wire.consumed; XCTAssertEqual(before,0,"a channel does not consume on behalf of the upper durable journal")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString); defer { try? FileManager.default.removeItem(at:file) }
        try result.result.write(to:file,options:.atomic); XCTAssertEqual(try Data(contentsOf:file),result.result)
        _ = try await client.request(.consumed(operation:op,resultDigest:result.resultDigest)); let after = await wire.consumed; XCTAssertEqual(after,1)
        XCTAssertEqual(gate.signCount,1); await client.close()
    }
    func testBadHostConfirmationCannotObtainTheMobileProof() async throws {
        let f = try MobileClientFixture(), gate = MobileClientGate(f.context), wire = MobileClientFixtureWire(f,badConfirmation:true)
        do { _ = try await CommunityMobileControlClient.connect(context:f.context,wire:wire,current:{try gate.snapshot()},signer:{try gate.sign($0)}); XCTFail("must reject") } catch {}
        XCTAssertEqual(gate.signCount,0)
    }
    func testRetainedClientCannotSendAfterTheCommonEpisodeFenceCloses() async throws {
        let f = try MobileClientFixture(), gate = MobileClientGate(f.context), wire = MobileClientFixtureWire(f)
        let client = try await CommunityMobileControlClient.connect(context:f.context,wire:wire,current:{try gate.snapshot()},signer:{try gate.sign($0)})
        gate.close(); do { _ = try await client.request(.capabilities(purpose:.agent)); XCTFail("must reject") } catch {}
        let closed = await wire.closed; XCTAssertTrue(closed); let runs = await wire.effects; XCTAssertEqual(runs,0)
    }
    func testUnknownEffectNeverRunsAgainOrSendsConsumedAutomatically() async throws {
        let f = try MobileClientFixture(), gate = MobileClientGate(f.context), wire = MobileClientFixtureWire(f,dropEffect:true)
        let client = try await CommunityMobileControlClient.connect(context:f.context,wire:wire,current:{try gate.snapshot()},signer:{try gate.sign($0)})
        let op = try CommunityMobileControlOperation.make(), command = try CommunityMobileControlBytes.json(["kind":"agent","op":"submit"])
        do { _ = try await client.request(.effect(purpose:.agent,operation:op,command:command)); XCTFail("must be unknown") }
        catch CommunityMobileControlClientError.unknown {} catch { XCTFail("wrong outcome: \(error)") }
        let count = await wire.effects, consumed = await wire.consumed; XCTAssertEqual(count,1); XCTAssertEqual(consumed,0)
        await client.close()
    }
}

private final class MobileJournalMemory: CommunityMobileControlJournalBackend, @unchecked Sendable {
    private let lock = NSLock(); var bytes: Data?; var fail = false
    func read() throws -> Data? { lock.withLock { bytes } }
    func write(_ value: Data) throws { try lock.withLock { if fail { throw ScreenCommunityError.service("FIXTURE_WRITE_FAILED") }; bytes = value } }
}
final class CommunityMobileControlJournalTests: XCTestCase {
    func testPreparedUnknownAndConsumedAreDurableAndNeverAuthorizeAReplay() throws {
        let f = try MobileClientFixture(), memory = MobileJournalMemory(), journal = CommunityMobileControlJournal(backend:memory)
        let op = try CommunityMobileControlOperation.make(), command = try CommunityMobileControlBytes.json(["kind":"agent","op":"submit"])
        let record = try journal.prepare(operation:op,context:f.context,command:command)
        XCTAssertThrowsError(try journal.prepare(operation:op,context:f.context,command:command))
        try journal.markUnknown(record.id,ownerHash:record.ownerHash)
        let restored = CommunityMobileControlJournal(backend:memory)
        XCTAssertEqual(try restored.records(ownerHash:record.ownerHash).first?.phase,.unknown)
        XCTAssertThrowsError(try restored.forgetConsumed(record.id,ownerHash:record.ownerHash))
        let result = try CommunityMobileControlBytes.json(["outcome":"accepted","contextId":"fixture-context"]), digest = CommunityMobileControlBytes.hex(CommunityMobileControlBytes.hash(result)), request=UUID().uuidString.lowercased()
        let response = try CommunityMobileControlResponse.decode(CommunityMobileControlBytes.json(["v":1,"kind":"response","requestId":request,"result":ScreenCommunityRequest.base64(result),"resultDigest":digest]),expectedRequestID:request)
        try restored.receive(record.id,ownerHash:record.ownerHash,response:response,terminal:true)
        XCTAssertEqual(try journal.records(ownerHash:record.ownerHash).first?.result,result)
        try restored.markConsumed(record.id,ownerHash:record.ownerHash,resultDigest:digest)
        try restored.forgetConsumed(record.id,ownerHash:record.ownerHash)
        XCTAssertTrue(try journal.records(ownerHash:record.ownerHash).isEmpty)
    }
    func testStoreFailureAndCorruptionCannotBeTreatedAsANewJournal() throws {
        let f = try MobileClientFixture(), memory = MobileJournalMemory(), journal = CommunityMobileControlJournal(backend:memory)
        memory.fail=true; XCTAssertThrowsError(try journal.prepare(operation:.make(),context:f.context,command:CommunityMobileControlBytes.json(["kind":"agent","op":"submit"])))
        memory.fail=false;memory.bytes=Data("{broken".utf8)
        XCTAssertThrowsError(try journal.records(ownerHash:String(repeating:"0",count:64)))
        XCTAssertThrowsError(try journal.prepare(operation:.make(),context:f.context,command:CommunityMobileControlBytes.json(["kind":"agent","op":"submit"])))
    }
}
#endif
