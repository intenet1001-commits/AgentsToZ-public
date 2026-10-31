import CryptoKit
import Foundation
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// Security requirement checks for DESIGN SR-1..SR-7, SR-13, SR-14, SR-16, SR-17, the registration rules, App Attest and
// the session limits.
// Runs two ways: `swift test`, and `scripts/check-screen-control.ts` (swiftc -D CORE_CHECKS), which needs no XCTest.

struct CheckFailure: Error, CustomStringConvertible { let description: String }

func check(_ condition: Bool, _ message: @autoclosure () -> String, line: Int = #line) throws {
    if !condition { throw CheckFailure(description: "line \(line): \(message())") }
}

func expectError<E: Error & Equatable>(_ expected: E, line: Int = #line, _ body: () async throws -> Void) async throws {
    do {
        try await body()
    } catch let error as E {
        try check(error == expected, "expected \(expected), got \(error)", line: line)
        return
    } catch {
        throw CheckFailure(description: "line \(line): expected \(expected), got \(error)")
    }
    throw CheckFailure(description: "line \(line): expected \(expected), nothing was thrown")
}

struct SoftwareSigner: TranscriptSigner, @unchecked Sendable {
    let key: P256.Signing.PrivateKey
    init(key: P256.Signing.PrivateKey = .init()) { self.key = key }
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for: data) }
}

/// Counts how often it is asked to sign: a fake Mac must never reach the phone's Face ID prompt.
actor SignCounter { var count = 0; func bump() { count += 1 } }
struct CountingSigner: TranscriptSigner, @unchecked Sendable {
    let inner = SoftwareSigner()
    let counter = SignCounter()
    var publicKey: P256.Signing.PublicKey { inner.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
        await counter.bump()
        return try await inner.signature(for: data)
    }
}

/// Claims one identity but signs with another key: a registered device E pretending to be device D.
struct ImpostorSigner: TranscriptSigner, @unchecked Sendable {
    let claimed: P256.Signing.PublicKey
    let actual = P256.Signing.PrivateKey()
    var publicKey: P256.Signing.PublicKey { claimed }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try actual.signature(for: data) }
}

/// Signs the transcript under the other role's label.
struct MislabelingSigner: TranscriptSigner, @unchecked Sendable {
    let inner = SoftwareSigner()
    let from: Data, to: Data
    var publicKey: P256.Signing.PublicKey { inner.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
        try await inner.signature(for: data.starts(with: from) ? to + data.dropFirst(from.count) : data)
    }
}

/// Stands in for App Attest in the registration checks: it "attests" a request by echoing its clientDataHash, so a
/// check can tell whether the window asked about the right record. AppAttestSample covers the real verifier.
struct EchoAttester: AppAttestationVerifying {
    func verify(_ attestation: Data, keyID: Data, clientDataHash: Data, at date: Date) throws -> AppAttestation {
        guard attestation == clientDataHash else { throw AppAttestError.nonceMismatch }
        return AppAttestation(publicKey: P256.Signing.PrivateKey().publicKey, keyID: keyID, receipt: Data())
    }
}

/// Test-side CBOR writer, to rebuild an attestation object with one part changed.
func encodeCBOR(_ value: CBOR) -> Data {
    func head(_ major: UInt8, _ argument: Int) -> Data {
        switch argument {
        case ..<24: Data([major << 5 | UInt8(argument)])
        case ..<0x100: Data([major << 5 | 24, UInt8(argument)])
        case ..<0x10000: Data([major << 5 | 25]) + UInt16(argument).bigEndianData
        default: Data([major << 5 | 26]) + UInt32(argument).bigEndianData
        }
    }
    switch value {
    case .unsigned(let n): return head(0, Int(n))
    case .negative(let n): return head(1, Int(n))
    case .bytes(let data): return head(2, data.count) + data
    case .text(let text): return head(3, text.utf8.count) + Data(text.utf8)
    case .array(let items): return items.reduce(head(4, items.count)) { $0 + encodeCBOR($1) }
    case .map(let map):
        return map.sorted { $0.key < $1.key }.reduce(head(5, map.count)) { $0 + encodeCBOR(.text($1.key)) + encodeCBOR($1.value) }
    }
}

/// DER TLV with a minimal length, for hand-built certificate shapes.
func der(_ tag: UInt8, _ content: Data) -> Data {
    let n = content.count
    let length: Data = n < 0x80 ? Data([UInt8(n)]) : n < 0x100 ? Data([0x81, UInt8(n)]) : Data([0x82, UInt8(n >> 8), UInt8(n & 0xFF)])
    return Data([tag]) + length + content
}

struct Fixture: @unchecked Sendable {
    let macSigner: TranscriptSigner
    let deviceSigner: TranscriptSigner
    let mac: MacHandshake

    /// The Mac negotiates like this build unless `macVersions` says otherwise (`.only(1)` plays a version-1 Mac).
    init(macSigner: TranscriptSigner = SoftwareSigner(), deviceSigner: TranscriptSigner = SoftwareSigner(),
         registered: [P256.Signing.PublicKey]? = nil, macVersions: VersionPolicy = .current) {
        self.macSigner = macSigner
        self.deviceSigner = deviceSigner
        let keys = registered ?? [deviceSigner.publicKey]
        let registry = Dictionary(uniqueKeysWithValues: keys.map { (ScreenControlIdentity.fingerprint(of: $0), $0) })
        mac = MacHandshake(signer: macSigner, replay: NonceReplayCache(), versions: macVersions) { registry[$0] }
    }

    /// A phone that negotiates like this build; with `version`, one that speaks exactly that version and offers nothing.
    func device(version: UInt16? = nil) -> DeviceHandshake {
        device(versions: version.map { .only($0) } ?? .current)
    }

    func device(versions: VersionPolicy) -> DeviceHandshake {
        DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: deviceSigner.publicKey, versions: versions)
    }

    /// A full handshake; returns (Mac channel, device channel).
    func connect() async throws -> (SecureChannel, SecureChannel) {
        let device = device()
        let (reply, pending) = try await mac.respond(to: device.hello)
        let (finish, deviceChannel) = try await device.finish(macHello: reply, signer: deviceSigner)
        return (try await pending.confirm(finish), deviceChannel)
    }
}

/// A Mac key as the phone would hold it after checking its fingerprint.
func pinned(_ key: P256.Signing.PublicKey) -> PinnedMac {
    try! PinnedMac(publicKey: key, fingerprint: ScreenControlIdentity.fingerprint(of: key))
}

func keyBytes(_ key: SymmetricKey) -> Data { key.withUnsafeBytes { Data($0) } }

func hex(_ text: String) -> Data {
    Data(stride(from: 0, to: text.count, by: 2).map { UInt8(text.dropFirst($0).prefix(2), radix: 16)! })
}

func flipByte(_ data: Data, at offset: Int) -> Data {
    var bytes = [UInt8](data)
    bytes[offset] ^= 0x01
    return Data(bytes)
}

struct ScreenControlChecks {
    func testHandshakeAgreesAndCarriesRecordsBothWays() async throws {
        let fixture = Fixture()
        let device = fixture.device()
        let (reply, pending) = try await fixture.mac.respond(to: device.hello)
        try check(pending.deviceID == ScreenControlIdentity.fingerprint(of: fixture.deviceSigner.publicKey), "device ID")
        let (finish, deviceChannel) = try await device.finish(macHello: reply, signer: fixture.deviceSigner)
        let macChannel = try await pending.confirm(finish)
        for n in 0..<3 {
            let frame = Data("frame \(n)".utf8)
            let opened = try deviceChannel.open(try macChannel.seal(.video, frame))
            try check(opened.type == .video && opened.payload == frame, "Mac to device record \(n)")
            let input = InputCodec.encode(.pointerMove(x: 0.25, y: 0.75))
            let received = try macChannel.open(try deviceChannel.seal(.input, input))
            try check(received.type == .input && received.payload == input, "device to Mac record \(n)")
        }
    }

