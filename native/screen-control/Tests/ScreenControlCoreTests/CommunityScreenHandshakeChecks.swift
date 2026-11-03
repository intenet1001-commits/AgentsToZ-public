#if !CORE_CHECKS
import XCTest
import Foundation
import CryptoKit
@testable import ScreenControlCore

final class CommunityScreenHandshakeChecks: XCTestCase {
    private struct Fixture: Sendable {
        let issuer = P256.Signing.PrivateKey(), host = SoftwareSigner(), client = SoftwareSigner(), mobile = SoftwareSigner()
        let profile = UUID().uuidString.lowercased(), community = UUID().uuidString.lowercased()
        let now = Date()
        var authority: ScreenCommunityAuthority { try! .init(origin: URL(string: "https://fixture.workers.dev")!, issuer: issuer.publicKey, profileID: profile) }
        func envelope(_ kind: String, _ value: Any) throws -> ScreenCommunityEnvelope {
            let bytes = try JSONSerialization.data(withJSONObject: [2, kind, UUID().uuidString.lowercased(), Int64(now.timeIntervalSince1970 * 1000), value])
            return .init(payload: ScreenCommunityRequest.base64(bytes), signature: ScreenCommunityRequest.base64(try issuer.signature(for: Data("agentstoz.community-access.response/v2\0".utf8) + bytes).rawRepresentation))
        }
        func authorization(hostKey: P256.Signing.PublicKey, operation: P256.Signing.PublicKey, kind: String, caps: [String]) throws -> CommunityAuthorization {
            let at = Int64(now.timeIntervalSince1970 * 1000)
            let body: [String: Any] = ["version": 1, "communityId": community, "profileId": profile, "enrollmentId": UUID().uuidString.lowercased(), "deviceId": UUID().uuidString.lowercased(),
                "name": "Software fixture", "deviceKind": kind, "hostPublicKey": ScreenCommunityRequest.base64(hostKey.x963Representation),
                "publicKey": ScreenCommunityRequest.base64(operation.x963Representation), "biometricPublicKey": ScreenCommunityRequest.base64(P256.Signing.PrivateKey().publicKey.x963Representation),
                "controlKey": NSNull(), "agentDeviceId": NSNull(), "capabilities": caps, "revision": 3, "keyEpoch": 1, "issuedAt": at, "expiresAt": at + 90_000]
            return try CommunityAccessReply.verify(envelope("authorization", body), authority: authority, now: now).authorization(authority: authority, now: now)
        }
        func session(_ auth: CommunityAuthorization) throws -> CommunityUseSession {
            let at = Int64(now.timeIntervalSince1970 * 1000)
            let value: [String: Any] = ["version": 1, "communityId": community, "enrollmentId": auth.body.enrollmentId, "sessionId": UUID().uuidString.lowercased(),
                "publicKey": ScreenCommunityRequest.base64(mobile.publicKey.x963Representation), "capabilities": ["screen.view", "screen.control"],
                "revision": 3, "sequence": 0, "lastHumanAt": at, "idleExpiresAt": at + 3_600_000, "issuedAt": at, "expiresAt": at + 90_000]
            return try CommunityAccessReply.verify(envelope("session", value), authority: authority, now: now).session(for: auth, now: now)
        }
        var binding: CommunityScreenBinding { try! .init(channelId: UUID().uuidString.lowercased(), clientConnectionId: UUID().uuidString.lowercased(), hostConnectionId: UUID().uuidString.lowercased()) }
    }
    func testDesktopAutomaticProofMakesMutuallyBoundEncryptedProtocolSixWithoutChangingLegacyVersions() async throws {
        let f = Fixture(), binding = f.binding
        let receiver = try f.authorization(hostKey: f.host.publicKey, operation: P256.Signing.PrivateKey().publicKey, kind: "desktop", caps: ["screen.receive.view", "screen.receive.control"])
        let client = try f.authorization(hostKey: P256.Signing.PrivateKey().publicKey, operation: f.client.publicKey, kind: "desktop", caps: ["screen.view", "screen.control"])
        let signer = try CommunityPurposeSigner(inner: f.client, authorization: client, capability: .screenView)
        let connector = try CommunityScreenClientHandshake(authority: f.authority, own: client, target: receiver, signer: signer,
            channelId: binding.channelId, connectionId: binding.clientConnectionId, requestedControl: true)
        let host = try CommunityScreenHostHandshake(authority: f.authority, own: receiver, signer: f.host, replay: .init()) { auth, session in
            guard auth.body == client.body, session == nil else { throw HandshakeError.unknownDevice }
        }
        let answer = try await host.respond(connector.hello, binding: binding)
        let finished = try await connector.finish(answer.message, peerConnectionId: binding.hostConnectionId)
        let server = try await answer.pending.confirm(finished.message)
        XCTAssertEqual(finished.channel.version, 6); XCTAssertTrue(finished.admission.canControl)
        XCTAssertNil(finished.admission.desktopTrust,"An old common registration cannot opt into device trust")
        XCTAssertEqual(try server.open(finished.channel.seal(.input, Data("fixture".utf8))).payload, Data("fixture".utf8))
        XCTAssertEqual(try finished.channel.open(server.seal(.video, Data([1, 2, 3]))).payload, Data([1, 2, 3]))
        do { _ = try await connector.finish(answer.message, peerConnectionId: binding.hostConnectionId); XCTFail("one use only") } catch HandshakeError.alreadyUsed { }
        XCTAssertEqual(ScreenControlProtocol.phoneVersion, 4); XCTAssertEqual(ScreenControlProtocol.version, 5)
    }
    func testExplicitBothDesktopTrustSurvivesRealKeyConfirmationAndKeepsRequestedViewOnly() async throws {
        let f=Fixture(),binding=f.binding
        let receiver=try f.authorization(hostKey:f.host.publicKey,operation:P256.Signing.PrivateKey().publicKey,kind:"desktop",caps:["screen.receive.view","screen.receive.control","screen.desktop-trust"])
        let client=try f.authorization(hostKey:P256.Signing.PrivateKey().publicKey,operation:f.client.publicKey,kind:"desktop",caps:["screen.view","screen.control","screen.desktop-trust"])
        for requestedControl in [false,true] {
            let connector=try CommunityScreenClientHandshake(authority:f.authority,own:client,target:receiver,signer:f.client,channelId:binding.channelId,connectionId:binding.clientConnectionId,requestedControl:requestedControl)
            let host=try CommunityScreenHostHandshake(authority:f.authority,own:receiver,signer:f.host,replay:.init()){auth,use in guard auth.body==client.body,use==nil else {throw HandshakeError.unknownDevice} }
            let answer=try await host.respond(connector.hello,binding:binding)
            let finish=try await connector.finish(answer.message,peerConnectionId:binding.hostConnectionId)
            let server=try await answer.pending.confirm(finish.message)
            XCTAssertEqual(finish.admission.canControl,requestedControl)
            let trust=try XCTUnwrap(finish.admission.desktopTrust)
            XCTAssertEqual(trust.channelId,binding.channelId);XCTAssertEqual(trust.controller,client.body);XCTAssertEqual(trust.receiver,receiver.body)
            XCTAssertEqual(answer.pending.admission.desktopTrust,trust)
            XCTAssertEqual(try server.open(finish.channel.seal(.input,Data("software only".utf8))).payload,Data("software only".utf8))
        }
    }
    func testMobileSessionKeyIsRequiredAndTransportConnectionSubstitutionFailsBeforeClientSigns() async throws {
        let f = Fixture(), binding = f.binding
        let receiver = try f.authorization(hostKey: f.host.publicKey, operation: P256.Signing.PrivateKey().publicKey, kind: "desktop", caps: ["screen.receive.view"])
        let client = try f.authorization(hostKey: P256.Signing.PrivateKey().publicKey, operation: f.client.publicKey, kind: "mobile", caps: ["screen.view", "screen.control"])
        let use = try f.session(client)
        XCTAssertThrowsError(try CommunityScreenClientHandshake(authority: f.authority, own: client, session: use, target: receiver, signer: f.client,
            channelId: binding.channelId, connectionId: binding.clientConnectionId, requestedControl: true))
        let connector = try CommunityScreenClientHandshake(authority: f.authority, own: client, session: use, target: receiver, signer: f.mobile,
            channelId: binding.channelId, connectionId: binding.clientConnectionId, requestedControl: true)
        let host = try CommunityScreenHostHandshake(authority: f.authority, own: receiver, signer: f.host, replay: .init()) { _, _ in }
        let answer = try await host.respond(connector.hello, binding: binding)
        do { _ = try await connector.finish(answer.message, peerConnectionId: UUID().uuidString.lowercased()); XCTFail("relay connection substitution") }
        catch HandshakeError.badSignature { }
        let second = try CommunityScreenClientHandshake(authority: f.authority, own: client, session: use, target: receiver, signer: f.mobile,
            channelId: binding.channelId, connectionId: binding.clientConnectionId, requestedControl: true)
        let next = try await host.respond(second.hello, binding: binding)
        let finished = try await second.finish(next.message, peerConnectionId: binding.hostConnectionId)
        XCTAssertFalse(finished.admission.canControl, "receiver view-only overrides mobile control selection")
        do { _ = try await next.pending.confirm(finished.message, now: f.now.addingTimeInterval(90)); XCTFail("expired authority") }
        catch ScreenCommunityError.expired { }
    }
    func testHostAdmissionAndScreenSignerNeverGrantUnselectedTeamsOrAdministrativeSignatures() async throws {
        let f = Fixture(), binding = f.binding
        let receiver = try f.authorization(hostKey: f.host.publicKey, operation: P256.Signing.PrivateKey().publicKey, kind: "desktop", caps: ["screen.receive.view"])
        let client = try f.authorization(hostKey: P256.Signing.PrivateKey().publicKey, operation: f.client.publicKey, kind: "desktop", caps: ["screen.view"])
        let signer = try CommunityPurposeSigner(inner: f.client, authorization: client, capability: .screenView)
        let connector = try CommunityScreenClientHandshake(authority: f.authority, own: client, target: receiver, signer: signer,
            channelId: binding.channelId, connectionId: binding.clientConnectionId, requestedControl: false)
        let host = try CommunityScreenHostHandshake(authority: f.authority, own: receiver, signer: f.host, replay: .init()) { _, _ in throw HandshakeError.unknownDevice }
        do { _ = try await host.respond(connector.hello, binding: binding); XCTFail("admission must run before host signs") } catch HandshakeError.unknownDevice { }
        let denied = try CommunityAccessRequest(operation: .relayTicket, actor: client.body.enrollmentId,
            argumentsJSON: JSONSerialization.data(withJSONObject: [f.community, "teams", UUID().uuidString.lowercased(), "client", NSNull()]))
        do { _ = try await denied.signed(by: signer); XCTFail("wrong purpose") } catch ScreenCommunityError.malformed { }
    }
}
#endif
