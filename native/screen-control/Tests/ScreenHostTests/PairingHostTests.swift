#if os(macOS)
import CryptoKit
import Foundation
import Network
import os
// Testable to make an `AppAttestation` and to reach the window's loopback port; nothing here touches the keychain.
@testable import ScreenControlCore
@testable import ScreenHost
import XCTest

/// A software P-256 key: the tests never reach the Secure Enclave or the keychain.
private struct PairingKey: TranscriptSigner, @unchecked Sendable {
    let key = P256.Signing.PrivateKey()
    /// How many times it signed, readable off the main actor: A's key signs P6 alone.
    let signed = OSAllocatedUnfairLock(initialState: 0)
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
        signed.withLock { $0 += 1 }
        return try key.signature(for: data)
    }
}

/// App Attest stand-in: an attestation is "valid" when it is the clientDataHash itself.
private struct EchoVerifier: AppAttestationVerifying {
    func verify(_ attestation: Data, keyID: Data, clientDataHash: Data, at date: Date) throws -> AppAttestation {
        guard attestation == clientDataHash else { throw AppAttestError.nonceMismatch }
        return AppAttestation(publicKey: P256.Signing.PrivateKey().publicKey, keyID: keyID, receipt: Data())
    }
}

/// A code as the person types it into a field: fabricated hardware key-downs (pid 0, fresh) through
/// `ControllerPairingCodeEntry`, the one maker of a submission. Nothing reaches the real input system.
private func keyed(_ code: String) -> ControllerPairingCodeEntry.Submission {
    let key = ScreenInputEvent(kind: .keyDown, ageSeconds: 0.05, sourcePid: 0, keyboardType: 40, sourceState: 1)
    var entry = ControllerPairingCodeEntry()
    for digit in code.utf8 { _ = entry.key(.digit(digit &- 48), event: key, ownPid: 4242, screenPid: 5151) }
    guard case .submitted(let submission) = entry.key(.submit, event: key, ownPid: 4242, screenPid: 5151) else {
        preconditionFailure("the field did not take \(code) from hardware keys")
    }
    return submission
}

private func roomy() -> PreAuthPolicy {
    var policy = PreAuthPolicy()
    policy.peerRate = 100; policy.peerBurst = 100; policy.globalRate = 100; policy.globalBurst = 100
    return policy
}

/// The person at A with a real Viewer client over loopback.
private final class ViewerSide: Sendable {
    let key = PairingKey()
    private let shownStream: AsyncStream<String>, shownSink: AsyncStream<String>.Continuation
    private let typedStream: AsyncStream<String?>, typedSink: AsyncStream<String?>.Continuation
    let attests: Bool
    /// The ID B's log keeps for this key (`RegisteredController.id`).
    var id: String { RegisteredController.hex(ScreenControlIdentity.fingerprint(of: key.publicKey)) }

    init(attests: Bool = false) {
        (shownStream, shownSink) = AsyncStream.makeStream()
        (typedStream, typedSink) = AsyncStream.makeStream()
        self.attests = attests
    }

    func pair(port: NWEndpoint.Port, windowID: Data, name: String = "CS의 MacBook Pro", model: String = "Mac15,7") -> Task<ControllerPairingResult, Error> {
        let prompts = ControllerPairingPrompts(
            attest: { [attests] hash in attests ? ControllerPairingAttestation(attestation: hash, keyID: Data(repeating: 0xa7, count: 32)) : nil },
            showControllerCode: { [shownSink] code, _ in shownSink.yield(code) },
            enterHostCode: { [typedStream] _ in
                var typed = typedStream.makeAsyncIterator()
                return (await typed.next() ?? nil).map(keyed)
            })
        return Task.detached { [key] in
            try await ControllerPairingClient.pair(to: .hostPort(host: .ipv4(.loopback), port: port), windowID: windowID, signer: key,
                                                   name: name, model: model, prompts: prompts, storedTimeout: .seconds(2))
        }
    }

