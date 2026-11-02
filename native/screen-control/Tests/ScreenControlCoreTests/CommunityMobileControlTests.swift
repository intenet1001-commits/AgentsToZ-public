#if !CORE_CHECKS
import Foundation
import CryptoKit
import XCTest
@testable import ScreenControlCore

final class CommunityMobileControlTests: XCTestCase {
    struct Fixture {
        let raw: [String: Any], authority: ScreenCommunityAuthority, mobile: CommunityAuthorization, receiver: CommunityAuthorization, use: CommunityUseSession, transcript: CommunityMobileControlTranscript, now: Date
        init() throws {
            let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/community-mobile-control-v2.json")
            raw = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any]
            let a = raw["authority"] as! [String: String]
            authority = try ScreenCommunityAuthority(origin: URL(string: a["origin"]!)!, issuer: CommunityMobileControlBytes.key(a["issuerPublicKey"]!), profileID: a["profileId"]!)
            now = Date(timeIntervalSince1970: (raw["now"] as! NSNumber).doubleValue / 1_000)
            let e = raw["envelopes"] as! [String: Any]
            func envelope(_ key: String) throws -> ScreenCommunityEnvelope { try JSONDecoder().decode(ScreenCommunityEnvelope.self, from: CommunityMobileControlBytes.json(e[key]!)) }
            mobile = try CommunityAccessReply.verify(envelope("mobile"), authority: authority, now: now).authorization(authority: authority, now: now)
            receiver = try CommunityAccessReply.verify(envelope("receiver"), authority: authority, now: now).authorization(authority: authority, now: now)
            use = try CommunityAccessReply.verify(envelope("use"), authority: authority, now: now).session(for: mobile, now: now)
            transcript = try CommunityMobileControlTranscript.decode(CommunityMobileControlBytes.json(raw["transcript"]!))
        }
        func signedUse(_ change: (inout [String: Any]) -> Void) throws -> CommunityUseSession {
            var body = raw["useSession"] as! [String: Any]; change(&body)
            let bytes = try CommunityMobileControlBytes.json([2,"session",use.body.sessionId,raw["now"]!,body])
            var scalar = Data(repeating: 0, count: 32); scalar[31] = 11
            let key = try P256.Signing.PrivateKey(rawRepresentation: scalar)
            let envelope = ScreenCommunityEnvelope(payload: ScreenCommunityRequest.base64(bytes), signature: ScreenCommunityRequest.base64(try key.signature(for: Data("agentstoz.community-access.response/v2\0".utf8) + bytes).rawRepresentation))
            return try CommunityAccessReply.verify(envelope, authority: authority, now: now).session(for: mobile, now: now)
        }
        func signedMobile(_ change: (inout [String: Any]) -> Void) throws -> CommunityAuthorization {
            var body = raw["mobileAuthorization"] as! [String: Any]; change(&body)
            let bytes = try CommunityMobileControlBytes.json([2,"authorization",UUID().uuidString.lowercased(),body["issuedAt"]!,body])
            var scalar = Data(repeating: 0, count: 32); scalar[31] = 11
            let key = try P256.Signing.PrivateKey(rawRepresentation: scalar)
            let envelope = ScreenCommunityEnvelope(payload: ScreenCommunityRequest.base64(bytes), signature: ScreenCommunityRequest.base64(try key.signature(for: Data("agentstoz.community-access.response/v2\0".utf8) + bytes).rawRepresentation))
            return try CommunityAccessReply.verify(envelope, authority: authority, now: now).authorization(authority: authority, now: now)
        }
    }
    func privateKey(_ scalar: UInt8) throws -> P256.KeyAgreement.PrivateKey { var bytes = Data(repeating: 0, count: 32); bytes[31] = scalar; return try P256.KeyAgreement.PrivateKey(rawRepresentation: bytes) }
    func text(_ value: Data) -> String { String(decoding: value, as: UTF8.self) }
    func testCommunityV2NameUsesIssuer120ByteBoundaryWithoutChangingLegacy64Bytes() {
        for size in [64,65,120] { XCTAssertTrue(CommunityAccessName.isValid(String(repeating: "a", count: size))) }
        XCTAssertFalse(CommunityAccessName.isValid(String(repeating: "a", count: 121)))
        XCTAssertTrue(CommunityAccessName.isValid(String(repeating: "가", count: 40)))
        XCTAssertFalse(CommunityAccessName.isValid(String(repeating: "가", count: 40) + "a"))
        XCTAssertTrue(CommunityAccessName.isValid("아젠투지3호 / 회사"))
        for value in ["", " a", "a ", "a\u{0}b", "a\u{1f}b", "a\u{7f}b", "a\u{85}b", "a\u{200b}b", "a\u{200d}b", "a\u{202e}b"] { XCTAssertFalse(CommunityAccessName.isValid(value)) }
        XCTAssertTrue(RegistrationInvite.isShowableName(String(repeating: "가", count: 21) + "a"))
        XCTAssertFalse(RegistrationInvite.isShowableName(String(repeating: "가", count: 21) + "ab"))
    }
    func testPolicyCanonicalTranscriptAndRoleProofsMatchNodeGolden() throws {
        let f = try Fixture(), t = f.transcript
        try t.validate(authority: f.authority, mobile: f.mobile, session: f.use, receiver: f.receiver, purpose: .agent, now: f.now)
        XCTAssertEqual(try text(t.canonicalBytes), f.raw["canonicalArrayUTF8"] as? String)
        XCTAssertEqual(try CommunityMobileControlBytes.hex(t.hash), f.raw["transcriptHashHex"] as? String)
        let proofs = f.raw["proofBytesHex"] as! [String: String], signatures = f.raw["signatures"] as! [String: String]
        for role in [CommunityMobileControlRole.client, .host] {
            XCTAssertEqual(try CommunityMobileControlBytes.hex(t.proofBytes(role: role)), proofs[role.rawValue])
            let key = try CommunityMobileControlBytes.key(role == .client ? f.use.body.publicKey : f.receiver.body.controlKey!)
            let sig = try P256.Signing.ECDSASignature(rawRepresentation: CommunityMobileControlBytes.decode(signatures[role.rawValue]!, bytes: 64))
            XCTAssertTrue(try key.isValidSignature(sig, for: t.proofBytes(role: role)))
            XCTAssertFalse(try key.isValidSignature(sig, for: t.proofBytes(role: role == .client ? .host : .client)))
        }
        let arrays = f.raw["policyArrays"] as! [String: Any]
        XCTAssertEqual(try CommunityMobileControlPolicy.authorizationDigest(f.mobile), try CommunityMobileControlBytes.hex(CommunityMobileControlBytes.hash(CommunityMobileControlBytes.json(arrays["mobile"]!))))
        XCTAssertTrue(try text(CommunityMobileControlBytes.json(arrays["receiver"]!)).contains("아젠투지3호 / 회사"))
    }
    func testRealECDHHKDFConfirmationsAndAEADMatchGoldenInBothDirections() throws {
        let f = try Fixture(), t = f.transcript
        let keys = try CommunityMobileControlKeys(privateKey: privateKey(1), transcript: t, role: .client)
        let expected = f.raw["derivedKeysHex"] as! [String: String]
        for (name,key) in [("client-to-host",keys.clientToHost),("host-to-client",keys.hostToClient),("client-confirm",keys.clientConfirm),("host-confirm",keys.hostConfirm)] { XCTAssertEqual(key.withUnsafeBytes { CommunityMobileControlBytes.hex(Data($0)) }, expected[name]) }
        let signatures = f.raw["signatures"] as! [String: String], confirms = f.raw["confirmations"] as! [String: String]
        let client = try CommunityMobileControlBytes.decode(signatures["client"]!, bytes: 64), host = try CommunityMobileControlBytes.decode(signatures["host"]!, bytes: 64)
        for (role,sig) in [(CommunityMobileControlRole.client,client),(.host,host)] {
            XCTAssertEqual(try ScreenCommunityRequest.base64(keys.confirmation(role: role, signature: sig)), confirms[role.rawValue])
            XCTAssertTrue(try keys.verifiesConfirmation(CommunityMobileControlBytes.decode(confirms[role.rawValue]!, bytes: 32), role: role, signature: sig))
        }
        XCTAssertEqual(try ScreenCommunityRequest.base64(keys.ready(clientSignature: client, hostSignature: host)), f.raw["readyConfirmation"] as? String)
        var sender = try CommunityMobileControlCipher(privateKey: privateKey(1), transcript: t, role: .client), receiver = try CommunityMobileControlCipher(privateKey: privateKey(2), transcript: t, role: .host)
        let record = f.raw["record"] as! [String: Any], plaintext = Data((record["plaintextUTF8"] as! String).utf8), request = record["requestId"] as! String
        let wire = try sender.seal(plaintext, requestID: request)
        XCTAssertEqual(try CommunityMobileControlJSON.object(wire, maximum: 40_000)["ciphertext"] as? String, record["ciphertext"] as? String)
        XCTAssertEqual(try receiver.open(wire, fromConnectionID: t.senderConnectionId).plaintext, plaintext)
        XCTAssertThrowsError(try receiver.open(wire, fromConnectionID: t.senderConnectionId))
        let response = try receiver.seal(CommunityMobileControlBytes.json(["v":1,"kind":"response","requestId":request,"result":"e30","resultDigest":String(repeating:"0",count:64)]), requestID: request)
        XCTAssertEqual(try sender.open(response, fromConnectionID: t.receiverConnectionId).requestID, request)
        sender.destroy(); XCTAssertThrowsError(try sender.seal(plaintext, requestID: request))
    }
    func testAlteredPurposeKeyEpochTargetSocketDuplicateFieldsAndCiphertextCannotPass() throws {
        let f = try Fixture(); var changed = f.raw["transcript"] as! [String: Any]
        for (key,value) in [("purpose","mobile-browser"),("receiverDeviceId",UUID().uuidString.lowercased()),("senderPolicyDigest",String(repeating:"0",count:64)),("senderUsePolicyDigest",String(repeating:"0",count:64)),("senderEphemeral",f.use.body.publicKey)] {
            changed = f.raw["transcript"] as! [String: Any]; changed[key] = value
            let t = try CommunityMobileControlTranscript.decode(CommunityMobileControlBytes.json(changed))
            XCTAssertThrowsError(try t.validate(authority: f.authority, mobile: f.mobile, session: f.use, receiver: f.receiver, purpose: .agent, now: f.now))
        }
        XCTAssertThrowsError(try CommunityMobileControlJSON.object(Data("{\"x\":1,\"\\u0078\":2}".utf8), maximum: 100))
        XCTAssertThrowsError(try CommunityMobileControlJSON.object(Data("{\"nested\":{\"x\":1,\"x\":2}}".utf8), maximum: 100))
        let r = f.raw["record"] as! [String: Any], wire = try CommunityMobileControlBytes.json(r["wire"]!)
        var receiver = try CommunityMobileControlCipher(privateKey: privateKey(2), transcript: f.transcript, role: .host)
        XCTAssertThrowsError(try receiver.open(wire, fromConnectionID: UUID().uuidString.lowercased()))
        var altered = r["wire"] as! [String: Any]; let cipher = altered["ciphertext"] as! String; altered["ciphertext"] = (cipher.first == "A" ? "B" : "A") + cipher.dropFirst()
        XCTAssertThrowsError(try receiver.open(CommunityMobileControlBytes.json(altered), fromConnectionID: f.transcript.senderConnectionId))
    }
    func testShorterIdleIsValidButExceededOrExpiredUseIsRejectedWithoutChangingStableHash() throws {
        let f = try Fixture(), short = try f.signedUse { $0["idleExpiresAt"] = (f.raw["now"] as! NSNumber).int64Value + 1_800_000 }
        XCTAssertEqual(try CommunityMobileControlPolicy.useDigest(authority: f.authority, authorization: f.mobile, session: short), f.transcript.senderUsePolicyDigest)
        XCTAssertNoThrow(try f.transcript.validate(authority: f.authority, mobile: f.mobile, session: short, receiver: f.receiver, purpose: .agent, now: f.now))
        XCTAssertThrowsError(try f.signedUse { $0["idleExpiresAt"] = (f.raw["now"] as! NSNumber).int64Value + 3_600_001 })
        XCTAssertThrowsError(try f.signedUse { $0["expiresAt"] = f.raw["now"] })
        XCTAssertThrowsError(try f.signedUse { $0["publicKey"] = f.mobile.body.publicKey })
    }
    func testUUIDv7TimestampIsOriginalAndAdmissionWindowDoesNotChangeReceiptIdentity() throws {
        let f = try Fixture(), operation = try CommunityMobileControlOperation.make(now: f.now)
        try operation.validate(); XCTAssertTrue(operation.isAdmissible(at: f.now.addingTimeInterval(30))); XCTAssertFalse(operation.isAdmissible(at: f.now.addingTimeInterval(30.001)))
        XCTAssertTrue(operation.isAdmissible(at: f.now.addingTimeInterval(-5))); XCTAssertFalse(operation.isAdmissible(at: f.now.addingTimeInterval(-5.001)))
        let golden = try JSONDecoder().decode(CommunityMobileControlOperation.self, from: CommunityMobileControlBytes.json(f.raw["effect"]!)); XCTAssertNoThrow(try golden.validate())
        var altered = f.raw["effect"] as! [String: Any]; altered["createdAt"] = golden.createdAt + 1
        XCTAssertThrowsError(try JSONDecoder().decode(CommunityMobileControlOperation.self, from: CommunityMobileControlBytes.json(altered)).validate())
        XCTAssertEqual(try JSONDecoder().decode(CommunityMobileControlOperation.self, from: JSONEncoder().encode(operation)), operation)
    }
    func testForwardedLeaseMayBe70SecondsOldButCannotBeMoreThan5SecondsInTheFuture() throws {
        let f = try Fixture()
        XCTAssertNoThrow(try f.transcript.validate(authority: f.authority, mobile: f.mobile, session: f.use, receiver: f.receiver, purpose: .agent, now: f.now.addingTimeInterval(70)))
        let original = (f.raw["now"] as! NSNumber).int64Value
        let future = try f.signedMobile { $0["issuedAt"] = original + 5_001; $0["expiresAt"] = original + 95_001 }
        XCTAssertThrowsError(try f.transcript.validate(authority: f.authority, mobile: future, session: f.use, receiver: f.receiver, purpose: .agent, now: f.now))
    }
}
#endif
