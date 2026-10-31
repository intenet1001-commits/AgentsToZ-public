import CryptoKit
import Foundation
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// Version negotiation (DESIGN 「버전 협상」): a version-2 Mac serves a version-1 phone, a version-2 phone works with a
// version-1 Mac, two version-2 ends settle on version 2, and the settled version is bound into the transcript so a
// stamp removed or changed in transit fails the handshake instead of downgrading it.

/// The combinations that must connect: (phone, Mac, settled version).
let negotiationMatrix: [(phone: VersionPolicy, mac: VersionPolicy, settled: UInt16, name: String)] = [
    (.only(1), .only(1), 1, "two version-1 builds"),
    (.only(1), .current, 1, "a version-2 Mac serves a version-1 phone"),
    (.current, .only(1), 1, "a version-2 phone works with a version-1 Mac"),
    (.upTo(2), .current, 2, "a version-3 Mac serves a version-2 phone"),
    (.current, .upTo(2), 2, "a version-3 phone works with a version-2 Mac"),
    (.upTo(3), .current, 3, "a v4 Mac serves a v3 phone"),
    (.current, .upTo(3), 3, "a v4 phone works with a v3 Mac"),
    (.current, .current, 4, "two version-4 builds"),
    (.upTo(5), .current, 4, "a newer phone settles on what this Mac speaks"),
    (.current, .upTo(5), 4, "a newer Mac settles on what this phone speaks"),
]

func offersVersions(_ policy: VersionPolicy) -> Bool {
    if case .upTo(let newest) = policy { return newest >= 2 }
    return false
}

/// The last ten bytes replaced by fresh ones that carry no stamp.
func unstamped(_ nonce: Data) -> Data {
    var plain: Data
    repeat { plain = Data([UInt8](nonce).prefix(nonce.count - 10)) + randomBytes(10) } while VersionStamp.version(in: plain) != nil
    return plain
}

extension ScreenControlChecks {
    func testVersionNegotiationMatrix() async throws {
        for (phone, mac, settled, name) in negotiationMatrix {
            let fixture = Fixture(macVersions: mac)
            let device = fixture.device(versions: phone)
            let (reply, pending) = try await fixture.mac.respond(to: device.hello)
            let (finish, deviceChannel) = try await device.finish(macHello: reply, signer: fixture.deviceSigner)
            let macChannel = try await pending.confirm(finish)
            try check(macChannel.version == settled && deviceChannel.version == settled,
                      "\(name): settled on \(macChannel.version)/\(deviceChannel.version), expected \(settled)")
            let frame = Data("frame".utf8), input = InputCodec.encode(.pointerMove(x: 0.5, y: 0.5))
            try check(try deviceChannel.open(try macChannel.seal(.video, frame)).payload == frame, "\(name): Mac to phone")
            try check(try macChannel.open(try deviceChannel.seal(.input, input)).payload == input, "\(name): phone to Mac")

            // On the wire: only a phone that speaks more than version 1 offers, and the Mac names a version only when it
            // settled above 1. A version-1 end sees nonces exactly as version 1 made them: plain random bytes.
            let hello = try LengthPrefixed.decode(device.hello, count: 4), answer = try LengthPrefixed.decode(reply, count: 5)
            let offered = VersionStamp.version(in: hello[2]), named = VersionStamp.version(in: answer[1])
            if offersVersions(phone), case .upTo(let newest) = phone {
                try check(offered == newest, "\(name): the phone offers \(newest), sent \(String(describing: offered))")
            } else {
                try check(offered == nil, "\(name): a phone that speaks only one version offers nothing")
            }
            try check(named == (settled >= 2 ? settled : nil), "\(name): the Mac names \(String(describing: named))")
        }
    }

    func testVersionNegotiationOverTCP() async throws {
        // The same matrix through the real listener and client on 127.0.0.1, in both directions of each pairing.
        for (phone, mac, settled, name) in negotiationMatrix {
            let fixture = Fixture(macVersions: mac)
            let (listener, endpoint) = try await loopbackListener(fixture.mac)
            defer { listener.stop() }
            let client = try await within(5) {
                try await ScreenClient.connect(to: endpoint, handshake: fixture.device(versions: phone), signer: fixture.deviceSigner)
            }
            let session = try await nextSession(listener)
            try check(client.version == settled && session.connection.version == settled,
                      "\(name) over TCP: \(client.version)/\(session.connection.version), expected \(settled)")
            try await session.connection.send(.video, Data("picture".utf8))
            try check(try await within(3) { try await client.receive() }.payload == Data("picture".utf8), "\(name): a record reaches the phone")
            try await client.send(.input, InputCodec.encode(.button(.left, isDown: true)))
            try check(try await within(3) { try await session.connection.receive() }.type == .input, "\(name): a record reaches the Mac")
            client.close()
            session.connection.close()
        }
    }

