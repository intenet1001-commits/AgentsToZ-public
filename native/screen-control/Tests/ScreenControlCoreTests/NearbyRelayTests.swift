#if !CORE_CHECKS
import CryptoKit
import Foundation
import XCTest
@testable import ScreenControlCore

final class NearbyRelayTests: XCTestCase {
    func testRegistrationMetadataIsPrivateAndRejectsReplayAndTampering() async throws {
        let code = RegistrationCode.generate()
        let outgoing = PrivacyFrames()
        let device = RegistrationPrivacyTransport(over: outgoing, code: code, role: .device)
        let metadata = Data("private iPad name and attestation".utf8)
        try await device.send(metadata)
        let encrypted = try XCTUnwrap(outgoing.sent.all.first)
        XCTAssertNil(encrypted.range(of: metadata))
        let incoming = PrivacyFrames()
        let mac = RegistrationPrivacyTransport(over: incoming, code: code, role: .mac)
        incoming.feed(encrypted)
        let opened = try await mac.receive()
        XCTAssertEqual(opened, metadata)
        incoming.feed(encrypted)
        do { _ = try await mac.receive(); XCTFail("Replayed metadata was accepted") } catch { }
        let retry = PrivacyFrames()
        try await RegistrationPrivacyTransport(over: retry, code: code, role: .device).send(metadata)
        XCTAssertNotEqual(retry.sent.all.first?.prefix(32), encrypted.prefix(32), "Reopening one QR must use a fresh encryption salt")
        var tampered = encrypted
        tampered[tampered.count - 1] ^= 1
        let corrupt = PrivacyFrames()
        corrupt.feed(tampered)
        do {
            _ = try await RegistrationPrivacyTransport(over: corrupt, code: code, role: .mac).receive()
            XCTFail("Corrupted metadata was accepted")
        } catch { }
    }

    func testNearbyBonjourDiscoveryStillRequiresPinnedKeyConfirmation() async throws {
        let mac = SoftwareSigner(), device = SoftwareSigner()
        let id = ScreenControlIdentity.fingerprint(of: device.publicKey)
        let handshake = MacHandshake(signer: mac, replay: NonceReplayCache()) { $0 == id ? device.publicKey : nil }
        let serviceName = "az-test-" + UUID().uuidString
        let listener = try ScreenListener(handshake: handshake, gate: PreAuthGate(), nearbyServiceName: serviceName)
        _ = try await listener.start()
        defer { listener.stop() }
        let frames = try await ScreenNearby.open(serviceName: serviceName, maxFrame: 1024, timeout: .seconds(5))
        let pinned = try PinnedMac(publicKey: mac.publicKey, fingerprint: ScreenControlIdentity.fingerprint(of: mac.publicKey))
        let phone = try await ScreenTransportHandshake.connect(over: frames, handshake: DeviceHandshake(mac: pinned, devicePublicKey: device.publicKey), signer: device)
        defer { phone.close() }
        let accepted = try await nextSession(listener)
        defer { accepted.connection.close() }
        XCTAssertEqual(accepted.deviceID, id)
        try await phone.send(.control, Data("nearby".utf8))
        let received = try await accepted.connection.receive()
        XCTAssertEqual(received.payload, Data("nearby".utf8))
    }

    func testInvitationsPreserveLegacyAndValidateInternetRoutes() throws {
        let mac = SoftwareSigner()
        let fingerprint = ScreenControlIdentity.fingerprint(of: mac.publicKey)
        let code = RegistrationCode.generate()
        let legacy = try RegistrationInvite(macFingerprint: fingerprint, code: code, macName: "Mac", hostName: "mac.local",
                                            address: "192.168.1.2", registrationPort: 12345, screenPort: 52741)
        XCTAssertEqual(try RegistrationInvite(text: legacy.text).address, legacy.address)
        let endpoint = URL(string: "wss://relay.example/screen-relay")!
        let registration = try ScreenRelayRoute(endpoint: endpoint, room: ScreenRelayRoute.newRoom(fingerprint: fingerprint))
        let screen = try ScreenRelayRoute(endpoint: endpoint, room: ScreenRelayRoute.newRoom(fingerprint: fingerprint))
        let invite = try RegistrationInvite(macFingerprint: fingerprint, code: code, macName: "Mac", hostName: "mac.local",
                                            nearbyRegistrationService: ScreenNearby.registrationService(codeID: code.id),
                                            nearbyScreenService: ScreenNearby.screenService(fingerprint: fingerprint),
                                            registrationRelay: registration, screenRelay: screen)
        let decoded = try RegistrationInvite(text: invite.text)
        XCTAssertEqual(decoded.screenRelay, screen)
        XCTAssertEqual(decoded.nearbyRegistrationService, invite.nearbyRegistrationService)
        XCTAssertEqual(decoded.code.qrSecret, code.qrSecret)
        XCTAssertLessThanOrEqual(invite.text.utf8.count, 2048)
        for bad in ["ws://relay.example/screen-relay", "wss://user@relay.example/screen-relay", "wss://relay.example/screen-relay?q=secret",
                    "wss://relay.example/screen-relay#secret", "wss://relay.example/other", "wss://relay.example:444/screen-relay"] {
            XCTAssertThrowsError(try ScreenRelayRoute(endpoint: URL(string: bad)!, room: screen.room))
        }
        let other = try ScreenRelayRoute(endpoint: endpoint, room: ScreenRelayRoute.newRoom(fingerprint: Data(repeating: 0, count: 32)))
        XCTAssertThrowsError(try RegistrationInvite(macFingerprint: fingerprint, code: code, macName: "Mac", hostName: "mac.local",
                                                   nearbyRegistrationService: invite.nearbyRegistrationService!,
                                                   nearbyScreenService: invite.nearbyScreenService!, registrationRelay: registration, screenRelay: other))
    }