    func testFakeMacIsRefusedBeforeFaceID() async throws {
        let counting = CountingSigner()
        let real = Fixture(deviceSigner: counting)
        let fake = Fixture(deviceSigner: counting)   // another Mac key, same registered phone
        let device = real.device()
        let (reply, _) = try await fake.mac.respond(to: device.hello)
        try await expectError(HandshakeError.badSignature) { _ = try await device.finish(macHello: reply, signer: counting) }
        try check(await counting.counter.count == 0, "Face ID signer was asked for a fake Mac")
    }

    func testUnknownOrInconsistentDeviceIsRefused() async throws {
        let stranger = Fixture(registered: [SoftwareSigner().publicKey])
        try await expectError(HandshakeError.unknownDevice) { _ = try await stranger.mac.respond(to: stranger.device().hello) }
        // A registry row whose key does not hash to its ID is treated as unknown, not trusted.
        let signer = SoftwareSigner(), other = SoftwareSigner().publicKey
        let id = ScreenControlIdentity.fingerprint(of: signer.publicKey)
        let corrupt = MacHandshake(signer: SoftwareSigner(), replay: NonceReplayCache()) { $0 == id ? other : nil }
        let device = DeviceHandshake(mac: pinned(SoftwareSigner().publicKey), devicePublicKey: signer.publicKey)
        try await expectError(HandshakeError.unknownDevice) { _ = try await corrupt.respond(to: device.hello) }
    }

    func testAnotherRegisteredDeviceCannotClaimSomeoneElsesIdentity() async throws {
        let victim = SoftwareSigner()
        let impostor = ImpostorSigner(claimed: victim.publicKey)
        let fixture = Fixture(deviceSigner: impostor, registered: [victim.publicKey, impostor.actual.publicKey])
        let device = fixture.device()
        let (reply, pending) = try await fixture.mac.respond(to: device.hello)
        let (finish, _) = try await device.finish(macHello: reply, signer: impostor)
        try await expectError(HandshakeError.badSignature) { _ = try await pending.confirm(finish) }
    }

    func testRoleLabelsAreNotInterchangeable() async throws {
        let labels = HandshakeLabels(version: ScreenControlProtocol.version)
        let mislabeledMac = MislabelingSigner(from: labels.macSignature, to: labels.deviceSignature)
        let macSide = Fixture(macSigner: mislabeledMac)
        let device = macSide.device()
        let (reply, _) = try await macSide.mac.respond(to: device.hello)
        try await expectError(HandshakeError.badSignature) { _ = try await device.finish(macHello: reply, signer: macSide.deviceSigner) }

        let mislabeledDevice = MislabelingSigner(from: labels.deviceSignature, to: labels.macSignature)
        let deviceSide = Fixture(deviceSigner: mislabeledDevice)
        let phone = deviceSide.device()
        let (answer, pending) = try await deviceSide.mac.respond(to: phone.hello)
        let (finish, _) = try await phone.finish(macHello: answer, signer: mislabeledDevice)
        try await expectError(HandshakeError.badSignature) { _ = try await pending.confirm(finish) }
    }

    func testReplayedHelloAndFreshKeys() async throws {
        let fixture = Fixture()
        let first = fixture.device(), second = fixture.device()
        let helloA = try LengthPrefixed.decode(first.hello, count: 4), helloB = try LengthPrefixed.decode(second.hello, count: 4)
        try check(helloA[2] != helloB[2], "each attempt has a fresh nonce")
        try check(helloA[3] != helloB[3], "each attempt has a fresh ephemeral key")
        let (replyA, _) = try await fixture.mac.respond(to: first.hello)
        try await expectError(HandshakeError.replayedNonce) { _ = try await fixture.mac.respond(to: first.hello) }
        let (replyB, _) = try await fixture.mac.respond(to: second.hello)
        let macA = try LengthPrefixed.decode(replyA, count: 5), macB = try LengthPrefixed.decode(replyB, count: 5)
        try check(macA[1] != macB[1], "the Mac's nonce is fresh for every hello")
        try check(macA[2] != macB[2], "the Mac's ephemeral key is fresh for every hello")
    }

    func testTamperedConfirmationsAndOtherVersionsAreRefused() async throws {
        let fixture = Fixture()
        let tampered = fixture.device()
        let (tamperedReply, _) = try await fixture.mac.respond(to: tampered.hello)
        try await expectError(HandshakeError.badConfirmation) {
            _ = try await tampered.finish(macHello: flipByte(tamperedReply, at: tamperedReply.count - 1), signer: fixture.deviceSigner)
        }
        let device = fixture.device()
        let (reply, pending) = try await fixture.mac.respond(to: device.hello)
        let (finish, _) = try await device.finish(macHello: reply, signer: fixture.deviceSigner)
        try await expectError(HandshakeError.badConfirmation) { _ = try await pending.confirm(flipByte(finish, at: finish.count - 1)) }
        // SR-1: the version is inside T, so a peer on another version never verifies.
        let newer = fixture.device(version: ScreenControlProtocol.version + 1)
        let (old, _) = try await fixture.mac.respond(to: newer.hello)
        try await expectError(HandshakeError.badSignature) { _ = try await newer.finish(macHello: old, signer: fixture.deviceSigner) }
    }

    func testMalformedHandshakeMessagesAreRefused() async throws {
        let fixture = Fixture()
        let hello = fixture.device().hello
        var fields = try LengthPrefixed.decode(hello, count: 4)
        let cases: [Data] = [
            hello.dropLast(),
            hello + Data([0]),
            LengthPrefixed.encode(fields + [Data()]),
            LengthPrefixed.encode([Data([MessageTag.macHello.rawValue])] + fields.dropFirst()),
            { fields[3][0] = 0x02; return LengthPrefixed.encode(fields) }(),                   // compressed point
            { fields[3] = Data([0x04]) + Data(repeating: 0x07, count: 64); return LengthPrefixed.encode(fields) }(), // off the curve
        ]
        for message in cases {
            try await expectError(HandshakeError.malformed) { _ = try await fixture.mac.respond(to: message) }
        }
    }

    func testChannelRefusesReplaySkipReflectionAndTampering() async throws {
        var (mac, device) = try await Fixture().connect()
        let first = try mac.seal(.video, Data("one".utf8)), second = try mac.seal(.video, Data("two".utf8))
        try await expectError(ChannelError.outOfOrder) { _ = try device.open(second) }
        try await expectError(ChannelError.closed) { _ = try device.open(first) }
        try check(device.isClosed, "a refused record closes the channel")

        (mac, device) = try await Fixture().connect()
        let record = try mac.seal(.control, Data("locked".utf8))
        _ = try device.open(record)
        try await expectError(ChannelError.outOfOrder) { _ = try device.open(record) }

        (mac, device) = try await Fixture().connect()
        let own = try mac.seal(.control, Data("reflect".utf8))
        try await expectError(ChannelError.authenticationFailed) { _ = try mac.open(own) }

        for tamper in [{ (r: Data) in flipByte(r, at: r.count - 20) }, { (r: Data) in flipByte(r, at: 0) }] {
            (mac, device) = try await Fixture().connect()
            let sealed = try mac.seal(.video, Data("frame".utf8))   // type 1 -> 0 is malformed; 1 -> 3 would be input
            let changed = tamper(sealed)
            do {
                _ = try device.open(changed)
                throw CheckFailure(description: "tampered record opened")
            } catch let error as ChannelError {
                try check([.authenticationFailed, .malformed].contains(error), "tamper gave \(error)")
            }
        }
        (mac, device) = try await Fixture().connect()
        var retyped = [UInt8](try mac.seal(.video, Data("frame".utf8)))
        retyped[0] = RecordType.control.rawValue
        try await expectError(ChannelError.authenticationFailed) { _ = try device.open(Data(retyped)) }
        try await expectError(ChannelError.tooLarge) { _ = try mac.seal(.video, Data(count: SecureChannel.maxPayload + 1)) }

        // Each end sends and receives only its own kinds: the phone never sends video, the Mac never takes it.
        (mac, device) = try await Fixture().connect()
        try await expectError(ChannelError.wrongDirection) { _ = try device.seal(.video, Data()) }
        try await expectError(ChannelError.wrongDirection) { _ = try mac.seal(.input, Data()) }
        let header = Data([RecordType.video.rawValue]) + UInt64(0).bigEndianData
        let box = try AES.GCM.seal(Data("frame".utf8), using: device.sendKey, nonce: SecureChannel.nonce(0),
                                   authenticating: device.label + header)
        try await expectError(ChannelError.wrongDirection) { _ = try mac.open(header + box.ciphertext + box.tag) }
        try check(mac.isClosed, "a record of the wrong kind closes the channel")
    }