    func testDowngradeFailsTheHandshake() async throws {
        // Two version-2 ends. An attacker in the path who strips the phone's offer gets a version-1 answer from the Mac,
        // signed over the nonce the Mac saw; the phone checks it over the nonce it sent, and never reaches Face ID.
        let counting = CountingSigner()
        let fixture = Fixture(deviceSigner: counting)
        let stripped = fixture.device()
        var hello = try LengthPrefixed.decode(stripped.hello, count: 4)
        hello[2] = unstamped(hello[2])
        let (versionOne, _) = try await fixture.mac.respond(to: LengthPrefixed.encode(hello))
        try check(VersionStamp.version(in: try LengthPrefixed.decode(versionOne, count: 5)[1]) == nil, "the Mac answered as version 1")
        try await expectError(HandshakeError.badSignature) { _ = try await stripped.finish(macHello: versionOne, signer: counting) }

        // Removing the Mac's stamp makes the phone check a version-1 transcript the Mac never signed.
        let erased = fixture.device()
        let (reply, _) = try await fixture.mac.respond(to: erased.hello)
        var answer = try LengthPrefixed.decode(reply, count: 5)
        answer[1] = unstamped(answer[1])
        try await expectError(HandshakeError.badSignature) { _ = try await erased.finish(macHello: LengthPrefixed.encode(answer), signer: counting) }

        // Raising the phone's offer still breaks the Mac's signature: the offer is inside T.
        let raised = fixture.device()
        var louder = try LengthPrefixed.decode(raised.hello, count: 4)
        louder[2] = VersionStamp.stamped(louder[2], version: ScreenControlProtocol.version + 1)
        let (overRaised, _) = try await fixture.mac.respond(to: LengthPrefixed.encode(louder))
        try await expectError(HandshakeError.badSignature) { _ = try await raised.finish(macHello: overRaised, signer: counting) }

        // A Mac that names a version the phone never offered is refused outright.
        let offeredTwo = fixture.device(versions: .upTo(2))
        let (named, _) = try await fixture.mac.respond(to: offeredTwo.hello)
        var newer = try LengthPrefixed.decode(named, count: 5)
        newer[1] = VersionStamp.stamped(newer[1], version: 3)
        try await expectError(HandshakeError.malformed) { _ = try await offeredTwo.finish(macHello: LengthPrefixed.encode(newer), signer: counting) }
        try check(await counting.counter.count == 0, "Face ID was asked during a tampered negotiation")

        // The Mac side: had the phone settled on version 1 over a stripped answer and signed anyway, the Mac, having
        // answered in version 2, would refuse its version-1 signature.
        let mac = fixture.mac
        let honestEphemeral = P256.KeyAgreement.PrivateKey()
        let honest = DeviceHandshake(mac: pinned(fixture.macSigner.publicKey), devicePublicKey: counting.publicKey,
                                     versions: .current, ephemeral: honestEphemeral)
        let sentHello = try LengthPrefixed.decode(honest.hello, count: 4)
        let (twoReply, pending) = try await mac.respond(to: honest.hello)
        var downgraded = try LengthPrefixed.decode(twoReply, count: 5)
        downgraded[1] = unstamped(downgraded[1])
        let version = UInt16(1), labels = HandshakeLabels(version: version)
        let transcript = transcriptHash(version: version, macFingerprint: ScreenControlIdentity.fingerprint(of: fixture.macSigner.publicKey),
                                        deviceID: sentHello[1], deviceNonce: sentHello[2],
                                        deviceEphemeral: sentHello[3],
                                        macNonce: downgraded[1], macEphemeral: downgraded[2])
        let keys = SessionKeys(secret: try honestEphemeral.sharedSecretFromKeyAgreement(with: try ephemeralKey(downgraded[2])),
                               transcriptHash: transcript, labels: labels)
        let signed = try await counting.inner.signature(for: labels.deviceSignature + transcript).rawRepresentation
        let finish = encodeMessage(.deviceFinish, [signed, confirmation(keys.deviceConfirm, transcript, signed)])
        try await expectError(HandshakeError.badSignature) { _ = try await pending.confirm(finish) }
    }