    /// CryptoKit host-challenge signatures, native key confirmation, counters and a video-size frame over real Bun sockets.
    func testNativeAuthenticationAndEncryptedFramesThroughActualRelay() async throws {
        let server = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tools/screen-relay/src/server.ts")
        guard FileManager.default.fileExists(atPath: server.path) else { return XCTFail("Screen relay source is missing") }
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", "-e", "const {createRelayServer}=await import(process.argv[1]); const s=createRelayServer(); console.log(s.url); process.on('SIGTERM',()=>{s.stop();process.exit(0)});", server.path]
        process.standardOutput = output
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        guard let address = String(data: output.fileHandleForReading.availableData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let endpoint = URL(string: address) else { return XCTFail("Relay did not start") }
        let mac = SoftwareSigner(), device = SoftwareSigner()
        let fingerprint = ScreenControlIdentity.fingerprint(of: mac.publicKey)
        let room = ScreenRelayRoute.newRoom(fingerprint: fingerprint)
        let progress = Collector<ScreenRelayProgress>()
        let hostOpening = Task { try await ScreenRelayTransport.openFixture(endpoint: endpoint, room: room, purpose: .screen, hostSigner: mac,
            timeout: .milliseconds(500), peerTimeout: .seconds(5), progress: { progress.add($0) }) }
        defer { hostOpening.cancel() }
        try await waitUntil { progress.all.contains(.waiting) }
        // Admission succeeded. The 500ms connect deadline must no longer disconnect this ready host.
        try await Task.sleep(for: .milliseconds(650))
        // Host verification is asynchronous. Controller offline responses do not consume native authentication.
        var controller: ScreenRelayTransport?
        for _ in 0..<20 {
            do { controller = try await ScreenRelayTransport.openFixture(endpoint: endpoint, room: room, purpose: .screen); break }
            catch ScreenRelayError.offline { try await Task.sleep(for: .milliseconds(50)) }
        }
        let client = try XCTUnwrap(controller)
        let host = try await hostOpening.value
        XCTAssertEqual(progress.all, [.connecting, .waiting, .paired])
        defer { host.cancel(); client.cancel() }
        let id = ScreenControlIdentity.fingerprint(of: device.publicKey)
        let handshake = MacHandshake(signer: mac, replay: NonceReplayCache()) { $0 == id ? device.publicKey : nil }
        let accepting = Task { try await ScreenTransportHandshake.accept(over: host, peer: PeerKey(relayEndpoint: endpoint), handshake: handshake, gate: PreAuthGate()) }
        let pinned = try PinnedMac(publicKey: mac.publicKey, fingerprint: fingerprint)
        let phone = try await ScreenTransportHandshake.connect(over: client, handshake: DeviceHandshake(mac: pinned, devicePublicKey: device.publicKey), signer: device)
        let accepted = try await accepting.value
        defer { phone.close(); accepted.connection.close() }
        try await host.authenticated()
        let input = Data("keyboard input".utf8)
        try await phone.send(.control, input)
        let received = try await accepted.connection.receive()
        XCTAssertEqual(received.payload, input)
        let video = Data(repeating: 0xa5, count: 128 * 1024)
        try await accepted.connection.send(.video, video)
        let displayed = try await phone.receive()
        XCTAssertEqual(displayed.payload, video)

        // The relay cannot replace QR proof/App Attest or complete registration without Mac approval.
        let registrationRoom = ScreenRelayRoute.newRoom(fingerprint: fingerprint)
        let registeringHost = Task { try await ScreenRelayTransport.openFixture(endpoint: endpoint, room: registrationRoom, purpose: .registration, hostSigner: mac) }
        defer { registeringHost.cancel() }
        var registrationClient: ScreenRelayTransport?
        for _ in 0..<20 {
            do { registrationClient = try await ScreenRelayTransport.openFixture(endpoint: endpoint, room: registrationRoom, purpose: .registration); break }
            catch ScreenRelayError.offline { try await Task.sleep(for: .milliseconds(50)) }
        }
        let phoneFrames = try XCTUnwrap(registrationClient)
        let macFrames = try await registeringHost.value
        defer { phoneFrames.cancel(); macFrames.cancel() }
        let code = RegistrationCode.generate(), shown = Collector<String>()
        let record = try RegistrationRecord(macFingerprint: fingerprint, codeID: code.id, devicePublicKey: device.publicKey,
                                            deviceName: "Test iPad", deviceModel: "fixture")
        let window = RegistrationWindow(code: code, signer: mac, openedAt: .now, attestationVerifier: EchoAttester())
        let request = Task { try await RegistrationHost.accept(over: macFrames, peer: PeerKey(relayEndpoint: endpoint), window: window, signer: mac, gate: PreAuthGate(), privacyCode: code) }
        let registration = Task {
            try await RegistrationClient.register(over: RegistrationPrivacyTransport(over: phoneFrames, code: code, role: .device), record: record, code: code, attestation: record.attestationClientDataHash,
                                                  attestationKeyID: Data(repeating: 7, count: 32), showSAS: { shown.add($0) }, decisionTimeout: .seconds(5))
        }
        let pending = try await request.value
        try await pending.approve()
        let registered = try await registration.value
        XCTAssertEqual(registered.fingerprint, fingerprint)
        XCTAssertEqual(shown.all, [pending.acceptance.sas])
        let stillOpen = await window.isOpen(at: .now)
        XCTAssertFalse(stillOpen)

        // Legacy relays send no waiting acknowledgement. A host must outlive the short connect timeout without
        // claiming verified admission; a controller arriving later still pairs over the actual WebSocket.
        let legacyRoom = ScreenRelayRoute.newRoom(fingerprint: fingerprint)
        let legacyProgress = Collector<ScreenRelayProgress>()
        let legacyOpening = Task { try await ScreenRelayTransport.openFixture(endpoint: endpoint, room: legacyRoom,
            purpose: .screen, hostSigner: mac, timeout: .milliseconds(300), peerTimeout: .seconds(3), version: 1,
            progress: { legacyProgress.add($0) }) }
        defer { legacyOpening.cancel() }
        try await Task.sleep(for: .milliseconds(650))
        let legacyClient = try await ScreenRelayTransport.openFixture(endpoint: endpoint, room: legacyRoom, purpose: .screen)
        defer { legacyClient.cancel() }
        let legacyHost = try await legacyOpening.value
        defer { legacyHost.cancel() }
        XCTAssertEqual(legacyProgress.all, [.connecting, .paired])

        let expiredRoom = ScreenRelayRoute.newRoom(fingerprint: fingerprint)
        do {
            let unexpected = try await ScreenRelayTransport.openFixture(endpoint: endpoint, room: expiredRoom,
                purpose: .screen, hostSigner: mac, timeout: .milliseconds(300), peerTimeout: .milliseconds(500), version: 1)
            unexpected.cancel(); XCTFail("an unpaired legacy join must stay bounded")
        } catch ScreenRelayError.peerWaitExpired {
            // A normal wait expiry has a distinct receipt so the host does not add failure backoff.
        }
    }
}

private final class PrivacyFrames: ScreenFrameTransport, Sendable {
    let sent = Collector<Data>()
    let stream: AsyncStream<Data>
    let sink: AsyncStream<Data>.Continuation
    init() { (stream, sink) = AsyncStream.makeStream() }
    func feed(_ data: Data) { sink.yield(data) }
    func setMaxFrame(_ value: Int) {}
    func send(_ payload: Data) async throws { sent.add(payload) }
    func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void) { sent.add(payload); completion(nil) }
    func receive() async throws -> Data {
        var iterator = stream.makeAsyncIterator()
        guard let data = await iterator.next() else { throw TransportError.closed }
        return data
    }
    func cancel() { sink.finish() }
}
#endif
