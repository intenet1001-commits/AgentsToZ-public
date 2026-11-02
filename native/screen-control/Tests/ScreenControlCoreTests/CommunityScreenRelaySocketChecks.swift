#if !CORE_CHECKS
import CryptoKit
import Foundation
import XCTest
@testable import ScreenControlCore

private actor NativeHandshakeSignatureCount {
    var value = 0
    func record() { value += 1 }
}
private struct CountedNativeHandshakeSigner: TranscriptSigner {
    let inner: NativeRelayFixtureSigner, count: NativeHandshakeSignatureCount
    var publicKey: P256.Signing.PublicKey { inner.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
        await count.record(); return try await inner.signature(for: data)
    }
}

final class CommunityScreenRelaySocketChecks: XCTestCase {
    /// The entire new credential→ticket→native WSS→bound protocol6→AEAD record path; synthetic bytes only.
    func testIssuerBoundDesktopAndMobileSecureChannelsThroughActualWorkerRejectMITMAndClassSpoofing() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", root.appending(path: "cloud/screen-community/tests/native-relay-fixture.mjs").path]
        process.standardOutput = output; process.standardError = FileHandle.standardError
        try process.run(); defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        var data = Data()
        while data.last != 10 {
            let chunk = output.fileHandleForReading.availableData
            guard !chunk.isEmpty, data.count + chunk.count <= 20_000 else { throw TransportError.badFrame }; data.append(chunk)
        }
        let fixture = try JSONDecoder().decode(RelayFixtureInfo.self, from: data), authority = try fixture.authority
        let desktop = fixture.devices[0], receiver = fixture.devices[1], attacker = fixture.devices[2], mobile = fixture.devices[3]
        let own = try await fixture.access(device: desktop, role: .client).authorization
        let target = try await fixture.access(device: receiver, role: .host).authorization
        let other = try await fixture.access(device: attacker, role: .host).authorization
        let mobileAccess = try await fixture.access(device: mobile, role: .client), mobileUse = try XCTUnwrap(mobileAccess.session)
        let first = NativeRelayIncoming(), second = NativeRelayIncoming()
        func open(_ device: RelayFixtureInfo.Device, role: CommunityRelayRole, incoming: @escaping CommunityRelayMultiplexer.Incoming = { $0.cancel() }) async throws -> CommunityRelayMultiplexer {
            let key = try NativeRelayFixtureSigner(role == .host ? device.hostPrivateDER : device.sessionPrivateDER ?? device.operationPrivateDER)
            let context = try CommunityRelayContext(communityID: fixture.community, enrollmentID: device.enrollment, deviceID: device.id,
                publicKey: role == .host ? device.hostPublicKey : device.sessionPublicKey ?? device.operationPublicKey, role: role, sessionID: device.sessionID)
            return try await CommunityRelayMultiplexer.openFixture(endpoint: fixture.websocket, authority: authority, context: context,
                ticketProvider: { try await fixture.tickets(device: device, role: role, connection: $0) },
                proofSigner: { try await $0.signed(by: key) }, incoming: incoming)
        }
        let hostMux = try await open(receiver, role: .host, incoming: { await first.add($0) })
        let otherMux = try await open(attacker, role: .host, incoming: { await second.add($0) })
        let desktopMux = try await open(desktop, role: .client), mobileMux = try await open(mobile, role: .client)
        defer { hostMux.cancel(); otherMux.cancel(); desktopMux.cancel(); mobileMux.cancel() }
        let desktopSigner = try NativeRelayFixtureSigner(desktop.operationPrivateDER), hostSigner = try NativeRelayFixtureSigner(receiver.hostPrivateDER)
        let otherSigner = try NativeRelayFixtureSigner(attacker.hostPrivateDER), mobileSigner = try NativeRelayFixtureSigner(XCTUnwrap(mobile.sessionPrivateDER))
        let host = try CommunityScreenHostHandshake(authority: authority, own: target, signer: hostSigner, replay: .init()) { auth, use in
            guard [desktop.id, mobile.id].contains(auth.body.deviceId), auth.body.deviceKind == (use == nil ? .desktop : .mobile) else { throw HandshakeError.unknownDevice }
        }
        let maliciousHost = try CommunityScreenHostHandshake(authority: authority, own: other, signer: otherSigner, replay: .init()) { _, _ in }
        func binding(_ stream: CommunityRelayFrameTransport) throws -> CommunityScreenBinding {
            try CommunityScreenBinding(channelId: stream.channelID, clientConnectionId: XCTUnwrap(stream.binding.peerConnectionID), hostConnectionId: stream.ownConnectionID)
        }
        func establish(mux: CommunityRelayMultiplexer, credential: CommunityAuthorization, use: CommunityUseSession?, signer: any TranscriptSigner)
            async throws -> (client: SecureConnection, host: SecureConnection, admission: CommunityScreenAdmission) {
            let outbound = try await mux.openChannel(to: receiver.id)
            let handshake = try CommunityScreenClientHandshake(authority: authority, own: credential, session: use, target: target, signer: signer,
                channelId: outbound.channelID, connectionId: outbound.ownConnectionID, requestedControl: true)
            try await outbound.send(handshake.hello); let inbound = await first.next()
            let answer = try await host.respond(inbound.receive(), binding: binding(inbound))
            try await inbound.send(answer.message)
            let response = try await outbound.receive()
            let finish = try await handshake.finish(response, peerConnectionId: XCTUnwrap(outbound.binding.peerConnectionID))
            try await outbound.send(finish.message); let channel = try await answer.pending.confirm(inbound.receive())
            return (SecureConnection(framed: outbound, channel: finish.channel), SecureConnection(framed: inbound, channel: channel), finish.admission)
        }
        let desktopSession = try await establish(mux: desktopMux, credential: own, use: nil, signer: desktopSigner)
        defer { desktopSession.client.close(); desktopSession.host.close() }
        XCTAssertEqual(desktopSession.client.version, 6); XCTAssertTrue(desktopSession.admission.canControl); XCTAssertEqual(desktopSession.admission.peerClass, .controller)
        let input = Data("synthetic desktop pointer/key record; no injection".utf8)
        try await desktopSession.client.send(.input, input); let receivedInput = try await desktopSession.host.receive()
        XCTAssertEqual(receivedInput.type, .input); XCTAssertEqual(receivedInput.payload, input)
        let video = Data(repeating: 0x5a, count: 700_000)
        try await desktopSession.host.send(.video, video); let receivedVideo = try await desktopSession.client.receive()
        XCTAssertEqual(receivedVideo.type, .video); XCTAssertEqual(receivedVideo.payload, video)
        let mobileSession = try await establish(mux: mobileMux, credential: mobileAccess.authorization, use: mobileUse, signer: mobileSigner)
        defer { mobileSession.client.close(); mobileSession.host.close() }
        XCTAssertEqual(mobileSession.admission.peerClass, .phone); XCTAssertTrue(mobileSession.admission.canControl)
        try await mobileSession.client.send(.input, Data("mobile synthetic input".utf8))
        let mobileRecord = try await mobileSession.host.receive(); XCTAssertEqual(mobileRecord.payload, Data("mobile synthetic input".utf8))
        try await mobileSession.host.send(.video, Data("mobile synthetic video".utf8))
        let mobileVideo = try await mobileSession.client.receive(); XCTAssertEqual(mobileVideo.payload, Data("mobile synthetic video".utf8))