    func testVersionTwoKeyScheduleMatchesTheReference() async throws {
        // reference/key-schedule.py derives these with the version-2 stamps in both nonces and "/v2" in every label.
        func scalar(_ name: String) -> Data { sha256(Data("agentstoz kat \(name)".utf8)) }
        let macSigner = SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: scalar("mac identity")))
        let deviceSigner = SoftwareSigner(key: try P256.Signing.PrivateKey(rawRepresentation: scalar("device identity")))
        let macEphemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar("mac ephemeral"))
        let deviceEphemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: scalar("device ephemeral"))
        let deviceKey = deviceSigner.publicKey
        let mac = MacHandshake(signer: macSigner, replay: NonceReplayCache(), versions: .upTo(2),
                               fresh: { (Data(repeating: 0x22, count: 32), macEphemeral) }) { _ in deviceKey }
        let device = DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: deviceKey, versions: .upTo(2),
                                     nonce: Data(repeating: 0x11, count: 32), ephemeral: deviceEphemeral)
        let (reply, pending) = try await mac.respond(to: device.hello)
        let (finish, deviceChannel) = try await device.finish(macHello: reply, signer: deviceSigner)
        let macChannel = try await pending.confirm(finish)

        let stamp = Data("AZScreen".utf8) + Data([0, 2])
        let hello = try LengthPrefixed.decode(device.hello, count: 4), answer = try LengthPrefixed.decode(reply, count: 5)
        try check(hello[2] == Data(repeating: 0x11, count: 22) + stamp, "Np: 22 random bytes, the marker, version 2")
        try check(answer[1] == Data(repeating: 0x22, count: 22) + stamp, "Nm: 22 random bytes, the marker, version 2")
        try check(macChannel.version == 2 && deviceChannel.version == 2, "settled on version 2")

        let transcript = hex("08eda2b970a1cefb5f003c79d7b1527f29de8997f2945f84158843099b79f21b")
        let macToDevice = hex("2d0ad82d472499d0fea0255152f08715ba771539b901a86ff5fdd4f301969190")
        let deviceToMac = hex("3e02429ba10a42cef3eb57225f4492dc35aa7051197dc647dd09ae869ad6e117")
        let macConfirm = hex("437a7af6e072cf175bf902d3af3b9cea7718857cf6a5e05b76958e2030deda10")
        let deviceConfirm = hex("3b6b27a88b6d647941573613d75eaec5d71434387428d105a77f23a33e40a9a9")
        try check(keyBytes(macChannel.sendKey) == macToDevice && keyBytes(deviceChannel.receiveKey) == macToDevice, "Mac-to-device key")
        try check(keyBytes(deviceChannel.sendKey) == deviceToMac && keyBytes(macChannel.receiveKey) == deviceToMac, "device-to-Mac key")
        let done = try LengthPrefixed.decode(finish, count: 3)
        func hmac(_ key: Data, _ signature: Data) -> Data {
            Data(HMAC<SHA256>.authenticationCode(for: transcript + signature, using: SymmetricKey(data: key)))
        }
        try check(answer[4] == hmac(macConfirm, answer[3]), "the Mac's confirmation is over the reference transcript")
        try check(done[2] == hmac(deviceConfirm, done[1]), "the phone's confirmation is over the reference transcript")
        try check(macSigner.publicKey.isValidSignature(try signature(answer[3]), for: Data("agentstoz.screen-control/v2/mac".utf8) + transcript),
                  "the Mac signs the reference transcript under the version-2 label")
        let record = try macChannel.seal(.video, Data("frame".utf8))
        let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: Data(count: 12)), ciphertext: record.dropFirst(9).dropLast(16),
                                        tag: record.suffix(16))
        try check(try AES.GCM.open(box, using: SymmetricKey(data: macToDevice),
                                   authenticating: Data("agentstoz.screen-control/v2 record".utf8) + record.prefix(9)) == Data("frame".utf8),
                  "records carry the version-2 label")
    }
}
