import CryptoKit
import Foundation
import Network
import os
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// Direct controller pairing v1 (ControllerPairing.swift, docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.3, 7.1, SR-20,
// SR-29, SR-31): the reference vectors, the exchange over real loopback sockets and in-memory pipes, every way it must
// end without a registration, a machine in the middle, and the hardware-only code field. No real key, keychain, screen
// or input: software signers, an echoing attester and fabricated events.

private let pairingName = "CS의 MacBook Pro", pairingModel = "Mac15,7", hostMacName = "사무실 iMac"

private func pairingHost(signer: SoftwareSigner = SoftwareSigner(), requiresAttestation: Bool = false,
                         verifier: any AppAttestationVerifying = EchoAttester(), opened: Date = Date(),
                         decisionTimeout: Duration = .seconds(180), attestationTimeout: Duration = .seconds(60)) throws -> ControllerPairingHost {
    try ControllerPairingHost(signer: signer, hostName: hostMacName, verifier: verifier, requiresAttestation: requiresAttestation, now: opened,
                              windowID: randomBytes(ControllerPairingProtocol.windowIDSize), decisionTimeout: decisionTimeout,
                              attestationTimeout: attestationTimeout)
}

/// The person at A, as the Viewer's prompts reach them: what A showed, and code ② when the check types it.
private final class PairingPerson: Sendable {
    private let shownStream: AsyncStream<String>
    private let shownSink: AsyncStream<String>.Continuation
    private let typedStream: AsyncStream<String?>
    private let typedSink: AsyncStream<String?>.Continuation
    private let attestation: @Sendable (Data) -> ControllerPairingAttestation?
    let attested = Collector<Data>()
    let grants = Collector<ControllerPairingGrant>()
    let shownFingerprints = Collector<String>()

    init(attest: @escaping @Sendable (Data) -> ControllerPairingAttestation? = { _ in nil }) {
        (shownStream, shownSink) = AsyncStream.makeStream()
        (typedStream, typedSink) = AsyncStream.makeStream()
        attestation = attest
    }

    var prompts: ControllerPairingPrompts {
        ControllerPairingPrompts(
            attest: { [self] hash in attested.add(hash); return attestation(hash) },
            showControllerCode: { [self] code, fingerprint in shownFingerprints.add(fingerprint); shownSink.yield(code) },
            enterHostCode: { [self] grant in
                grants.add(grant)
                var typed = typedStream.makeAsyncIterator()
                return (await typed.next() ?? nil).map { ControllerPairingCodeEntry.Submission(text: $0) }
            })
    }

    /// Code ① as A showed it.
    func shownCode(line: Int = #line) async throws -> String {
        try await within(5, line: line) { [self] in
            var shown = shownStream.makeAsyncIterator()
            guard let code = await shown.next() else { throw CheckFailure(description: "line \(line): A showed no code") }
            return code
        }
    }

    func type(_ code: String?) { typedSink.yield(code) }
    var neverShown: Bool { shownFingerprints.all.isEmpty }
}

/// App Attest stand-in: "attests" by echoing the clientDataHash, which `EchoAttester` accepts.
private let echoAttestation: @Sendable (Data) -> ControllerPairingAttestation? = {
    ControllerPairingAttestation(attestation: $0, keyID: Data(repeating: 0xa7, count: 32))
}

/// A and B over in-memory pipes, every frame each side sent recorded.
private struct PipePairing {
    let host: ControllerPairingHost
    let hostKey: P256.Signing.PublicKey
    let controllerKey: P256.Signing.PublicKey
    let person: PairingPerson
    let a: FramePipeEnd, b: FramePipeEnd
    let client: Task<ControllerPairingResult, Error>
    let accepted: Task<PendingControllerPairing, Error>

    init(host: ControllerPairingHost, controller: any TranscriptSigner = SoftwareSigner(), person: PairingPerson = PairingPerson(),
         windowID: Data? = nil, storedTimeout: Duration = .seconds(3)) {
        (a, b) = framePipe()
        self.host = host
        hostKey = host.signer.publicKey
        controllerKey = controller.publicKey
        self.person = person
        let (a, b) = (a, b)
        client = Task {
            try await ControllerPairingClient.pair(over: a, windowID: windowID ?? host.windowID, signer: controller, name: pairingName,
                                                   model: pairingModel, prompts: person.prompts, storedTimeout: storedTimeout)
        }
        accepted = Task { try await host.accept(over: b) }
    }

    func pending(line: Int = #line) async throws -> PendingControllerPairing {
        try await within(5, line: line) { [accepted] in try await accepted.value }
    }

    func result(line: Int = #line) async -> Result<ControllerPairingResult, Error> {
        do { return .success(try await within(5, line: line) { [client] in try await client.value }) } catch { return .failure(error) }
    }
}

/// A pairing task's outcome, or a timeout failure after five seconds.
private func outcome(_ task: Task<ControllerPairingResult, Error>, line: Int = #line) async -> Result<ControllerPairingResult, Error> {
    do { return .success(try await within(5, line: line) { try await task.value }) } catch { return .failure(error) }
}

private func expectPairingError(_ expected: ControllerPairingError, _ result: Result<ControllerPairingResult, Error>, line: Int = #line) throws {
    guard case .failure(let error) = result else { throw CheckFailure(description: "line \(line): paired, expected \(expected)") }
    try check(error as? ControllerPairingError == expected, "expected \(expected), got \(error)", line: line)
}

private func pairingVectors() throws -> [String: Any] {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "ControllerPairingContract").appending(path: "vectors.json")
    guard let data = try? Data(contentsOf: url), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw CheckFailure(description: "ControllerPairingContract/vectors.json unreadable")
    }
    return json
}

private func hexData(_ text: Any?, _ what: String) throws -> Data {
    guard let text = text as? String, text.count % 2 == 0 else { throw CheckFailure(description: "vectors: \(what) is not hex") }
    var out = Data()
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(index, offsetBy: 2)
        guard let byte = UInt8(text[index..<next], radix: 16) else { throw CheckFailure(description: "vectors: \(what) is not hex") }
        out.append(byte)
        index = next
    }
    return out
}

private func katKey(_ name: String) throws -> P256.Signing.PrivateKey {
    try P256.Signing.PrivateKey(rawRepresentation: sha256(Data(("agentstoz kat " + name).utf8)))
}

/// A hardware key-down on the code field (pid 0, fresh): what `humanKey` accepts.
private let hardwareKey = ScreenInputEvent(kind: .keyDown, ageSeconds: 0.05, sourcePid: 0, keyboardType: 40, sourceState: 1)

/// A code typed into a fresh field with `hardwareKey`: the public way in, a submission only the field makes.
private func keyed(_ code: String) throws -> ControllerPairingCodeEntry.Submission {
    var entry = ControllerPairingCodeEntry()
    for digit in code.utf8 { _ = entry.key(.digit(digit &- 48), event: hardwareKey, ownPid: 4242, screenPid: 5151) }
    guard case .submitted(let submission) = entry.key(.submit, event: hardwareKey, ownPid: 4242, screenPid: 5151) else {
        throw CheckFailure(description: "the field did not take \(code) from hardware keys")
    }
    return submission
}