    func shownCode() async throws -> String {
        try await withThrowingTaskGroup(of: String?.self) { group in
            group.addTask { [shownStream] in var shown = shownStream.makeAsyncIterator(); return await shown.next() }
            group.addTask { try? await Task.sleep(for: .seconds(5)); return nil }
            defer { group.cancelAll() }
            guard case let code?? = try await group.next() else { throw CancellationError() }
            return code
        }
    }

    func type(_ code: String?) { typedSink.yield(code) }
}

/// B's keychain, phones, Touch ID and session in memory.
@MainActor
private final class Harness {
    var controllers = ScreenControllers()
    var saves: [ScreenControllers] = []
    var phones: [RegisteredDevice] = []
    var authAnswers: [Bool] = []
    var authReasons: [String] = []
    var sessionActive = false
    var lidClosed = false
    var events: [ScreenControllerPairingEvent] = []
    /// While true, Touch ID stays up until the check answers `heldAuthentication`.
    var holdsAuthentication = false
    var heldAuthentication: CheckedContinuation<Bool, Never>?
    /// Runs after each save, on the main actor.
    var afterSave: () -> Void = {}
    let identity = PairingKey()

    func pairing(allowsControl: Bool = false, requiresAttestation: Bool = false) -> ScreenControllerPairing {
        let pairing = ScreenControllerPairing(dependencies: .init(
            identity: { [identity] in identity },
            hostName: { "사무실 iMac" },
            controllers: { [unowned self] in self.controllers },
            saveControllers: { [unowned self] in self.saves.append($0); self.controllers = $0; self.afterSave() },
            phones: { [unowned self] in self.phones },
            authenticate: { [unowned self] reason in
                self.authReasons.append(reason)
                if self.holdsAuthentication { return await withCheckedContinuation { self.heldAuthentication = $0 } }
                return self.authAnswers.isEmpty ? true : self.authAnswers.removeFirst()
            },
            sessionActive: { [unowned self] in self.sessionActive },
            lidClosed: { [unowned self] in self.lidClosed },
            verifier: EchoVerifier(), requiresAttestation: requiresAttestation, allowsControl: allowsControl,
            listen: { try ControllerPairingListener(host: $0, gate: PreAuthGate(policy: roomy()), bind: .ipv4(.loopback)) }))
        pairing.onEvent = { [unowned self] in self.events.append($0) }
        return pairing
    }
}

/// Docs: docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.3, SR-19, SR-20, SR-22, SR-29, SR-37. B's window with a real
/// Viewer client over loopback: the approval writes the switch and the row once, 「조작」 waits for S-M3, 「기존 항목
/// 바꾸기」 is off unless chosen, and a session starting closes the window.
@MainActor
final class PairingHostTests: XCTestCase {
    private func eventually(_ what: String, _ condition: () -> Bool) async throws {
        for _ in 0..<500 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("timed out waiting for \(what)")
        throw CancellationError()
    }

    private func review(_ pairing: ScreenControllerPairing) -> ScreenControllerPairing.Review? {
        switch pairing.phase {
        case .reviewing(let review), .approving(let review), .showingHostCode(_, let review): review
        default: nil
        }
    }

    private func isOpen(_ pairing: ScreenControllerPairing) -> Bool { if case .open = pairing.phase { true } else { false } }
    private func isClosed(_ pairing: ScreenControllerPairing) -> Bool { if case .closed = pairing.phase { true } else { false } }
    private func isApproving(_ pairing: ScreenControllerPairing) -> Bool { if case .approving = pairing.phase { true } else { false } }

    /// Opens a window with a real click, lets A get to P4 and returns A's task and code ①.
    private func reach(_ pairing: ScreenControllerPairing, _ viewer: ViewerSide, name: String = "CS의 MacBook Pro",
                       model: String = "Mac15,7") async throws -> (Task<ControllerPairingResult, Error>, String) {
        await pairing.open(click: nil)
        try await eventually("the window") { isOpen(pairing) }
        let port = try XCTUnwrap(pairing.port), windowID = try XCTUnwrap(pairing.window?.windowID)
        let client = viewer.pair(port: port, windowID: windowID, name: name, model: model)
        let code = try await viewer.shownCode()
        try await eventually("the review") { review(pairing) != nil }
        return (client, code)
    }