        // Receiver arbitration stays attached to the enrolled mobile device, rather than its replaceable RAM session key.
        let stableStream = try await mobileMux.openChannel(to: receiver.id)
        let stableHandshake = try CommunityScreenClientHandshake(authority: authority, own: mobileAccess.authorization, session: mobileUse,
            target: target, signer: mobileSigner, channelId: stableStream.channelID, connectionId: stableStream.ownConnectionID, requestedControl: true)
        try await stableStream.send(stableHandshake.hello); let stableInbound = await first.next()
        let accepting = Task { try await CommunityScreenConnector.accept(over: stableInbound, handshake: host,
            peer: PeerKey(relayEndpoint: fixture.websocket), gate: PreAuthGate()) }
        let stableResponse = try await stableStream.receive()
        let stableFinish = try await stableHandshake.finish(stableResponse, peerConnectionId: XCTUnwrap(stableStream.binding.peerConnectionID))
        try await stableStream.send(stableFinish.message); let accepted = try await accepting.value
        let permanent = try P256.Signing.PublicKey(x963Representation: AccessValue.key(mobileAccess.authorization.body.publicKey))
        XCTAssertEqual(accepted.session.deviceID, ScreenControlIdentity.fingerprint(of: permanent))
        XCTAssertNotEqual(accepted.session.deviceID, ScreenControlIdentity.fingerprint(of: mobileSigner.publicKey))
        accepted.session.connection.close(); stableStream.cancel()

