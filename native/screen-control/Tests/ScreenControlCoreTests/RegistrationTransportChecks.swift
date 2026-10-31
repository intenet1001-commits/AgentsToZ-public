import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import Network
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// Registration over real TCP on 127.0.0.1, the QR text, and the input path from the phone's gestures to injection.

/// Throws the given refusal, standing in for one App Attest verifier among several.
struct RefusingAttester: AppAttestationVerifying {
    let error: AppAttestError
    func verify(_ attestation: Data, keyID: Data, clientDataHash: Data, at date: Date) throws -> AppAttestation { throw error }
}

/// Never emits a frame: for sessions that only carry input.
struct SilentEncoder: PictureEncoding {
    func encode(_ image: CVPixelBuffer, at time: CMTime) {}
    func requestKeyframe() {}
}

/// One QR's registration listener on loopback, as the Mac opens it.
struct RegistrationDesk {
    let macSigner = SoftwareSigner()
    let code = RegistrationCode.generate()
    let window: RegistrationWindow
    let listener: RegistrationListener
    let endpoint: NWEndpoint

    init() async throws {
        window = RegistrationWindow(code: code, signer: macSigner, openedAt: .now, attestationVerifier: EchoAttester())
        listener = try RegistrationListener(window: window, signer: macSigner, gate: PreAuthGate(policy: roomyPolicy()),
                                            host: .ipv4(.loopback))
        let listener = listener
        let port = try await within(5) { try await listener.start() }
        endpoint = .hostPort(host: .ipv4(.loopback), port: port)
    }

    var macFingerprint: Data { ScreenControlIdentity.fingerprint(of: macSigner.publicKey) }

    func nextOutcome(line: Int = #line) async throws -> RegistrationListener.Outcome {
        try await within(5, line: line) { [listener] in
            var outcomes = listener.outcomes.makeAsyncIterator()
            guard let outcome = await outcomes.next() else { throw CheckFailure(description: "line \(line): listener stopped") }
            return outcome
        }
    }

    /// The phone's attempt with the code it read, or with `secret` in place of the QR's.
    func phone(secret: Data? = nil, codeID: Data? = nil, shown: Collector<String>) throws -> Task<PinnedMac, Error> {
        let phoneCode = try RegistrationCode(id: codeID ?? code.id, secret: secret ?? code.qrSecret)
        let record = try RegistrationRecord(macFingerprint: macFingerprint, codeID: phoneCode.id,
                                            devicePublicKey: SoftwareSigner().publicKey, deviceName: "iPad", deviceModel: "iPad14,1")
        let endpoint = endpoint
        return Task {
            try await RegistrationClient.register(to: endpoint, record: record, code: phoneCode,
                                                  attestation: record.attestationClientDataHash,
                                                  attestationKeyID: Data(repeating: 7, count: 32),
                                                  showSAS: { shown.add($0) }, decisionTimeout: .seconds(5))
        }
    }
}