    private func result(_ task: Task<ControllerPairingResult, Error>) async -> Result<ControllerPairingResult, Error> {
        do { return .success(try await task.value) } catch { return .failure(error) }
    }

    func testApprovalTurnsTheSwitchOnAndAddsTheRowInOneChange() async throws {
        let harness = Harness(), viewer = ViewerSide(attests: true)
        let pairing = harness.pairing()
        let (client, code1) = try await reach(pairing, viewer)
        let shown = try XCTUnwrap(review(pairing))
        XCTAssertEqual(shown.name, "CS의 MacBook Pro")
        XCTAssertEqual(shown.model, "Mac15,7")
        XCTAssertEqual(shown.shortFingerprint, ScreenControlIdentity.shortFingerprint(of: viewer.key.publicKey))
        XCTAssertTrue(shown.attested, "a valid attestation must show as 「확인됨」")
        XCTAssertEqual(shown.windowNumber, pairing.window.map { ControllerPairingProtocol.windowNumber($0.windowID) })
        await pairing.enterCode(keyed(code1))
        XCTAssertTrue(isApproving(pairing))
        XCTAssertTrue(harness.saves.isEmpty, "nothing is stored before P6")
        let approval = Task { @MainActor in await pairing.approve(click: nil, grant: .view) }
        try await eventually("code ②") { if case .showingHostCode = pairing.phase { true } else { false } }
        if case .showingHostCode(let code, _) = pairing.phase { viewer.type(code) }
        await approval.value
        let paired = try await client.value
        XCTAssertEqual(paired.state, .confirmed)
        XCTAssertEqual(paired.grant, .view)
        XCTAssertEqual(paired.host.publicKey.x963Representation, harness.identity.publicKey.x963Representation)
        XCTAssertEqual(harness.saves.count, 1, "the switch and the row are one change")
        let saved = try XCTUnwrap(harness.saves.first)
        XCTAssertTrue(saved.allowMacControllers, "the first approval turns 「다른 Mac 연결 허용」 on")
        XCTAssertEqual(saved.controllers.count, 1)
        let row = try XCTUnwrap(saved.controllers.first)
        XCTAssertEqual(row.id, RegisteredController.hex(ScreenControlIdentity.fingerprint(of: viewer.key.publicKey)))
        XCTAssertEqual(row.enrollment.method, .directSAS)
        XCTAssertTrue(row.bindsGenuineViewer && row.enrollment.attestationKeyID == Data(repeating: 0xa7, count: 32))
        XCTAssertEqual(row.grant, .view)
        XCTAssertEqual(row.keyFingerprint, paired.controllerShortFingerprint, "both lists show the same four characters")
        XCTAssertEqual(harness.authReasons, [String(format: ScreenControllerPairing.authenticationReason, "CS의 MacBook Pro")])
        XCTAssertEqual(harness.events, [.enrolled(row)])
        XCTAssertTrue(isClosed(pairing) && pairing.window == nil && pairing.port == nil, "the window closes after the pairing")
    }

    func testControlIsOfferedAndKeptOnlyAfterSM3() async throws {
        XCTAssertFalse(ScreenInputCalibration.current.allowsControl, "S-M3 has not passed in this build")
        for allowsControl in [false, true] {
            let harness = Harness(), viewer = ViewerSide()
            let pairing = harness.pairing(allowsControl: allowsControl)
            let (client, code1) = try await reach(pairing, viewer)
            XCTAssertEqual(review(pairing)?.allowsControl, allowsControl, "「조작」 must be hidden until S-M3")
            await pairing.enterCode(keyed(code1))
            let approval = Task { @MainActor in await pairing.approve(click: nil, grant: .control) }
            try await eventually("code ②") { if case .showingHostCode = pairing.phase { true } else { false } }
            if case .showingHostCode(let code, _) = pairing.phase { viewer.type(code) }
            await approval.value
            let paired = try await client.value
            XCTAssertEqual(paired.grant, allowsControl ? .control : .view, "B signed another grant than it stored")
            XCTAssertEqual(harness.controllers.controllers.first?.grant, allowsControl ? .control : .view)
            XCTAssertFalse(harness.controllers.controllers.first?.bindsGenuineViewer ?? true, "no attestation, yet bound")
        }
    }