extension ScreenControlChecks {
    static var controllerPairingChecks: [(String, (ScreenControlChecks) -> () async throws -> Void)] { [
        ("pairing: the core matches the independent reference vectors", { $0.testPairingMatchesTheReferenceVectors }),
        ("pairing: the App Attest requirement stays off until S-K2 vectors exist", { $0.testPairingAttestationSwitchMatchesTheVectors }),
        ("pairing: real loopback sockets, the same codes on both Macs, P5–P7 verify", { $0.testPairingOverLoopback }),
        ("pairing: P5, P6 and P7 verify under their own labels and keys", { $0.testPairingSignaturesVerifyUnderTheirLabels }),
        ("pairing: a commitment B did not keep aborts before any code", { $0.testPairingCommitmentMismatchAborts }),
        ("pairing: a wrong code ① refuses, signed, and uses the window up", { $0.testPairingWrongControllerCodeRefuses }),
        ("pairing: a wrong code ② sends nothing and signs nothing", { $0.testPairingWrongHostCodeSendsNothing }),
        ("pairing: a second P1 is answered busy and raises the Viewer's alarm", { $0.testPairingSecondHelloIsBusy }),
        ("pairing: the window and the decision expire", { $0.testPairingWindowAndDecisionExpire }),
        ("pairing: a lost P7 leaves needsCheck and P6 is never resent", { $0.testPairingLostStoredLeavesNeedsCheck }),
        ("pairing: a missing or wrong attestation is refused", { $0.testPairingAttestation }),
        ("pairing: a machine in the middle meets a code mismatch", { $0.testPairingMachineInTheMiddle }),
        ("pairing: codes agree across two transcripts only by chance", { $0.testPairingCodesCollideOnlyByChance }),
        ("pairing: its labels never pass for another signature", { $0.testPairingLabelsDoNotCross }),
        ("pairing: names are filtered for display, never trusted", { $0.testPairingNamesAreFiltered }),
        ("pairing: every message parses strictly", { $0.testPairingMessagesParseStrictly }),
        ("pairing: the code field takes hardware key-downs only", { $0.testPairingCodeEntryTakesHardwareKeysOnly }),
        ("pairing: a refusal or session start after the code ends without a registration", { $0.testPairingRefusalEndsWithoutRegistration }),
        ("pairing: a refusal after P6 arrived, or while B stores, sends no P7 and stores nothing new", { $0.testPairingRefusalAfterP6 }),
        ("pairing: giving up at A ends it as cancelled, not as B's window closing", { $0.testPairingGivingUpAtAIsCancelled }),
    ] }

    func testPairingMatchesTheReferenceVectors() throws {
        let json = try pairingVectors()
        try check(json["label"] as? String == ControllerPairingProtocol.label, "label")
        guard let vectors = json["vectors"] as? [[String: Any]], vectors.count >= 2 else { throw CheckFailure(description: "vectors missing") }
        for v in vectors {
            let name = v["case"] as? String ?? "?"
            guard let inputs = v["inputs"] as? [String: Any], let controllerName = inputs["controllerName"] as? String,
                  let controllerModel = inputs["controllerModel"] as? String, let hostName = inputs["hostName"] as? String,
                  let controllerScalar = inputs["controllerScalar"] as? String, let hostScalar = inputs["hostScalar"] as? String else {
                throw CheckFailure(description: "\(name): inputs")
            }
            let controllerKey = try katKey(controllerScalar).publicKey, hostKey = try katKey(hostScalar).publicKey
            let windowID = try hexData(inputs["windowID"], "windowID")
            let controllerNonce = try hexData(inputs["controllerNonce"], "controllerNonce"), hostNonce = try hexData(inputs["hostNonce"], "hostNonce")
            try check(controllerKey.x963Representation == (try hexData(v["controllerKey"], "controllerKey")), "\(name): controller key")
            try check(hostKey.x963Representation == (try hexData(v["hostKey"], "hostKey")), "\(name): host key")
            let hello = try ControllerPairingHello(controllerKey: controllerKey, name: controllerName, model: controllerModel)
            try check(hello.encoded == (try hexData(v["p1"], "p1")), "\(name): P1 bytes")
            let commitment = ControllerPairingMath.commitment(windowID: windowID, controllerKey: controllerKey.x963Representation,
                                                              hostKey: hostKey.x963Representation, hostNonce: hostNonce)
            try check(commitment == (try hexData(v["commitment"], "commitment")), "\(name): C_B")
            let commit = try ControllerPairingCommit(windowID: windowID, hostKey: hostKey, hostName: hostName, commitment: commitment)
            try check(commit.encoded == (try hexData(v["p2"], "p2")), "\(name): P2 bytes")
            try check(try ControllerPairingReveal(nonce: controllerNonce, attestation: Data(), attestationKeyID: Data()).encoded
                      == (try hexData(v["p3"], "p3")), "\(name): P3 bytes")
            try check(try ControllerPairingOpening(nonce: hostNonce).encoded == (try hexData(v["p4"], "p4")), "\(name): P4 bytes")
            try check(ControllerPairingWire.busy == (try hexData(v["busy"], "busy")), "\(name): busy byte")
            let transcript = ControllerPairingTranscript(hello: hello, commit: commit, controllerNonce: controllerNonce, hostNonce: hostNonce)
            try check(transcript.hash == (try hexData(v["transcript"], "transcript")), "\(name): T")
            try check(transcript.controllerCode == v["controllerCode"] as? String, "\(name): code ①")
            try check(transcript.hostCode == v["hostCode"] as? String, "\(name): code ②")
            try check(ControllerPairingMath.attestationHash(windowID: windowID, controllerKey: controllerKey.x963Representation,
                                                            controllerName: Data(controllerName.utf8), controllerModel: Data(controllerModel.utf8),
                                                            hostKey: hostKey.x963Representation, commitment: commitment, controllerNonce: controllerNonce)
                      == (try hexData(v["attestationClientDataHash"], "clientDataHash")), "\(name): App Attest binding")
            let t = transcript.hash
            try check(ControllerPairingMath.decisionData(t, decision: 1, grant: 1) == (try hexData(v["decisionApproveViewSigned"], "P5 view")), "\(name): P5 view")
            try check(ControllerPairingMath.decisionData(t, decision: 1, grant: 2) == (try hexData(v["decisionApproveControlSigned"], "P5 control")), "\(name): P5 control")
            try check(ControllerPairingMath.decisionData(t, decision: 2, grant: 0) == (try hexData(v["decisionRefuseSigned"], "P5 refuse")), "\(name): P5 refuse")
            try check(ControllerPairingMath.confirmData(t) == (try hexData(v["confirmSigned"], "P6")), "\(name): P6")
            try check(ControllerPairingMath.storedData(t) == (try hexData(v["storedSigned"], "P7")), "\(name): P7")
            try check(ControllerPairingProtocol.serviceName(windowID: windowID) == v["serviceName"] as? String, "\(name): service name")
            try check(ControllerPairingProtocol.windowNumber(windowID) == v["windowNumber"] as? String, "\(name): window number")
            try check(ControllerPairingProtocol.windowID(serviceName: v["serviceName"] as? String ?? "") == windowID, "\(name): service name round trip")
            // The other direction: the reference's bytes parse back to the same fields.
            let parsedHello = try ControllerPairingHello(try hexData(v["p1"], "p1"))
            try check(parsedHello.name == controllerName && parsedHello.model == controllerModel
                      && parsedHello.controllerKey.x963Representation == controllerKey.x963Representation, "\(name): P1 parse")
            let parsedCommit = try ControllerPairingCommit(try hexData(v["p2"], "p2"))
            try check(parsedCommit.windowID == windowID && parsedCommit.hostName == hostName && parsedCommit.commitment == commitment, "\(name): P2 parse")
            try check(try ControllerPairingReveal(try hexData(v["p3"], "p3")).nonce == controllerNonce, "\(name): P3 parse")
            try check(try ControllerPairingOpening(try hexData(v["p4"], "p4")).nonce == hostNonce, "\(name): P4 parse")
        }
    }