        // A same-community relay/host can rewrite the unsigned hello's target, but cannot make B look like pinned A.
        let mitm = try await desktopMux.openChannel(to: attacker.id), signatures = NativeHandshakeSignatureCount()
        let expectedA = try CommunityScreenClientHandshake(authority: authority, own: own, target: target,
            signer: CountedNativeHandshakeSigner(inner: desktopSigner, count: signatures), channelId: mitm.channelID,
            connectionId: mitm.ownConnectionID, requestedControl: false)
        var rewritten = try LengthPrefixed.decode(expectedA.hello, count: 9); rewritten[1] = Data(attacker.id.utf8)
        try await mitm.send(LengthPrefixed.encode(rewritten)); let routedB = await second.next()
        let answerB = try await maliciousHost.respond(routedB.receive(), binding: binding(routedB)); try await routedB.send(answerB.message)
        let forgedResponse = try await mitm.receive()
        do { _ = try await expectedA.finish(forgedResponse, peerConnectionId: XCTUnwrap(mitm.binding.peerConnectionID)); XCTFail("Same-community host substitution accepted") }
        catch HandshakeError.badSignature { }
        let signed = await signatures.value; XCTAssertEqual(signed, 0, "wrong host must fail before a controller proof")
        mitm.cancel(); routedB.cancel()

        let wrongConnection = try await desktopMux.openChannel(to: receiver.id)
        let bound = try CommunityScreenClientHandshake(authority: authority, own: own, target: target, signer: desktopSigner,
            channelId: wrongConnection.channelID, connectionId: wrongConnection.ownConnectionID, requestedControl: false)
        try await wrongConnection.send(bound.hello); let receivedWrong = await first.next()
        let validAnswer = try await host.respond(receivedWrong.receive(), binding: binding(receivedWrong)); try await receivedWrong.send(validAnswer.message)
        do { _ = try await bound.finish(wrongConnection.receive(), peerConnectionId: UUID().uuidString.lowercased()); XCTFail("Connection epoch substitution accepted") }
        catch HandshakeError.badSignature { }
        wrongConnection.cancel(); receivedWrong.cancel()

        // Changing a DTO boolean/key cannot override the issuer's actual credential or remove the mobile session requirement.
        var mobileBody = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(mobileAccess.authorization.body)) as? [String: Any])
        mobileBody["deviceKind"] = "desktop"; mobileBody["publicKey"] = desktop.operationPublicKey
        let fakeBody = try JSONDecoder().decode(CommunityAuthorization.Body.self, from: JSONSerialization.data(withJSONObject: mobileBody))
        let spoofed = CommunityAuthorization(body: fakeBody, envelope: mobileAccess.authorization.envelope)
        XCTAssertThrowsError(try CommunityScreenClientHandshake(authority: authority, own: spoofed, target: target, signer: desktopSigner,
            channelId: UUID().uuidString.lowercased(), connectionId: UUID().uuidString.lowercased(), requestedControl: true))
        XCTAssertThrowsError(try CommunityScreenClientHandshake(authority: authority, own: mobileAccess.authorization, session: mobileUse,
            target: target, signer: NativeRelayFixtureSigner(mobile.operationPrivateDER), channelId: UUID().uuidString.lowercased(),
            connectionId: UUID().uuidString.lowercased(), requestedControl: true))
        XCTAssertThrowsError(try CommunityScreenHostHandshake(authority: authority, own: target, signer: otherSigner, replay: .init()) { _, _ in })
        XCTAssertEqual(ScreenControlProtocol.phoneVersion, 4); XCTAssertEqual(ScreenControlProtocol.version, 5)
    }
}
#endif