    func testInputCodecIsStrict() async throws {
        let events: [InputEvent] = [.pointerMove(x: 0, y: 1), .button(.right, isDown: true), .scroll(dx: -120, dy: 3.5),
                                    .key(code: 0x37, isDown: true, modifiers: [.command, .shift]),
                                    .text("한글 입력"), .text("👩‍💻")]
        for event in events { try check(try InputCodec.decode(InputCodec.encode(event)) == event, "round trip \(event)") }
        let malformed: [Data] = [
            Data([9]), Data(), InputCodec.encode(.button(.left, isDown: true)) + Data([0]),
            Data([2, 0, 2]), Data([2, 7, 1]), Data([4, 0, 0x37, 1, 0x80]),
            Data([5]) + Data("bell\u{07}".utf8), Data([5]), Data([5, 0xFF, 0xFE]),
            Data([5]) + Data(String(repeating: "a", count: InputCodec.maxTextBytes + 1).utf8),
        ]
        for data in malformed { try await expectError(InputError.malformed) { _ = try InputCodec.decode(data) } }
        let outOfRange: [InputEvent] = [.pointerMove(x: 1.5, y: 0), .pointerMove(x: .nan, y: 0), .scroll(dx: 0, dy: .infinity),
                                        .scroll(dx: InputCodec.maxScrollDelta * 2, dy: 0),
                                        .key(code: 0x80, isDown: true, modifiers: [])]
        for event in outOfRange {
            try await expectError(InputError.outOfRange) { _ = try InputCodec.decode(InputCodec.encode(event)) }
        }
    }

    func testRateLimitAndHeldInputRelease() async throws {
        var limiter = TokenBucket(perSecond: 1, burst: 3)
        let start = ContinuousClock.now
        try check((0..<3).allSatisfy { _ in limiter.admit(at: start) }, "burst admitted")
        try check(!limiter.admit(at: start), "over budget dropped")
        try check(limiter.admit(at: start.advanced(by: .seconds(1))), "refills over time")

        var held = InputGate()
        for event: InputEvent in [.key(code: 0x37, isDown: true, modifiers: [.command]), .button(.left, isDown: true),
                                  .key(code: 0x00, isDown: true, modifiers: []), .key(code: 0x00, isDown: false, modifiers: [])] {
            try check(held.admit(event, at: start), "admitted \(event)")
        }
        try check(held.releaseAll() == [.button(.left, isDown: false), .key(code: 0x37, isDown: false, modifiers: [])],
                  "teardown releases what is still held")
        try check(held.releaseAll().isEmpty, "nothing left after release")

        // Out of budget, releasing what is held still passes, so Command or a drag is never left pressed.
        var gate = InputGate(perSecond: 1, burst: 2)
        try check(gate.admit(.key(code: 0x37, isDown: true, modifiers: [.command]), at: start)
                  && gate.admit(.button(.left, isDown: true), at: start), "within budget")
        try check(!gate.admit(.key(code: 0x00, isDown: true, modifiers: []), at: start), "over budget, a press is dropped")
        try check(!gate.admit(.key(code: 0x00, isDown: false, modifiers: []), at: start),
                  "a release of something not held spends the budget like anything else")
        try check(gate.admit(.key(code: 0x37, isDown: false, modifiers: []), at: start)
                  && gate.admit(.button(.left, isDown: false), at: start), "releasing what is held always passes")
        try check(gate.releaseAll().isEmpty, "a dropped press never counts as held")
    }

    func testActiveAttackerSwappingEphemeralKeysIsRefused() async throws {
        // SR-4: each side signs the ephemeral keys it saw. An attacker in the middle who swaps both ephemeral keys and
        // recomputes every confirmation from the secrets it shares with each side still breaks a signature.
        let fixture = Fixture()
        let version = ScreenControlProtocol.version, labels = HandshakeLabels(version: version)
        let macFingerprint = ScreenControlIdentity.fingerprint(of: fixture.macSigner.publicKey)
        let towardMac = P256.KeyAgreement.PrivateKey(), towardDevice = P256.KeyAgreement.PrivateKey()
        let device = fixture.device()
        var hello = try LengthPrefixed.decode(device.hello, count: 4)          // tag, device ID, Np, Pe
        let deviceEphemeral = hello[3]
        hello[3] = towardMac.publicKey.x963Representation
        let (reply, pending) = try await fixture.mac.respond(to: LengthPrefixed.encode(hello))
        var answer = try LengthPrefixed.decode(reply, count: 5)                // tag, Nm, Ma, signature, confirmation
        let macEphemeral = answer[2]

        let deviceView = transcriptHash(version: version, macFingerprint: macFingerprint, deviceID: hello[1], deviceNonce: hello[2],
                                        deviceEphemeral: deviceEphemeral, macNonce: answer[1],
                                        macEphemeral: towardDevice.publicKey.x963Representation)
        let deviceKeys = SessionKeys(secret: try towardDevice.sharedSecretFromKeyAgreement(with: try ephemeralKey(deviceEphemeral)),
                                     transcriptHash: deviceView, labels: labels)
        answer[2] = towardDevice.publicKey.x963Representation
        answer[4] = confirmation(deviceKeys.macConfirm, deviceView, answer[3])
        try await expectError(HandshakeError.badSignature) {
            _ = try await device.finish(macHello: LengthPrefixed.encode(answer), signer: fixture.deviceSigner)
        }

        // The Mac side, even if a careless phone had signed what it saw.
        let macView = transcriptHash(version: version, macFingerprint: macFingerprint, deviceID: hello[1], deviceNonce: hello[2],
                                     deviceEphemeral: towardMac.publicKey.x963Representation, macNonce: answer[1],
                                     macEphemeral: macEphemeral)
        let macKeys = SessionKeys(secret: try towardMac.sharedSecretFromKeyAgreement(with: try ephemeralKey(macEphemeral)),
                                  transcriptHash: macView, labels: labels)
        let signed = try await fixture.deviceSigner.signature(for: labels.deviceSignature + deviceView).rawRepresentation
        let relayed = encodeMessage(.deviceFinish, [signed, confirmation(macKeys.deviceConfirm, macView, signed)])
        try await expectError(HandshakeError.badSignature) { _ = try await pending.confirm(relayed) }
    }