    func testPairingAttestationSwitchMatchesTheVectors() throws {
        guard let attestation = try pairingVectors()["attestation"] as? [String: Any], let required = attestation["required"] as? Bool,
              let vectors = attestation["vectors"] as? [Any] else { throw CheckFailure(description: "vectors: attestation block") }
        try check(required == ControllerPairingProtocol.requiresAttestation, "vectors.json and ControllerPairingProtocol disagree on S-K2")
        try check(!ControllerPairingProtocol.requiresAttestation || !vectors.isEmpty,
                  "the attestation requirement is on without a real attestation vector (S-K2)")
        try check(ControllerPairingProtocol.requiresAttestation == false, "S-K2 has not passed: the requirement stays off in this build")
        // The default window takes the build's switch and the genuine Viewer's production identity, nothing else.
        let host = try ControllerPairingHost(signer: SoftwareSigner(), hostName: hostMacName)
        try check(host.requiresAttestation == ControllerPairingProtocol.requiresAttestation, "default window ignores the build switch")
        guard let verifier = host.verifier as? AppAttestVerifier else { throw CheckFailure(description: "default verifier is not App Attest") }
        try check(verifier.appID == "DA8QKAQ2C9.com.intenet.agentstozbycs.viewer" && verifier.environment == .production,
                  "the controller path must accept the genuine Viewer only")
    }

    func testPairingOverLoopback() async throws {
        let hostSigner = SoftwareSigner()
        let host = try pairingHost(signer: hostSigner)
        let listener = try ControllerPairingListener(host: host, gate: PreAuthGate(policy: roomyPolicy()), bind: .ipv4(.loopback))
        let port = try await within(5) { try await listener.start() }
        defer { listener.stop() }
        let controller = SoftwareSigner(), person = PairingPerson()
        let client = Task {
            try await ControllerPairingClient.pair(to: .hostPort(host: .ipv4(.loopback), port: port), windowID: host.windowID, signer: controller,
                                                   name: pairingName, model: pairingModel, prompts: person.prompts)
        }
        let pending = try await within(5) {
            for await outcome in listener.outcomes { if case .pending(let pending) = outcome { return pending } }
            throw CheckFailure(description: "listener ended")
        }
        let code1 = try await person.shownCode()
        try check(code1 == pending.transcript.controllerCode, "A and B computed different codes ①: different T")
        try check(person.shownFingerprints.all == [pending.shortFingerprint], "A showed another key's four characters than B")
        try check(pending.controllerName == pairingName && pending.controllerModel == pairingModel && !pending.attested, "B's view of A")
        try check(!host.isOpen(), "the window still takes a P1 after taking one")
        try check(await pending.enterControllerCode(try keyed(code1)), "B refused the code A showed")
        let code2 = try await pending.approve(grant: .view)
        try check(code2 == pending.transcript.hostCode && code2 != code1, "code ②")
        let stored = Collector<Bool>()
        let completion = Task { try await pending.complete { stored.add(true) } }
        person.type(code2)
        let result = try await within(5) { try await client.value }
        try await within(5) { try await completion.value }
        try check(result.state == .confirmed, "P7 did not verify: \(result.state)")
        try check(result.grant == .view && person.grants.all == [.view], "grant")
        try check(result.host.publicKey.x963Representation == hostSigner.publicKey.x963Representation, "A pinned another key than B's")
        try check(result.hostName == hostMacName && result.windowID == host.windowID, "B's name and window")
        try check(result.controllerShortFingerprint == pending.shortFingerprint, "the two lists would show different fingerprints")
        try check(stored.all.count == 1, "B stored \(stored.all.count) times")
    }

    func testPairingSignaturesVerifyUnderTheirLabels() async throws {
        let run = PipePairing(host: try pairingHost())
        let pending = try await run.pending()
        guard await pending.enterControllerCode(try await run.person.shownCode()) else { throw CheckFailure(description: "code ①") }
        let code2 = try await pending.approve(grant: .control)
        let completion = Task { try await pending.complete {} }
        run.person.type(code2)
        guard case .success(let result) = await run.result() else { throw CheckFailure(description: "pairing failed") }
        try await within(5) { try await completion.value }
        try check(result.state == .confirmed && result.grant == .control, "result")
        let t = pending.transcript.hash
        let fromB = run.b.sent.all, fromA = run.a.sent.all
        try check(fromB.map { $0.first } == [0x22, 0x24, 0x25, 0x27] && fromA.map { $0.first } == [0x21, 0x23, 0x26], "message order")
        let decision = try ControllerPairingDecision(fromB[2])
        try check(decision.grant == .control, "P5 grant")
        try check(ControllerPairingMath.verify(decision.signature, ControllerPairingMath.decisionData(t, decision: 1, grant: 2), by: run.hostKey),
                  "P5 does not verify with B's key over T")
        let confirm = try ControllerPairingSigned(fromA[2], .confirm)
        try check(ControllerPairingMath.verify(confirm.signature, ControllerPairingMath.confirmData(t), by: run.controllerKey),
                  "P6 does not verify with K_A over T")
        let stored = try ControllerPairingSigned(fromB[3], .stored)
        try check(ControllerPairingMath.verify(stored.signature, ControllerPairingMath.storedData(t), by: run.hostKey),
                  "P7 does not verify with B's key over T")
        // Each signature fails under every other label, and under the other side's key.
        try check(!ControllerPairingMath.verify(decision.signature, ControllerPairingMath.storedData(t), by: run.hostKey), "P5 passes as P7")
        try check(!ControllerPairingMath.verify(stored.signature, ControllerPairingMath.decisionData(t, decision: 1, grant: 2), by: run.hostKey), "P7 passes as P5")
        try check(!ControllerPairingMath.verify(confirm.signature, ControllerPairingMath.confirmData(t), by: run.hostKey), "P6 passes under B's key")
        try check(!ControllerPairingMath.verify(decision.signature, ControllerPairingMath.decisionData(t, decision: 1, grant: 1), by: run.hostKey),
                  "a control grant's P5 passes as a view grant")
    }

    func testPairingCommitmentMismatchAborts() async throws {
        let (a, b) = framePipe()
        let hostSigner = SoftwareSigner(), windowID = randomBytes(16), person = PairingPerson()
        let client = Task {
            try await ControllerPairingClient.pair(over: a, windowID: windowID, signer: SoftwareSigner(), name: pairingName, model: pairingModel,
                                                   prompts: person.prompts)
        }
        let hello = try ControllerPairingHello(try await within(5) { try await b.receive() })
        let committed = randomBytes(32)
        let commitment = ControllerPairingMath.commitment(windowID: windowID, controllerKey: hello.controllerKey.x963Representation,
                                                          hostKey: hostSigner.publicKey.x963Representation, hostNonce: committed)
        try await b.send(try ControllerPairingCommit(windowID: windowID, hostKey: hostSigner.publicKey, hostName: hostMacName, commitment: commitment).encoded)
        _ = try await within(5) { try await b.receive() }
        // B opens another nonce than the one it committed to: what a B that chose N_B after seeing N_A would do.
        try await b.send(try ControllerPairingOpening(nonce: randomBytes(32)).encoded)
        let result: Result<ControllerPairingResult, Error>
        do { result = .success(try await within(5) { try await client.value }) } catch { result = .failure(error) }
        try expectPairingError(.commitmentMismatch, result)
        try check(person.neverShown, "A showed a code after a broken commitment")
        try check(ControllerPairingText.viewerNotice(for: ControllerPairingError.commitmentMismatch).alarm == false, "notice")
    }

