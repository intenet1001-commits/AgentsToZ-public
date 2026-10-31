import CryptoKit
import Foundation
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// Mac controllers (ControllerOffer.swift, docs/design/mac-to-mac-2026-10-29/DESIGN.md): the offer QR, the delivery
// channel's own key domain, the six digits at A, the version-3 invitation and the brokering phone refusing every host
// that cannot tell a Mac controller from a phone. SR-19..SR-23 groundwork; nothing here starts a session.

/// Two ends of an in-memory frame stream, for the brokered exchanges without sockets.
final class FramePipeEnd: ScreenFrameTransport, Sendable {
    private let inbox: AsyncStream<Data>
    private let inboxSink: AsyncStream<Data>.Continuation
    private let outbox: AsyncStream<Data>.Continuation
    let sent = Collector<Data>()

    init(inbox: AsyncStream<Data>, inboxSink: AsyncStream<Data>.Continuation, outbox: AsyncStream<Data>.Continuation) {
        self.inbox = inbox; self.inboxSink = inboxSink; self.outbox = outbox
    }

    func setMaxFrame(_ value: Int) {}
    /// Sends always succeed, like a socket's buffer; a closed peer shows as the end of its stream.
    func send(_ payload: Data) async throws {
        sent.add(payload)
        outbox.yield(payload)
    }
    func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void) {
        sent.add(payload)
        outbox.yield(payload)
        completion(nil)
    }
    func receive() async throws -> Data {
        var iterator = inbox.makeAsyncIterator()
        guard let data = await iterator.next() else { throw TransportError.closed }
        return data
    }
    func cancel() { inboxSink.finish(); outbox.finish() }
}

func framePipe() -> (FramePipeEnd, FramePipeEnd) {
    let (a, aSink) = AsyncStream.makeStream(of: Data.self)
    let (b, bSink) = AsyncStream.makeStream(of: Data.self)
    return (FramePipeEnd(inbox: a, inboxSink: aSink, outbox: bSink), FramePipeEnd(inbox: b, inboxSink: bSink, outbox: aSink))
}

/// Mac B with a 「Mac 컨트롤러 추가」 window open, or an ordinary 「기기 등록」 one.
private struct HostDesk {
    let signer = SoftwareSigner()
    let code = RegistrationCode.generate()
    let window: RegistrationWindow
    let invite: RegistrationInvite

    init(purpose: RegistrationPurpose = .macController, openedAt: ContinuousClock.Instant = .now) throws {
        let fingerprint = ScreenControlIdentity.fingerprint(of: signer.publicKey)
        window = RegistrationWindow(code: code, signer: signer, openedAt: openedAt, attestationVerifier: EchoAttester(), purpose: purpose)
        invite = try RegistrationInvite(macFingerprint: fingerprint, code: code, macName: "3호 Mac mini", hostName: "Mac-mini-3.local",
                                        nearbyRegistrationService: ScreenNearby.registrationService(codeID: code.id),
                                        nearbyScreenService: ScreenNearby.screenService(fingerprint: fingerprint),
                                        capabilities: purpose == .macController ? [.macController] : [])
    }
}

