import CryptoKit
import Foundation
import Network
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// Session protocol 5 (docs/design/mac-to-mac-2026-11-01/DESIGN.md 7.2, 7.7): the Mac controller's version. A phone stays
// on 4 whatever this build speaks (SR-36), the peer class is bound into a version-5 transcript (SR-22), each listener
// answers only the classes it serves (SR-33), version-5 values parse only in a version-5 session, and a refusal before
// message 2 is named only to a peer that offered 5. Fakes and loopback only: no screen, input, keychain or TCC.

/// A Mac whose registries hold one phone and one Mac controller, apart (DESIGN 6.4), as the screen host keeps them.
/// `knowsControllers: false` plays a version-4 Mac, which has no controller registry.
struct PeerFixture: @unchecked Sendable {
    let macSigner: TranscriptSigner
    let phoneSigner: TranscriptSigner
    let controllerSigner: TranscriptSigner
    let mac: MacHandshake

    init(macSigner: TranscriptSigner = SoftwareSigner(), phoneSigner: TranscriptSigner = SoftwareSigner(),
         controllerSigner: TranscriptSigner = SoftwareSigner(), macVersions: VersionPolicy = .current, knowsControllers: Bool = true) {
        self.macSigner = macSigner
        self.phoneSigner = phoneSigner
        self.controllerSigner = controllerSigner
        let phone = phoneSigner.publicKey, controller = controllerSigner.publicKey
        let phoneID = ScreenControlIdentity.fingerprint(of: phone), controllerID = ScreenControlIdentity.fingerprint(of: controller)
        mac = MacHandshake(signer: macSigner, replay: NonceReplayCache(), versions: macVersions, registeredPeer: { id in
            if id == phoneID { return RegisteredPeerKey(key: phone, peerClass: .phone) }
            if knowsControllers, id == controllerID { return RegisteredPeerKey(key: controller, peerClass: .controller) }
            return nil
        })
    }

    var pinnedMac: PinnedMac { pinned(macSigner.publicKey) }
    /// A phone as the iOS app makes it: the public initializer's default.
    func phone() -> DeviceHandshake { DeviceHandshake(mac: pinnedMac, devicePublicKey: phoneSigner.publicKey) }
    /// A Mac controller (Viewer): offers up to 5, goes on only at 5.
    func controller() -> DeviceHandshake {
        DeviceHandshake(mac: pinnedMac, devicePublicKey: controllerSigner.publicKey, peerClass: .controller)
    }
}

/// A loopback listener with a chosen class set and connector rule, and a budget no check here runs out of.
func peerListener(_ mac: MacHandshake, accepting: Set<ScreenPeerClass>, connectors: ScreenListener.ConnectorRule? = nil,
                  policy: PreAuthPolicy = roomierPolicy()) async throws -> (ScreenListener, NWEndpoint) {
    let listener = try ScreenListener(handshake: mac, gate: PreAuthGate(policy: policy), host: .ipv4(.loopback),
                                      accepting: accepting, connectors: connectors)
    let port = try await within(5) { try await listener.start() }
    return (listener, .hostPort(host: .ipv4(.loopback), port: port))
}

func roomierPolicy() -> PreAuthPolicy {
    var policy = roomyPolicy()
    policy.failuresBeforeBlock = 1000
    policy.connectorRate = 100; policy.connectorBurst = 100
    policy.deviceRate = 100; policy.deviceBurst = 100
    return policy
}

/// The next frame, or nil when the other end closes first.
func nextFrameOrEnd(_ framed: any ScreenFrameTransport, within seconds: Double = 3, line: Int = #line) async throws -> Data? {
    try await within(seconds, line: line) {
        do { return try await framed.receive() } catch { return nil }
    }
}

/// The version-4 hello of the fixed reference inputs (reference/key-schedule.py, "phone hello").
let phoneHelloGolden = hex("000000010100000020ee9a6dca2eff5e369db103766821086aad9d76193c917f0784222b1c11d9959a0000002011111111111111111111111111111111111111111111415a53637265656e000400000041046d6727e012b295e6f773fa5a0778d809206c10e6dfb6e3ff26cc6944c379ac5a8314c7b0f4100391f1be9d5360ec9d0054b4914b8762679ca4fba3e9368f0a7d")

extension ScreenControlChecks {
    static var sessionV5Checks: [(String, (ScreenControlChecks) -> () async throws -> Void)] { [
        ("SR-36: a phone offers and settles on 4, byte for byte", { $0.testPhoneStaysOnVersionFourByteForByte }),
        ("version-5 key schedule binds the peer class", { $0.testVersionFiveKeyScheduleMatchesTheReference }),
        ("version 5 negotiates with controllers only", { $0.testVersionFiveNegotiationTable }),
        ("a peer class mix-up fails the signature", { $0.testPeerClassMixUpFailsTheSignature }),
        ("each listener answers only its peer classes", { $0.testEachListenerAnswersOnlyItsPeerClasses }),
        ("pre-authentication notice only to a version-5 offer", { $0.testPreAuthNoticeOnlyToAVersionFiveOffer }),
        ("version-5 values parse strictly by version", { $0.testVersionFiveValuesParseStrictlyByVersion }),
        ("authenticated controller hears B's hold and hand-back; phone remains on 4", { $0.testExplicitMacHoldOverSession }),
        ("a version-5 session tells its limits and takes unenrolment", { $0.testVersionFiveSessionTellsLimitsAndTakesUnenrolment }),
        ("version-5 end reasons reach older peers in their older form", { $0.testVersionFiveEndReasonsReachOlderPeersInTheirOlderForm }),
        ("SR-21: a view grant drops the input the host passed", { $0.testViewGrantDropsTheInputTheHostPassed }),
    ] }