    func testPairingWrongControllerCodeRefuses() async throws {
        let host = try pairingHost()
        let run = PipePairing(host: host)
        let pending = try await run.pending()
        let shown = try await run.person.shownCode()
        let wrong = String(shown.dropLast()) + (shown.last == "0" ? "1" : "0")
        let stored = Collector<Bool>()
        try check(await pending.enterControllerCode(wrong) == false, "B took a wrong code ①")
        try check(await pending.enterControllerCode(shown) == false, "code ① took a second try")
        try await expectError(ControllerPairingError.refused) { _ = try await pending.approve(grant: .view) }
        try await expectError(ControllerPairingError.refused) { try await pending.complete { stored.add(true) } }
        try expectPairingError(.refused, await run.result())
        try check(stored.all.isEmpty && run.person.grants.all.isEmpty, "something was stored or code ② asked for")
        try check(run.b.sent.all.last?.first == 0x25, "the refusal was not a signed P5")
        let refusal = try ControllerPairingDecision(run.b.sent.all.last!)
        try check(refusal.grant == nil && ControllerPairingMath.verify(refusal.signature,
                  ControllerPairingMath.decisionData(pending.transcript.hash, decision: 2, grant: 0), by: run.hostKey), "refusal signature")
        // The window is used up: another A only hears busy.
        let again = PipePairing(host: host)
        try expectPairingError(.windowBusy, await again.result())
        try check(host.isTaken && !host.isOpen(), "the window took another P1")
    }

    func testPairingWrongHostCodeSendsNothing() async throws {
        let controller = CountingSigner()
        let run = PipePairing(host: try pairingHost(), controller: controller)
        let pending = try await run.pending()
        guard await pending.enterControllerCode(try await run.person.shownCode()) else { throw CheckFailure(description: "code ①") }
        let code2 = try await pending.approve(grant: .view)
        let stored = Collector<Bool>()
        let completion = Task { try await pending.complete { stored.add(true) } }
        run.person.type(code2 == "000000" ? "111111" : "000000")
        try expectPairingError(.codeMismatch, await run.result())
        try check(run.a.sent.all.map { $0.first } == [0x21, 0x23], "A sent something after a wrong code ②: \(run.a.sent.all.map { $0.first })")
        let signatures = await controller.counter.count
        try check(signatures == 0, "K_A signed after a wrong code ②")
        let completed = (try? await within(5) { try await completion.value }) != nil
        try check(!completed && stored.all.isEmpty, "B completed or stored without P6")
        try check(ControllerPairingText.viewerNotice(for: ControllerPairingError.codeMismatch).text == ControllerPairingText.codeMismatch, "notice")
        // A person who gives up instead sends nothing either.
        let gaveUp = PipePairing(host: try pairingHost())
        let second = try await gaveUp.pending()
        guard await second.enterControllerCode(try await gaveUp.person.shownCode()) else { throw CheckFailure(description: "code ①") }
        _ = try await second.approve(grant: .view)
        gaveUp.person.type(nil)
        try expectPairingError(.cancelled, await gaveUp.result())
        try check(gaveUp.a.sent.all.count == 2, "A sent something after giving up")
    }