    func testKeyScheduleMatchesTheIndependentReference() async throws {
        // Fixed inputs; reference/key-schedule.py derives the expected values without CryptoKit. A key that ignored
        // the ECDH secret, a thinner transcript or a reused nonce would all show here.
        func scalar(_ name: String) -> Data { sha256(Data("agentstoz kat \(name)".utf8)) }
        // Version 1's values, which every build still speaks with a version-1 peer (version 2:
        // testVersionTwoKeyScheduleMatchesTheReference).
        let version: UInt16 = 1
        let macSigner = SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: scalar("mac identity")))
        let deviceSigner = SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: scalar("device identity")))
        let macEphemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar("mac ephemeral"))
        let deviceEphemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar("device ephemeral"))
        let deviceKey = deviceSigner.publicKey
        let mac = MacHandshake(signer: macSigner, replay: NonceReplayCache(), version: version,
                               fresh: { (Data(repeating: 0x22, count: 32), macEphemeral) }) { _ in deviceKey }
        let device = DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: deviceKey, version: version,
                                     nonce: Data(repeating: 0x11, count: 32), ephemeral: deviceEphemeral)
        let (reply, pending) = try await mac.respond(to: device.hello)
        let (finish, deviceChannel) = try await device.finish(macHello: reply, signer: deviceSigner)
        let macChannel = try await pending.confirm(finish)

        let transcript = hex("b408a4342b9c7f3ebc7d79c00897eb50cf1702da0b3a955eecfb26c153ef0f57")
        let macToDevice = hex("3d13201924caf5b934ab3e4705643bf14cc781b5f93d9b4cc5dca85f4104967d")
        let deviceToMac = hex("ef4ebdd61120663c332c428ee0e55780fd88b2561c3260125c18c69ba4cd0fb9")
        let macConfirm = hex("2b9fbd538fe16e68d795757b53a41a5b3a3fa48dd9029908f6ab43a5406f4f35")
        let deviceConfirm = hex("692c54b2ad44933a5080db69e6370c8d260a9ea094132a63a6b2aeae58200a28")
        try check(keyBytes(macChannel.sendKey) == macToDevice && keyBytes(deviceChannel.receiveKey) == macToDevice, "Mac-to-device key")
        try check(keyBytes(deviceChannel.sendKey) == deviceToMac && keyBytes(macChannel.receiveKey) == deviceToMac, "device-to-Mac key")
        let answer = try LengthPrefixed.decode(reply, count: 5), done = try LengthPrefixed.decode(finish, count: 3)
        func hmac(_ key: Data, _ signature: Data) -> Data {
            Data(HMAC<SHA256>.authenticationCode(for: transcript + signature, using: SymmetricKey(data: key)))
        }
        try check(answer[4] == hmac(macConfirm, answer[3]), "the Mac's confirmation is over the reference transcript")
        try check(done[2] == hmac(deviceConfirm, done[1]), "the phone's confirmation is over the reference transcript")
        try check(macSigner.publicKey.isValidSignature(try signature(answer[3]), for: HandshakeLabels(version: version).macSignature + transcript),
                  "the Mac signs the reference transcript")

        // Records follow the stated layout: nonce = 4 zero bytes ‖ counter, AAD = protocol label ‖ header.
        let frame = Data("the same frame".utf8)
        var ciphertexts: [Data] = []
        for counter in UInt64(0)..<2 {
            let record = try macChannel.seal(.video, frame)
            let header = Data([RecordType.video.rawValue]) + counter.bigEndianData
            try check(record.prefix(9) == header, "header \(counter)")
            let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: Data(count: 4) + counter.bigEndianData),
                                            ciphertext: record.dropFirst(9).dropLast(16), tag: record.suffix(16))
            try check(try AES.GCM.open(box, using: SymmetricKey(data: macToDevice),
                                       authenticating: Data("agentstoz.screen-control/v1 record".utf8) + header) == frame,
                      "record \(counter) opens by the stated layout")
            ciphertexts.append(record.dropFirst(9))
        }
        try check(ciphertexts[0] != ciphertexts[1], "the same frame never encrypts the same way twice")
    }

    func testHandshakesAndChannelsCannotBeUsedTwice() async throws {
        // A second finish or confirm would give a second channel with the same keys and counters: AES-GCM nonce reuse.
        let fixture = Fixture()
        let device = fixture.device()
        let (reply, pending) = try await fixture.mac.respond(to: device.hello)
        let (finish, deviceChannel) = try await device.finish(macHello: reply, signer: fixture.deviceSigner)
        try await expectError(HandshakeError.alreadyUsed) { _ = try await device.finish(macHello: reply, signer: fixture.deviceSigner) }
        let macChannel = try await pending.confirm(finish)
        try await expectError(HandshakeError.alreadyUsed) { _ = try await pending.confirm(finish) }

        // A failed attempt uses them up too: nobody retries against the same keys.
        let other = fixture.device()
        let (otherReply, otherPending) = try await fixture.mac.respond(to: other.hello)
        try await expectError(HandshakeError.badConfirmation) {
            _ = try await other.finish(macHello: flipByte(otherReply, at: otherReply.count - 1), signer: fixture.deviceSigner)
        }
        try await expectError(HandshakeError.alreadyUsed) { _ = try await other.finish(macHello: otherReply, signer: fixture.deviceSigner) }
        try await expectError(HandshakeError.badSignature) {
            _ = try await otherPending.confirm(encodeMessage(.deviceFinish, [Data(repeating: 1, count: 64), Data(count: 32)]))
        }
        try await expectError(HandshakeError.alreadyUsed) { _ = try await otherPending.confirm(finish) }

        // A copy of a channel is the same channel, so two senders share one counter.
        let copy = macChannel
        let first = try macChannel.seal(.video, Data("a".utf8)), second = try copy.seal(.video, Data("a".utf8))
        try check(first.prefix(9) != second.prefix(9), "copies share one counter")
        _ = try deviceChannel.open(first)
        _ = try deviceChannel.open(second)
    }

    func testSecureEnclaveSignerSignsWithAFreshContext() async throws {
        guard SecureEnclave.isAvailable else { return print("note  no Secure Enclave here; signer check skipped") }
        // No access control on this test key, so no prompt; the point is that loading from the blob per signature works.
        let key = try SecureEnclave.P256.Signing.PrivateKey()
        let signer = try SecureEnclaveTranscriptSigner(dataRepresentation: key.dataRepresentation)
        try check(signer.publicKey.x963Representation == key.publicKey.x963Representation, "same key")
        let data = Data("transcript".utf8)
        for _ in 0..<2 {
            try check(signer.publicKey.isValidSignature(try await signer.signature(for: data), for: data), "signature verifies")
        }
    }

    func testPreAuthGateBoundsWorkBeforeAuthentication() async throws {
        let start = ContinuousClock.now
        func at(_ seconds: Double) -> ContinuousClock.Instant { start + .milliseconds(Int(seconds * 1000)) }
        func peer(_ host: String) -> PeerKey { PeerKey(host: host)! }
        func ticket(_ result: Result<PreAuthTicket, PreAuthRefusal>, line: Int = #line) throws -> PreAuthTicket {
            guard case .success(let ticket) = result else { throw CheckFailure(description: "line \(line): refused \(result)") }
            return ticket
        }
        func refusal(_ result: Result<PreAuthTicket, PreAuthRefusal>) -> PreAuthRefusal? {
            if case .failure(let reason) = result { return reason } else { return nil }
        }

        // Grouping: an IPv6 host can use its whole /64, so the /64 is one peer; an IPv4-mapped address is the IPv4 peer.
        try check(peer("fe80::1:2:3:4") == peer("fe80::ffff:ffff:ffff:ffff") && peer("fe80::1") != peer("fe81::1"), "IPv6 /64")
        try check(peer("::ffff:192.168.0.7") == peer("192.168.0.7") && peer("192.168.0.7") != peer("192.168.0.8"), "IPv4")
        try check(PeerKey(host: "mac.local") == nil, "a name is not a peer")

        // One attempt in flight per peer, four overall.
        let gate = PreAuthGate()
        let first = try ticket(await gate.admit(peer("10.0.0.1"), at: start))
        try check(refusal(await gate.admit(peer("10.0.0.1"), at: start)) == .busy, "second attempt from the same peer waits")
        for n in 2...4 { _ = try ticket(await gate.admit(peer("10.0.0.\(n)"), at: start)) }
        try check(refusal(await gate.admit(peer("10.0.0.5"), at: start)) == .busy, "a fifth attempt overall waits")
        await gate.finish(first, succeeded: true, at: start)
        _ = try ticket(await gate.admit(peer("10.0.0.5"), at: start))

        // Per-peer budget: three at once, then one a second. One noisy peer does not spend the others' budget.
        let rate = PreAuthGate()
        for _ in 0..<3 { await rate.finish(try ticket(await rate.admit(peer("10.0.1.1"), at: start)), succeeded: true, at: start) }
        try check(refusal(await rate.admit(peer("10.0.1.1"), at: start)) == .tooFast, "over the peer budget")
        await rate.finish(try ticket(await rate.admit(peer("10.0.1.2"), at: start)), succeeded: true, at: start)
        await rate.finish(try ticket(await rate.admit(peer("10.0.1.1"), at: at(1))), succeeded: true, at: at(1))
        // Global budget: eight at once across peers.
        var policy = PreAuthPolicy()
        policy.globalBurst = 2
        policy.globalRate = 1
        let global = PreAuthGate(policy: policy)
        for n in 1...2 { await global.finish(try ticket(await global.admit(peer("10.0.2.\(n)"), at: start)), succeeded: true, at: start) }
        try check(refusal(await global.admit(peer("10.0.2.3"), at: start)) == .tooFast, "over the listener budget")
        // A peer refused by its own budget spends nothing of the listener's.
        policy.globalBurst = 4
        let order = PreAuthGate(policy: policy)
        for _ in 0..<3 { await order.finish(try ticket(await order.admit(peer("10.0.2.9"), at: start)), succeeded: true, at: start) }
        for _ in 0..<5 { try check(refusal(await order.admit(peer("10.0.2.9"), at: start)) == .tooFast, "noisy peer") }
        _ = try ticket(await order.admit(peer("10.0.2.10"), at: start))

        // Repeated failures block the peer and say so; a success in between starts the count again.
        let failing = PreAuthGate()
        var now = 0.0
        func fail(_ host: String) async throws -> PreAuthGate.Event? {
            now += 1.5
            return await failing.finish(try ticket(await failing.admit(peer(host), at: at(now))), succeeded: false, at: at(now))
        }
        for _ in 0..<4 { try check(try await fail("10.0.3.1") == nil, "not yet blocked") }
        now += 1.5
        await failing.finish(try ticket(await failing.admit(peer("10.0.3.1"), at: at(now))), succeeded: true, at: at(now))
        for _ in 0..<4 { try check(try await fail("10.0.3.1") == nil, "a success restarted the count") }
        let blocked = try await fail("10.0.3.1")
        try check(blocked == .blocked(peer("10.0.3.1"), until: at(now) + .seconds(600)), "the fifth failure blocks and reports")
        try check(refusal(await failing.admit(peer("10.0.3.1"), at: at(now + 599))) == .blocked, "blocked for ten minutes")
        _ = try ticket(await failing.admit(peer("10.0.3.2"), at: at(now + 599)))
        _ = try ticket(await failing.admit(peer("10.0.3.1"), at: at(now + 600)))
        // Failures older than the window do not add up.
        let slow = PreAuthGate()
        for n in 0..<8 {
            let time = at(Double(n) * 200)
            try check(await slow.finish(try ticket(await slow.admit(peer("10.0.4.1"), at: time)), succeeded: false, at: time) == nil,
                      "spread-out failures never block")
        }

        // An attempt that runs past its deadline frees its slot and counts as a failure, even if nobody finishes it.
        // Finishing it late counts nothing more, either way.
        let stuck = PreAuthGate()
        var overdue: [PreAuthTicket] = []
        for n in 0..<5 {
            let time = at(Double(n) * 6)
            overdue.append(try ticket(await stuck.admit(peer("10.0.5.1"), at: time)))
            try check(overdue.last!.deadline == time + .seconds(5), "five-second deadline")
        }
        try check(await stuck.finish(overdue[0], succeeded: false, at: at(25)) == nil, "a late failure is not counted twice")
        await stuck.finish(overdue[1], succeeded: true, at: at(25))
        _ = await stuck.admit(peer("10.0.5.2"), at: at(30))
        try check(await stuck.takeEvents() == [.blocked(peer("10.0.5.1"), until: at(30) + .seconds(600))],
                  "overdue attempts block too, and a late success did not clear them")
        await stuck.finish(overdue[4], succeeded: true, at: at(31))
        try check(refusal(await stuck.admit(peer("10.0.5.1"), at: at(31))) == .blocked, "still blocked after a late success")

        // Memory stays bounded however many addresses a LAN attacker cycles through; idle peers are forgotten.
        var small = PreAuthPolicy()
        small.maxTrackedPeers = 3
        let bounded = PreAuthGate(policy: small)
        for n in 1...3 { await bounded.finish(try ticket(await bounded.admit(peer("10.0.6.\(n)"), at: start)), succeeded: true, at: start) }
        try check(refusal(await bounded.admit(peer("10.0.6.4"), at: start)) == .busy, "no room for a fourth peer yet")
        _ = try ticket(await bounded.admit(peer("10.0.6.4"), at: at(4)))
        // A peer with an attempt still running is never forgotten, or that attempt's failure would be lost.
        let running = PreAuthGate()
        let pending = try ticket(await running.admit(peer("10.0.7.1"), at: start))
        _ = try ticket(await running.admit(peer("10.0.7.2"), at: at(2)))   // the first peer's bucket is full again
        await running.finish(pending, succeeded: false, at: at(2))
        for n in 1...3 {
            await running.finish(try ticket(await running.admit(peer("10.0.7.1"), at: at(2 + Double(n) * 2))), succeeded: false,
                                 at: at(2 + Double(n) * 2))
        }
        let fifth = try ticket(await running.admit(peer("10.0.7.1"), at: at(10)))
        try check(await running.finish(fifth, succeeded: false, at: at(10)) != nil, "the first failure still counted")
    }

    func testRegistrationIsOneUseBoundAndConfirmedBySAS() async throws {
        let macSigner = SoftwareSigner()
        let macFingerprint = ScreenControlIdentity.fingerprint(of: macSigner.publicKey)
        let device = SoftwareSigner().publicKey
        let start = ContinuousClock.now
        func window() -> (RegistrationWindow, RegistrationCode) {
            let code = RegistrationCode.generate()
            return (RegistrationWindow(code: code, signer: macSigner, openedAt: start, attestationVerifier: EchoAttester()), code)
        }
        func record(_ code: RegistrationCode, fingerprint: Data? = nil, key: P256.Signing.PublicKey? = nil,
                    name: String = "iPhone 17 Pro") throws -> RegistrationRecord {
            try RegistrationRecord(macFingerprint: fingerprint ?? macFingerprint, codeID: code.id, devicePublicKey: key ?? device,
                                   deviceName: name, deviceModel: "iPhone18,1")
        }
        /// What the phone sends: the record, its proof and an attestation over it, unless a check replaces one.
        func submit(_ window: RegistrationWindow, _ record: RegistrationRecord, code: RegistrationCode, proof: Data? = nil,
                    attestation: Data? = nil, now: ContinuousClock.Instant? = nil) async throws -> RegistrationAcceptance {
            try await window.verify(record: record.encoded(), proof: proof ?? RegistrationProof.proof(for: record, code: code),
                                    attestation: attestation ?? record.attestationClientDataHash,
                                    attestationKeyID: Data(repeating: 7, count: 32), now: now ?? start)
        }

        let (open, macCode) = window()
        try check(await open.isOpen(at: start), "a new QR is open")
        let phoneCode = try RegistrationCode(id: macCode.id, secret: macCode.qrSecret)
        let mine = try record(phoneCode)
        let accepted = try await submit(open, mine, code: phoneCode, now: start.advanced(by: .seconds(30)))
        try check(accepted.record == mine && accepted.record.deviceID == ScreenControlIdentity.fingerprint(of: device), "record")
        try check(accepted.attestation.keyID == Data(repeating: 7, count: 32), "the attested App Attest key is returned to keep")
        let shown = try RegistrationAcknowledgement.open(accepted.acknowledgement, for: mine, code: phoneCode)
        try check(shown.sas == accepted.sas && accepted.sas.count == 6, "both screens show one SAS")
        try check(shown.mac.fingerprint == macFingerprint, "the phone keeps the Mac key it checked against the QR")
        try await expectError(RegistrationError.alreadyUsed) { _ = try await submit(open, mine, code: phoneCode) }
        try check(!(await open.isOpen(at: start)), "a used QR is closed")

        // Someone who photographed the QR races the real phone with their own record, varied until its six digits
        // match. The Mac answers their record, not the phone's, so the real phone shows no SAS to compare.
        let (raced, racedCode) = window()
        let theirs = try record(racedCode, key: SoftwareSigner().publicKey)
        let theirAnswer = try await submit(raced, theirs, code: racedCode).acknowledgement
        let real = try record(racedCode)
        try await expectError(RegistrationError.badAcknowledgement) {
            _ = try RegistrationAcknowledgement.open(theirAnswer, for: real, code: racedCode)
        }
        try await expectError(RegistrationError.alreadyUsed) { _ = try await submit(raced, real, code: racedCode) }
        // An answer from another Mac is refused whatever it signs: the record names this Mac's fingerprint.
        let otherMacAnswer = try await RegistrationAcknowledgement.make(for: real, signer: SoftwareSigner())
        try await expectError(RegistrationError.mismatch) { _ = try RegistrationAcknowledgement.open(otherMacAnswer, for: real, code: racedCode) }
        try await expectError(RegistrationError.malformed) {
            _ = try RegistrationAcknowledgement.open(theirAnswer.dropLast(), for: theirs, code: racedCode)
        }

        let (guessed, guessedCode) = window()
        let wrong = try RegistrationCode(id: guessedCode.id, secret: randomBytes(32))
        try await expectError(RegistrationError.invalidProof) { _ = try await submit(guessed, try record(wrong), code: wrong) }
        try check(!(await guessed.isOpen(at: start)), "a failed attempt closes the QR")

        // The proof covers the whole record: a proof the phone made cannot carry someone else's key or name.
        for change in [{ (code: RegistrationCode) in try record(code, key: SoftwareSigner().publicKey) },
                       { (code: RegistrationCode) in try record(code, name: "Someone's iPhone") }] {
            let (swapped, swappedCode) = window()
            let proof = RegistrationProof.proof(for: try record(swappedCode), code: swappedCode)
            try await expectError(RegistrationError.invalidProof) {
                _ = try await submit(swapped, try change(swappedCode), code: swappedCode, proof: proof)
            }
        }

        // Someone who read the QR but runs a script, not the genuine app, has no attestation over this record:
        // an attestation the real app made for another record does not carry over.
        let (scripted, scriptedCode) = window()
        let replayed = try record(scriptedCode, key: SoftwareSigner().publicKey).attestationClientDataHash
        try await expectError(RegistrationError.untrustedApp(.nonceMismatch)) {
            _ = try await submit(scripted, try record(scriptedCode), code: scriptedCode, attestation: replayed)
        }
        try check(!(await scripted.isOpen(at: start)), "a failed attestation also closes the QR")

        let (late, lateCode) = window()
        try check(!(await late.isOpen(at: start.advanced(by: .seconds(121)))), "an expired QR is closed")
        try await expectError(RegistrationError.expired) {
            _ = try await submit(late, try record(lateCode), code: lateCode, now: start.advanced(by: .seconds(121)))
        }

        let (elsewhere, elsewhereCode) = window()
        try await expectError(RegistrationError.mismatch) {
            _ = try await submit(elsewhere, try record(elsewhereCode, fingerprint: Data(repeating: 1, count: 32)), code: elsewhereCode)
        }

        let (untouched, _) = window()
        let strayCode = RegistrationCode.generate()
        try await expectError(RegistrationError.mismatch) {
            _ = try await submit(untouched, try record(strayCode), code: strayCode, proof: Data(count: 32))
        }
        try check(await untouched.isOpen(at: start), "an attempt for another QR does not close this one")
        await untouched.close()
        try check(!(await untouched.isOpen(at: start)), "a session start or closed lid closes the QR")

        let sasCode = RegistrationCode.generate()
        // A changed record changes the SAS (a one-in-a-million collision would only fail this check, not the design).
        try check(RegistrationProof.sas(for: try record(sasCode), code: sasCode)
                  != RegistrationProof.sas(for: try record(sasCode, key: SoftwareSigner().publicKey), code: sasCode),
                  "SAS depends on the record")
        try await expectError(RegistrationError.malformed) { _ = try RegistrationCode(id: Data(count: 15), secret: Data(count: 32)) }
        try await expectError(RegistrationError.malformed) { _ = try RegistrationRecord.decode(Data("not a record".utf8)) }
    }

    func testDeviceNamesShowExactlyWhatWasRegistered() async throws {
        let key = SoftwareSigner().publicKey
        func name(_ text: String) throws -> RegistrationRecord {
            try RegistrationRecord(macFingerprint: Data(count: 32), codeID: Data(count: 16), devicePublicKey: key,
                                   deviceName: text, deviceModel: "iPhone18,1")
        }
        for good in ["iPhone 17 Pro", "관리의 iPhone", "Gwanli\u{2019}s iPad", "📱 work", "Café Mac"] {
            _ = try name(good)
        }
        // Reordering, a second line, invisible differences, look-alike decompositions and overlong names.
        for bad in ["iPhone \u{202E}enohPi", "bad\nname", "iPhone\u{2028}Verified by Apple", "iPh\u{200B}one", "\u{FEFF}iPhone",
                    "iPhone\u{2060}", "iPhone\u{FFFC}", "iPhone\u{FFFD}", "iPhone\u{E0041}", "Cafe\u{0301}", "iPhone\u{E000}", "",
                    String(repeating: "a", count: 33)] {
            try await expectError(RegistrationError.malformed) { _ = try name(bad) }
        }
    }

    func testAppAttestAcceptsOnlyAGenuineAttestationForThisAppAndRequest() async throws {
        typealias Sample = AppAttestSample
        let verifier = AppAttestVerifier(teamID: Sample.teamID, bundleID: Sample.bundleID, environment: .development)
        func verify(_ attestation: Data = Sample.attestation, with verifier: AppAttestVerifier = verifier, keyID: Data = Sample.keyID,
                    clientDataHash: Data = Sample.clientDataHash, at date: Date = Sample.capturedAt) throws -> AppAttestation {
            try verifier.verify(attestation, keyID: keyID, clientDataHash: clientDataHash, at: date)
        }
        let genuine = try verify()
        try check(genuine.publicKey.x963Representation == Sample.publicKeyX963 && genuine.keyID == Sample.keyID, "certified key")
        try check(!genuine.receipt.isEmpty, "receipt kept")
        try check(try verify(encodeCBOR(try CBOR.decode(Sample.attestation))).keyID == Sample.keyID, "test CBOR writer round-trips")

        try await expectError(AppAttestError.wrongApp) {
            _ = try verify(with: AppAttestVerifier(teamID: "ABCDE12345", bundleID: Sample.bundleID, environment: .development))
        }
        try await expectError(AppAttestError.wrongApp) {
            _ = try verify(with: AppAttestVerifier(teamID: Sample.teamID, bundleID: "com.example.other", environment: .development))
        }
        try await expectError(AppAttestError.wrongEnvironment) {
            _ = try verify(with: AppAttestVerifier(teamID: Sample.teamID, bundleID: Sample.bundleID, environment: .production))
        }
        try await expectError(AppAttestError.nonceMismatch) { _ = try verify(clientDataHash: sha256(Data("another request".utf8))) }
        try await expectError(AppAttestError.keyMismatch) { _ = try verify(keyID: sha256(Data("another key".utf8))) }
        // The leaf expired on 2020-11-23, and a chain is judged against the pinned App Attestation root only.
        try await expectError(AppAttestError.untrustedChain) { _ = try verify(at: Date(timeIntervalSince1970: 1_800_000_000)) }
        try await expectError(AppAttestError.untrustedChain) {
            _ = try verify(with: AppAttestVerifier(appID: "\(Sample.teamID).\(Sample.bundleID)", environment: .development,
                                                   rootCertificate: Sample.otherAppleRoot))
        }

        guard case .map(var object) = try CBOR.decode(Sample.attestation), case .map(var statement) = object["attStmt"],
              case .array(let chain) = statement["x5c"], case .bytes(let leaf) = chain[0], case .bytes(let authData) = object["authData"] else {
            throw CheckFailure(description: "sample layout")
        }
        func rebuilt(_ change: (inout [String: CBOR], inout [String: CBOR]) -> Void) -> Data {
            var object = object, statement = statement
            change(&object, &statement)
            object["attStmt"] = .map(statement)
            return encodeCBOR(.map(object))
        }
        try await expectError(AppAttestError.untrustedChain) {
            _ = try verify(rebuilt { _, statement in statement["x5c"] = .array([.bytes(flipByte(leaf, at: leaf.count - 1)), chain[1]]) })
        }
        // authData counter, environment and app fields are all under the leaf's nonce: changing any of them is caught there.
        try await expectError(AppAttestError.nonceMismatch) {
            _ = try verify(rebuilt { object, _ in object["authData"] = .bytes(flipByte(authData, at: 36)) })
        }
        // The intermediate presented as the leaf chains to the root, but it vouches for no request.
        try await expectError(AppAttestError.malformed) {
            _ = try verify(rebuilt { _, statement in statement["x5c"] = .array([chain[1], chain[0]]) })
        }
        try await expectError(AppAttestError.malformed) { _ = try verify(rebuilt { _, statement in statement["x5c"] = .array([chain[0]]) }) }
        try await expectError(AppAttestError.malformed) {
            _ = try verify(rebuilt { _, statement in statement["x5c"] = .array(chain + [.bytes(AppAttestVerifier.appAttestationRoot)]) })
        }
        try await expectError(AppAttestError.malformed) { _ = try verify(rebuilt { object, _ in object["fmt"] = .text("packed") }) }
        try await expectError(AppAttestError.malformed) { _ = try verify(rebuilt { _, statement in statement["receipt"] = nil }) }
        try await expectError(AppAttestError.malformed) { _ = try verify(Sample.attestation + Data([0])) }
        try await expectError(AppAttestError.malformed) { _ = try verify(keyID: Data(count: 31)) }
        statement["x5c"] = nil
        object["attStmt"] = .map(statement)
        try await expectError(AppAttestError.malformed) { _ = try verify(encodeCBOR(.map(object))) }
    }

    func testAttestationParsersAreStrict() async throws {
        let nonce = Data(repeating: 0xAB, count: 32)
        let oid = der(0x06, Data(AppAttestVerifier.nonceExtensionOID))
        let value = der(0x04, der(0x30, der(0xA1, der(0x04, nonce))))
        let other = der(0x30, der(0x06, Data([0x55, 0x1D, 0x13])) + der(0x01, Data([0xFF])) + der(0x04, Data([0x30, 0x00])))
        func certificate(_ extensions: [Data], wrap: UInt8 = 0xA3) -> Data {
            let tbs = der(0x30, der(0x02, Data([1])) + der(wrap, der(0x30, extensions.reduce(Data(), +))))
            return der(0x30, tbs + der(0x30, Data()) + der(0x03, Data([0])))
        }
        try check(try AppAttestVerifier.nonce(inLeaf: certificate([other, der(0x30, oid + value)])) == nonce, "nonce found among extensions")
        for (shape, cert) in [
            ("twice", certificate([der(0x30, oid + value), der(0x30, oid + value)])),
            ("missing", certificate([other])),
            ("outside [3]", certificate([der(0x30, oid + value)], wrap: 0xA2)),
            ("short nonce", certificate([der(0x30, oid + der(0x04, der(0x30, der(0xA1, der(0x04, nonce.prefix(31))))))])),
            ("untagged", certificate([der(0x30, oid + der(0x04, der(0x30, der(0x04, nonce))))])),
            ("trailing", certificate([der(0x30, oid + value)]) + Data([0])),
            ("long length", Data([0x30, 0x81, 0x05]) + Data(count: 5)),
        ] {
            try await expectError(AppAttestError.malformed, line: #line) { _ = try AppAttestVerifier.nonce(inLeaf: cert) }
            _ = shape
        }

        try check(try CBOR.decode(Data([0xA1, 0x61, 0x61, 0x82, 0x01, 0x20])) == .map(["a": .array([.unsigned(1), .negative(0)])]), "CBOR")
        for bad in [
            Data([0x5F, 0x41, 0x00, 0xFF]),              // indefinite-length bytes
            Data([0xA2, 0x61, 0x61, 0x00, 0x61, 0x61, 0x01]), // duplicate key
            Data([0xA1, 0x01, 0x00]),                    // integer key
            Data([0x5A, 0xFF, 0xFF, 0xFF, 0xFF]),        // length beyond the input
            Data([0xC0, 0x00]),                          // tag
            Data([0xF5]),                                // simple value
            Data([0x01, 0x01]),                          // trailing byte
            Data([0x62, 0xC3, 0x28]),                    // invalid UTF-8
            Data(repeating: 0x81, count: 12) + Data([0x00]), // nested too deep
            Data([0x98, 0x41]) + Data(count: 0x41),      // too many items
        ] {
            try await expectError(AppAttestError.malformed) { _ = try CBOR.decode(bad) }
        }
    }

    // Notifications and remote stop: PushChecks.swift.
    static var all: [(String, (ScreenControlChecks) -> () async throws -> Void)] { pushChecks + controllerChecks + coreChecks }
    static var coreChecks: [(String, (ScreenControlChecks) -> () async throws -> Void)] { [
        ("private network route is explicit and bounded", { $0.testPrivateNetworkRouteIsExplicitAndBounded }),
        ("desktop controls strictly versioned", { $0.testDesktopControlsAreStrictAndVersioned }),
        ("Caps Lock tap, hold and cancellation", { $0.testCapsLockTapHoldAndCancellation }),
        ("keyboard first-character fence and bounds", { $0.testKeyboardFenceOrdersFirstCharacterAndBoundsMemory }),
        ("keyboard fence coalesces pointer positions across no button boundary", { $0.testKeyboardFenceCoalescesPointerPositionsWithoutCrossingButtonBoundaries }),
        ("registry read failure cannot replace registrations", { $0.testReadFailureCannotReplaceAnUnreadableRegistry }),
        ("registry mutation preserves the latest other device", { $0.testStaleViewsAlwaysPreserveTheCurrentOtherDevice }),
        ("failed registry write never publishes a removed device", { $0.testFailedRevokeDoesNotPublishADeletedRow }),
        ("desktop input respects local input and lifetime", { $0.testDesktopInputUsesLocalPriorityAndSessionLifetime }),
        ("keyboard controls and input share wire order", { $0.testDesktopCommandsAndInputShareWireOrder }),
        ("quality restarts encoder and keeps display", { $0.testQualityChangeRestartsEncoderAndKeepsDisplay }),
        ("relay retry is bounded and resettable", { $0.testRelayRetryIsBoundedAndResettable }),
        ("desktop controls and notices cross authenticated channel", { $0.testDesktopControlsReachAuthenticatedHostAndReturnNotices }),
        ("handshake agrees and carries records", { $0.testHandshakeAgreesAndCarriesRecordsBothWays }),
        ("fake Mac refused before Face ID", { $0.testFakeMacIsRefusedBeforeFaceID }),
        ("unknown or inconsistent device refused", { $0.testUnknownOrInconsistentDeviceIsRefused }),
        ("registered device cannot claim another identity", { $0.testAnotherRegisteredDeviceCannotClaimSomeoneElsesIdentity }),
        ("role labels not interchangeable", { $0.testRoleLabelsAreNotInterchangeable }),
        ("replayed hello refused, keys fresh", { $0.testReplayedHelloAndFreshKeys }),
        ("tampered confirmations and other versions refused", { $0.testTamperedConfirmationsAndOtherVersionsAreRefused }),
        ("malformed handshake messages refused", { $0.testMalformedHandshakeMessagesAreRefused }),
        ("channel refuses replay, skip, reflection, tampering", { $0.testChannelRefusesReplaySkipReflectionAndTampering }),
        ("input codec strict", { $0.testInputCodecIsStrict }),
        ("rate limit and held input release", { $0.testRateLimitAndHeldInputRelease }),
        ("active attacker swapping ephemeral keys refused", { $0.testActiveAttackerSwappingEphemeralKeysIsRefused }),
        ("key schedule matches the independent reference", { $0.testKeyScheduleMatchesTheIndependentReference }),
        ("handshakes and channels cannot be used twice", { $0.testHandshakesAndChannelsCannotBeUsedTwice }),
        ("Secure Enclave signer, fresh context per signature", { $0.testSecureEnclaveSignerSignsWithAFreshContext }),
        ("pre-authentication gate bounds work", { $0.testPreAuthGateBoundsWorkBeforeAuthentication }),
        ("network identity is the router and the subnet", { $0.testNetworkIdentityIsTheRouterAndTheSubnet }),
        ("approved networks decide where the Mac listens", { $0.testApprovedNetworksDecideWhereTheMacListens }),
        ("approved network list is capped and renewed", { $0.testApprovedNetworkListIsCappedAndRenewed }),
        ("routing tables are read strictly", { $0.testRoutingTablesAreReadStrictly }),
        ("frame reader checks every length before buffering", { $0.testFrameReaderChecksEveryLengthBeforeBuffering }),
        ("connection waits for a usable path until cancelled", { $0.testConnectionWaitsForAUsablePathUntilCancelled }),
        ("transport carries records over TCP", { $0.testTransportCarriesRecordsOverLoopback }),
        ("listener bounds attempts before authentication", { $0.testListenerBoundsAttemptsBeforeAuthentication }),
        ("video frames parse strictly", { $0.testVideoFrameWireFormatIsStrict }),
        ("video loop: encode, encrypt, TCP, decrypt, decode", { $0.testVideoLoopEncodesEncryptsAndDecodes }),
        ("video pump keeps feeding the encoder, answers the phone", { $0.testVideoPumpKeepsFeedingTheEncoder }),
        ("viewer asks for a keyframe, shows pictures, says goodbye", { $0.testViewerAsksForAKeyframeShowsPicturesAndSaysGoodbye }),
        ("Face ID approval signs once", { $0.testFaceIDApprovalSignsOnce }),
        ("lockout recovery requires available biometry", { $0.testLockoutRecoveryRequiresAvailableBiometry }),
        ("device authentication key protection", { $0.testDeviceAuthenticationKeyProtection }),
        ("registration QR text is strict", { $0.testRegistrationInviteTextIsStrict }),
        ("registration QR is a URL the app opens", { $0.testRegistrationQRIsAURLTheAppOpens }),
        ("registration over TCP needs the Mac's approval", { $0.testRegistrationOverTCPNeedsTheMacsApproval }),
        ("App Attest: any one app ID, telling refusal", { $0.testAnyAppAttestVerifierAcceptsOneAndReportsTheTellingRefusal }),
        ("text and Return authenticated transport", { $0.testTextAndReturnCrossesAuthenticatedTransportOnce }),
        ("text and Return one admission, version, and replay", { $0.testTextAndReturnIsVersionedAndSingleAdmission }),
        ("input receiver decodes, limits and releases", { $0.testInputReceiverDecodesLimitsAndReleases }),
        ("input reaches the Mac in order; malformed ends it", { $0.testInputReachesTheMacInOrderAndAMalformedRecordEndsTheSession }),
        ("registration one-use, bound, acknowledged, attested", { $0.testRegistrationIsOneUseBoundAndConfirmedBySAS }),
        ("device names show exactly what was registered", { $0.testDeviceNamesShowExactlyWhatWasRegistered }),
        ("App Attest accepts only a genuine attestation", { $0.testAppAttestAcceptsOnlyAGenuineAttestationForThisAppAndRequest }),
        ("attestation parsers strict", { $0.testAttestationParsersAreStrict }),
        ("session limits, end reasons, control directions", { $0.testSessionTimerReasonsAndControlDirections }),
        ("local priority tells local input from injected", { $0.testLocalPriorityTellsLocalInputFromInjected }),
        ("pointer resync precedes local-priority resume", { $0.testPointerResynchronizesBeforeLocalPriorityResume }),
        ("input availability reasons reach authenticated viewer", { $0.testInputAvailabilityCrossesAuthenticatedSessionWhenOnlyItsReasonChanges }),
        ("secure input and view-only reasons survive unrelated notices", { $0.testSecureInputAndViewOnlyReasonsCannotBeClearedByUnrelatedNotices }),
        ("physical input wins during same-kind injection and held input", { $0.testPhysicalInputWinsDuringSameKindInjectionAndHeldInput }),
        ("physical takeover checks before dispatch and notifies viewer", { $0.testPhysicalTakeoverIsCheckedBeforeDispatchAndNotifiesTheViewer }),
        ("input receiver pauses for local input and lets go", { $0.testInputReceiverPausesForLocalInputAndLetsGo }),
        ("session limits end the session and tell the phone", { $0.testSessionLimitsEndTheSessionAndTellThePhone }),
        ("display choice extends idle, keyframe request does not", { $0.testDisplayChoiceRestartsIdleWithoutKeyframeRequestsExtendingIt }),
        ("every way a session ends lets go", { $0.testEveryWayASessionEndsLetsGo }),
        ("local input pauses remote input over the session", { $0.testLocalInputPausesRemoteInputOverTheSession }),
        ("registrations expire after 90 days without use", { $0.testRegistrationsExpireAfterNinetyDaysWithoutUse }),
        ("versions negotiate: v1 and v2 phones and Macs", { $0.testVersionNegotiationMatrix }),
        ("versions negotiate over TCP", { $0.testVersionNegotiationOverTCP }),
        ("a removed or changed version stamp fails the handshake", { $0.testDowngradeFailsTheHandshake }),
        ("version-2 key schedule matches the reference", { $0.testVersionTwoKeyScheduleMatchesTheReference }),
        ("control messages parse strictly by version", { $0.testControlMessagesParseStrictlyByVersion }),
        ("control messages go only from their sender and version", { $0.testControlMessagesGoOnlyFromTheirSenderAndVersion }),
        ("each end refuses what it may not receive", { $0.testEachEndRefusesWhatItMayNotReceive }),
        ("lock state reaches version-2 phones only", { $0.testLockStateReachesVersionTwoPhonesOnly }),
        ("display change: keyframe with new parameter sets", { $0.testDisplayChangeSendsAKeyframeWithNewParameterSets }),
        ("a replaced encoder never reaches the phone", { $0.testAReplacedEncoderNeverReachesThePhone }),
        ("cursor requests reach the capture, outlast a display change", { $0.testCursorRequestsReachTheCaptureAndOutlastADisplayChange }),
        ("turning off from the phone ends with its own reason", { $0.testTurningOffFromThePhoneEndsWithItsOwnReason }),
        ("after the Mac's goodbye the phone changes nothing", { $0.testAfterTheMacsGoodbyeThePhoneChangesNothing }),
        ("the phone keeps each Mac signal apart", { $0.testThePhoneKeepsEachMacSignalApart }),
    ] }
}

#if CORE_CHECKS
@main struct ScreenControlChecksMain {
    static func main() async {
        var failed = 0
        for (name, run) in ScreenControlChecks.all {
            do {
                try await run(ScreenControlChecks())()
                print("pass  \(name)")
            } catch {
                failed += 1
                print("FAIL  \(name): \(error)")
            }
        }
        print("\(ScreenControlChecks.all.count - failed)/\(ScreenControlChecks.all.count) screen-control checks passed")
        exit(failed == 0 ? 0 : 1)
    }
}
#else
import XCTest
final class ScreenControlCoreTests: XCTestCase {
    func testTextAndReturn() async throws { try await ScreenControlChecks().testTextAndReturnIsVersionedAndSingleAdmission() }
    func testSecurityRequirements() async throws {
        for (name, run) in ScreenControlChecks.all {
            do { try await run(ScreenControlChecks())() } catch { XCTFail("\(name): \(error)") }
        }
    }
}
#endif