extension ScreenControlChecks {
    func testRegistrationInviteTextIsStrict() async throws {
        let code = RegistrationCode.generate()
        let fingerprint = Data(repeating: 0xAB, count: 32)
        func invite(name: String = "최천성's MacBook Pro", host: String = "MacBook-Pro.local", address: String = "192.168.0.12",
                    registrationPort: UInt16 = 50123, screenPort: UInt16 = 52741) throws -> RegistrationInvite {
            try RegistrationInvite(macFingerprint: fingerprint, code: code, macName: name, hostName: host, address: address,
                                   registrationPort: registrationPort, screenPort: screenPort)
        }
        let original = try invite()
        let read = try RegistrationInvite(text: original.text)
        try check(read.macFingerprint == fingerprint && read.code.id == code.id && read.code.qrSecret == code.qrSecret
                  && read.macName == original.macName && read.hostName == "MacBook-Pro.local" && read.address == "192.168.0.12"
                  && read.registrationPort == 50123 && read.screenPort == 52741, "the QR text reads back exactly")
        try check(original.text.hasPrefix("agentstoz-screen:") && original.text.utf8.count < 400, "short enough for a QR")

        for host in ["MacBook-Pro", "Mac Book.local", "-mac.local", "mac-.local", "mac..local", "mac.lan", "맥.local"] {
            try await expectError(RegistrationError.malformed) { _ = try invite(host: host) }
        }
        for address in ["192.168.0", "192.168.0.256", "192.168.00.1", "192.168.0.1.5", "::1", "192.168.0.1 "] {
            try await expectError(RegistrationError.malformed) { _ = try invite(address: address) }
        }
        try await expectError(RegistrationError.malformed) { _ = try invite(name: "Mac\nPro") }
        try await expectError(RegistrationError.malformed) { _ = try invite(registrationPort: 0) }
        try await expectError(RegistrationError.malformed) { _ = try invite(screenPort: 0) }

        try await expectError(RegistrationError.malformed) { _ = try RegistrationInvite(text: "agentstoz-screen-x:" + original.text.dropFirst(17)) }
        try await expectError(RegistrationError.malformed) { _ = try RegistrationInvite(text: original.text + "+") }
        try await expectError(RegistrationError.malformed) { _ = try RegistrationInvite(text: String(original.text.dropLast(4))) }
        // Another protocol version is not read as this one.
        func text(_ fields: [Data]) -> String {
            "agentstoz-screen:" + LengthPrefixed.encode(fields).base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let fields = [ScreenControlProtocol.registrationVersion.bigEndianData, fingerprint, code.id, code.qrSecret, Data("Mac".utf8),
                      Data("mac.local".utf8), Data("10.0.0.2".utf8), UInt16(1).bigEndianData, UInt16(2).bigEndianData]
        _ = try RegistrationInvite(text: text(fields))
        var other = fields
        other[0] = UInt16(2).bigEndianData
        try await expectError(RegistrationError.malformed) { _ = try RegistrationInvite(text: text(other)) }
        try await expectError(RegistrationError.malformed) { _ = try RegistrationInvite(text: text(fields + [Data()])) }
    }

    /// The registration QR scanned with the iPhone Camera said 「사용 가능한 데이터가 없음」: its text is a URL in a scheme
    /// no app had registered (2026-11-01). The app now registers `RegistrationInvite.scheme`; this pins that every QR the
    /// Mac shows parses as a URL in exactly that scheme, that the URL the system opens the app with gives back the very
    /// text that was scanned, and that the opened text meets the same parser, purpose check included.
    func testRegistrationQRIsAURLTheAppOpens() async throws {
        let mac = SoftwareSigner()
        let fingerprint = ScreenControlIdentity.fingerprint(of: mac.publicKey)
        let code = RegistrationCode.generate()
        let endpoint = URL(string: "wss://relay.example/screen-relay")!
        let legacy = try RegistrationInvite(macFingerprint: fingerprint, code: code, macName: "Mac", hostName: "mac.local",
                                            address: "192.168.0.12", registrationPort: 50123, screenPort: 52741)
        let nearby = try RegistrationInvite(macFingerprint: fingerprint, code: code, macName: "최천성's MacBook Pro",
                                            hostName: "MacBook-Pro.local",
                                            nearbyRegistrationService: ScreenNearby.registrationService(codeID: code.id),
                                            nearbyScreenService: ScreenNearby.screenService(fingerprint: fingerprint))
        let internet = try RegistrationInvite(macFingerprint: fingerprint, code: code, macName: "Mac", hostName: "mac.local",
                                              nearbyRegistrationService: ScreenNearby.registrationService(codeID: code.id),
                                              nearbyScreenService: ScreenNearby.screenService(fingerprint: fingerprint),
                                              registrationRelay: try ScreenRelayRoute(endpoint: endpoint, room: ScreenRelayRoute.newRoom(fingerprint: fingerprint)),
                                              screenRelay: try ScreenRelayRoute(endpoint: endpoint, room: ScreenRelayRoute.newRoom(fingerprint: fingerprint)))
        try check(RegistrationInvite.prefix == RegistrationInvite.scheme + ":", "the QR prefix is the URL scheme")
        for invite in [legacy, nearby, internet] {
            guard let url = URL(string: invite.text) else { throw CheckFailure(description: "the QR text is not a URL: \(invite.text)") }
            try check(url.scheme == RegistrationInvite.scheme && url.host == nil && url.query == nil && url.fragment == nil,
                      "an opaque URL in the app's scheme: nothing a browser or server would take apart")
            guard let opened = RegistrationInvite.text(openedURL: url) else { throw CheckFailure(description: "the app ignores its own QR") }
            try check(opened == invite.text, "the opened URL gives back the exact scanned text")
            let read = try RegistrationInvite(deviceRegistrationText: opened)
            try check(read.macFingerprint == fingerprint && read.code.id == code.id && read.code.qrSecret == code.qrSecret
                      && read.registrationRelay == invite.registrationRelay && read.nearbyScreenService == invite.nearbyScreenService,
                      "opening the QR as a URL reads the same invitation as scanning it")
        }
        // Only this scheme is a registration; other app links and look-alikes are left to their own handlers.
        for other in ["agentstoz://connect#e30", "agentstoz-mobile://auth/callback?state=x", "agentstoz-screen-controller:AAAA",
                      "https://example.com/agentstoz-screen:AAAA", "agentstoz-screenx:AAAA"] {
            guard let url = URL(string: other) else { throw CheckFailure(description: "fixture is not a URL: \(other)") }
            try check(RegistrationInvite.text(openedURL: url) == nil, "\(other) is not a registration URL")
        }
        // A URL in the scheme is still only text to the strict parser: another spelling or a cut QR is refused.
        for bad in ["agentstoz-screen://register#" + internet.text.dropFirst(RegistrationInvite.prefix.count),
                    "AGENTSTOZ-SCREEN:" + internet.text.dropFirst(RegistrationInvite.prefix.count),
                    String(internet.text.dropLast(4))] {
            guard let url = URL(string: bad), let opened = RegistrationInvite.text(openedURL: url) else {
                throw CheckFailure(description: "fixture should be in the scheme: \(bad)")
            }
            try await expectError(RegistrationError.malformed) { _ = try RegistrationInvite(deviceRegistrationText: opened) }
        }
        // A Mac-controller invitation opened from the Camera is refused for this device, as when it is scanned.
        let controller = try RegistrationInvite(macFingerprint: fingerprint, code: RegistrationCode.generate(), macName: "Mac",
                                                hostName: "mac.local",
                                                nearbyRegistrationService: ScreenNearby.registrationService(codeID: code.id),
                                                nearbyScreenService: ScreenNearby.screenService(fingerprint: fingerprint),
                                                capabilities: .macController)
        guard let controllerURL = URL(string: controller.text), let controllerText = RegistrationInvite.text(openedURL: controllerURL) else {
            throw CheckFailure(description: "the controller QR is not a URL in the scheme")
        }
        try await expectError(RegistrationError.wrongPurpose) { _ = try RegistrationInvite(deviceRegistrationText: controllerText) }
    }

    func testRegistrationOverTCPNeedsTheMacsApproval() async throws {
        // Approved: the phone shows the Mac's SAS, then keeps the Mac it pinned from the QR.
        let desk = try await RegistrationDesk()
        let shown = Collector<String>()
        let phone = try desk.phone(shown: shown)
        guard case .pending(let pending) = try await desk.nextOutcome() else { throw CheckFailure(description: "expected a request") }
        _ = try await within(3) {
            while shown.all.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
            return true
        }
        try check(shown.all == [pending.acceptance.sas], "both screens show one SAS before anyone approves")
        try check(pending.acceptance.record.deviceName == "iPad", "the Mac sees the device name")
        try await pending.approve()
        let mac = try await within(3) { try await phone.value }
        try check(mac.fingerprint == desk.macFingerprint, "the phone keeps the Mac from the QR")
        try check(!(await desk.window.isOpen(at: .now)), "the QR is used up")
        desk.listener.stop()

        // Declined at the Mac: the phone keeps nothing.
        let declined = try await RegistrationDesk()
        let declinedPhone = try declined.phone(shown: Collector())
        guard case .pending(let waiting) = try await declined.nextOutcome() else { throw CheckFailure(description: "expected a request") }
        await waiting.refuse()
        try await expectError(RegistrationError.refused) { _ = try await within(3) { try await declinedPhone.value } }
        declined.listener.stop()

        // A wrong code secret uses up the QR and tells the Mac, and the phone learns only that it was refused.
        let guessed = try await RegistrationDesk()
        let guessedShown = Collector<String>()
        let guesser = try guessed.phone(secret: Data(repeating: 1, count: 32), shown: guessedShown)
        guard case .failed(_, let error) = try await guessed.nextOutcome() else { throw CheckFailure(description: "expected a failure") }
        try check(error == .invalidProof, "the Mac knows why: \(error)")
        try await expectError(RegistrationError.refused) { _ = try await within(3) { try await guesser.value } }
        let stillOpen = await guessed.window.isOpen(at: .now)
        try check(guessedShown.all.isEmpty && !stillOpen, "no SAS; the QR is closed")
        guessed.listener.stop()

        // Another QR's code does not touch this one.
        let other = try await RegistrationDesk()
        let stranger = try other.phone(codeID: Data(repeating: 9, count: 16), shown: Collector())
        _ = await within3(stranger)
        try check(await other.window.isOpen(at: .now), "an attempt for another QR leaves this one open")
        other.listener.stop()

        // The approval is the pinned Mac's signature over exactly this record.
        let record = try RegistrationRecord(macFingerprint: desk.macFingerprint, codeID: desk.code.id,
                                            devicePublicKey: SoftwareSigner().publicKey, deviceName: "iPad", deviceModel: "iPad14,1")
        let approval = try await RegistrationApproval.make(for: record, signer: desk.macSigner)
        try check(RegistrationApproval.isValid(approval, for: record, mac: pinned(desk.macSigner.publicKey)), "approval")
        try check(!RegistrationApproval.isValid(approval, for: record, mac: pinned(SoftwareSigner().publicKey)), "another Mac")
        let otherRecord = try RegistrationRecord(macFingerprint: desk.macFingerprint, codeID: desk.code.id,
                                                 devicePublicKey: SoftwareSigner().publicKey, deviceName: "iPad", deviceModel: "iPad14,1")
        try check(!RegistrationApproval.isValid(approval, for: otherRecord, mac: pinned(desk.macSigner.publicKey)), "another record")
        let acknowledgement = try await RegistrationAcknowledgement.make(for: record, signer: desk.macSigner)
        try check(!RegistrationApproval.isValid(acknowledgement, for: record, mac: pinned(desk.macSigner.publicKey)),
                  "an acknowledgement is not an approval")
        try await expectError(RegistrationError.refused) { _ = try RegistrationWire.open(Data([0])) }
        try await expectError(RegistrationError.malformed) { _ = try RegistrationWire.open(Data([0, 1])) }
        try await expectError(RegistrationError.malformed) { _ = try RegistrationWire.open(Data([1])) }
        try await expectError(RegistrationError.malformed) { _ = try RegistrationWire.open(Data([2, 1])) }
    }

    private func within3(_ task: Task<PinnedMac, Error>) async -> Result<PinnedMac, Error> {
        await (try? within(3) { await task.result }) ?? .failure(CheckFailure(description: "timed out"))
    }

    func testAnyAppAttestVerifierAcceptsOneAndReportsTheTellingRefusal() async throws {
        let hash = Data(repeating: 3, count: 32), keyID = Data(repeating: 7, count: 32)
        let either = AnyAppAttestVerifier([RefusingAttester(error: .wrongApp), EchoAttester()])
        try check((try? either.verify(hash, keyID: keyID, clientDataHash: hash, at: Date())) != nil, "the second app ID accepts")
        func refusal(_ verifiers: [any AppAttestationVerifying]) -> AppAttestError? {
            do { _ = try AnyAppAttestVerifier(verifiers).verify(hash, keyID: keyID, clientDataHash: hash, at: Date()); return nil }
            catch { return error as? AppAttestError }
        }
        try check(refusal([RefusingAttester(error: .wrongApp), RefusingAttester(error: .wrongEnvironment)]) == .wrongEnvironment,
                  "the right app in the wrong environment says more than another app")
        try check(refusal([RefusingAttester(error: .untrustedChain), RefusingAttester(error: .wrongApp)]) == .untrustedChain,
                  "a forged chain is not hidden behind another verifier's wrong app")
        try check(refusal([]) == .wrongApp, "no verifier accepts nothing")
    }

    func testInputReceiverDecodesLimitsAndReleases() async throws {
        let injected = Collector<InputEvent>()
        let receiver = InputReceiver { injected.add($0) }
        let now = ContinuousClock.now
        try receiver.receive(InputCodec.encode(.button(.left, isDown: true)), at: now)
        try await expectError(InputError.malformed) { try receiver.receive(Data([0xFF]), at: now) }
        try await expectError(InputError.outOfRange) { try receiver.receive(InputCodec.encode(.pointerMove(x: 2, y: 0)), at: now) }
        for _ in 0..<1000 { try receiver.receive(InputCodec.encode(.pointerMove(x: 0.5, y: 0.5)), at: now) }
        try check(injected.all.count == 480, "the burst passes, the rest is dropped: \(injected.all.count)")
        try receiver.receive(InputCodec.encode(.key(code: 55, isDown: true, modifiers: [.command])), at: now)
        try check(injected.all.count == 480, "pressing more is limited too")
        receiver.finish()
        try check(injected.all.last == .button(.left, isDown: false), "ending the session lets go of the button: \(injected.all.suffix(2))")
    }

    func testInputReachesTheMacInOrderAndAMalformedRecordEndsTheSession() async throws {
        let fixture = Fixture()
        let (listener, endpoint) = try await loopbackListener(fixture.mac)
        defer { listener.stop() }
        let viewer = try await within(5) {
            try await ScreenViewer.connect(to: endpoint, mac: pinned(fixture.macSigner.publicKey), signer: fixture.deviceSigner)
        }
        let mac = try await nextSession(listener)
        let injected = Collector<InputEvent>()
        let pump = try VideoPump(connection: mac.connection, input: InputReceiver { injected.add($0) }) { _ in SilentEncoder() }
        let running = Task { try await pump.run() }

        let moves = (0..<300).map { InputEvent.pointerMove(x: Double($0) / 300, y: 0.5) }
        viewer.input(.button(.left, isDown: true))
        for move in moves { viewer.input(move) }
        _ = try await within(3) {
            while injected.all.count < 301 { try await Task.sleep(for: .milliseconds(10)) }
            return true
        }
        try check(injected.all == [.button(.left, isDown: true)] + moves, "every event, in the order it was made")

        try await viewer.connection.send(.input, Data([0xFF]))
        try await expectError(InputError.malformed) { try await within(3) { try await running.value } }
        try check(injected.all.last == .button(.left, isDown: false), "the held button is let go when the session ends")
        await viewer.close()
    }
}