    func testReplacingAnExistingRowIsOffUnlessChosen() async throws {
        for chooses in [false, true] {
            let harness = Harness(), viewer = ViewerSide()
            let old = RegisteredController(publicKey: P256.Signing.PrivateKey().publicKey, name: "CS의 MacBook Pro", model: "Mac15,7",
                                           enrollment: try .directSAS(attestation: nil), at: Date(timeIntervalSince1970: 1_790_000_000))
            harness.controllers = ScreenControllers(allowMacControllers: true, controllers: [old])
            let pairing = harness.pairing()
            let (client, code1) = try await reach(pairing, viewer)
            let candidates = try XCTUnwrap(review(pairing)).replacements
            XCTAssertEqual(candidates.map(\.id), [old.id])
            XCTAssertEqual(candidates.first?.shortFingerprint, old.keyFingerprint, "the old row's fingerprint stands beside the new one")
            await pairing.enterCode(keyed(code1))
            let approval = Task { @MainActor in
                if chooses { await pairing.approve(click: nil, grant: .view, replacing: old.id) } else { await pairing.approve(click: nil, grant: .view) }
            }
            try await eventually("code ②") { if case .showingHostCode = pairing.phase { true } else { false } }
            if case .showingHostCode(let code, _) = pairing.phase { viewer.type(code) }
            await approval.value
            _ = try await client.value
            let ids = Set(harness.controllers.controllers.map(\.id))
            XCTAssertEqual(ids.contains(old.id), !chooses, chooses ? "the chosen row was kept" : "a row was replaced without the person choosing it")
            XCTAssertEqual(harness.controllers.controllers.count, chooses ? 1 : 2)
        }
    }

    func testSessionStartClosesTheWindowAndRefusesThePairing() async throws {
        // An open window with nobody in it.
        let harness = Harness()
        let pairing = harness.pairing()
        await pairing.open(click: nil)
        try await eventually("the window") { isOpen(pairing) }
        let window = try XCTUnwrap(pairing.window)
        pairing.sessionStarted()
        XCTAssertEqual(pairing.phase, .closed(notice: "화면 연결이 시작돼 등록 창을 닫았습니다"))
        XCTAssertFalse(window.isOpen(), "the window still takes a P1")
        XCTAssertNil(pairing.port, "the listener is still up")
        // A pairing waiting for the person: refused, signed, nothing stored, and code ② never shown.
        let viewer = ViewerSide()
        let (client, _) = try await reach(pairing, viewer)
        pairing.sessionStarted()
        XCTAssertTrue(isClosed(pairing))
        guard case .failure(let error) = await result(client) else { return XCTFail("A paired across a session start") }
        XCTAssertEqual(error as? ControllerPairingError, .refused)
        XCTAssertTrue(harness.saves.isEmpty)
        XCTAssertEqual(harness.events.last, .refused(name: "CS의 MacBook Pro", reason: .sessionStarted, controllerID: viewer.id))
        // After code ①, before 「승인」: a press that comes after the session started asks for no Touch ID and sends
        // nothing. (A session starting while Touch ID is up, and while code ② shows, have their own tests below.)
        let third = ViewerSide()
        let (thirdClient, code1) = try await reach(pairing, third)
        await pairing.enterCode(keyed(code1))
        harness.sessionActive = true
        pairing.sessionStarted()
        await pairing.approve(click: nil, grant: .view)
        XCTAssertTrue(harness.authReasons.isEmpty, "Touch ID was asked for a closed window")
        guard case .failure = await result(thirdClient) else { return XCTFail("A paired across a session start") }
        // While the session lasts, the window does not open.
        await pairing.open(click: nil)
        XCTAssertTrue(isClosed(pairing) && pairing.port == nil)
        XCTAssertNotNil(pairing.notice)
    }