    func testPhoneStaysOnVersionFourByteForByte() async throws {
        try check(ScreenControlProtocol.version == 5 && ScreenControlProtocol.phoneVersion == 4
                  && ScreenControlProtocol.controllerMinimumVersion == 5 && ScreenControlProtocol.minimumVersion == 1
                  && ScreenControlProtocol.registrationVersion == 1, "protocol 5, phones 4, registration 1")
        try check(VersionPolicy.phone == .upTo(4) && VersionPolicy.controller == .upTo(5) && VersionPolicy.current == .upTo(5),
                  "the phone's policy is not the Mac's")

        // The public initializer, as the iOS app calls it: offers 4, in exactly version 4's layout.
        let fixture = PeerFixture()
        let hello = try LengthPrefixed.decode(fixture.phone().hello, count: 4)
        try check(hello[0] == Data([1]) && hello[1] == ScreenControlIdentity.fingerprint(of: fixture.phoneSigner.publicKey)
                  && hello[2].count == 32 && hello[2].suffix(10) == Data("AZScreen".utf8) + Data([0, 4]) && hello[3].count == 65,
                  "the default hello offers version 4")
        try check(try DeviceHelloSummary(fixture.phone().hello).offeredVersion == 4
                  && (try DeviceHelloSummary(fixture.controller().hello).offeredVersion) == 5, "only a controller offers 5")

        // Fixed inputs: the hello and the key schedule are the reference's, and this build's Mac answers a phone in 4.
        func scalar(_ name: String) -> Data { sha256(Data("agentstoz kat \(name)".utf8)) }
        let macSigner = SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: scalar("mac identity")))
        let deviceSigner = SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: scalar("device identity")))
        let macEphemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar("mac ephemeral"))
        let deviceEphemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar("device ephemeral"))
        let deviceKey = deviceSigner.publicKey
        let mac = MacHandshake(signer: macSigner, replay: NonceReplayCache(), versions: .current,
                               fresh: { (Data(repeating: 0x22, count: 32), macEphemeral) }, registeredKey: { _ in deviceKey })
        let phone = DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: deviceKey, versions: .phone,
                                    nonce: Data(repeating: 0x11, count: 32), ephemeral: deviceEphemeral)
        try check(phone.hello == phoneHelloGolden, "the version-4 hello is the reference's byte for byte")
        let (reply, pending) = try await mac.respond(to: phone.hello)
        let (finish, deviceChannel) = try await phone.finish(macHello: reply, signer: deviceSigner)
        let macChannel = try await pending.confirm(finish)
        try check(macChannel.version == 4 && deviceChannel.version == 4 && pending.peerClass == .phone, "settled on 4")
        let transcript = hex("c1bd2536d5478ddaaa27cd19dae88a3e23e6ce722629d5f7b1d5036b74dae6e1")
        try check(keyBytes(macChannel.sendKey) == hex("e0f031b6067639396c2a9b4c2e4d4fad2aa7b8a766b3dcc64b0700c92d91c376")
                  && keyBytes(deviceChannel.sendKey) == hex("780adb419ed1b4b8c2c6c7554b9d43cf5d73a5af202fdf2750321609e9493195"),
                  "version-4 record keys are the reference's")
        let answer = try LengthPrefixed.decode(reply, count: 5), done = try LengthPrefixed.decode(finish, count: 3)
        func hmac(_ key: String, _ signature: Data) -> Data {
            Data(HMAC<SHA256>.authenticationCode(for: transcript + signature, using: SymmetricKey(data: hex(key))))
        }
        try check(answer[4] == hmac("d76616c613ab81d70071e274c17b8744b27f5bedb05e507cfe35e7559daeacd6", answer[3])
                  && done[2] == hmac("7f436c55e7aed45728493fe8be98b4a964d484e144ab66d2c4560975190a2e4b", done[1]),
                  "both confirmations are over version 4's transcript, which has no peer class")
        try check(answer[1].suffix(10) == Data("AZScreen".utf8) + Data([0, 4]), "the Mac names 4")

        // The Viewer's default path sends that hello too; a controller passes its class and offers 5.
        for (peerClass, offered) in [(ScreenPeerClass.phone, UInt16(4)), (.controller, 5)] {
            let (viewerEnd, macEnd) = framePipe()
            let signer = SoftwareSigner()
            let pinnedMac = fixture.pinnedMac
            let connecting = Task {
                if peerClass == .phone {
                    _ = try await ScreenViewer.connect(over: viewerEnd, mac: pinnedMac, signer: signer)
                } else {
                    _ = try await ScreenViewer.connect(over: viewerEnd, mac: pinnedMac, signer: signer, peerClass: .controller)
                }
            }
            let sent = try await within(3) { try await macEnd.receive() }
            macEnd.cancel()
            _ = await connecting.result
            try check(try DeviceHelloSummary(sent).offeredVersion == offered, "ScreenViewer.connect as \(peerClass) offers \(offered)")
        }
    }

    func testVersionFiveKeyScheduleMatchesTheReference() async throws {
        func scalar(_ name: String) -> Data { sha256(Data("agentstoz kat \(name)".utf8)) }
        let macSigner = SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: scalar("mac identity")))
        let deviceSigner = SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: scalar("device identity")))
        let macEphemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar("mac ephemeral"))
        let deviceEphemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar("device ephemeral"))
        let deviceKey = deviceSigner.publicKey
        let mac = MacHandshake(signer: macSigner, replay: NonceReplayCache(), versions: .current,
                               fresh: { (Data(repeating: 0x22, count: 32), macEphemeral) },
                               registeredPeer: { _ in RegisteredPeerKey(key: deviceKey, peerClass: .controller) })
        let controller = DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: deviceKey, versions: .controller,
                                         minimum: 5, peerClass: .controller,
                                         nonce: Data(repeating: 0x11, count: 32), ephemeral: deviceEphemeral)
        let (reply, pending) = try await mac.respond(to: controller.hello, accepting: [.controller])
        let (finish, deviceChannel) = try await controller.finish(macHello: reply, signer: deviceSigner)
        let macChannel = try await pending.confirm(finish)
        try check(macChannel.version == 5 && deviceChannel.version == 5 && pending.peerClass == .controller, "settled on 5")
        let transcript = hex("a9ec15f16aaf1880405176fd32bd161dfff80d1799caab8000d8808971788c00")
        try check(keyBytes(macChannel.sendKey) == hex("812c13704f47d3c459e4b97f5a8cfd05ef3e0098b686b2218aa9b1b88d2749ab")
                  && keyBytes(deviceChannel.sendKey) == hex("80368090de85719f80ebe5c3edcd35552aee98bcbd954c1c9cb9fb4a48e10d18"),
                  "version-5 record keys are the reference's")
        let answer = try LengthPrefixed.decode(reply, count: 5)
        try check(macSigner.publicKey.isValidSignature(try signature(answer[3]), for: HandshakeLabels(version: 5).macSignature + transcript),
                  "the Mac signs the reference transcript, which ends with the controller class")
        // Versions 1-4 never hash a class; from 5 the class changes T.
        let fields = (Data(repeating: 1, count: 32), Data(repeating: 2, count: 32), Data(repeating: 3, count: 65))
        func t(_ version: UInt16, _ peerClass: ScreenPeerClass) -> Data {
            transcriptHash(version: version, macFingerprint: fields.0, deviceID: fields.1, deviceNonce: fields.0,
                           deviceEphemeral: fields.2, macNonce: fields.1, macEphemeral: fields.2, peerClass: peerClass)
        }
        for version: UInt16 in 1...4 { try check(t(version, .phone) == t(version, .controller), "version \(version) hashes no class") }
        try check(t(5, .phone) != t(5, .controller), "version 5 binds the class")
    }

    func testVersionFiveNegotiationTable() async throws {
        // In memory: who settles on what, and who is refused before any signature.
        struct Row { let name: String; let mac: VersionPolicy; let knowsControllers: Bool; let asController: Bool; let settled: UInt16? }
        let rows = [
            Row(name: "a phone with this Mac", mac: .current, knowsControllers: true, asController: false, settled: 4),
            Row(name: "a phone with a version-4 Mac", mac: .upTo(4), knowsControllers: false, asController: false, settled: 4),
            Row(name: "a phone with a version-3 Mac", mac: .upTo(3), knowsControllers: false, asController: false, settled: 3),
            Row(name: "a controller with this Mac", mac: .current, knowsControllers: true, asController: true, settled: 5),
        ]
        for row in rows {
            let fixture = PeerFixture(macVersions: row.mac, knowsControllers: row.knowsControllers)
            let device = row.asController ? fixture.controller() : fixture.phone()
            let signer = row.asController ? fixture.controllerSigner : fixture.phoneSigner
            let (reply, pending) = try await fixture.mac.respond(to: device.hello, accepting: [.phone, .controller])
            let (finish, deviceChannel) = try await device.finish(macHello: reply, signer: signer)
            let macChannel = try await pending.confirm(finish)
            try check(macChannel.version == row.settled && deviceChannel.version == row.settled
                      && pending.peerClass == (row.asController ? .controller : .phone), "\(row.name): \(macChannel.version)")
        }
        // A future phone build that offered 5 still settles on 4 with this Mac: phones never get version 5 (SR-36).
        let future = PeerFixture()
        let louder = DeviceHandshake(mac: future.pinnedMac, devicePublicKey: future.phoneSigner.publicKey, versions: .upTo(5))
        let (louderReply, louderPending) = try await future.mac.respond(to: louder.hello)
        let (louderFinish, louderChannel) = try await louder.finish(macHello: louderReply, signer: future.phoneSigner)
        let louderMac = try await louderPending.confirm(louderFinish)
        try check(louderChannel.version == 4 && louderMac.version == 4, "a phone is capped at 4")

        // A Viewer and a version-4 Mac: the old Mac has no controller registry and refuses at the lookup, before macHello.
        let old = PeerFixture(macVersions: .upTo(4), knowsControllers: false)
        try await expectError(HandshakeError.unknownDevice) {
            _ = try await old.mac.respond(to: old.controller().hello, accepting: [.phone, .controller])
        }

        // A controller key settling below 5 is refused at the Mac: one that offers only 4, or a Mac that speaks only 4.
        let fixture = PeerFixture()
        let offersFour = DeviceHandshake(mac: fixture.pinnedMac, devicePublicKey: fixture.controllerSigner.publicKey,
                                         versions: .upTo(4), peerClass: .controller)
        try await expectError(HandshakeError.versionBelowMinimum) {
            _ = try await fixture.mac.respond(to: offersFour.hello, accepting: [.phone, .controller])
        }
        let fourOnly = PeerFixture(macVersions: .upTo(4))
        try await expectError(HandshakeError.versionBelowMinimum) {
            _ = try await fourOnly.mac.respond(to: fourOnly.controller().hello, accepting: [.phone, .controller])
        }

        // The Viewer side: a real Mac's macHello settled on 4 (it holds this key as a phone) reads as an old Mac once its
        // signature checks out, and the Viewer signs nothing.
        let counting = CountingSigner()
        let asPhone = PeerFixture(phoneSigner: counting)
        let viewer = DeviceHandshake(mac: asPhone.pinnedMac, devicePublicKey: counting.publicKey, peerClass: .controller)
        let (four, _) = try await asPhone.mac.respond(to: viewer.hello)
        try await expectError(HandshakeError.versionBelowMinimum) { _ = try await viewer.finish(macHello: four, signer: counting) }
        try check(await counting.counter.count == 0, "the Viewer signed for a version-4 Mac")
        // A version-5 answer whose stamp was turned to 4 on the path is a forgery, not an old Mac: never 「update B」.
        let honest = PeerFixture(controllerSigner: counting)
        let target = honest.controller()
        let (five, _) = try await honest.mac.respond(to: target.hello, accepting: [.controller])
        var stamped = try LengthPrefixed.decode(five, count: 5)
        try check(VersionStamp.version(in: stamped[1]) == 5, "the Mac answered in 5")
        stamped[1] = VersionStamp.stamped(stamped[1], version: 4)
        try await expectError(HandshakeError.badSignature) {
            _ = try await target.finish(macHello: LengthPrefixed.encode(stamped), signer: counting)
        }
        try check(await counting.counter.count == 0, "the Viewer signed over a tampered version")

        // Over TCP, through a listener that serves both classes.
        let both = PeerFixture()
        let (listener, endpoint) = try await peerListener(both.mac, accepting: [.phone, .controller])
        defer { listener.stop() }
        for asController in [false, true] {
            let client = try await within(5) {
                try await ScreenClient.connect(to: endpoint, handshake: asController ? both.controller() : both.phone(),
                                               signer: asController ? both.controllerSigner : both.phoneSigner)
            }
            let session = try await nextSession(listener)
            try check(client.version == (asController ? 5 : 4) && session.connection.version == client.version
                      && session.peerClass == (asController ? .controller : .phone), "over TCP as \(asController ? "controller" : "phone")")
            client.close(); session.connection.close()
        }
    }

    func testPeerClassMixUpFailsTheSignature() async throws {
        // The Mac holds the key as a controller; the peer signs as a phone in version 5. Its check of the Mac's signature
        // fails before Face ID.
        let counting = CountingSigner()
        let fixture = PeerFixture(controllerSigner: counting)
        let lying = DeviceHandshake(mac: fixture.pinnedMac, devicePublicKey: counting.publicKey, versions: .controller,
                                    minimum: 5, peerClass: .phone)
        let (reply, pending) = try await fixture.mac.respond(to: lying.hello, accepting: [.phone, .controller])
        let answered = VersionStamp.version(in: try LengthPrefixed.decode(reply, count: 5)[1])
        try check(pending.peerClass == .controller && answered == 5, "the Mac answered a controller in 5")
        try await expectError(HandshakeError.badSignature) { _ = try await lying.finish(macHello: reply, signer: counting) }
        try check(await counting.counter.count == 0, "Face ID was asked over a mismatched class")

        // The other way: a finish signed over the phone-class transcript never confirms a controller session.
        let honest = PeerFixture()
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let device = DeviceHandshake(mac: honest.pinnedMac, devicePublicKey: honest.controllerSigner.publicKey,
                                     versions: .controller, minimum: 5, peerClass: .controller, ephemeral: ephemeral)
        let hello = try LengthPrefixed.decode(device.hello, count: 4)
        let (answerData, macPending) = try await honest.mac.respond(to: device.hello, accepting: [.controller])
        let answer = try LengthPrefixed.decode(answerData, count: 5)
        let labels = HandshakeLabels(version: 5)
        let wrong = transcriptHash(version: 5, macFingerprint: ScreenControlIdentity.fingerprint(of: honest.macSigner.publicKey),
                                   deviceID: hello[1], deviceNonce: hello[2], deviceEphemeral: hello[3],
                                   macNonce: answer[1], macEphemeral: answer[2], peerClass: .phone)
        let keys = SessionKeys(secret: try ephemeral.sharedSecretFromKeyAgreement(with: try ephemeralKey(answer[2])),
                               transcriptHash: wrong, labels: labels)
        let signed = try await honest.controllerSigner.signature(for: labels.deviceSignature + wrong).rawRepresentation
        let finish = encodeMessage(.deviceFinish, [signed, confirmation(keys.deviceConfirm, wrong, signed)])
        try await expectError(HandshakeError.badSignature) { _ = try await macPending.confirm(finish) }
    }

    func testEachListenerAnswersOnlyItsPeerClasses() async throws {
        let fixture = PeerFixture()
        try await expectError(HandshakeError.peerClassRefused) {
            _ = try await fixture.mac.respond(to: fixture.controller().hello, accepting: [.phone])
        }
        try await expectError(HandshakeError.peerClassRefused) {
            _ = try await fixture.mac.respond(to: fixture.phone().hello, accepting: [.controller])
        }
        // Without a class set the Mac answers phones only, as the listener and the relay path do by default.
        try await expectError(HandshakeError.peerClassRefused) { _ = try await fixture.mac.respond(to: fixture.controller().hello) }
        let (_, phonePending) = try await fixture.mac.respond(to: fixture.phone().hello)
        try check(phonePending.peerClass == .phone, "the default answers a phone")

        // A listener that was never told about controllers (the default) answers phones and refuses a controller, naming
        // the refusal to it alone, since it offered 5.
        let counting = CountingSigner()
        let guarded = PeerFixture(controllerSigner: counting)
        let (listener, endpoint) = try await peerListener(guarded.mac, accepting: [.phone])
        defer { listener.stop() }
        let local = PeerKey(host: "127.0.0.1")!
        try await expectError(HandshakeError.preAuthNotice(.notAccepted)) {
            _ = try await ScreenClient.connect(to: endpoint, handshake: guarded.controller(), signer: counting)
        }
        try check(try await nextEvent(listener) == .failed(local, reason: "\(HandshakeError.peerClassRefused)"), "refused by class")
        try check(await counting.counter.count == 0, "the refused controller signed nothing")
        let phone = try await within(5) {
            try await ScreenClient.connect(to: endpoint, handshake: guarded.phone(), signer: guarded.phoneSigner)
        }
        let session = try await nextSession(listener)
        try check(session.peerClass == .phone && phone.version == 4, "the phone is served")
        phone.close(); session.connection.close()
        try check(ScreenListener.isLoopback(.ipv4(.loopback)), "a loopback listener")

        // The relay path takes phones only unless told otherwise (SR-33).
        let gate = PreAuthGate(policy: roomierPolicy())
        let relay = PeerKey(relayEndpoint: URL(string: "wss://relay.invalid/screen")!)
        for asController in [false, true] {
            let (deviceEnd, macEnd) = framePipe()
            let accepting = Task { try await ScreenTransportHandshake.accept(over: macEnd, peer: relay, handshake: guarded.mac, gate: gate) }
            let signer: TranscriptSigner = asController ? counting : guarded.phoneSigner
            let connecting = Task {
                try await ScreenTransportHandshake.connect(over: deviceEnd, handshake: asController ? guarded.controller() : guarded.phone(),
                                                           signer: signer)
            }
            if asController {
                try await expectError(HandshakeError.peerClassRefused) { _ = try await finished(accepting) }
                try await expectError(HandshakeError.preAuthNotice(.notAccepted)) { _ = try await finished(connecting) }
            } else {
                let session = try await finished(accepting)
                let connection = try await finished(connecting)
                try check(session.peerClass == .phone && session.peer == relay && connection.version == 4, "a relay phone")
                connection.close(); session.connection.close()
            }
        }
        let (deviceEnd, macEnd) = framePipe()
        let opened = Task {
            try await ScreenTransportHandshake.accept(over: macEnd, peer: relay, handshake: guarded.mac, gate: gate, accepting: [.phone, .controller])
        }
        let connection = try await finished(Task {
            try await ScreenTransportHandshake.connect(over: deviceEnd, handshake: guarded.controller(), signer: counting)
        })
        let optedIn = try await finished(opened)
        try check(optedIn.peerClass == .controller && connection.version == 5, "a path that opts in takes a controller")
        connection.close(); optedIn.connection.close()
    }

    func testPreAuthNoticeOnlyToAVersionFiveOffer() async throws {
        // Strict frames and the refusals they may name.
        for notice in PreAuthNotice.allCases {
            try check(PreAuthNotice(message: notice.message) == notice, "\(notice) round trip")
        }
        try check(PreAuthNotice.notAccepted.message == hex("000000010400000001") + Data([1]) && PreAuthNotice.busy.message.last == 4,
                  "a tag and one reason byte")
        for bad in [encodeMessage(.preAuthNotice, [Data([0])]), encodeMessage(.preAuthNotice, [Data([5])]),
                    encodeMessage(.preAuthNotice, [Data([1, 1])]), encodeMessage(.preAuthNotice, [Data()]),
                    encodeMessage(.macHello, [Data([1])]), encodeMessage(.preAuthNotice, [Data([1]), Data([1])])] {
            try check(PreAuthNotice(message: bad) == nil, "not a notice: \([UInt8](bad))")
        }
        try check(PreAuthNotice(refusal: HandshakeError.unknownDevice) == .notAccepted
                  && PreAuthNotice(refusal: HandshakeError.peerClassRefused) == .notAccepted
                  && PreAuthNotice(refusal: HandshakeError.versionBelowMinimum) == .notAccepted
                  && PreAuthNotice(refusal: PreAuthRefusal.tooFast) == .rateLimited
                  && PreAuthNotice(refusal: PreAuthRefusal.blocked) == .blocked
                  && PreAuthNotice(refusal: PreAuthRefusal.busy) == .busy
                  && PreAuthNotice(refusal: PreAuthAccountRefusal(peer: .connectorUnknownDevice, refusal: .blocked)) == .blocked,
                  "each refusal names its reason")
        for unnamed: Error in [HandshakeError.malformed, HandshakeError.replayedNonce, HandshakeError.badSignature,
                               TransportError.timedOut, TransportError.badFrame] {
            try check(PreAuthNotice(refusal: unnamed) == nil, "\(unnamed) is never named")
        }

        // On the wire: the same unknown key, offered as a phone (4) and as a Viewer (5).
        let fixture = PeerFixture()
        let strangerKey = SoftwareSigner().publicKey
        let (listener, endpoint) = try await peerListener(fixture.mac, accepting: [.phone, .controller])
        defer { listener.stop() }
        let asPhone = try await rawConnection(to: endpoint)
        try await asPhone.send(DeviceHandshake(mac: fixture.pinnedMac, devicePublicKey: strangerKey).hello)
        try check(try await nextFrameOrEnd(asPhone) == nil, "a phone hears nothing new: the connection just ends")
        let asViewer = try await rawConnection(to: endpoint)
        try await asViewer.send(DeviceHandshake(mac: fixture.pinnedMac, devicePublicKey: strangerKey, peerClass: .controller).hello)
        try check(try await nextFrameOrEnd(asViewer) == PreAuthNotice.notAccepted.message, "a Viewer hears notAccepted")
        try check(try await nextFrameOrEnd(asViewer) == nil, "and then the connection ends")
        // Garbage tells no version: nothing is named.
        let garbage = try await rawConnection(to: endpoint)
        try await garbage.send(randomBytes(146))
        try check(try await nextFrameOrEnd(garbage) == nil, "a malformed hello hears nothing")

        // The Viewer reads the notice as wording only: it throws, signs nothing, and the attempt is spent.
        let counting = CountingSigner()
        let viewer = DeviceHandshake(mac: fixture.pinnedMac, devicePublicKey: counting.publicKey, peerClass: .controller)
        try await expectError(HandshakeError.preAuthNotice(.notAccepted)) {
            _ = try await viewer.finish(macHello: PreAuthNotice.notAccepted.message, signer: counting)
        }
        try await expectError(HandshakeError.alreadyUsed) { _ = try await viewer.finish(macHello: Data(), signer: counting) }
        try check(await counting.counter.count == 0, "a notice never reaches the signer")
        // A phone never interprets one: to it the frame is a malformed answer.
        let phone = DeviceHandshake(mac: fixture.pinnedMac, devicePublicKey: counting.publicKey)
        try await expectError(HandshakeError.malformed) {
            _ = try await phone.finish(macHello: PreAuthNotice.busy.message, signer: counting)
        }
        // Through the real client too.
        try await expectError(HandshakeError.preAuthNotice(.notAccepted)) {
            _ = try await ScreenClient.connect(to: endpoint, handshake: DeviceHandshake(
                mac: fixture.pinnedMac, devicePublicKey: counting.publicKey, peerClass: .controller), signer: counting)
        }
        try check(await counting.counter.count == 0, "the client signed nothing for a refused Viewer")
    }

    func testVersionFiveValuesParseStrictlyByVersion() async throws {
        // End reasons: new ones are version 5's and reach older peers in an older form or none.
        for reason: SessionEndReason in [.takenOver, .busy, .captureUnavailable] {
            try check(reason.minimumVersion == 5 && reason.closePayload(version: 5) == reason.encoded, "\(reason) is version 5's")
            for version: UInt16 in 1...4 {
                try check(SessionEndReason(closePayload: reason.encoded, version: version) == nil, "\(reason) is unknown in \(version)")
            }
            try check(SessionEndReason(closePayload: reason.encoded, version: 5) == reason
                      && SessionEndReason(closePayload: reason.encoded) == reason, "\(reason) read in 5")
        }
        try check(SessionEndReason.takenOver.rawValue == 8 && SessionEndReason.busy.rawValue == 9
                  && SessionEndReason.captureUnavailable.rawValue == 10, "values 8, 9, 10")
        for version: UInt16 in 1...4 {
            try check(SessionEndReason.takenOver.closePayload(version: version) == SessionEndReason.replaced.encoded
                      && SessionEndReason.busy.closePayload(version: version) == Data()
                      && SessionEndReason.captureUnavailable.closePayload(version: version) == SessionEndReason.endedAtMac.encoded,
                      "version \(version) hears replaced, nothing, endedAtMac")
        }
        try check(SessionEndReason.turnedOffFromDevice.closePayload(version: 1) == SessionEndReason.turnedOff.encoded
                  && SessionEndReason(closePayload: Data([7]), version: 1) == nil && SessionEndReason(closePayload: Data([7]), version: 2) == .turnedOffFromDevice,
                  "version 2's reason keeps its rule")
        for payload in [Data(), Data([0]), Data([11]), Data([8, 8])] {
            try check(SessionEndReason(closePayload: payload, version: 5) == nil, "no reason in \([UInt8](payload))")
        }

        // The view-only reasons: the grant (5), and for a controller granted control the push gate (6) or this build (7).
        let versionFive: [ScreenInputAvailability] = [.viewOnly, .notificationsUnconfirmed, .controlNotInThisBuild]
        try check(versionFive.map(\.rawValue) == [5, 6, 7] && versionFive.allSatisfy { $0.minimumVersion == 5 }
                  && ScreenInputAvailability.allCases.filter { !versionFive.contains($0) }.allSatisfy { $0.minimumVersion == 3 },
                  "the view-only reasons are 5's")
        for reason in versionFive {
            let message = ControlMessage.inputAvailability(reason)
            try check(message.minimumVersion == 5 && message.encoded == Data([19, reason.rawValue])
                      && (try ControlMessage(decoding: message.encoded, version: 5)) == message, "\(reason) round trip in 5")
            for version: UInt16 in 1...4 {
                try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: message.encoded, version: version) }
            }
        }
        try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: Data([19, 8]), version: 5) }
        // What a session the host gave no input hears first: the host's reason only for a version-5 controller granted
        // control; a view grant hears viewOnly whatever the host said, an older session what it always heard.
        try check(SessionFeatures(grant: .control, viewOnlyReason: .notificationsUnconfirmed).availabilityWithoutInput(version: 5) == .notificationsUnconfirmed
                  && SessionFeatures(grant: .control, viewOnlyReason: .controlNotInThisBuild).availabilityWithoutInput(version: 5) == .controlNotInThisBuild
                  && SessionFeatures(grant: .control, viewOnlyReason: .permissionsRequired).availabilityWithoutInput(version: 5) == .permissionsRequired
                  && SessionFeatures(grant: .view, viewOnlyReason: .notificationsUnconfirmed).availabilityWithoutInput(version: 5) == .viewOnly
                  && SessionFeatures(grant: .control, viewOnlyReason: .ready).availabilityWithoutInput(version: 5) == .viewOnly
                  && SessionFeatures(grant: .control).availabilityWithoutInput(version: 5) == .viewOnly
                  && (UInt16(1)...4).allSatisfy { SessionFeatures(grant: .control, viewOnlyReason: .notificationsUnconfirmed).availabilityWithoutInput(version: $0) == .permissionsRequired },
                  "the first availability of a session without input")

        // The version-5 messages, including the explicit B-side hold (never sent to a phone).
        let limits = ControlMessage.sessionLimits(grant: .control, limits: SessionLimits(idle: .seconds(3600), maximum: .seconds(28_800)))
        let view = ControlMessage.sessionLimits(grant: .view, limits: SessionLimits(idle: .seconds(3600)))
        let hint = ControlMessage.addressHint([try ScreenPrivateNetworkRoute(address: "10.0.0.2"), try ScreenPrivateNetworkRoute(address: "192.168.1.20")])
        try check(limits.encoded == Data([22, 2, 0, 0, 0x0E, 0x10, 0, 0, 0x70, 0x80]) && view.encoded == Data([22, 1, 0, 0, 0x0E, 0x10, 0, 0, 0, 0])
                  && hint.encoded == Data([23, 2, 10, 0, 0, 2, 192, 168, 1, 20]) && ControlMessage.unenrollSelf.encoded == Data([24])
                  && ControlMessage.inputHeldAtMac(true).encoded == Data([25, 1]) && ControlMessage.inputHeldAtMac(false).encoded == Data([25, 0]),
                  "the wire forms")
        let widest = ControlMessage.addressHint(try (1...4).map { try ScreenPrivateNetworkRoute(address: "172.16.0.\($0)") })
        for message in [limits, view, hint, widest, .unenrollSelf, .inputHeldAtMac(true), .inputHeldAtMac(false),
                        .sessionLimits(grant: .view, limits: SessionLimits(idle: .seconds(1), maximum: .seconds(86_400)))] {
            try check(message.minimumVersion == 5 && (try ControlMessage(decoding: message.encoded, version: 5)) == message, "\(message) in 5")
            for version: UInt16 in 1...4 {
                try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: message.encoded, version: version) }
            }
        }
        try check(limits.sender == .mac && hint.sender == .mac && ControlMessage.inputHeldAtMac(true).sender == .mac
                  && ControlMessage.unenrollSelf.sender == .device, "directions")
        for bad in [Data([22, 0, 0, 0, 0, 1, 0, 0, 0, 0]), Data([22, 3, 0, 0, 0, 1, 0, 0, 0, 0]),
                    Data([22, 1, 0, 0, 0, 0, 0, 0, 0, 0]), Data([22, 1, 0, 1, 0x51, 0x81, 0, 0, 0, 0]),
                    Data([22, 1, 0, 0, 0, 1, 0, 1, 0x51, 0x81]), Data([22, 1, 0, 0, 0, 1, 0, 0, 0]), Data([22, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0]),
                    Data([23]), Data([23, 0]), Data([23, 1, 10, 0, 0]), Data([23, 1, 10, 0, 0, 1, 0]), Data([23, 2, 10, 0, 0, 1]),
                    Data([23, 5, 10, 0, 0, 1, 10, 0, 0, 2, 10, 0, 0, 3, 10, 0, 0, 4, 10, 0, 0, 5]),
                    Data([23, 1, 8, 8, 8, 8]), Data([23, 1, 127, 0, 0, 1]), Data([23, 2, 10, 0, 0, 1, 10, 0, 0, 1]),
                    Data([24, 0]), Data([25]), Data([25, 2]), Data([25, 1, 0])] {
            try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: bad, version: 5) }
        }
        // Limits that are not whole seconds within a day are never put on the wire; `wireLimits` rounds them up and in.
        let fractional = ControlMessage.sessionLimits(grant: .view, limits: SessionLimits(idle: .milliseconds(1500)))
        try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: fractional.encoded, version: 5) }
        try check(ControlMessage.wireLimits(SessionLimits(idle: .milliseconds(1500), maximum: .seconds(3 * 86_400)))
                  == SessionLimits(idle: .seconds(2), maximum: .seconds(86_400))
                  && ControlMessage.wireLimits(SessionLimits(idle: .zero)) == SessionLimits(idle: .seconds(1))
                  && ControlMessage.wireLimits(.standard) == .standard, "wire limits")
    }

    func testExplicitMacHoldOverSession() async throws {
        let fixture = PeerFixture()
        let (listener, endpoint) = try await peerListener(fixture.mac, accepting: [.phone, .controller])
        defer { listener.stop() }
        for controller in [true, false] {
            let client = try await within(5) {
                try await ScreenClient.connect(to: endpoint, handshake: controller ? fixture.controller() : fixture.phone(),
                                               signer: controller ? fixture.controllerSigner : fixture.phoneSigner)
            }
            let mac = try await nextSession(listener).connection
            let samples = Collector<PhysicalInputSnapshot>(), injected = Collector<InputEvent>(), notices = Collector<ScreenNotice>()
            samples.add(.init(available: true))
            let receiver = InputReceiver(physicalInput: { samples.all.last! }, inject: { injected.add($0) })
            let pump = VideoPump(connection: mac, input: receiver, encoderFactory: EncoderShop().factory)
            let viewer = ScreenViewer(connection: client)
            let hearing = Task { for await notice in viewer.notices { notices.add(notice) } }
            let watching = Task { for try await _ in viewer.pictures() {} }
            let running = Task { try await pump.run(features: SessionFeatures(reportsInputAvailability: true, grant: .control)) }
            try await waitUntil { notices.all.contains(.inputAvailability(.ready)) }
            samples.add(.init(available: true, heldAtMac: true))
            try await waitUntil { notices.all.contains(.remoteInputPaused) }
            if controller { try await waitUntil { notices.all.contains(.inputHeldAtMac(true)) } }
            try await client.send(.input, InputCodec.encode(.button(.left, isDown: true)))
            try await Task.sleep(for: .milliseconds(300))
            try check(injected.all.isEmpty, "held input must not be injected")
            samples.add(.init(available: true))
            try await waitUntil { notices.all.contains(.remoteInputResumed) }
            if controller {
                try await waitUntil { notices.all.contains(.inputHeldAtMac(false)) }
                var state = ScreenMacState()
                state.hear(.sessionLimits(grant: .control, limits: .standard))
                state.hear(.inputAvailability(.ready))
                state.hear(.inputHeldAtMac(true))
                state.hear(.macLocked)
                state.hear(.inputAvailability(.secureInput))
                let measured = ScreenInputCalibration(status: .passed, hardwareSourceStates: [1], virtualKeyboardTypes: [77])
                try check(!state.canSendInput && !ViewerInputGate.allowsLockedEntry(state, calibration: measured),
                          "hold also blocks locked entry")
                try check(ScreenTargetText.band(state, pausedHere: false).contains(ScreenTargetText.inputHeldAtMac), "hold stays visible")
                state.hear(.inputHeldAtMac(false))
                try check(!ScreenTargetText.band(state, pausedHere: false).contains(ScreenTargetText.inputHeldAtMac), "only hand-back clears hold")
            } else {
                try check(client.version == 4 && !notices.all.contains(.inputHeldAtMac(true)) && !notices.all.contains(.inputHeldAtMac(false)),
                          "phone receives no new v5 notice")
            }
            client.close()
            _ = try? await finished(watching)
            _ = try? await finished(running)
            hearing.cancel()
        }

        // A new controller session may start while B is still held from a prior phone or Mac session.
        do {
            let client = try await within(5) { try await ScreenClient.connect(to: endpoint, handshake: fixture.controller(), signer: fixture.controllerSigner) }
            let mac = try await nextSession(listener).connection
            let samples = Collector<PhysicalInputSnapshot>(), notices = Collector<ScreenNotice>()
            samples.add(.init(available: true, heldAtMac: true))
            let receiver = InputReceiver(physicalInput: { samples.all.last! }, inject: { _ in })
            let pump = VideoPump(connection: mac, input: receiver, encoderFactory: EncoderShop().factory)
            let viewer = ScreenViewer(connection: client)
            let hearing = Task { for await notice in viewer.notices { notices.add(notice) } }
            let watching = Task { for try await _ in viewer.pictures() {} }
            let running = Task { try await pump.run(features: SessionFeatures(reportsInputAvailability: true, grant: .control)) }
            try await waitUntil { notices.all.contains(.inputHeldAtMac(true)) && notices.all.contains(.remoteInputPaused) }
            samples.add(.init(available: true))
            try await waitUntil { notices.all.contains(.inputHeldAtMac(false)) && notices.all.contains(.remoteInputResumed) }
            client.close(); _ = try? await finished(watching); _ = try? await finished(running); hearing.cancel()
        }

        // A fake plaintext record cannot cause the viewer to announce a hold before authentication of that record.
        let client = try await within(5) { try await ScreenClient.connect(to: endpoint, handshake: fixture.controller(), signer: fixture.controllerSigner) }
        let mac = try await nextSession(listener).connection
        let viewer = ScreenViewer(connection: client), notices = Collector<ScreenNotice>()
        let hearing = Task { for await notice in viewer.notices { notices.add(notice) } }
        let watching = Task { for try await _ in viewer.pictures() {} }
        try await mac.framed.send(Data(repeating: 0x19, count: 40))
        do { try await finished(watching); throw CheckFailure(description: "forged record accepted") }
        catch is CheckFailure { throw CheckFailure(description: "forged record accepted or timed out") }
        catch {}
        try check(!notices.all.contains(.inputHeldAtMac(true)), "forged hold never reaches the viewer")
        hearing.cancel(); client.close(); mac.close()
    }

    func testVersionFiveSessionTellsLimitsAndTakesUnenrolment() async throws {
        let fixture = PeerFixture()
        let (listener, endpoint) = try await peerListener(fixture.mac, accepting: [.phone, .controller])
        defer { listener.stop() }
        func open(asController: Bool) async throws -> (viewer: SecureConnection, mac: SecureConnection) {
            let client = try await within(5) {
                try await ScreenClient.connect(to: endpoint, handshake: asController ? fixture.controller() : fixture.phone(),
                                               signer: asController ? fixture.controllerSigner : fixture.phoneSigner)
            }
            return (client, try await nextSession(listener).connection)
        }

        // A view-only controller session: the grant and limits, the address hint, then why input is closed.
        let five = try await open(asController: true)
        let unenrolled = Collector<Int>()
        let addresses = [try ScreenPrivateNetworkRoute(address: "192.168.0.7"), try ScreenPrivateNetworkRoute(address: "192.168.0.7"),
                         try ScreenPrivateNetworkRoute(address: "10.1.2.3")]
        let pump = VideoPump(connection: five.mac, limits: SessionLimits(idle: .seconds(3600), maximum: .milliseconds(28_800_500)),
                             encoderFactory: EncoderShop().factory)
        let running = Task {
            try await pump.run(features: SessionFeatures(reportsInputAvailability: true, addressHint: addresses,
                                                         unenrollSelf: { unenrolled.add(1) }))
        }
        let viewer = ScreenViewer(connection: five.viewer)
        let notices = Collector<ScreenNotice>()
        let reading = Task { for await notice in viewer.notices { notices.add(notice) } }
        let watching = Task { for try await _ in viewer.pictures() {} }
        try await waitUntil { notices.all.count >= 4 }
        try check(Array(notices.all.prefix(4)) == [
            .sessionLimits(grant: .view, limits: SessionLimits(idle: .seconds(3600), maximum: .seconds(28_801))),
            .addressHint([try ScreenPrivateNetworkRoute(address: "192.168.0.7"), try ScreenPrivateNetworkRoute(address: "10.1.2.3")]),
            .inputAvailability(.viewOnly), .remoteInputPaused,
        ], "the controller hears: \(notices.all)")
        var state = ScreenMacState()
        for notice in notices.all { state.hear(notice) }
        try check(state.grant == .view && state.limits?.maximum == .seconds(28_801) && state.addressHint.count == 2
                  && !state.canSendInput && state.inputAvailability == .viewOnly, "the Viewer's state")
        try await viewer.unenrollSelf()
        try await expectError(HandshakeError.alreadyUsed) { try await viewer.unenrollSelf() }
        _ = try await finished(watching)
        try await finished(running)
        try check(unenrolled.all == [1] && pump.endReason == .revoked && viewer.endReason == .revoked,
                  "unenrolled once, ended as revoked: \(unenrolled.all) \(String(describing: viewer.endReason))")
        reading.cancel()

        // A controller session with input is told `control`; the Mac's own messages from the controller end it.
        let control = try await open(asController: true)
        let receiver = InputReceiver(physicalInput: { .init(available: true) }, inject: { _ in })
        let controlPump = VideoPump(connection: control.mac, input: receiver, encoderFactory: EncoderShop().factory)
        let controlRunning = Task { try await controlPump.run(features: SessionFeatures(grant: .control)) }
        let first = try await within(3) { try await control.viewer.receive() }
        try check(first.type == .control && (try ControlMessage(decoding: first.payload, version: 5))
                  == .sessionLimits(grant: .control, limits: .standard), "the first message names the grant")
        try await control.viewer.send(.control, ControlMessage.sessionLimits(grant: .control, limits: .standard).encoded)
        try await expectError(ScreenControlWireError.malformed) { try await finished(controlRunning) }

        // A phone session (4) hears none of it, keeps its old view-only reason, and cannot unenrol.
        let four = try await open(asController: false)
        try check(four.viewer.version == 4, "a phone settles on 4")
        let phonePump = VideoPump(connection: four.mac, encoderFactory: EncoderShop().factory)
        let phoneRunning = Task {
            try await phonePump.run(features: SessionFeatures(reportsInputAvailability: true, grant: .view, addressHint: addresses,
                                                              unenrollSelf: { unenrolled.add(2) }))
        }
        let heard = try await within(3) { try await four.viewer.receive() }
        try check(heard.type == .control && (try ControlMessage(decoding: heard.payload, version: 4)) == .inputAvailability(.permissionsRequired),
                  "a phone's first message is the version-3 reason")
        let phoneViewer = ScreenViewer(connection: four.viewer)
        try await expectError(ChannelError.notNegotiated) { try await phoneViewer.unenrollSelf() }
        try await expectError(ChannelError.notNegotiated) { try await four.viewer.send(ControlMessage.unenrollSelf) }
        try await expectError(ChannelError.notNegotiated) { try await four.mac.send(ControlMessage.inputAvailability(.viewOnly)) }
        try await four.viewer.send(.control, ControlMessage.unenrollSelf.encoded)
        try await expectError(ScreenControlWireError.malformed) { try await finished(phoneRunning) }
        try check(unenrolled.all == [1], "a phone cannot unenrol a controller")
    }

    func testVersionFiveEndReasonsReachOlderPeersInTheirOlderForm() async throws {
        let fixture = PeerFixture()
        let (listener, endpoint) = try await peerListener(fixture.mac, accepting: [.phone, .controller])
        defer { listener.stop() }
        for (asController, reason, expected) in [(true, SessionEndReason.takenOver, SessionEndReason?.some(.takenOver)),
                                                 (false, .takenOver, .replaced), (true, .busy, .busy), (false, .busy, nil),
                                                 (true, .captureUnavailable, .captureUnavailable), (false, .captureUnavailable, .endedAtMac)] {
            let client = try await within(5) {
                try await ScreenClient.connect(to: endpoint, handshake: asController ? fixture.controller() : fixture.phone(),
                                               signer: asController ? fixture.controllerSigner : fixture.phoneSigner)
            }
            let session = try await nextSession(listener)
            let pump = VideoPump(connection: session.connection, encoderFactory: EncoderShop().factory)
            let viewer = ScreenViewer(connection: client)
            let watching = Task { for try await _ in viewer.pictures() {} }
            let running = Task { try await pump.run() }
            await pump.end(reason).value
            _ = try await finished(watching)
            try await finished(running)
            try check(viewer.endReason == expected, "\(reason) to a \(asController ? "controller" : "phone"): \(String(describing: viewer.endReason))")
        }
    }

    func testViewGrantDropsTheInputTheHostPassed() async throws {
        // The host hands the pump a live input receiver and a desktop, and grants only `view`. The core itself drops the
        // controller's input and refuses its keyboard and Spaces requests (SR-21); with `control`, and for a phone, which
        // has no grant, the same session takes them.
        let fixture = PeerFixture()
        let (listener, endpoint) = try await peerListener(fixture.mac, accepting: [.phone, .controller])
        defer { listener.stop() }
        for (asController, grant) in [(true, ScreenSessionGrant.view), (true, .control), (false, .view)] {
            let name = "\(asController ? "controller" : "phone") granted \(grant)"
            let client = try await within(5) {
                try await ScreenClient.connect(to: endpoint, handshake: asController ? fixture.controller() : fixture.phone(),
                                               signer: asController ? fixture.controllerSigner : fixture.phoneSigner)
            }
            let mac = try await nextSession(listener).connection
            let injected = Collector<InputEvent>(), posted = Collector<String>()
            let receiver = InputReceiver(physicalInput: { .init(available: true) }, compound: { text, _ in
                posted.add(text); return .posted
            }, inject: { injected.add($0) })
            let desktop = CountingDesktop()
            let pump = VideoPump(connection: mac, input: receiver, encoderFactory: EncoderShop().factory)
            let running = Task {
                try await pump.run(features: SessionFeatures(desktop: desktop, reportsInputAvailability: true, grant: grant))
            }
            try await client.send(.input, InputCodec.encode(.pointerMove(x: 0.5, y: 0.5)))
            try await client.send(.input, InputCodec.encode(.button(.left, isDown: true)))
            try await client.send(.input, InputCodec.encode(.textAndReturn(id: 7, text: "secret")))
            try await client.send(ControlMessage.keyboardAction(id: 8, .capsOn))
            try await client.send(ControlMessage.navigateSpace(.next))
            // Replies come in the order the Mac read the records; the Space's is last.
            var heard: [ControlMessage] = []
            while !heard.contains(where: { if case .spaceResult = $0 { true } else { false } }) {
                let record = try await within(3) { try await client.receive() }
                if record.type == .control { heard.append(try ControlMessage(decoding: record.payload, version: client.version)) }
            }
            let actions = await desktop.actions, spaces = await desktop.spaces
            if asController, grant == .view {
                try check(Array(heard.prefix(3)) == [.sessionLimits(grant: .view, limits: .standard), .inputAvailability(.viewOnly),
                                                     .remoteInputPaused], "\(name) is told it may only watch: \(heard)")
                try check(injected.all.isEmpty && posted.all.isEmpty && actions.isEmpty && spaces.isEmpty,
                          "\(name): nothing reached the Mac: \(injected.all) \(posted.all) \(actions) \(spaces)")
                try check(heard.contains(.textAndReturnResult(id: 7, .blocked))
                          && heard.contains(.keyboardState(id: 8, CountingDesktop.state, .blocked))
                          && heard.contains(.spaceResult(.next, .blocked)), "\(name) hears each request blocked: \(heard)")
            } else {
                if asController {
                    try check(heard.first == .sessionLimits(grant: .control, limits: .standard), "\(name) is told control: \(heard)")
                } else {
                    try check(client.version == 4 && !heard.contains { if case .sessionLimits = $0 { true } else { false } },
                              "\(name) settles on 4 and hears no grant: \(heard)")
                }
                try check(heard.contains(.inputAvailability(.ready)) && !heard.contains(.inputAvailability(.viewOnly)),
                          "\(name) may control: \(heard)")
                try check(Array(injected.all.prefix(2)) == [.pointerMove(x: 0.5, y: 0.5), .button(.left, isDown: true)]
                          && posted.all == ["secret"] && actions == [.capsOn] && spaces == [.next],
                          "\(name): the input reached the Mac: \(injected.all) \(posted.all) \(actions) \(spaces)")
                try check(heard.contains(.textAndReturnResult(id: 7, .posted))
                          && heard.contains(.keyboardState(id: 8, CountingDesktop.state, .applied))
                          && heard.contains(.spaceResult(.next, .applied)), "\(name) hears each request applied: \(heard)")
            }
            // The controller leaves; the pump ends with the connection, and only a hang fails the check.
            client.close()
            do { try await finished(running) } catch let failure as CheckFailure { throw failure } catch {}
        }
    }
}

/// A desktop that records what it is asked to change and changes nothing.
private actor CountingDesktop: DesktopControlling {
    static let state = ScreenKeyboardState(language: .latin, capsLock: false, canSelectLatin: true, canSelectKorean: true)
    var actions: [ScreenKeyboardAction] = []
    var spaces: [ScreenSpaceAction] = []
    func keyboardState() -> ScreenKeyboardState { Self.state }
    func keyboard(_ action: ScreenKeyboardAction) -> (ScreenKeyboardState, ScreenControlResult) {
        actions.append(action); return (Self.state, .applied)
    }
    func navigate(_ action: ScreenSpaceAction) -> ScreenControlResult { spaces.append(action); return .applied }
    func spaceChanges() -> AsyncStream<Bool> { AsyncStream { _ in } }
}