    func testPairingSecondHelloIsBusy() async throws {
        let host = try pairingHost()
        let listener = try ControllerPairingListener(host: host, gate: PreAuthGate(policy: roomyPolicy()), bind: .ipv4(.loopback))
        let port = try await within(5) { try await listener.start() }
        defer { listener.stop() }
        let endpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: port)
        let first = PairingPerson()
        let firstClient = Task {
            try await ControllerPairingClient.pair(to: endpoint, windowID: host.windowID, signer: SoftwareSigner(), name: "먼저 온 Mac",
                                                   model: pairingModel, prompts: first.prompts)
        }
        let pending = try await within(5) {
            for await outcome in listener.outcomes { if case .pending(let pending) = outcome { return pending } }
            throw CheckFailure(description: "first P1 did not take the window")
        }
        _ = try await first.shownCode()
        let second = PairingPerson()
        let secondResult: Result<ControllerPairingResult, Error>
        do {
            secondResult = .success(try await within(5) {
                try await ControllerPairingClient.pair(to: endpoint, windowID: host.windowID, signer: SoftwareSigner(), name: pairingName,
                                                       model: pairingModel, prompts: second.prompts)
            })
        } catch { secondResult = .failure(error) }
        try expectPairingError(.windowBusy, secondResult)
        try check(second.neverShown, "the busy A showed a code")
        let notice = ControllerPairingText.viewerNotice(for: ControllerPairingError.windowBusy)
        try check(notice.alarm && notice.text == ControllerPairingText.busyAlarm, "the real Viewer must raise the red alarm")
        let busy = try await within(5) {
            for await outcome in listener.outcomes { if case .busy = outcome { return true } }
            return false
        }
        try check(busy, "B did not record the busy P1")
        try check(pending.displayName == "먼저 온 Mac", "B shows the first P1's name")
        await pending.refuse()
        try check((try? await within(5) { try await firstClient.value }) == nil, "the first A paired after a refusal")
    }

    func testPairingWindowAndDecisionExpire() async throws {
        // A window nobody took in its 120 seconds.
        let stale = try pairingHost(opened: Date().addingTimeInterval(-ControllerPairingProtocol.windowLifetime - 1))
        try check(!stale.isOpen(), "an expired window is open")
        let late = PipePairing(host: stale)
        try await expectError(ControllerPairingError.expired) { _ = try await within(5) { [accepted = late.accepted] in try await accepted.value } }
        guard case .failure(let lateError) = await late.result() else { throw CheckFailure(description: "paired with an expired window") }
        try check(ControllerPairingText.viewerNotice(for: lateError).text.hasPrefix(ControllerPairingText.windowClosed), "notice: \(lateError)")
        try check(!stale.isTaken, "an expired window was taken")
        // A window closed early (the person, a session) takes nothing either.
        let closed = try pairingHost()
        closed.close()
        try await expectError(ControllerPairingError.expired) { _ = try await within(5) { [accepted = PipePairing(host: closed).accepted] in try await accepted.value } }
        // A decision nobody made: B's deadline ends the pairing and nothing more is taken.
        let slow = try pairingHost(decisionTimeout: .milliseconds(400))
        let run = PipePairing(host: slow)
        let pending = try await run.pending()
        let code = try await run.person.shownCode()
        try check(try await within(5) { await pending.waitForEnd() }, "the decision deadline did not end the connection")
        try check(await pending.enterControllerCode(code) == false, "B took code ① after its deadline")
        guard case .failure = await run.result() else { throw CheckFailure(description: "A paired after B's deadline") }
    }

    func testPairingLostStoredLeavesNeedsCheck() async throws {
        let controller = CountingSigner()
        let run = PipePairing(host: try pairingHost(), controller: controller, storedTimeout: .milliseconds(300))
        let pending = try await run.pending()
        guard await pending.enterControllerCode(try await run.person.shownCode()) else { throw CheckFailure(description: "code ①") }
        let code2 = try await pending.approve(grant: .view)
        struct StoreFailed: Error {}
        let completion = Task { try await pending.complete { throw StoreFailed() } }
        run.person.type(code2)
        guard case .success(let result) = await run.result() else { throw CheckFailure(description: "A failed instead of keeping the target") }
        try check(result.state == .needsCheck, "no P7 yet the target is \(result.state)")
        let signatures = await controller.counter.count
        try check(run.a.sent.all.filter { $0.first == 0x26 }.count == 1 && signatures == 1, "P6 sent or signed again")
        try check(run.b.sent.all.allSatisfy { $0.first != 0x27 }, "B said stored after a failed store")
        try check((try? await within(5) { try await completion.value }) == nil, "B's completion hid the failed store")

        // A forged P7 (B's P5 signature in its place) is not a confirmation either.
        let (a, b) = framePipe()
        let hostSigner = SoftwareSigner(), windowID = randomBytes(16), person = PairingPerson()
        let client = Task {
            try await ControllerPairingClient.pair(over: a, windowID: windowID, signer: SoftwareSigner(), name: pairingName, model: pairingModel,
                                                   prompts: person.prompts, storedTimeout: .seconds(2))
        }
        let hello = try ControllerPairingHello(try await within(5) { try await b.receive() })
        let nonceB = randomBytes(32)
        let commit = try ControllerPairingCommit(windowID: windowID, hostKey: hostSigner.publicKey, hostName: hostMacName,
                                                 commitment: ControllerPairingMath.commitment(windowID: windowID, controllerKey: hello.controllerKey.x963Representation,
                                                                                              hostKey: hostSigner.publicKey.x963Representation, hostNonce: nonceB))
        try await b.send(commit.encoded)
        let reveal = try ControllerPairingReveal(try await within(5) { try await b.receive() })
        try await b.send(try ControllerPairingOpening(nonce: nonceB).encoded)
        let t = ControllerPairingTranscript(hello: hello, commit: commit, controllerNonce: reveal.nonce, hostNonce: nonceB)
        let decisionSignature = try await hostSigner.signature(for: ControllerPairingMath.decisionData(t.hash, decision: 1, grant: 1)).rawRepresentation
        try await b.send(ControllerPairingDecision(grant: .view, signature: decisionSignature).encoded)
        person.type(t.hostCode)
        _ = try await within(5) { try await b.receive() }   // P6
        try await b.send(ControllerPairingSigned(signature: decisionSignature).encoded(.stored))
        let forged = try await within(5) { try await client.value }
        try check(forged.state == .needsCheck, "a P5 signature passed as P7")
    }

    func testPairingAttestation() async throws {
        // Required, and A brings none: refused before any code, whatever else is right.
        let strict = PipePairing(host: try pairingHost(requiresAttestation: true))
        try await expectError(ControllerPairingError.attestationRequired) { _ = try await within(5) { [accepted = strict.accepted] in try await accepted.value } }
        guard case .failure = await strict.result() else { throw CheckFailure(description: "paired without the required attestation") }
        try check(strict.person.neverShown, "A showed a code although B refused")
        // Required, and the attestation is for another registration (another window's binding): refused.
        let other = PairingPerson(attest: { _ in ControllerPairingAttestation(attestation: randomBytes(32), keyID: Data(repeating: 1, count: 32)) })
        let wrong = PipePairing(host: try pairingHost(requiresAttestation: true), person: other)
        try await expectError(ControllerPairingError.untrustedViewer(.nonceMismatch)) {
            _ = try await within(5) { [accepted = wrong.accepted] in try await accepted.value }
        }
        // A chain App Attest itself refuses: refused with its reason, required or not.
        for required in [true, false] {
            let refused = PipePairing(host: try pairingHost(requiresAttestation: required, verifier: RefusingAttester(error: .wrongApp)),
                                      person: PairingPerson(attest: echoAttestation))
            try await expectError(ControllerPairingError.untrustedViewer(.wrongApp)) {
                _ = try await within(5) { [accepted = refused.accepted] in try await accepted.value }
            }
        }
        // Not required (this build), a wrong attestation is still refused; a right one marks the controller attested.
        let notRequiredWrong = PipePairing(host: try pairingHost(requiresAttestation: false), person: other)
        try await expectError(ControllerPairingError.untrustedViewer(.nonceMismatch)) {
            _ = try await within(5) { [accepted = notRequiredWrong.accepted] in try await accepted.value }
        }
        let genuine = PipePairing(host: try pairingHost(requiresAttestation: true), person: PairingPerson(attest: echoAttestation))
        let pending = try await genuine.pending()
        try check(pending.attested && pending.attestation?.keyID == Data(repeating: 0xa7, count: 32), "a valid attestation was not kept")
        try check(genuine.person.attested.all.count == 1, "A attested \(genuine.person.attested.all.count) times")
        // The hash A attested is the one B checked: EchoAttester accepted it only because both computed the same binding.
        let unattested = PipePairing(host: try pairingHost(requiresAttestation: false))
        try check(try await unattested.pending().attested == false, "no attestation, yet attested")
        await pending.refuse()
    }

    func testPairingMachineInTheMiddle() async throws {
        // Fixed nonces: the reference inputs, with a third key standing in for A at B and for B at A.
        let controller = try katKey("pairing controller").publicKey, host = try katKey("pairing host").publicKey
        let middle = try katKey("pairing middle").publicKey
        let windowID = sha256(Data("agentstoz kat pairing window".utf8)).prefix(16)
        let nonceA = sha256(Data("agentstoz kat pairing controller nonce".utf8)), nonceB = sha256(Data("agentstoz kat pairing host nonce".utf8))
        let nonceM = sha256(Data("agentstoz kat pairing middle nonce".utf8))
        func t(_ controllerKey: P256.Signing.PublicKey, _ hostKey: P256.Signing.PublicKey, _ nA: Data, _ nB: Data) -> ControllerPairingTranscript {
            ControllerPairingTranscript(windowID: Data(windowID), controllerKey: controllerKey.x963Representation, controllerName: Data(pairingName.utf8),
                                        controllerModel: Data(pairingModel.utf8), hostKey: hostKey.x963Representation, hostName: Data(hostMacName.utf8),
                                        controllerNonce: nA, hostNonce: nB)
        }
        let honest = t(controller, host, nonceA, nonceB)
        let atA = t(controller, middle, nonceA, nonceM), atB = t(middle, host, nonceM, nonceB)
        try check(atA.hash != atB.hash && atA.controllerCode != atB.controllerCode && atA.hostCode != atB.hostCode,
                  "a machine in the middle met equal codes on fixed nonces")
        try check(honest.controllerCode != atB.controllerCode, "B's code with the middle key equals the honest one")

        // The whole exchange through a machine that runs both halves with keys of its own.
        let hostSigner = SoftwareSigner(), middleSigner = SoftwareSigner()
        let pairingWindow = try pairingHost(signer: hostSigner)
        let (a, toA) = framePipe(), (toB, b) = framePipe()
        let person = PairingPerson()
        let client = Task {
            try await ControllerPairingClient.pair(over: a, windowID: pairingWindow.windowID, signer: SoftwareSigner(), name: pairingName,
                                                   model: pairingModel, prompts: person.prompts)
        }
        let accepted = Task { try await pairingWindow.accept(over: b) }
        let helloA = try ControllerPairingHello(try await within(5) { try await toA.receive() })
        try await toB.send(try ControllerPairingHello(controllerKey: middleSigner.publicKey, name: helloA.name, model: helloA.model).encoded)
        let commitB = try ControllerPairingCommit(try await within(5) { try await toB.receive() })
        let middleNonce = randomBytes(32)
        let commitA = try ControllerPairingCommit(windowID: commitB.windowID, hostKey: middleSigner.publicKey, hostName: commitB.hostName,
                                                  commitment: ControllerPairingMath.commitment(windowID: commitB.windowID,
                                                                                               controllerKey: helloA.controllerKey.x963Representation,
                                                                                               hostKey: middleSigner.publicKey.x963Representation,
                                                                                               hostNonce: middleNonce))
        try await toA.send(commitA.encoded)
        let revealA = try ControllerPairingReveal(try await within(5) { try await toA.receive() })
        try await toB.send(try ControllerPairingReveal(nonce: revealA.nonce, attestation: Data(), attestationKeyID: Data()).encoded)
        let pending = try await within(5) { try await accepted.value }
        _ = try await within(5) { try await toB.receive() }   // P4: N_B, too late to choose anything by
        try await toA.send(try ControllerPairingOpening(nonce: middleNonce).encoded)
        let shown = try await person.shownCode()
        try check(await pending.enterControllerCode(shown) == false, "B took the code A showed through a machine in the middle")
        toA.cancel()
        guard case .failure = await outcome(client) else { throw CheckFailure(description: "A paired through a machine in the middle") }
    }

    func testPairingCodesCollideOnlyByChance() throws {
        // Two transcripts that differ anywhere (a middle key, another nonce) give independent codes: about one in 10⁶
        // agree. 20,000 pairs expect 0.02 equal codes ①; three or more happen with probability about 10⁻⁶.
        let trials = 20_000
        var equalController = 0, equalHost = 0, equalBoth = 0
        var seen = Set<String>()
        let base = ControllerPairingTranscript(windowID: randomBytes(16), controllerKey: Data(repeating: 4, count: 65), controllerName: Data("A".utf8),
                                               controllerModel: Data("M".utf8), hostKey: Data(repeating: 5, count: 65), hostName: Data("B".utf8),
                                               controllerNonce: randomBytes(32), hostNonce: randomBytes(32))
        for _ in 0..<trials {
            let atA = ControllerPairingTranscript(windowID: base.windowID, controllerKey: base.controllerKey, controllerName: base.controllerName,
                                                  controllerModel: base.controllerModel, hostKey: randomBytes(65), hostName: base.hostName,
                                                  controllerNonce: base.controllerNonce, hostNonce: randomBytes(32))
            let atB = ControllerPairingTranscript(windowID: base.windowID, controllerKey: randomBytes(65), controllerName: base.controllerName,
                                                  controllerModel: base.controllerModel, hostKey: base.hostKey, hostName: base.hostName,
                                                  controllerNonce: randomBytes(32), hostNonce: base.hostNonce)
            let c = atA.controllerCode == atB.controllerCode, h = atA.hostCode == atB.hostCode
            equalController += c ? 1 : 0; equalHost += h ? 1 : 0; equalBoth += c && h ? 1 : 0
            try check(atA.controllerCode.utf8.count == 6 && atA.controllerCode.utf8.allSatisfy { (48...57).contains($0) }, "not six digits")
            seen.insert(atA.controllerCode)
        }
        try check(equalController <= 2 && equalHost <= 2 && equalBoth == 0,
                  "codes agree too often: ① \(equalController), ② \(equalHost), both \(equalBoth) in \(trials)")
        // A constant or narrow code would show here: 20,000 draws from 10⁶ give about 19,800 distinct values.
        try check(seen.count >= 19_500, "only \(seen.count) distinct codes in \(trials)")
        // Code ① and code ② of one transcript are separate: they agree only by chance too.
        var sameTranscript = 0
        for _ in 0..<trials {
            let one = ControllerPairingTranscript(windowID: randomBytes(16), controllerKey: base.controllerKey, controllerName: base.controllerName,
                                                  controllerModel: base.controllerModel, hostKey: base.hostKey, hostName: base.hostName,
                                                  controllerNonce: randomBytes(32), hostNonce: randomBytes(32))
            sameTranscript += one.controllerCode == one.hostCode ? 1 : 0
        }
        try check(sameTranscript <= 2, "code ① equals code ② \(sameTranscript) times in \(trials)")
    }

    func testPairingLabelsDoNotCross() throws {
        let ours = [ControllerPairingMath.decisionLabel, ControllerPairingMath.confirmLabel, ControllerPairingMath.storedLabel,
                    ControllerPairingMath.label + Data("commit".utf8), ControllerPairingMath.label + Data("sas-controller".utf8),
                    ControllerPairingMath.label + Data("sas-host".utf8)].map { String(decoding: $0, as: UTF8.self) }
        var theirs: [String] = [ControllerOffer.label + "delivery acknowledgement", ControllerDeliveryChannel.info,
                                RegistrationPurpose.device.label(" registration approved"), RegistrationPurpose.device.label(" registration acknowledgement"),
                                RegistrationPurpose.macController.label(" registration approved"),
                                RegistrationPurpose.macController.label(" registration acknowledgement"),
                                ScreenControlProtocol.label(version: ScreenControlProtocol.registrationVersion) + " registration attestation",
                                RegistrationPrivacyTransport.registrationInfo, "agentstoz.screen-control.key-approval/v1\n"]
        for version in ScreenControlProtocol.minimumVersion...ScreenControlProtocol.version {
            let labels = HandshakeLabels(version: version)
            theirs += [labels.macSignature, labels.deviceSignature, labels.macToDevice, labels.deviceToMac, labels.macConfirm, labels.deviceConfirm]
                .map { String(decoding: $0, as: UTF8.self) }
            theirs.append(ScreenControlProtocol.label(version: version) + " record")
        }
        for (index, label) in ours.enumerated() {
            for other in ours.enumerated() where other.offset != index {
                try check(!label.hasPrefix(other.element), "pairing labels \(label) and \(other.element) overlap")
            }
            for other in theirs {
                try check(!label.hasPrefix(other) && !other.hasPrefix(label), "pairing label \(label) overlaps \(other)")
            }
        }
        // A real signature from one domain fails in the others, for the same 32 bytes after the label.
        let key = P256.Signing.PrivateKey(), t = randomBytes(32)
        let handshake = try key.signature(for: HandshakeLabels(version: 5).deviceSignature + t).rawRepresentation
        try check(!ControllerPairingMath.verify(handshake, ControllerPairingMath.confirmData(t), by: key.publicKey), "a session signature passes as P6")
        let confirm = try key.signature(for: ControllerPairingMath.confirmData(t)).rawRepresentation
        try check(ControllerPairingMath.verify(confirm, ControllerPairingMath.confirmData(t), by: key.publicKey), "P6 itself")
        try check(!ControllerPairingMath.verify(confirm, HandshakeLabels(version: 5).deviceSignature + t, by: key.publicKey), "P6 passes as a session signature")
        try check(!ControllerPairingMath.verify(confirm, ControllerPairingMath.storedData(t), by: key.publicKey), "P6 passes as P7")
    }

    func testPairingNamesAreFiltered() async throws {
        // A name that would reorder itself on B's screen still pairs, as 「이름 없는 Mac」; the bytes stay as they came.
        let spoof = "\u{202E}cam ruoy", (a, b) = framePipe()
        let host = try pairingHost()
        let client = Task {
            try await ControllerPairingClient.pair(over: a, windowID: host.windowID, signer: SoftwareSigner(), name: spoof, model: "Mac\u{200B}15",
                                                   prompts: PairingPerson().prompts)
        }
        let pending = try await within(5) { try await host.accept(over: b) }
        try check(pending.displayName == ControllerPairingText.unnamed && pending.controllerName == spoof, "display name \(pending.displayName)")
        try check(pending.displayModel == nil, "an unshowable model is shown")
        await pending.refuse()
        _ = try? await within(5) { try await client.value }
        // Too long or not UTF-8: never a P1.
        try await expectError(ControllerPairingError.malformed) {
            _ = try ControllerPairingHello(controllerKey: SoftwareSigner().publicKey, name: String(repeating: "가", count: 22), model: pairingModel)
        }
        let key = SoftwareSigner().publicKey.x963Representation
        for (name, model) in [(Data([0xff, 0xfe]), Data("M".utf8)), (Data(repeating: 0x41, count: 65), Data("M".utf8)),
                              (Data("A".utf8), Data(repeating: 0x41, count: 33)), (Data(), Data("M".utf8))] {
            try await expectError(ControllerPairingError.malformed) {
                _ = try ControllerPairingHello(ControllerPairingWire.encode(.hello, [Data([1]), key, name, model]))
            }
        }
        // B's name in A's list: the TXT is never authenticated, and shown only when it can be.
        let windowID = randomBytes(16), service = ControllerPairingProtocol.serviceName(windowID: windowID)
        try check(ControllerPairingWindowListing(serviceName: service, txt: ["n": hostMacName, "pv": "1"])?.hostName == hostMacName, "listing")
        try check(ControllerPairingWindowListing(serviceName: service, txt: ["n": "\u{202E}cam", "pv": "1"])?.hostName == ControllerPairingText.unnamed, "bidi")
        try check(ControllerPairingWindowListing(serviceName: service, txt: ["pv": "1"])?.hostName == ControllerPairingText.unnamed, "no name")
        try check(ControllerPairingWindowListing(serviceName: service, txt: ["pv": "1"])?.windowNumber == String(ControllerPairingProtocol.hex(windowID).prefix(4)), "number")
        try check(ControllerPairingWindowListing(serviceName: service, txt: ["n": "B", "pv": "2"]) == nil, "another version listed")
        try check(ControllerPairingWindowListing(serviceName: service.uppercased(), txt: ["n": "B", "pv": "1"]) == nil, "uppercase name listed")
        try check(ControllerPairingWindowListing(serviceName: "az-pair-" + ControllerPairingProtocol.hex(windowID), txt: ["pv": "1"]) == nil, "phone window listed")
        try check(ControllerPairingWindowListing(serviceName: service + "00", txt: ["pv": "1"]) == nil, "long name listed")
        let twice = ControllerPairingBrowser.listings([(service, ["n": "B", "pv": "1"]), (service, ["n": "B", "pv": "1"])])
        try check(twice.count == 1, "one window found on two interfaces is listed twice")
        try check(ScreenNearby.isValidServiceName(service) && service.utf8.count <= 63, "service name")
    }

    func testPairingMessagesParseStrictly() async throws {
        let key = SoftwareSigner().publicKey.x963Representation, nonce = randomBytes(32), signature = Data(repeating: 1, count: 64)
        let valid = try ControllerPairingHello(controllerKey: SoftwareSigner().publicKey, name: "A", model: "M").encoded
        let malformed: [(String, () throws -> Void)] = [
            ("P1 trailing byte", { _ = try ControllerPairingHello(valid + Data([0])) }),
            ("P1 version 2", { _ = try ControllerPairingHello(ControllerPairingWire.encode(.hello, [Data([2]), key, Data("A".utf8), Data("M".utf8)])) }),
            ("P1 compressed key", { _ = try ControllerPairingHello(ControllerPairingWire.encode(.hello, [Data([1]), Data([0x02]) + key.dropFirst().prefix(32), Data("A".utf8), Data("M".utf8)])) }),
            ("P1 over 1024 bytes", { _ = try ControllerPairingHello(valid + Data(count: 1024)) }),
            ("P1 under P2's tag", { _ = try ControllerPairingCommit(valid) }),
            ("P2 short window", { _ = try ControllerPairingCommit(ControllerPairingWire.encode(.commit, [Data(count: 15), key, Data("B".utf8), Data(count: 32)])) }),
            ("P3 attestation without key ID", { _ = try ControllerPairingReveal(ControllerPairingWire.encode(.reveal, [nonce, Data([1]), Data()])) }),
            ("P3 key ID without attestation", { _ = try ControllerPairingReveal(ControllerPairingWire.encode(.reveal, [nonce, Data(), Data(count: 32)])) }),
            ("P3 short key ID", { _ = try ControllerPairingReveal(ControllerPairingWire.encode(.reveal, [nonce, Data([1]), Data(count: 31)])) }),
            ("P3 short nonce", { _ = try ControllerPairingReveal(ControllerPairingWire.encode(.reveal, [nonce.prefix(31), Data(), Data()])) }),
            ("P4 long nonce", { _ = try ControllerPairingOpening(ControllerPairingWire.encode(.open, [nonce + Data([0])])) }),
            ("P5 approval of grant 0", { _ = try ControllerPairingDecision(ControllerPairingWire.encode(.decision, [Data([1]), Data([0]), signature])) }),
            ("P5 refusal with a grant", { _ = try ControllerPairingDecision(ControllerPairingWire.encode(.decision, [Data([2]), Data([1]), signature])) }),
            ("P5 unknown decision", { _ = try ControllerPairingDecision(ControllerPairingWire.encode(.decision, [Data([3]), Data([1]), signature])) }),
            ("P5 unknown grant", { _ = try ControllerPairingDecision(ControllerPairingWire.encode(.decision, [Data([1]), Data([3]), signature])) }),
            ("P5 short signature", { _ = try ControllerPairingDecision(ControllerPairingWire.encode(.decision, [Data([1]), Data([1]), signature.prefix(63)])) }),
            ("P6 under P7's tag", { _ = try ControllerPairingSigned(ControllerPairingWire.encode(.stored, [signature]), .confirm) }),
            ("P7 two signatures", { _ = try ControllerPairingSigned(ControllerPairingWire.encode(.stored, [signature, signature]), .stored) }),
            ("busy where P5 belongs", { _ = try ControllerPairingDecision(ControllerPairingWire.busy) }),
        ]
        for (name, parse) in malformed {
            do { try parse(); throw CheckFailure(description: "\(name) parsed") } catch let error as ControllerPairingError {
                try check(error == .malformed, "\(name): \(error)")
            }
        }
        // Busy answers P1 only; in P2's place it is the window's answer.
        try await expectError(ControllerPairingError.windowBusy) { _ = try ControllerPairingCommit(ControllerPairingWire.busy) }
        // A window ID the person did not pick, even with every other byte right.
        let host = try pairingHost()
        let run = PipePairing(host: host, windowID: randomBytes(16))
        try expectPairingError(.windowMismatch, await run.result())
        try check(run.person.neverShown, "A showed a code for another window")
    }

    func testPairingCodeEntryTakesHardwareKeysOnly() throws {
        var entry = ControllerPairingCodeEntry()
        let own: Int64 = 4242, screen: Int64 = 5151
        // Accessibility, a paste, a program: never.
        try check(entry.setValue("123456") == .ignored(.noCurrentEvent) && entry.digits.isEmpty, "AXSetValue filled the field")
        try check(entry.key(.digit(1), event: nil, ownPid: own, screenPid: screen) == .ignored(.noCurrentEvent), "an AX action typed")
        let refusals: [(ScreenInputEvent, ScreenInputRefusal)] = [
            (ScreenInputEvent(kind: .keyDown, ageSeconds: 0.05, sourcePid: 999, keyboardType: 40, sourceState: 1), .synthetic),
            (ScreenInputEvent(kind: .keyDown, ageSeconds: 0.05, sourcePid: own, keyboardType: 40, sourceState: 1), .ownEvent),
            (ScreenInputEvent(kind: .keyDown, ageSeconds: 0.05, sourcePid: screen, keyboardType: 40, sourceState: 1), .screenInjection),
            (ScreenInputEvent(kind: .keyDown, ageSeconds: 0.05, sourcePid: 77, keyboardType: 40, sourceState: 1,
                              poster: ScreenInputPoster(identifier: "com.apple.screensharing.agent", team: nil, apple: true)), .remoteDesktop),
            (ScreenInputEvent(kind: .keyUp, ageSeconds: 0.05, sourcePid: 0, keyboardType: 40, sourceState: 1), .notTheControl),
            (ScreenInputEvent(kind: .leftMouseUp, ageSeconds: 0.05, sourcePid: 0, keyboardType: 40, sourceState: 1), .notTheControl),
            (ScreenInputEvent(kind: .keyDown, ageSeconds: 1.5, sourcePid: 0, keyboardType: 40, sourceState: 1), .staleEvent),
        ]
        for (event, refusal) in refusals {
            try check(entry.key(.digit(1), event: event, ownPid: own, screenPid: screen) == .ignored(refusal), "\(event) typed")
        }
        try check(entry.digits.isEmpty, "a refused key changed the field")
        for digit: UInt8 in [0, 4, 2, 9, 9, 1] {
            try check(entry.key(.digit(digit), event: hardwareKey, ownPid: own, screenPid: screen) == .changed, "hardware digit \(digit)")
        }
        try check(entry.key(.digit(5), event: hardwareKey, ownPid: own, screenPid: screen) == .ignored(nil), "a seventh digit")
        try check(entry.key(.digit(12), event: hardwareKey, ownPid: own, screenPid: screen) == .ignored(nil) || entry.digits.count == 6, "not a digit")
        try check(entry.key(.delete, event: hardwareKey, ownPid: own, screenPid: screen) == .changed && entry.text == "04299", "delete")
        try check(entry.key(.submit, event: hardwareKey, ownPid: own, screenPid: screen) == .ignored(nil), "five digits submitted")
        _ = entry.key(.digit(7), event: hardwareKey, ownPid: own, screenPid: screen)
        try check(entry.key(.submit, event: ScreenInputEvent(kind: .keyDown, ageSeconds: 0.05, sourcePid: 999, keyboardType: 40, sourceState: 1),
                            ownPid: own, screenPid: screen) == .ignored(.synthetic), "a synthetic Return submitted")
        try check(entry.key(.submit, event: hardwareKey, ownPid: own, screenPid: screen) == .submitted(.init(text: "042997")), "submit")
        // One try: after it, nothing, not even the person's keys.
        try check(entry.key(.delete, event: hardwareKey, ownPid: own, screenPid: screen) == .ignored(nil), "changed after submission")
        try check(entry.key(.submit, event: hardwareKey, ownPid: own, screenPid: screen) == .ignored(nil) && entry.submitted, "submitted twice")
        // The codes compare as typed digits only.
        try check(ControllerPairingMath.typed("042 997") == "042997" && ControllerPairingMath.typed("42997") == nil
                  && ControllerPairingMath.typed("04299a") == nil && ControllerPairingMath.typed("０４２９９７") == nil, "typed codes")
    }

    func testPairingRefusalEndsWithoutRegistration() async throws {
        // Before code ①: the person at B refuses (or a session starts, SR-37). A hears a signed refusal.
        let early = PipePairing(host: try pairingHost())
        let first = try await early.pending()
        await first.refuse()
        try expectPairingError(.refused, await early.result())
        try check(await first.enterControllerCode(try await early.person.shownCode()) == false, "code ① after a refusal")
        try await expectError(ControllerPairingError.refused) { _ = try await first.approve(grant: .view) }
        // After code ①, before 「승인」: the same.
        let middle = PipePairing(host: try pairingHost())
        let second = try await middle.pending()
        guard await second.enterControllerCode(try await middle.person.shownCode()) else { throw CheckFailure(description: "code ①") }
        await second.refuse()
        try expectPairingError(.refused, await middle.result())
        // After 「승인」: refusing only ends the connection; P6 never reaches a store.
        let late = PipePairing(host: try pairingHost())
        let third = try await late.pending()
        guard await third.enterControllerCode(try await late.person.shownCode()) else { throw CheckFailure(description: "code ①") }
        _ = try await third.approve(grant: .view)
        await third.refuse()
        let stored = Collector<Bool>()
        try await expectError(ControllerPairingError.refused) { try await third.complete { stored.add(true) } }
        late.person.type(third.transcript.hostCode)
        // A cannot tell whether B kept it: never 「확인됨」, and P6 is not sent twice.
        if case .success(let result) = await late.result() { try check(result.state == .needsCheck, "A confirmed after B ended the pairing") }
        try check(stored.all.isEmpty && late.a.sent.all.filter { $0.first == 0x26 }.count <= 1, "stored after a refusal")
    }

    func testPairingRefusalAfterP6() async throws {
        // P6 already reached B when the person closed the window (or a session started): `complete` stores nothing.
        let arrived = PipePairing(host: try pairingHost())
        let first = try await arrived.pending()
        guard await first.enterControllerCode(try await arrived.person.shownCode()) else { throw CheckFailure(description: "code ①") }
        arrived.person.type(try await first.approve(grant: .view))
        try await within(5) { [a = arrived.a] in
            while !a.sent.all.contains(where: { $0.first == 0x26 }) { try await Task.sleep(for: .milliseconds(5)) }
        }
        try await Task.sleep(for: .milliseconds(50))   // B's reader takes P6
        await first.refuse()
        let stored = Collector<Bool>()
        try await expectError(ControllerPairingError.refused) { try await first.complete { stored.add(true) } }
        try check(stored.all.isEmpty, "stored a P6 that arrived before the refusal")
        try check(arrived.b.sent.all.allSatisfy { $0.first != 0x27 }, "B said stored after a refusal")
        guard case .success(let kept) = await arrived.result() else { throw CheckFailure(description: "A dropped a target it sent P6 for") }
        try check(kept.state == .needsCheck, "A confirmed a pairing B refused")

        // The refusal comes while B's store runs: the store cannot be called back, but the connection ends, so no P7
        // goes out and A keeps 「확인 필요」; the caller's store is the one that checks its window (ScreenControllerPairing).
        let storing = PipePairing(host: try pairingHost())
        let second = try await storing.pending()
        guard await second.enterControllerCode(try await storing.person.shownCode()) else { throw CheckFailure(description: "code ①") }
        let code2 = try await second.approve(grant: .view)
        let began = Collector<Bool>()
        let (gate, release) = AsyncStream.makeStream(of: Void.self)
        let completion = Task {
            try await second.complete {
                began.add(true)
                var opened = gate.makeAsyncIterator()
                _ = await opened.next()
            }
        }
        storing.person.type(code2)
        try await within(5) { while began.all.isEmpty { try await Task.sleep(for: .milliseconds(5)) } }
        await second.refuse()
        release.yield(())
        release.finish()
        _ = try? await within(5) { try await completion.value }
        try check(began.all.count == 1, "the store ran \(began.all.count) times")
        try check(storing.b.sent.all.allSatisfy { $0.first != 0x27 }, "P7 went out after a refusal")
        guard case .success(let unsure) = await storing.result() else { throw CheckFailure(description: "A dropped a target it sent P6 for") }
        try check(unsure.state == .needsCheck, "A confirmed without P7")
    }

    func testPairingGivingUpAtAIsCancelled() async throws {
        // 「그만두기」 while A shows code ① and waits for B: the task is cancelled, and A says so.
        let controller = CountingSigner()
        let atCode = PipePairing(host: try pairingHost(), controller: controller)
        let pending = try await atCode.pending()
        _ = try await atCode.person.shownCode()
        atCode.client.cancel()
        try expectPairingError(.cancelled, await atCode.result())
        try check(atCode.a.sent.all.map { $0.first } == [0x21, 0x23], "A sent something after giving up")
        try check(try await within(5) { await pending.waitForEnd() }, "B's window did not hear A leave")
        let notice = ControllerPairingText.viewerNotice(for: ControllerPairingError.cancelled)
        try check(notice.text == "등록을 그만두었습니다 · 등록하지 않았습니다" && !notice.alarm, "notice: \(notice.text)")
        // 「그만두기」 at the code ② field: nothing is signed or sent.
        let atHostCode = PipePairing(host: try pairingHost(), controller: controller)
        let second = try await atHostCode.pending()
        guard await second.enterControllerCode(try await atHostCode.person.shownCode()) else { throw CheckFailure(description: "code ①") }
        _ = try await second.approve(grant: .view)
        try await within(5) { [person = atHostCode.person] in
            while person.grants.all.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        }
        atHostCode.client.cancel()
        try expectPairingError(.cancelled, await atHostCode.result())
        try check(atHostCode.a.sent.all.map { $0.first } == [0x21, 0x23], "A sent P6 after giving up")
        let signatures = await controller.counter.count
        try check(signatures == 0, "K_A signed after giving up")
        // In a cancelled task anything but a busy window is the person's giving up; the busy alarm stays.
        let mapped = Task { () -> [Error] in
            try? await Task.sleep(for: .seconds(5))
            return [ControllerPairingError.afterGivingUp(ControllerPairingError.windowBusy),
                    ControllerPairingError.afterGivingUp(TransportError.closed),
                    ControllerPairingError.afterGivingUp(ControllerPairingError.expired)]
        }
        mapped.cancel()
        let errors = await mapped.value
        try check(errors.map { $0 as? ControllerPairingError } == [.windowBusy, .cancelled, .cancelled], "cancelled: \(errors)")
        try check(ControllerPairingError.afterGivingUp(TransportError.closed) as? TransportError == .closed,
                  "a pairing nobody gave up was reported as given up")
    }
}