    func testOpeningNeedsTheHardwareClickNoSessionAndAnOpenLid() async throws {
        let harness = Harness()
        let pairing = harness.pairing()
        for refusal in [ScreenInputRefusal.noCurrentEvent, .synthetic, .remoteDesktop, .staleEvent] {
            await pairing.open(click: refusal)
            XCTAssertTrue(isClosed(pairing) && pairing.window == nil, "\(refusal) opened the window")
            XCTAssertEqual(pairing.notice, ScreenInputOriginText.notInFront)
        }
        harness.lidClosed = true
        await pairing.open(click: nil)
        XCTAssertTrue(isClosed(pairing) && pairing.window == nil, "opened with the lid closed")
        harness.lidClosed = false
        harness.sessionActive = true
        await pairing.open(click: nil)
        XCTAssertTrue(isClosed(pairing) && pairing.window == nil, "opened during a session")
        harness.sessionActive = false
        await pairing.open(click: nil)
        XCTAssertTrue(isOpen(pairing))
        // Reopening makes a new window and a new number; the old one takes nothing.
        let first = try XCTUnwrap(pairing.window)
        await pairing.open(click: nil)
        let second = try XCTUnwrap(pairing.window)
        XCTAssertNotEqual(first.windowID, second.windowID)
        XCTAssertFalse(first.isOpen())
        pairing.close()
        XCTAssertTrue(isClosed(pairing) && !second.isOpen())
    }

    func testWrongCodeClosesTheWindow() async throws {
        let harness = Harness(), viewer = ViewerSide()
        let pairing = harness.pairing()
        let (client, code1) = try await reach(pairing, viewer)
        let window = try XCTUnwrap(pairing.window)
        await pairing.enterCode(keyed(code1 == "000000" ? "111111" : "000000"))
        XCTAssertEqual(pairing.phase, .closed(notice: ControllerPairingText.codeMismatch))
        XCTAssertTrue(window.isTaken && !window.isOpen())
        guard case .failure(let error) = await result(client) else { return XCTFail("paired after a wrong code ①") }
        XCTAssertEqual(error as? ControllerPairingError, .refused)
        XCTAssertTrue(harness.saves.isEmpty && harness.authReasons.isEmpty)
        XCTAssertEqual(harness.events, [.refused(name: "CS의 MacBook Pro", reason: .codeMismatch, controllerID: viewer.id)])
    }

    func testAPhoneKeyIsRefused() async throws {
        let harness = Harness(), viewer = ViewerSide()
        let record = try RegistrationRecord(macFingerprint: Data(repeating: 7, count: 32), codeID: Data(repeating: 9, count: RegistrationCode.idSize),
                                            devicePublicKey: viewer.key.publicKey, deviceName: "iPhone", deviceModel: "iPhone17,1")
        harness.phones = [RegisteredDevice(record: record, attestationKeyID: Data(repeating: 1, count: 32))]
        let pairing = harness.pairing()
        await pairing.open(click: nil)
        try await eventually("the window") { isOpen(pairing) }
        let client = viewer.pair(port: try XCTUnwrap(pairing.port), windowID: try XCTUnwrap(pairing.window?.windowID))
        guard case .failure = await result(client) else { return XCTFail("a phone's key paired as a controller") }
        try await eventually("the refusal") { isClosed(pairing) }
        XCTAssertEqual(pairing.phase, .closed(notice: "이 키는 이미 폰으로 등록돼 있어 받지 않았습니다"))
        XCTAssertTrue(harness.saves.isEmpty)
        XCTAssertEqual(harness.events, [.refused(name: "CS의 MacBook Pro", reason: .registeredAsPhone, controllerID: viewer.id)],
                       "the log names the key a phone holds (SR-30)")
    }

