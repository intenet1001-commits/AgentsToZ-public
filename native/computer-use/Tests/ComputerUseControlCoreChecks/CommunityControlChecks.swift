import Foundation
import CryptoKit
#if !CORE_CHECKS
@testable import ComputerUseControlCore
import ComputerUseApproval
#endif

/// Software keys and in-memory saves only. No Keychain, TCC, XPC, real issuer or production action is touched.
enum CommunityControlChecks {
    static func testSharedSoftwareGolden() throws {
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("ControlContract/community-component-golden.json")
        guard let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any],
              let now = vector["now"] as? Int64, let issuer = vector["issuerPublicKey"] as? String,
              let profile = vector["profileId"] as? String, let sender = vector["sender"] as? [String: Any],
              let receiver = vector["receiver"] as? [String: Any], let senderEnvelope = sender["envelope"] as? [String: Any],
              let receiverEnvelope = receiver["envelope"] as? [String: Any], let transcript = vector["transcript"] as? [String: Any] else { throw ApprovalError.invalidPayload }
        let authority = CommunityControlAuthority(issuer: try P256.Signing.PublicKey(x963Representation: CommunityControlLease.decodeURL(issuer)), profileID: profile)
        let own = try CommunityControlLease.verify(envelope: senderEnvelope, requestID: sender["requestId"] as? String, authority: authority, now: now)
        let peer = try CommunityControlLease.verify(envelope: receiverEnvelope, requestID: receiver["requestId"] as? String, authority: authority, now: now)
        try check(own.policyDigest == sender["expectedPolicyDigest"] as? String && peer.policyDigest == receiver["expectedPolicyDigest"] as? String, "Unicode/slash policy values match the shared TypeScript golden")
        for (role, lease, ownEnvelope, peerEnvelope) in [("sender", own, senderEnvelope, receiverEnvelope), ("receiver", peer, receiverEnvelope, senderEnvelope)] {
            let bytes = try CommunityComponentProof.handshakeMessage(["kind": "handshake", "role": role, "transcript": transcript,
                "ownAuthorization": ownEnvelope, "peerAuthorization": peerEnvelope], authority: authority, own: lease, purpose: "teams", now: now)
            let expected = vector[role == "sender" ? "expectedSenderMessage" : "expectedReceiverMessage"] as! String
            try check(CommunityControlLease.encodeURL(bytes) == expected, "19-field transcript order and role domain match shared golden")
            let signature = try P256.Signing.ECDSASignature(rawRepresentation: CommunityControlLease.decodeURL(vector[role + "Proof"] as! String))
            let key = try P256.Signing.PublicKey(x963Representation: CommunityControlLease.decodeURL(lease.controlKey))
            try check(key.isValidSignature(signature, for: bytes), "software P1363 proof verifies across runtimes")
        }
    }
    static func testMobileHostGoldenAndStrictPeers() throws {
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("screen-control/Tests/Fixtures/community-mobile-control-v2.json")
        let vector = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any], now = vector["now"] as! Int64
        let a = vector["authority"] as! [String: String], envelopes = vector["envelopes"] as! [String: [String: Any]], transcript = vector["transcript"] as! [String: Any]
        let authority = CommunityControlAuthority(issuer: try P256.Signing.PublicKey(x963Representation: CommunityControlLease.decodeURL(a["issuerPublicKey"]!)), profileID: a["profileId"]!, origin: URL(string: a["origin"]!))
        let own = try CommunityControlLease.verify(envelope: envelopes["receiver"]!, authority: authority, now: now)
        let payload: [String: Any] = ["kind": "mobile-host-handshake", "transcript": transcript, "ownAuthorization": envelopes["receiver"]!, "controllerAuthorization": envelopes["mobile"]!, "controllerUseSession": envelopes["use"]!]
        let bytes = try CommunityComponentProof.mobileHostHandshakeMessage(payload, authority: authority, own: own, purpose: "mobile-agent", now: now)
        try check(bytes.map { String(format: "%02x", $0) }.joined() == (vector["proofBytesHex"] as! [String: String])["host"], "24-field transcript and mobile/use policy match shared Swift/TS golden")
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: CommunityControlLease.decodeURL((vector["signatures"] as! [String: String])["host"]!))
        let key = try P256.Signing.PublicKey(x963Representation: CommunityControlLease.decodeURL(own.controlKey))
        try check(key.isValidSignature(signature, for: bytes), "host software signature verifies without any native private key")
        for field in ["senderUsePublicKey", "senderPolicyDigest", "receiverPolicyDigest", "senderUsePolicyDigest", "receiverInstance", "senderConnectionId", "purpose", "senderKind"] {
            var t = transcript; t[field] = "changed"; var value = payload; value["transcript"] = t
            try rejected { _ = try CommunityComponentProof.mobileHostHandshakeMessage(value, authority: authority, own: own, purpose: "mobile-agent", now: now) }
        }
        for edit: (inout [String: Any]) -> Void in [{ $0["role"] = "client" }, { $0["controllerAuthorization"] = envelopes["receiver"]! }, { $0["controllerUseSession"] = envelopes["mobile"]! }] {
            var value = payload; edit(&value); try rejected { _ = try CommunityComponentProof.mobileHostHandshakeMessage(value, authority: authority, own: own, purpose: "mobile-agent", now: now) }
        }
        try rejected { _ = try CommunityComponentProof.mobileHostHandshakeMessage(payload, authority: authority, own: own, purpose: "agent", now: now) }
        try rejected { _ = try CommunityComponentProof.mobileHostHandshakeMessage(payload, authority: authority, own: own, purpose: "mobile-agent", now: now + 90_000) }
    }
    static func testIssuerNameParity() throws {
        let f = Fixture()
        for name in [String(repeating: "a", count: 64), String(repeating: "a", count: 65), String(repeating: "a", count: 120), String(repeating: "가", count: 40), "Mac / 회사"] { _ = try f.lease(edit: { $0["name"] = name }) }
        for name in [String(repeating: "a", count: 121), String(repeating: "가", count: 40) + "a", "a\u{0}", "a\u{85}", "a\u{7f}", "a\u{200b}", "a\u{200d}", "a\u{202e}"] { try rejected { _ = try f.lease(edit: { $0["name"] = name }) } }
    }
    struct Fixture {
        let now: Int64 = 1_793_622_000_000
        let issuer = P256.Signing.PrivateKey()
        let key = P256.Signing.PrivateKey()
        let host = P256.Signing.PrivateKey()
        let bio = P256.Signing.PrivateKey()
        let operation = P256.Signing.PrivateKey()
        let profile = "11111111-1111-4111-8111-111111111111"
        let device = "22222222-2222-4222-8222-222222222222"
        let agentDevice = "66666666-6666-4666-8666-666666666666"
        let id = "33333333-3333-4333-8333-333333333333"
        let owner = ControlOwner(pid: 100, start: 1)
        var authority: CommunityControlAuthority { CommunityControlAuthority(issuer: issuer.publicKey, profileID: profile) }
        var point: String { CommunityControlLease.encodeURL(key.publicKey.x963Representation) }
        var binding: CommunityControlBinding { CommunityControlBinding(profileID: profile, deviceID: device, publicKey: point, agentDeviceID: agentDevice) }
        func envelope(revision: Int64 = 1, epoch: Int64 = 1, at: Int64? = nil,
                      edit: (inout [String: Any]) -> Void = { _ in }, domain: String = "agentstoz.community-access.response/v2\0") throws -> [String: Any] {
            let clock = at ?? now
            var body: [String: Any] = ["version": 1, "communityId": "44444444-4444-4444-8444-444444444444", "profileId": profile,
                "enrollmentId": "55555555-5555-4555-8555-555555555555", "deviceId": device, "deviceKind": "desktop", "name": "Fixture Mac",
                "agentDeviceId": agentDevice, "hostPublicKey": CommunityControlLease.encodeURL(host.publicKey.x963Representation),
                "publicKey": CommunityControlLease.encodeURL(operation.publicKey.x963Representation),
                "biometricPublicKey": CommunityControlLease.encodeURL(bio.publicKey.x963Representation), "controlKey": point,
                "capabilities": ["agent.communicate", "computer-use.agent-settings"], "revision": revision, "keyEpoch": epoch,
                "issuedAt": clock, "expiresAt": clock + 90_000]
            edit(&body)
            let bytes = try JSONSerialization.data(withJSONObject: [2, "authorization", id, clock, body])
            return ["payload": CommunityControlLease.encodeURL(bytes),
                    "signature": CommunityControlLease.encodeURL(try issuer.signature(for: Data(domain.utf8) + bytes).rawRepresentation)]
        }
        func lease(revision: Int64 = 1, epoch: Int64 = 1, at: Int64? = nil,
                   edit: (inout [String: Any]) -> Void = { _ in }) throws -> CommunityControlLease {
            try CommunityControlLease.verify(envelope: envelope(revision: revision, epoch: epoch, at: at, edit: edit),
                requestID: id, authority: authority, now: at ?? now)
        }
    }
    static func rejected(_ body: () throws -> Void) throws {
        do { try body() } catch { return }
        throw CheckFailure(description: "untrusted community data was accepted")
    }
    static func testIssuerRequestAndDomain() throws {
        let f = Fixture(), envelope = try f.envelope()
        let lease = try CommunityControlLease.verify(envelope: envelope, requestID: f.id, authority: f.authority, now: f.now)
        try check(lease.controlKey == f.point && lease.capabilities == [.agentSettings, .agentCommunicate], "verified purposes stay distinct from desktop permissions")
        try rejected { _ = try CommunityControlLease.verify(envelope: envelope, requestID: f.device, authority: f.authority, now: f.now) }
        try rejected { _ = try CommunityControlLease.verify(envelope: envelope, requestID: f.id,
            authority: CommunityControlAuthority(issuer: P256.Signing.PrivateKey().publicKey, profileID: f.profile), now: f.now) }
        try rejected { _ = try CommunityControlLease.verify(envelope: f.envelope(domain: "agentstoz.screen-community.response/v1\0"), requestID: f.id, authority: f.authority, now: f.now) }
        try rejected { _ = try CommunityControlLease.verify(envelope: envelope.merging(["hostSignature": "extra"], uniquingKeysWith: { _, b in b }), requestID: f.id, authority: f.authority, now: f.now) }
    }
    static func testShapesAndLifetime() throws {
        let f = Fixture()
        for edit: (inout [String: Any]) -> Void in [
            { $0["controlKey"] = NSNull() }, { $0["extra"] = true }, { $0["revision"] = true }, { $0["keyEpoch"] = 1.5 },
            { $0["deviceKind"] = "mobile" }, { $0["capabilities"] = ["computer-use.agent-settings", "agent.communicate"] },
            { $0["capabilities"] = ["screen.control"] }, { $0["capabilities"] = ["arbitrary.desktop"] },
            { $0["publicKey"] = $0["controlKey"] }, { $0["expiresAt"] = f.now }, { $0["expiresAt"] = f.now + 90_001 }
        ] { try rejected { _ = try f.lease(edit: edit) } }
        try rejected { _ = try CommunityControlLease.verify(envelope: f.envelope(), requestID: f.id, authority: f.authority, now: f.now + 90_001) }
    }
    static func testCandidateIsNotAuthorityAndLocalBinding() throws {
        let f = Fixture(), state = CommunityControlState(binding: Fixture().binding)
        try expectCode("community-not-authorized") { _ = try state.authorize(.agentSettings, owner: f.owner, now: f.now, tick: 10, personHoldsControl: false) }
        try expectCode("community-binding-refused") { try state.install(f.lease(), localPublicKey: f.point, owner: f.owner, now: f.now, tick: 10, save: { _ in }) }
        let own = CommunityControlState(binding: f.binding)
        try expectCode("community-binding-refused") { try own.install(f.lease(), localPublicKey: Fixture().point, owner: f.owner, now: f.now, tick: 10, save: { _ in }) }
    }
    static func testPurposeOwnerHoldAndDeadline() throws {
        let f = Fixture(), state = CommunityControlState(binding: f.binding)
        try state.install(f.lease(), localPublicKey: f.point, owner: f.owner, now: f.now, tick: 10, save: { _ in })
        _ = try state.authorize(.agentSettings, owner: f.owner, now: f.now, tick: 11, personHoldsControl: false)
        try expectCode("community-not-authorized") { _ = try state.authorize(.browser, owner: f.owner, now: f.now, tick: 11, personHoldsControl: false) }
        try expectCode("community-not-authorized") { _ = try state.authorize(.agentSettings, owner: ControlOwner(pid: 100, start: 2), now: f.now, tick: 11, personHoldsControl: false) }
        try expectCode("community-not-authorized") { _ = try state.authorize(.agentSettings, owner: f.owner, now: f.now, tick: 11, personHoldsControl: true) }
        try expectCode("community-not-authorized") { _ = try state.authorize(.agentSettings, owner: f.owner, now: f.now, tick: 9, personHoldsControl: false) }
        try expectCode("community-not-authorized") { _ = try state.authorize(.agentSettings, owner: f.owner, now: f.now, tick: 100, personHoldsControl: false) }
        try expectCode("community-not-authorized") { _ = try state.authorize(.agentSettings, owner: f.owner, now: f.now + 90_000, tick: 12, personHoldsControl: false) }
    }
    static func testRollbackAndLocalOffSurviveRestart() throws {
        let f = Fixture(), state = CommunityControlState(binding: f.binding)
        try state.install(f.lease(revision: 2, epoch: 2), localPublicKey: f.point, owner: f.owner, now: f.now, tick: 10, save: { _ in })
        try expectCode("community-binding-refused") { try state.install(f.lease(), localPublicKey: f.point, owner: f.owner, now: f.now, tick: 10, save: { _ in }) }
        try expectCode("community-binding-refused") { try state.install(f.lease(revision: 2, epoch: 2, edit: { $0["capabilities"] = ["computer-use.browser"] }), localPublicKey: f.point, owner: f.owner, now: f.now, tick: 10, save: { _ in }) }
        var record = state.binding
        try state.disable { record = $0 }
        let restarted = CommunityControlState(binding: try JSONDecoder().decode(CommunityControlBinding.self, from: JSONEncoder().encode(record)))
        try expectCode("community-binding-refused") { try restarted.install(f.lease(revision: 2, epoch: 2, at: f.now + 10_000), localPublicKey: f.point, owner: f.owner, now: f.now + 10_000, tick: 20, save: { _ in }) }
        try restarted.install(f.lease(revision: 3, epoch: 2, at: f.now + 10_000), localPublicKey: f.point, owner: f.owner, now: f.now + 10_000, tick: 20, save: { _ in })
        _ = try restarted.authorize(.agentSettings, owner: f.owner, now: f.now + 10_000, tick: 21, personHoldsControl: false)
    }
    static func testRenewalAndStorageFailure() throws {
        let f = Fixture(), state = CommunityControlState(binding: f.binding)
        try rejected { try state.install(f.lease(), localPublicKey: f.point, owner: f.owner, now: f.now, tick: 1, save: { _ in throw CheckFailure(description: "write failed") }) }
        try expectCode("community-not-authorized") { _ = try state.authorize(.agentSettings, owner: f.owner, now: f.now, tick: 2, personHoldsControl: false) }
        try state.install(f.lease(), localPublicKey: f.point, owner: f.owner, now: f.now, tick: 3, save: { _ in })
        try state.install(f.lease(at: f.now + 20_000), localPublicKey: f.point, owner: f.owner, now: f.now + 20_000, tick: 23, save: { _ in })
        try expectCode("community-binding-refused") { try state.install(f.lease(), localPublicKey: f.point, owner: f.owner, now: f.now + 20_000, tick: 23, save: { _ in }) }
        try rejected { try state.disable(save: { _ in throw CheckFailure(description: "write failed") }) }
        try expectCode("community-not-authorized") { _ = try state.authorize(.agentSettings, owner: f.owner, now: f.now + 20_000, tick: 24, personHoldsControl: false) }
        let restarted = CommunityControlState(binding: state.binding)
        try expectCode("community-not-authorized") { _ = try restarted.authorize(.agentSettings, owner: f.owner, now: f.now + 20_000, tick: 24, personHoldsControl: false) }
    }
    static func testManagementProtocolIsClosed() throws {
        let f = Fixture()
        let samples: [[String: Any]] = [["op": "community-status"], ["op": "community-prepare", "profileId": f.profile, "deviceId": f.device, "agentDeviceId": f.agentDevice],
            ["op": "community-install", "requestId": f.id, "envelope": try f.envelope()], ["op": "community-authorize", "capability": "computer-use.browser"], ["op": "community-disable"]]
        for sample in samples {
            var request = sample; request["v"] = 3; request["channel"] = "management"
            _ = try CommunityControlRequest.decode(JSONSerialization.data(withJSONObject: request))
            for change in [["channel": "agent"], ["v": 2], ["extra": true]] as [[String: Any]] {
                try rejected { _ = try CommunityControlRequest.decode(JSONSerialization.data(withJSONObject: request.merging(change, uniquingKeysWith: { _, b in b }))) }
            }
        }
        try check(StandingAllowance.covers(.desktop), "legacy standing remains independent")
        try rejected { _ = try CommunityControlRequest.decode(JSONSerialization.data(withJSONObject: ["v": 3, "channel": "management", "op": "community-authorize", "capability": "screen.control"])) }
    }
    static func testComponentSigningHasClosedPurposeAndSubject() throws {
        let f = Fixture(), lease = try f.lease(), state = CommunityControlState(binding: f.binding)
        try check(!state.mayRefresh(.agentCommunicate), "a prepared key cannot sign its own enrollment")
        try state.install(lease, localPublicKey: f.point, owner: f.owner, now: f.now, tick: 1, save: { _ in })
        try check(state.mayRefresh(.agentCommunicate) && !state.mayRefresh(.teamsRun), "only already selected component purpose may refresh")
        let nonce = CommunityControlLease.encodeURL(Data(repeating: 1, count: 32))
        let request: [String: Any] = ["operation": "component-status", "requestId": f.id, "observedAt": f.now, "nonce": nonce,
            "actor": lease.enrollmentID, "args": [lease.communityID]]
        let payload: [String: Any] = ["kind": "access", "request": request]
        let bytes = try CommunityComponentProof.accessBytes(payload, communityID: lease.communityID, enrollmentID: lease.enrollmentID, purpose: "agent", now: f.now)
        let fields = try JSONSerialization.jsonObject(with: bytes) as! [Any]
        try check(fields[1] as? String == "component-status" && fields[5] as? String == lease.enrollmentID, "typed signed envelope binds exact subject")
        for edit: (inout [String: Any]) -> Void in [{ $0["operation"] = "approve" }, { $0["actor"] = f.device },
            { $0["args"] = [f.profile] }, { $0["nonce"] = "arbitrary bytes" }, { $0["extra"] = true }] {
            var changed = request; edit(&changed)
            try rejected { _ = try CommunityComponentProof.accessBytes(["kind": "access", "request": changed], communityID: lease.communityID, enrollmentID: lease.enrollmentID, purpose: "agent", now: f.now) }
        }
        try rejected { _ = try CommunityComponentProof.capability("screen") }
        try state.disable(save: { _ in });try check(!state.mayRefresh(.agentCommunicate), "local off blocks even an expired-lease refresh")
    }
    static func testComponentHandshakeBindsBothCertificatesAndPortalIDs() throws {
        let f = Fixture(), g = Fixture(), own = try f.lease()
        let peerDevice = "77777777-7777-4777-8777-777777777777", peerAgent = "88888888-8888-4888-8888-888888888888", peerEnrollment = "99999999-9999-4999-8999-999999999999"
        let peerEnvelope = try f.envelope(edit: { $0["deviceId"] = peerDevice; $0["agentDeviceId"] = peerAgent; $0["enrollmentId"] = peerEnrollment; $0["controlKey"] = g.point })
        let peer = try CommunityControlLease.verify(envelope: peerEnvelope, authority: f.authority, now: f.now)
        let t: [String: Any] = ["version": 1, "purpose": "agent", "profileId": f.profile, "communityId": own.communityID,
            "senderDeviceId": own.deviceID, "receiverDeviceId": peer.deviceID, "senderAgentDeviceId": f.agentDevice, "receiverAgentDeviceId": peerAgent,
            "senderEnrollmentId": own.enrollmentID, "receiverEnrollmentId": peerEnrollment, "senderCertificateHash": own.policyDigest, "receiverCertificateHash": peer.policyDigest,
            "session": String(repeating: "a", count: 32), "instance": String(repeating: "b", count: 32), "receiverBootId": String(repeating: "c", count: 32),
            "senderEphemeral": CommunityControlLease.encodeURL(f.host.publicKey.x963Representation), "receiverEphemeral": CommunityControlLease.encodeURL(g.host.publicKey.x963Representation),
            "senderNonce": CommunityControlLease.encodeURL(Data(repeating: 1, count: 32)), "receiverNonce": CommunityControlLease.encodeURL(Data(repeating: 2, count: 32))]
        let p: [String: Any] = ["kind": "handshake", "role": "sender", "transcript": t, "ownAuthorization": try f.envelope(), "peerAuthorization": peerEnvelope]
        let bytes = try CommunityComponentProof.handshakeMessage(p, authority: f.authority, own: own, purpose: "agent", now: f.now)
        try check(bytes.starts(with: Data("agentstoz.community-component.handshake/v1\0sender\0".utf8)), "signer role is in the signature domain")
        for edit: (inout [String: Any]) -> Void in [{ $0["senderAgentDeviceId"] = peerAgent }, { $0["receiverCertificateHash"] = String(repeating: "0", count: 64) },
            { $0["senderEphemeral"] = $0["receiverEphemeral"] }, { $0["purpose"] = "teams" }, { $0["extra"] = "bytes" }] {
            var changed = t; edit(&changed);var payload = p;payload["transcript"] = changed
            try rejected { _ = try CommunityComponentProof.handshakeMessage(payload, authority: f.authority, own: own, purpose: "agent", now: f.now) }
        }
        var reflected = p;reflected["role"] = "receiver"
        try rejected { _ = try CommunityComponentProof.handshakeMessage(reflected, authority: f.authority, own: own, purpose: "agent", now: f.now) }
    }
}