private func offerText(_ fields: [Data]) -> String {
    ControllerOffer.prefix + LengthPrefixed.encode(fields).base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

extension ScreenControlChecks {
    static var controllerChecks: [(String, (ScreenControlChecks) -> () async throws -> Void)] { [
        ("controller offer QR text is strict", { $0.testControllerOfferQRIsStrict }),
        ("an offer secret is never a registration secret", { $0.testOfferSecretIsNeverARegistrationSecret }),
        ("version-3 invitation marks Mac-controller hosts strictly", { $0.testVersionThreeInvitationMarksMacControllerHosts }),
        ("ordinary device registration refuses controller invitations", { $0.testDeviceRegistrationRejectsControllerInvitations }),
        ("brokering refuses hosts without Mac-controller support", { $0.testBrokeringRefusesHostsWithoutMacControllerSupport }),
        ("brokered registration uses its own labels end to end", { $0.testBrokeredRegistrationUsesItsOwnLabelsEndToEnd }),
        ("offer window takes one checked delivery, digits after acknowledgement", { $0.testOfferWindowTakesOneCheckedDelivery }),
    ] }

    func testControllerOfferQRIsStrict() async throws {
        let controller = SoftwareSigner().publicKey, acknowledgement = SoftwareSigner().publicKey
        let code = ControllerOfferCode.generate()
        let offer = try ControllerOffer(controllerKey: controller, acknowledgementKey: acknowledgement, code: code,
                                        name: "최천성's MacBook Pro", model: "Mac16,7")
        let read = try ControllerOffer(text: offer.text)
        try check(read.controllerKey.x963Representation == controller.x963Representation
                  && read.acknowledgementKey.x963Representation == acknowledgement.x963Representation
                  && read.code.id == code.id && read.code.qrSecret == code.qrSecret && read.name == offer.name && read.model == "Mac16,7",
                  "the offer QR reads back exactly")
        try check(offer.text.hasPrefix("agentstoz-screen-controller:") && offer.text.utf8.count < 600, "short enough for a QR")
        try check(ScreenNearby.isValidServiceName(offer.deliveryService) && offer.deliveryService.hasPrefix("az-offer-")
                  && offer.deliveryService != ScreenNearby.registrationService(codeID: code.id), "its own nearby service, named by the code")
        try check(ControllerOfferCode.lifetime <= .seconds(300) && ControllerOfferCode.secretSize == 32, "short, one-time, 256-bit")

        // Neither QR reads as the other.
        let invite = try HostDesk().invite
        try await expectError(ControllerEnrollmentError.malformed) { _ = try ControllerOffer(text: invite.text) }
        try await expectError(RegistrationError.malformed) { _ = try RegistrationInvite(text: offer.text) }

        let fields = [ControllerOffer.version.bigEndianData, controller.x963Representation, acknowledgement.x963Representation,
                      code.id, code.qrSecret, Data("MacBook Pro".utf8), Data("Mac16,7".utf8)]
        _ = try ControllerOffer(text: offerText(fields))
        func replaced(_ index: Int, _ value: Data) -> [Data] { var copy = fields; copy[index] = value; return copy }
        var notOnCurve = controller.x963Representation
        notOnCurve[64] ^= 1
        for bad in [replaced(0, UInt16(2).bigEndianData), fields + [Data()], Array(fields.dropLast()),
                    replaced(2, controller.x963Representation),                    // one key for both jobs
                    replaced(1, controller.compressedRepresentation), replaced(1, notOnCurve),
                    replaced(3, code.id.dropLast()), replaced(4, code.qrSecret + Data([0])),
                    replaced(5, Data("Mac\nBook".utf8)), replaced(5, Data()), replaced(5, Data(String(repeating: "M", count: 33).utf8)),
                    replaced(6, Data("Mac\u{200D}16".utf8)), replaced(5, Data([0xC3, 0x28]))] {
            try await expectError(ControllerEnrollmentError.malformed) { _ = try ControllerOffer(text: offerText(bad)) }
        }
        for bad in [offer.text + "+", String(offer.text.dropLast(4)), "agentstoz-screen-controller-x:" + offer.text.dropFirst(28),
                    offer.text + String(repeating: "A", count: 1024)] {
            try await expectError(ControllerEnrollmentError.malformed) { _ = try ControllerOffer(text: bad) }
        }
    }

    func testOfferSecretIsNeverARegistrationSecret() async throws {
        let offerCode = ControllerOfferCode.generate()
        // The very same bytes as a registration code: still no frame crosses between the two domains.
        let registrationCode = try RegistrationCode(id: offerCode.id, secret: offerCode.qrSecret)
        let delivery = Data("B's key, names, record and approval".utf8)

        let brokerFrames = FramePipeEnd.capture()
        try await ControllerDeliveryChannel.transport(over: brokerFrames, code: offerCode, role: .broker).send(delivery)
        let sealed = try unwrap(brokerFrames.sent.all.first, "sealed delivery")
        try check(sealed.range(of: delivery) == nil, "the delivery is encrypted")
        try check(try await opened(sealed, by: { ControllerDeliveryChannel.transport(over: $0, code: offerCode, role: .controller) }) == delivery,
                  "the controller opens the broker's delivery")
        for (name, reader) in [
            ("registration Mac", { RegistrationPrivacyTransport(over: $0, code: registrationCode, role: .mac) as any ScreenFrameTransport }),
            ("registration device", { RegistrationPrivacyTransport(over: $0, code: registrationCode, role: .device) }),
            ("broker reading its own direction", { ControllerDeliveryChannel.transport(over: $0, code: offerCode, role: .broker) }),
        ] as [(String, (FramePipeEnd) -> any ScreenFrameTransport)] {
            try check((try? await opened(sealed, by: reader)) == nil, "\(name) opened a controller delivery")
        }

        let deviceFrames = FramePipeEnd.capture()
        try await RegistrationPrivacyTransport(over: deviceFrames, code: registrationCode, role: .device).send(delivery)
        let registration = try unwrap(deviceFrames.sent.all.first, "sealed registration metadata")
        try check((try? await opened(registration, by: { ControllerDeliveryChannel.transport(over: $0, code: offerCode, role: .controller) })) == nil,
                  "registration metadata opened as a controller delivery")
        try check(try await opened(registration, by: { RegistrationPrivacyTransport(over: $0, code: registrationCode, role: .mac) }) == delivery,
                  "registration itself is unchanged")
        // Every use of the offer secret is derived under a controller label; the raw secret is never a key.
        try check(keyBytes(offerCode.derivedKey("sas")) != offerCode.qrSecret
                  && keyBytes(offerCode.derivedKey("sas")) != keyBytes(offerCode.derivedKey("delivery/")), "derived, separated keys")
    }

    func testVersionThreeInvitationMarksMacControllerHosts() async throws {
        let desk = try HostDesk()
        let read = try RegistrationInvite(text: desk.invite.text)
        try check(read.capabilities == [.macController] && read.purpose == .macController
                  && read.nearbyScreenService == desk.invite.nearbyScreenService && read.code.qrSecret == desk.code.qrSecret,
                  "a version-3 invitation reads back with its capability")
        let ordinary = try HostDesk(purpose: .device).invite
        let readOrdinary = try RegistrationInvite(text: ordinary.text)
        try check(readOrdinary.capabilities.isEmpty && readOrdinary.purpose == .device, "version 2 stays a phone registration")

        // A phone that knows only versions 1 and 2 reads 14 or 9 fields; version 3 has 15, so it refuses the QR.
        func fields(_ text: String) throws -> [Data] {
            var base64 = String(text.dropFirst(RegistrationInvite.prefix.count)).replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/")
            base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
            return try LengthPrefixed.decode(try unwrap(Data(base64Encoded: base64), "base64"), count: 15)
        }
        let v3 = try fields(desk.invite.text)
        try check(v3[0] == UInt16(3).bigEndianData && v3[14] == UInt16(1).bigEndianData, "version 3, capability 1")
        try check((try? LengthPrefixed.decode(LengthPrefixed.encode(v3), count: 14)) == nil, "an older phone's version-2 reader refuses it")
        func text(_ fields: [Data]) -> String {
            RegistrationInvite.prefix + LengthPrefixed.encode(fields).base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        _ = try RegistrationInvite(text: text(v3))
        func replaced(_ index: Int, _ value: Data) -> [Data] { var copy = v3; copy[index] = value; return copy }
        for bad in [replaced(14, UInt16(0).bigEndianData), replaced(14, UInt16(2).bigEndianData), replaced(14, UInt16(3).bigEndianData),
                    replaced(14, Data([1])), replaced(14, Data([0, 0, 1])), replaced(0, UInt16(2).bigEndianData),
                    replaced(0, UInt16(4).bigEndianData), v3 + [Data()]] {
            try await expectError(RegistrationError.malformed) { _ = try RegistrationInvite(text: text(bad)) }
        }
        try await expectError(RegistrationError.malformed) {
            _ = try RegistrationInvite(macFingerprint: desk.invite.macFingerprint, code: desk.code, macName: "Mac", hostName: "mac.local",
                                       nearbyRegistrationService: desk.invite.nearbyRegistrationService!,
                                       nearbyScreenService: desk.invite.nearbyScreenService!,
                                       capabilities: RegistrationInvite.Capabilities(rawValue: 2))
        }
    }

    func testDeviceRegistrationRejectsControllerInvitations() async throws {
        let ordinary = try HostDesk(purpose: .device).invite
        let legacy = try RegistrationInvite(macFingerprint: ordinary.macFingerprint, code: RegistrationCode.generate(), macName: "Mac",
                                            hostName: "mac.local", address: "192.168.0.12", registrationPort: 50123, screenPort: 52741)
        for original in [legacy, ordinary] {
            let decoded = try RegistrationInvite(deviceRegistrationText: original.text)
            try decoded.requireDeviceRegistration()
            try check(decoded.purpose == .device && decoded.macFingerprint == original.macFingerprint
                      && decoded.code.id == original.code.id && decoded.code.qrSecret == original.code.qrSecret,
                      "ordinary v1 and v2 invitations still register the phone")
        }
        let controller = try HostDesk().invite
        try await expectError(RegistrationError.wrongPurpose) { _ = try RegistrationInvite(deviceRegistrationText: controller.text) }
        try await expectError(RegistrationError.wrongPurpose) { try controller.requireDeviceRegistration() }
        try await expectError(RegistrationError.malformed) { _ = try RegistrationInvite(deviceRegistrationText: "not-a-qr") }
        // The purpose-neutral parser and distinct broker path still accept the v3 invitation.
        let brokered = try RegistrationInvite(text: controller.text)
        try ControllerBroker.requireMacControllerHost(brokered)
        try check(brokered.purpose == .macController, "v3 remains available only for the dedicated broker")
    }

    func testBrokeringRefusesHostsWithoutMacControllerSupport() async throws {
        let window = try ControllerOfferWindow(controllerKey: SoftwareSigner().publicKey, name: "1호 MacBook Pro", model: "Mac16,7",
                                               openedAt: .now)
        let offer = try ControllerOffer(text: window.offer.text)
        let modern = try HostDesk(purpose: .device).invite
        let legacy = try RegistrationInvite(macFingerprint: modern.macFingerprint, code: RegistrationCode.generate(), macName: "Mac",
                                            hostName: "mac.local", address: "192.168.0.12", registrationPort: 50123, screenPort: 52741)
        for invite in [modern, legacy, try RegistrationInvite(text: modern.text), try RegistrationInvite(text: legacy.text)] {
            try await expectError(ControllerEnrollmentError.hostLacksMacControllerSupport) { try ControllerBroker.requireMacControllerHost(invite) }
            try await expectError(ControllerEnrollmentError.hostLacksMacControllerSupport) {
                _ = try ControllerBroker.record(for: offer, at: invite)
            }
        }
        let host = try HostDesk()
        let record = try ControllerBroker.record(for: offer, at: try RegistrationInvite(text: host.invite.text))
        try check(record.devicePublicKey.x963Representation == offer.controllerKey.x963Representation
                  && record.deviceName == "1호 MacBook Pro" && record.deviceModel == "Mac16,7"
                  && record.macFingerprint == host.invite.macFingerprint && record.codeID == host.code.id,
                  "the record carries A's per-target key and names, bound to B's QR")
    }

    func testBrokeredRegistrationUsesItsOwnLabelsEndToEnd() async throws {
        let a = SoftwareSigner()   // stands in for A's per-target Secure Enclave key
        let offerWindow = try ControllerOfferWindow(controllerKey: a.publicKey, name: "1호 MacBook Pro", model: "Mac16,7", openedAt: .now)
        let offer = try ControllerOffer(text: offerWindow.offer.text)

        // At B: the phone registers A's key through B's 「Mac 컨트롤러 추가」 window.
        let host = try HostDesk()
        let invite = try RegistrationInvite(text: host.invite.text)
        let record = try ControllerBroker.record(for: offer, at: invite)
        let shown = Collector<String>()
        let (phoneEnd, hostEnd) = framePipe()
        let accepting = Task {
            try await RegistrationHost.accept(over: hostEnd, peer: PeerKey(relayEndpoint: URL(string: "wss://relay.example/screen-relay")!),
                                              window: host.window, signer: host.signer, gate: PreAuthGate(policy: roomyPolicy()))
        }
        let brokering = Task {
            try await RegistrationClient.registerController(over: phoneEnd, record: record, code: invite.code,
                                                            attestation: record.attestationClientDataHash,
                                                            attestationKeyID: Data(repeating: 7, count: 32),
                                                            showSAS: { shown.add($0) }, decisionTimeout: .seconds(5))
        }
        let pending = try await within(5) { try await accepting.value }
        try check(pending.acceptance.purpose == .macController && pending.acceptance.record == record, "B sees a Mac controller's record")
        try await pending.approve()
        let (pinnedHost, approval) = try await within(5) { try await brokering.value }
        try check(shown.all == [pending.acceptance.sas], "the phone showed B's digits once, before B approved")
        try check(pinnedHost.fingerprint == invite.macFingerprint, "the phone pinned B from its QR")
        try check(RegistrationApproval.isValid(approval, for: record, mac: pinnedHost, purpose: .macController)
                  && !RegistrationApproval.isValid(approval, for: record, mac: pinnedHost), "B's approval is a Mac-controller approval only")

        // An ordinary window — what an older Mac or 「기기 등록」 opens — never satisfies a brokering phone, and a phone
        // registering itself never accepts a Mac-controller window's answer. Neither shows digits.
        for (hostPurpose, brokers) in [(RegistrationPurpose.device, true), (.macController, false)] {
            let other = try HostDesk(purpose: hostPurpose)
            let otherRecord = try RegistrationRecord(macFingerprint: other.invite.macFingerprint, codeID: other.code.id,
                                                     devicePublicKey: a.publicKey, deviceName: "1호 MacBook Pro", deviceModel: "Mac16,7")
            let digits = Collector<String>()
            let (phone, mac) = framePipe()
            let hostSide = Task {
                try await RegistrationHost.accept(over: mac, peer: PeerKey(relayEndpoint: URL(string: "wss://relay.example/screen-relay")!),
                                                  window: other.window, signer: other.signer, gate: PreAuthGate(policy: roomyPolicy()))
            }
            let phoneSide = Task {
                if brokers {
                    _ = try await RegistrationClient.registerController(over: phone, record: otherRecord, code: other.code,
                        attestation: otherRecord.attestationClientDataHash, attestationKeyID: Data(repeating: 7, count: 32),
                        showSAS: { digits.add($0) }, timeout: .seconds(2), decisionTimeout: .seconds(2))
                } else {
                    _ = try await RegistrationClient.register(over: phone, record: otherRecord, code: other.code,
                        attestation: otherRecord.attestationClientDataHash, attestationKeyID: Data(repeating: 7, count: 32),
                        showSAS: { digits.add($0) }, timeout: .seconds(2), decisionTimeout: .seconds(2))
                }
            }
            _ = try? await within(5) { try await hostSide.value }
            let outcome = await within3(phoneSide)
            guard case .failure(let error) = outcome, (error as? RegistrationError) == .badAcknowledgement else {
                throw CheckFailure(description: "a \(hostPurpose) window answered a \(brokers ? "brokering" : "registering") phone: \(outcome)")
            }
            try check(digits.all.isEmpty, "no digits shown across purposes")
        }

        // Back at A: the delivery over the offer's own channel, A's acknowledgement, then the same six digits.
        let delivery = try ControllerBroker.delivery(for: offer, at: invite, record: record, host: pinnedHost, approval: approval)
        let (brokerEnd, controllerEnd) = framePipe()
        let broker = ControllerDeliveryChannel.transport(over: brokerEnd, code: offer.code, role: .broker)
        let controller = ControllerDeliveryChannel.transport(over: controllerEnd, code: offerWindow.offer.code, role: .controller)
        try await broker.send(delivery.encoded())
        let accepted = try await offerWindow.receive(try await within(5) { try await controller.receive() }, now: .now)
        try check(accepted.delivery == delivery && accepted.delivery.host.fingerprint == invite.macFingerprint
                  && accepted.delivery.screenService == invite.nearbyScreenService && accepted.sas.count == 6, "A has B as the phone pinned it")
        try await controller.send(accepted.acknowledgement)
        let digits = try ControllerDeliveryAcknowledgement.open(try await within(5) { try await broker.receive() }, for: delivery, offer: offer)
        try check(digits == accepted.sas, "the phone shows A's digits only after A acknowledged this delivery")
        try check(!(await offerWindow.isOpen(at: .now)), "the offer is used up")
        try await expectError(ControllerEnrollmentError.alreadyUsed) { _ = try await offerWindow.receive(delivery.encoded(), now: .now) }
    }

    func testOfferWindowTakesOneCheckedDelivery() async throws {
        let a = SoftwareSigner().publicKey
        let start = ContinuousClock.now
        func offerWindow() throws -> ControllerOfferWindow {
            try ControllerOfferWindow(controllerKey: a, name: "1호 MacBook Pro", model: "Mac16,7", openedAt: start)
        }
        /// What a phone would deliver to `window` after `host` (a fresh B by default) approved `key` under `purpose`.
        func delivery(for window: ControllerOfferWindow, host: HostDesk? = nil, key: P256.Signing.PublicKey? = nil,
                      name: String = "1호 MacBook Pro", purpose: RegistrationPurpose = .macController,
                      approver: SoftwareSigner? = nil) async throws -> (ControllerDelivery?, Data) {
            let host = try host ?? HostDesk()
            let record = try RegistrationRecord(macFingerprint: host.invite.macFingerprint, codeID: host.code.id,
                                                devicePublicKey: key ?? a, deviceName: name, deviceModel: "Mac16,7")
            let approval = try await RegistrationApproval.make(for: record, purpose: purpose, signer: approver ?? host.signer)
            let data = LengthPrefixed.encode([Data(ControllerDelivery.name.utf8), ControllerOffer.version.bigEndianData, window.offer.code.id,
                                              host.signer.publicKey.x963Representation, Data(host.invite.macName.utf8),
                                              Data(host.invite.hostName.utf8), Data(host.invite.nearbyScreenService!.utf8),
                                              record.encoded(), approval])
            return (try? ControllerDelivery.decode(data), data)
        }

        let open = try offerWindow()
        let (good, goodData) = try await delivery(for: open)
        let accepted = try await open.receive(goodData, now: start.advanced(by: .seconds(240)))
        try check(good != nil && accepted.delivery == good, "a delivery within the window is taken")

        // Each refusal closes the offer, like the first attempt at a registration QR.
        let other = try offerWindow()
        let refusals: [(ControllerEnrollmentError, (ControllerOfferWindow) async throws -> Data, ContinuousClock.Instant)] = [
            (.expired, { try await delivery(for: $0).1 }, start.advanced(by: .seconds(301))),
            (.notThisController, { try await delivery(for: $0, key: SoftwareSigner().publicKey).1 }, start),
            (.mismatch, { try await delivery(for: $0, name: "Someone's Mac").1 }, start),
            (.mismatch, { _ in try await delivery(for: other).1 }, start),                 // another offer's code
            (.badApproval, { try await delivery(for: $0, purpose: .device).1 }, start),   // an ordinary phone approval
            (.badApproval, { try await delivery(for: $0, approver: SoftwareSigner()).1 }, start),
            (.malformed, { try await delivery(for: $0).1.dropLast() }, start),
        ]
        for (expected, payload, now) in refusals {
            let window = try offerWindow()
            let data = try await payload(window)
            try await expectError(expected) { _ = try await window.receive(data, now: now) }
            try check(!(await window.isOpen(at: start)), "a refused delivery closes the offer (\(expected))")
        }

        // A host whose key does not match the fingerprint in the record it approved is refused before anything else.
        let liar = try HostDesk()
        let record = try RegistrationRecord(macFingerprint: liar.invite.macFingerprint, codeID: liar.code.id, devicePublicKey: a,
                                            deviceName: "1호 MacBook Pro", deviceModel: "Mac16,7")
        let impostor = SoftwareSigner()
        let mismatched = LengthPrefixed.encode([Data(ControllerDelivery.name.utf8), ControllerOffer.version.bigEndianData, open.offer.code.id,
                                                impostor.publicKey.x963Representation, Data("Mac".utf8), Data("mac.local".utf8),
                                                Data("az-screen-00".utf8), record.encoded(),
                                                try await RegistrationApproval.make(for: record, purpose: .macController, signer: impostor)])
        try await expectError(ControllerEnrollmentError.mismatch) { _ = try ControllerDelivery.decode(mismatched) }

        // Someone who saw the offer QR races the real phone with their own host. A takes theirs and acknowledges only
        // theirs, so the real phone shows no digits, and its own delivery finds the offer used.
        let raced = try offerWindow()
        let (theirs, theirData) = try await delivery(for: raced, host: try HostDesk())
        let theirAnswer = try await raced.receive(theirData, now: start).acknowledgement
        let (real, realData) = try await delivery(for: raced)
        try check(theirs != nil && real != nil, "both deliveries are well formed")
        try await expectError(ControllerEnrollmentError.badAcknowledgement) {
            _ = try ControllerDeliveryAcknowledgement.open(theirAnswer, for: real!, offer: raced.offer)
        }
        try await expectError(ControllerEnrollmentError.alreadyUsed) { _ = try await raced.receive(realData, now: start) }
        let forged = try SoftwareSigner().key.signature(for: ControllerDeliveryAcknowledgement.signedData(for: real!)).rawRepresentation
        try await expectError(ControllerEnrollmentError.badAcknowledgement) {
            _ = try ControllerDeliveryAcknowledgement.open(forged, for: real!, offer: raced.offer)
        }
        try await expectError(ControllerEnrollmentError.malformed) {
            _ = try ControllerDeliveryAcknowledgement.open(theirAnswer.dropLast(), for: theirs!, offer: raced.offer)
        }
        try await expectError(ControllerEnrollmentError.mismatch) {
            _ = try ControllerDeliveryAcknowledgement.open(theirAnswer, for: theirs!, offer: open.offer)
        }
        try check(try ControllerDeliveryAcknowledgement.open(theirAnswer, for: theirs!, offer: raced.offer).count == 6,
                  "only the acknowledged delivery yields digits")
    }
}

extension FramePipeEnd {
    /// An end whose sends are only recorded.
    static func capture() -> FramePipeEnd { framePipe().0 }
}

/// Feeds one sealed frame to a reader built over a fresh pipe end and returns what it opened.
private func opened(_ frame: Data, by reader: (FramePipeEnd) -> any ScreenFrameTransport) async throws -> Data {
    let (feeder, end) = framePipe()
    let transport = reader(end)
    try await feeder.send(frame)
    return try await within(2) { try await transport.receive() }
}

private func unwrap<T>(_ value: T?, _ what: String, line: Int = #line) throws -> T {
    guard let value else { throw CheckFailure(description: "line \(line): missing \(what)") }
    return value
}

/// The outcome of a phone task, or a timeout failure after three seconds.
private func within3<T: Sendable>(_ task: Task<T, Error>) async -> Result<T, Error> {
    do { return .success(try await within(3) { try await task.value }) } catch { return .failure(error) }
}