    func testApprovalNeedsTheClickAndBiometricsOrWatch() async throws {
        let harness = Harness(), viewer = ViewerSide()
        let pairing = harness.pairing()
        let (client, code1) = try await reach(pairing, viewer)
        await pairing.enterCode(keyed(code1))
        // Accessibility, a program or a remote desktop never approves, and never even reaches Touch ID.
        for refusal in [ScreenInputRefusal.noCurrentEvent, .synthetic, .remoteDesktop] {
            await pairing.approve(click: refusal, grant: .view)
            XCTAssertTrue(isApproving(pairing))
            XCTAssertEqual(pairing.notice, ScreenInputOriginText.notInFront)
        }
        XCTAssertTrue(harness.authReasons.isEmpty)
        // A replacement the window did not offer is refused before Touch ID, and the window says why.
        await pairing.approve(click: nil, grant: .view, replacing: "not-a-candidate")
        XCTAssertTrue(harness.authReasons.isEmpty && isApproving(pairing))
        XCTAssertEqual(pairing.notice, ScreenControllerPairing.replacementNotice)
        // Touch ID cancelled: still waiting, nothing sent.
        harness.authAnswers = [false]
        await pairing.approve(click: nil, grant: .view)
        XCTAssertTrue(isApproving(pairing))
        XCTAssertEqual(harness.authReasons.count, 1)
        XCTAssertTrue(harness.saves.isEmpty)
        // Then the person approves.
        let approval = Task { @MainActor in await pairing.approve(click: nil, grant: .view) }
        try await eventually("code ②") { if case .showingHostCode = pairing.phase { true } else { false } }
        if case .showingHostCode(let code, _) = pairing.phase { viewer.type(code) }
        await approval.value
        let confirmed = try await client.value.state
        XCTAssertEqual(confirmed, .confirmed)
        XCTAssertEqual(harness.saves.count, 1)
    }

    func testAnAttestationRequiringBuildRefusesAPlainViewer() async throws {
        let harness = Harness(), viewer = ViewerSide(attests: false)
        let pairing = harness.pairing(requiresAttestation: true)
        await pairing.open(click: nil)
        try await eventually("the window") { isOpen(pairing) }
        let client = viewer.pair(port: try XCTUnwrap(pairing.port), windowID: try XCTUnwrap(pairing.window?.windowID))
        guard case .failure = await result(client) else { return XCTFail("paired without the required attestation") }
        try await eventually("the refusal") { isClosed(pairing) }
        XCTAssertEqual(pairing.phase, .closed(notice: ControllerPairingText.untrustedViewer))
        XCTAssertTrue(harness.saves.isEmpty)
        XCTAssertEqual(harness.events, [.refused(name: ControllerPairingText.unnamed, reason: .untrustedViewer, controllerID: nil)],
                       "a Viewer that could not prove itself is logged as refused (SR-30)")
    }

    /// Blocks this (main) thread until `signal` holds, then `settle` seconds more: what a busy main actor does to B's
    /// store, which runs on it. Synchronous on purpose.
    private nonisolated func holdTheMainActor(until signal: () -> Bool, settle: TimeInterval) {
        let until = Date().addingTimeInterval(5)
        while !signal(), Date() < until { Thread.sleep(forTimeInterval: 0.01) }
        Thread.sleep(forTimeInterval: settle)
    }

