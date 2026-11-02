#if !CORE_CHECKS
import XCTest
import Foundation
import CryptoKit
@testable import ScreenControlCore

final class CommunityAccessChecks: XCTestCase {
    private struct Fixture {
        let issuer = P256.Signing.PrivateKey(), host = P256.Signing.PrivateKey(), biometric = P256.Signing.PrivateKey(), operation = P256.Signing.PrivateKey()
        let profile = UUID().uuidString.lowercased(), device = UUID().uuidString.lowercased(), community = UUID().uuidString.lowercased(), enrollment = UUID().uuidString.lowercased()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var at: Int64 { Int64(now.timeIntervalSince1970 * 1000) }
        var authority: ScreenCommunityAuthority { try! ScreenCommunityAuthority(origin: URL(string: "https://fixture.workers.dev")!, issuer: issuer.publicKey, profileID: profile) }
        var authorization: [String: Any] {
            ["version": 1, "communityId": community, "profileId": profile, "enrollmentId": enrollment, "deviceId": device, "deviceKind": "mobile",
             "name": "iPad", "hostPublicKey": ScreenCommunityRequest.base64(host.publicKey.x963Representation), "controlKey": NSNull(), "agentDeviceId": NSNull(), "publicKey": ScreenCommunityRequest.base64(operation.publicKey.x963Representation), "biometricPublicKey": ScreenCommunityRequest.base64(biometric.publicKey.x963Representation),
             "capabilities": ["screen.view", "screen.control", "teams.run"], "revision": 3, "keyEpoch": 1, "issuedAt": at, "expiresAt": at + 90_000]
        }
        func signed(_ kind: String, _ value: Any, domain: String = "agentstoz.community-access.response/v2\0") throws -> ScreenCommunityEnvelope {
            let data = try JSONSerialization.data(withJSONObject: [2, kind, UUID().uuidString.lowercased(), at, value])
            let signature = try issuer.signature(for: Data(domain.utf8) + data)
            return ScreenCommunityEnvelope(payload: ScreenCommunityRequest.base64(data), signature: ScreenCommunityRequest.base64(signature.rawRepresentation))
        }
        func reply(_ kind: String, _ value: Any) throws -> CommunityAccessReply { try .verify(signed(kind, value), authority: authority, now: now) }
    }
    func testCapabilityPlanDigestMatchesWorkerIncludingKoreanName() throws {
        struct Vector: Decodable { let plan: CommunityAccessPlan; let digest: String }
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "Fixtures/community-access-v2.json")
        let vector = try JSONDecoder().decode(Vector.self, from: Data(contentsOf: path))
        XCTAssertEqual(try vector.plan.digest, vector.digest)
        XCTAssertThrowsError(try CommunityAccessPlan(profileId: vector.plan.profileId, deviceId: vector.plan.deviceId, name: vector.plan.name, kind: .mobile,
            hostKey: AccessValue.key(vector.plan.hostKey), biometricKey: AccessValue.key(vector.plan.biometricKey), operationKey: AccessValue.key(vector.plan.operationKey), capabilities: [.receiveView]))
    }
    func testIssuerDomainExpiryAndUnknownFieldsAreFailClosed() throws {
        let f = Fixture()
        let accepted = try f.reply("authorization", f.authorization).authorization(authority: f.authority, now: f.now)
        XCTAssertEqual(accepted.body.capabilities, [.screenView, .screenControl, .teams])
        XCTAssertFalse(accepted.isCurrent(at: f.now.addingTimeInterval(90)))
        let oldDomain = try f.signed("authorization", f.authorization, domain: "agentstoz.screen-community.response/v1\0")
        XCTAssertThrowsError(try CommunityAccessReply.verify(oldDomain, authority: f.authority, now: f.now))
        var modified = f.authorization; modified["admin"] = true
        XCTAssertThrowsError(try f.reply("authorization", modified).authorization(authority: f.authority, now: f.now))
        modified = f.authorization; modified["expiresAt"] = f.at + 90_001
        XCTAssertThrowsError(try f.reply("authorization", modified).authorization(authority: f.authority, now: f.now))
    }
    func testMobileSessionBindsTheGrantRevisionAndExactIdleDeadline() throws {
        let f = Fixture(), ephemeral = P256.Signing.PrivateKey()
        let auth = try f.reply("authorization", f.authorization).authorization(authority: f.authority, now: f.now)
        var body: [String: Any] = ["version": 1, "communityId": f.community, "enrollmentId": f.enrollment, "sessionId": UUID().uuidString.lowercased(),
            "publicKey": ScreenCommunityRequest.base64(ephemeral.publicKey.x963Representation), "capabilities": ["screen.view", "teams.run"],
            "revision": 3, "sequence": 0, "lastHumanAt": f.at, "idleExpiresAt": f.at + 3_600_000, "issuedAt": f.at, "expiresAt": f.at + 90_000]
        let session = try f.reply("session", body).session(for: auth, now: f.now)
        XCTAssertEqual(session.body.idleExpiresAt, f.at + 3_600_000)
        body["revision"] = 2
        XCTAssertThrowsError(try f.reply("session", body).session(for: auth, now: f.now))
        body["revision"] = 3; body["idleExpiresAt"] = f.at + 3_600_001
        XCTAssertThrowsError(try f.reply("session", body).session(for: auth, now: f.now))
        body["idleExpiresAt"] = f.at + 3_600_000; body["capabilities"] = ["screen.view", "computer-use.browser"]
        XCTAssertThrowsError(try f.reply("session", body).session(for: auth, now: f.now))
    }
    func testWrongProfileAndBooleansInNumericFieldsDoNotCreateAuthority() throws {
        let f = Fixture(); var body = f.authorization
        body["profileId"] = UUID().uuidString.lowercased()
        XCTAssertThrowsError(try f.reply("authorization", body).authorization(authority: f.authority, now: f.now))
        body = f.authorization; body["revision"] = true
        XCTAssertThrowsError(try f.reply("authorization", body).authorization(authority: f.authority, now: f.now))
    }
}
#endif