    func testP6ArrivingAsTheWindowClosesStoresNothing() async throws {
        // P6 arrives and verifies while B's main actor is busy; the person closes the window, or a session starts
        // (SR-37), before the store gets the actor. Nothing is stored, the switch stays off, and the log hears one refusal.
        for bySession in [false, true] {
            let harness = Harness(), viewer = ViewerSide()
            let pairing = harness.pairing()
            let (client, code1) = try await reach(pairing, viewer)
            await pairing.enterCode(keyed(code1))
            let approval = Task { @MainActor in await pairing.approve(click: nil, grant: .view) }
            try await eventually("code ②") { if case .showingHostCode = pairing.phase { true } else { false } }
            guard case .showingHostCode(let code2, _) = pairing.phase else { return XCTFail("no code ②") }
            viewer.type(code2)
            holdTheMainActor(until: { viewer.key.signed.withLock { $0 } > 0 }, settle: 0.5)
            XCTAssertEqual(viewer.key.signed.withLock { $0 }, 1, "A did not sign P6")
            if bySession {
                harness.sessionActive = true
                pairing.sessionStarted()
            } else {
                pairing.close()
            }
            await approval.value
            let paired = await result(client)
            XCTAssertTrue(harness.saves.isEmpty, "B stored a controller after its window closed (\(bySession ? "session" : "closed"))")
            XCTAssertFalse(harness.controllers.allowMacControllers, "「다른 Mac 연결 허용」 turned on after the window closed")
            XCTAssertEqual(harness.events, [.refused(name: "CS의 MacBook Pro", reason: bySession ? .sessionStarted : .windowClosed,
                                                     controllerID: viewer.id)])
            XCTAssertEqual(pairing.phase, .closed(notice: bySession ? ScreenControllerPairing.sessionNotice : nil))
            if case .success(let result) = paired { XCTAssertEqual(result.state, .needsCheck, "A confirmed a pairing B never stored") }
        }
    }

    func testASessionAfterTheStoreReportsTheAdditionNotARefusal() async throws {
        // The row is stored, then a session starts before A heard P7: the window closes, the log hears the enrolment
        // alone, and B still tells A it stored the key.
        let harness = Harness(), viewer = ViewerSide()
        let pairing = harness.pairing()
        let (client, code1) = try await reach(pairing, viewer)
        await pairing.enterCode(keyed(code1))
        harness.afterSave = { [unowned harness] in
            Task { @MainActor in
                harness.sessionActive = true
                pairing.sessionStarted()
            }
        }
        let approval = Task { @MainActor in await pairing.approve(click: nil, grant: .view) }
        try await eventually("code ②") { if case .showingHostCode = pairing.phase { true } else { false } }
        guard case .showingHostCode(let code2, let shown) = pairing.phase else { return XCTFail("no code ②") }
        viewer.type(code2)
        await approval.value
        let paired = try await client.value
        let row = try XCTUnwrap(harness.controllers.controllers.first)
        XCTAssertEqual(harness.saves.count, 1)
        XCTAssertEqual(harness.events, [.enrolled(row)], "a stored controller was also logged as refused")
        XCTAssertEqual(pairing.phase, .closed(notice: "‘\(shown.name)’을(를) 추가했습니다 · 키 지문 \(shown.shortFingerprint)"))
        XCTAssertEqual(paired.state, .confirmed, "the session cut P7 for a key B stored")
    }

    func testASecondPressOnApproveDoesNotBreakTheFirst() async throws {
        // 「승인」 pressed twice while Touch ID is up: the second press does nothing, and the first approval goes through.
        let harness = Harness(), viewer = ViewerSide()
        let pairing = harness.pairing()
        let (client, code1) = try await reach(pairing, viewer)
        await pairing.enterCode(keyed(code1))
        harness.holdsAuthentication = true
        XCTAssertFalse(pairing.approvalInProgress)
        let first = Task { @MainActor in await pairing.approve(click: nil, grant: .view) }
        try await eventually("Touch ID") { harness.heldAuthentication != nil }
        XCTAssertTrue(pairing.approvalInProgress, "the window would not disable 「승인」 while Touch ID is up")
        await pairing.approve(click: nil, grant: .view)
        XCTAssertEqual(harness.authReasons.count, 1, "a second press asked for Touch ID again")
        XCTAssertTrue(isApproving(pairing), "a second press ended the approval in progress")
        harness.holdsAuthentication = false
        harness.heldAuthentication?.resume(returning: true)
        try await eventually("code ②") { if case .showingHostCode = pairing.phase { true } else { false } }
        if case .showingHostCode(let code, _) = pairing.phase { viewer.type(code) }
        await first.value
        let paired = try await client.value
        XCTAssertEqual(paired.state, .confirmed)
        XCTAssertEqual(harness.saves.count, 1)
        XCTAssertFalse(pairing.approvalInProgress)
        // A cancelled Touch ID frees the button again.
        let again = Harness(), other = ViewerSide()
        let second = again.pairing()
        let (otherClient, otherCode) = try await reach(second, other)
        await second.enterCode(keyed(otherCode))
        again.authAnswers = [false]
        await second.approve(click: nil, grant: .view)
        XCTAssertFalse(second.approvalInProgress, "「승인」 stayed disabled after Touch ID was cancelled")
        second.refuse()
        _ = await result(otherClient)
    }

    func testASessionStartingWhileTouchIDIsUpSendsNothing() async throws {
        // The person pressed 「승인」 and Touch ID is up when a session starts: the window closes with a signed refusal,
        // and Touch ID's answer, when it comes, sends no P5.
        let harness = Harness(), viewer = ViewerSide()
        let pairing = harness.pairing()
        let (client, code1) = try await reach(pairing, viewer)
        await pairing.enterCode(keyed(code1))
        harness.holdsAuthentication = true
        let approval = Task { @MainActor in await pairing.approve(click: nil, grant: .view) }
        try await eventually("Touch ID") { harness.heldAuthentication != nil }
        harness.sessionActive = true
        pairing.sessionStarted()
        XCTAssertEqual(pairing.phase, .closed(notice: ScreenControllerPairing.sessionNotice))
        harness.heldAuthentication?.resume(returning: true)
        await approval.value
        XCTAssertEqual(pairing.phase, .closed(notice: ScreenControllerPairing.sessionNotice), "Touch ID's answer reopened the approval")
        guard case .failure(let error) = await result(client) else { return XCTFail("A paired across a session start") }
        XCTAssertEqual(error as? ControllerPairingError, .refused, "A did not hear B's signed refusal")
        XCTAssertEqual(viewer.key.signed.withLock { $0 }, 0, "A signed P6")
        XCTAssertTrue(harness.saves.isEmpty)
        XCTAssertEqual(harness.events, [.refused(name: "CS의 MacBook Pro", reason: .sessionStarted, controllerID: viewer.id)])
    }

    func testASessionStartingWhileCodeTwoShowsStoresNothing() async throws {
        // P5 is out and code ② is on B's screen when a session starts (SR-37): the window closes before the code can
        // travel in the stream, and A's P6, if it still goes out, reaches no store.
        let harness = Harness(), viewer = ViewerSide()
        let pairing = harness.pairing()
        let (client, code1) = try await reach(pairing, viewer)
        await pairing.enterCode(keyed(code1))
        let approval = Task { @MainActor in await pairing.approve(click: nil, grant: .view) }
        try await eventually("code ②") { if case .showingHostCode = pairing.phase { true } else { false } }
        guard case .showingHostCode(let code2, _) = pairing.phase else { return XCTFail("no code ②") }
        harness.sessionActive = true
        pairing.sessionStarted()
        XCTAssertEqual(pairing.phase, .closed(notice: ScreenControllerPairing.sessionNotice), "code ② stayed on screen")
        await approval.value
        viewer.type(code2)
        let paired = await result(client)
        XCTAssertTrue(harness.saves.isEmpty, "B stored a controller after the session closed its window")
        XCTAssertFalse(harness.controllers.allowMacControllers)
        XCTAssertEqual(harness.events, [.refused(name: "CS의 MacBook Pro", reason: .sessionStarted, controllerID: viewer.id)])
        if case .success(let result) = paired { XCTAssertEqual(result.state, .needsCheck, "A confirmed a pairing B never stored") }
    }
}
#endif
