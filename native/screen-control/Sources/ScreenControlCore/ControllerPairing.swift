import CryptoKit
import Foundation
import os

// Direct controller pairing v1 (docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.3, 7.1, D-1, SR-20): the person stands at
// both Macs. B (AgentsToZ Screen) opens a window for 120 seconds; A (AgentsToZ Viewer) picks it by its number and
// registers a Secure Enclave key it made for B alone. B commits to its nonce before A reveals its own, so a machine in
// the middle gets one guess in 10⁶ per window at each of the two codes: ① A shows and the person types at B, ② B shows
// and the person types at A. Each code is typed once, with hardware keys only (SR-29, `ControllerPairingCodeEntry`).
//
// Messages: one tag byte and length-prefixed fields (Encoding.swift).
//   P1 A→B 0x21 [version, pk_A, name_A, model_A]            ≤ 1024 bytes, the window's own pre-authentication gate
//   P2 B→A 0x22 [windowID, pk_B, name_B, C_B]               C_B = SHA256(L‖"commit"‖windowID‖pk_A‖pk_B‖N_B)
//   P3 A→B 0x23 [N_A, attestation, attestation key ID]      both empty when A brings no App Attest (S-K2)
//   P4 B→A 0x24 [N_B]                                        A checks C_B
//   P5 B→A 0x25 [d, grant, Sig_B(L‖" host decision"‖T‖d‖grant)]   d 1 approve / 2 refuse; a refusal's grant is 0
//   P6 A→B 0x26 [Sig_KA(L‖" controller confirm"‖T)]
//   P7 B→A 0x27 [Sig_B(L‖" host stored"‖T)]
//   busy B→A 0x28, no fields: the window already took its one P1 (unauthenticated; the real Viewer raises an alarm)
// T = SHA256(LP[L, windowID, pk_A, name_A, model_A, pk_B, name_B, N_A, N_B]).
// The App Attest binding is SHA256(LP[L, "attest", windowID, pk_A, name_A, model_A, pk_B, C_B, N_A]): the names vary in
// length, so its fields are length-prefixed like T's (DESIGN 7.1 writes it the same way). C_B binds N_B, so the binding
// covers every value that decides T. Tests/ControllerPairingContract/vectors.json pins every value, and
// reference/controller-pairing.py computes them from the specification alone.

public enum ControllerPairingProtocol {
    public static let label = "agentstoz.screen-controller-pairing/v1"
    public static let version: UInt8 = 1
    public static let windowIDSize = 16
    public static let nonceSize = 32
    static let keySize = 65
    static let signatureSize = 64
    static let attestationKeyIDSize = 32
    public static let maxNameBytes = RegistrationRecord.maxTextBytes
    public static let maxModelBytes = 32
    /// P1, before the window has taken anybody: the pre-authentication limit (7.1).
    public static let maxFirstFrame = 1024
    /// Every later frame; P3's attestation object is the largest.
    public static let maxFrame = RegistrationWire.maxFrame
    /// How long a window waits for its one P1.
    public static let windowLifetime: TimeInterval = 120
    /// From P1 until the person at B has decided and A has confirmed, apart from 52741's five-second deadline.
    public static let decisionTimeout: Duration = .seconds(180)
    /// A machine step at A: P2 after P1, P4 after P3.
    public static let exchangeTimeout: Duration = .seconds(10)
    /// From P1 until B has sent P4: A's App Attest asks Apple's server in between (S-K2).
    public static let attestationTimeout: Duration = .seconds(60)
    /// How long A waits for P7 before it keeps the target as 「확인 필요」 (SR-31: it never sends P6 again).
    public static let storedTimeout: Duration = .seconds(10)
    public static let codeDigits = 6
    public static let serviceType = "_atzmpair._tcp"
    static let servicePrefix = "az-mpair-"
    /// TXT keys: B's name (never authenticated) and this protocol's version.
    public static let nameKey = "n", versionKey = "pv"

    /// The S-K2 build switch (DESIGN 7.1, 9절). Off until a signed Mac build proves App Attest works: B then accepts a P3
    /// without an attestation and stores the controller as not bound to a genuine Viewer, which keeps every session of it
    /// behind the push gate. A present attestation is always verified, and a wrong one is always refused. Turning this on
    /// also needs a real attestation vector in Tests/ControllerPairingContract/vectors.json (ControllerPairingChecks).
    public static let requiresAttestation = false

    /// The genuine Viewer, for this path alone: the phone registration's allow-list never names it (7.1).
    public static let viewerTeamID = "DA8QKAQ2C9"
    public static let viewerBundleID = "com.intenet.agentstozbycs.viewer"
    public static var viewerVerifier: any AppAttestationVerifying {
        AppAttestVerifier(teamID: viewerTeamID, bundleID: viewerBundleID, environment: .production)
    }

    /// The Bonjour name of a window: `az-mpair-` and its ID in hex.
    public static func serviceName(windowID: Data) -> String { servicePrefix + hex(windowID) }

    /// The window ID a service name carries, or nil for anything that is not a pairing window's name.
    public static func windowID(serviceName: String) -> Data? {
        guard serviceName.hasPrefix(servicePrefix) else { return nil }
        let text = Array(serviceName.utf8.dropFirst(servicePrefix.utf8.count))
        guard text.count == windowIDSize * 2 else { return nil }
        var bytes = Data()
        for index in stride(from: 0, to: text.count, by: 2) {
            guard let high = hexValue(text[index]), let low = hexValue(text[index + 1]) else { return nil }
            bytes.append(high << 4 | low)
        }
        return bytes
    }

    /// What both screens show to tell windows apart: the first four hex characters of the window ID.
    public static func windowNumber(_ windowID: Data) -> String { String(hex(windowID).prefix(4)) }

    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48...57: byte - 48
        case 97...102: byte - 87
        default: nil   // lowercase only: one window has one name
        }
    }
}

public enum ControllerPairingError: Error, Equatable, Sendable {
    case malformed
    /// P4's nonce does not open P2's commitment: someone in the middle, or a broken B. Nothing was shown.
    case commitmentMismatch
    /// P2 names another window than the one the person picked.
    case windowMismatch
    /// A code the person typed is not the one this side computed. Nothing more is sent.
    case codeMismatch
    /// This build requires a genuine Viewer's attestation and P3 had none (S-K2).
    case attestationRequired
    /// P3's attestation did not verify. Always refused, whatever the build.
    case untrustedViewer(AppAttestError)
    case badSignature
    /// B refused, signed. The person at B pressed 「거절」, typed another code ①, or a session started (SR-37).
    case refused
    /// The window had already taken its one P1.
    case windowBusy
    /// The window or the decision deadline passed.
    case expired
    /// The person at A gave up: 「그만두기」, or the sheet closed (the pairing task was cancelled).
    case cancelled
}

/// What A may do at B, as P5 signs it. A refusal signs grant 0.
public enum ControllerPairingGrant: UInt8, Sendable, CaseIterable {
    case view = 1, control = 2
}

/// Words both apps show for the pairing (DESIGN 12절), in one language as everywhere in the Viewer and Screen.
public enum ControllerPairingText {
    public static let unnamed = "이름 없는 Mac"
    public static let windowClosed = "B의 등록 창이 닫혔습니다"
    public static let codeMismatch = "숫자가 다릅니다 · 등록하지 않았습니다"
    public static let needsCheck = "확인 필요"
    public static let busyAlarm = "B의 등록 창을 다른 프로그램이 먼저 잡았습니다. B에서 거절하고 이 Mac에서 실행 중인 프로그램을 확인하세요"
    public static let untrustedViewer = "정품 AgentsToZ Viewer임을 확인하지 못해 거절했습니다"
    public static let warpHint = "등록하는 동안 Cloudflare One을 잠시 끄세요"

    /// A name as the other Mac's screen may show it (`RegistrationInvite.isShowableName`), else 「이름 없는 Mac」.
    public static func showable(_ name: String) -> String { RegistrationInvite.isShowableName(name) ? name : unnamed }
    /// A model, or nil when it cannot be shown as it came.
    public static func showableModel(_ model: String) -> String? { RegistrationInvite.isShowableName(model) ? model : nil }

    /// What the Viewer says when a pairing ended without a target (12절). Only a busy window raises the red alarm (6.3):
    /// a program on this Mac may have taken B's window first.
    public static func viewerNotice(for error: Error) -> ControllerPairingNotice {
        switch error as? ControllerPairingError {
        case .windowBusy: ControllerPairingNotice(text: busyAlarm, alarm: true)
        case .codeMismatch: ControllerPairingNotice(text: codeMismatch, alarm: false)
        case .refused: ControllerPairingNotice(text: "B에서 거절했습니다 · 등록하지 않았습니다", alarm: false)
        case .cancelled: ControllerPairingNotice(text: "등록을 그만두었습니다 · 등록하지 않았습니다", alarm: false)
        case .commitmentMismatch, .badSignature, .windowMismatch, .malformed:
            ControllerPairingNotice(text: "B의 응답을 확인하지 못했습니다 · 등록하지 않았습니다. B에서 창을 다시 여세요", alarm: false)
        case .attestationRequired, .untrustedViewer: ControllerPairingNotice(text: untrustedViewer, alarm: false)
        case .expired, nil: ControllerPairingNotice(text: windowClosed + ". B에서 창이 열려 있는지 확인하세요 · " + warpHint, alarm: false)
        }
    }
}

public struct ControllerPairingNotice: Sendable, Equatable {
    public let text: String
    /// The red alarm: shown until the person dismisses it.
    public let alarm: Bool
}

// MARK: - Wire

enum ControllerPairingTag: UInt8 {
    case hello = 0x21, commit = 0x22, reveal = 0x23, open = 0x24, decision = 0x25, confirm = 0x26, stored = 0x27, busy = 0x28
}

enum ControllerPairingWire {
    static let busy = Data([ControllerPairingTag.busy.rawValue])

    static func encode(_ tag: ControllerPairingTag, _ fields: [Data]) -> Data { Data([tag.rawValue]) + LengthPrefixed.encode(fields) }

    /// Exactly `count` fields under `tag`. A busy reply in place of P2 is the window's answer, not a malformed frame.
    static func decode(_ frame: Data, _ tag: ControllerPairingTag, count: Int) throws -> [Data] {
        guard frame.first == tag.rawValue else {
            throw frame == busy && tag == .commit ? ControllerPairingError.windowBusy : ControllerPairingError.malformed
        }
        do { return try LengthPrefixed.decode(Data(frame.dropFirst()), count: count) } catch { throw ControllerPairingError.malformed }
    }

    static func key(_ data: Data) throws -> P256.Signing.PublicKey {
        guard data.count == ControllerPairingProtocol.keySize, data.first == 0x04,
              let key = try? P256.Signing.PublicKey(x963Representation: data) else { throw ControllerPairingError.malformed }
        return key
    }

    /// UTF-8 text as it came, at most `maxBytes`. Whether a screen may show it is `ControllerPairingText.showable`.
    static func text(_ data: Data, maxBytes: Int) throws -> String {
        guard (1...maxBytes).contains(data.count), let text = String(data: data, encoding: .utf8),
              Data(text.utf8) == data else { throw ControllerPairingError.malformed }
        return text
    }

    static func signature(_ data: Data) throws -> P256.Signing.ECDSASignature {
        guard data.count == ControllerPairingProtocol.signatureSize,
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: data) else { throw ControllerPairingError.malformed }
        return signature
    }
}

/// P1.
struct ControllerPairingHello {
    let controllerKey: P256.Signing.PublicKey
    let name: String, model: String

    init(controllerKey: P256.Signing.PublicKey, name: String, model: String) throws {
        guard (1...ControllerPairingProtocol.maxNameBytes).contains(name.utf8.count),
              (1...ControllerPairingProtocol.maxModelBytes).contains(model.utf8.count) else { throw ControllerPairingError.malformed }
        self.controllerKey = controllerKey; self.name = name; self.model = model
    }

    init(_ frame: Data) throws {
        guard frame.count <= ControllerPairingProtocol.maxFirstFrame else { throw ControllerPairingError.malformed }
        let f = try ControllerPairingWire.decode(frame, .hello, count: 4)
        guard f[0] == Data([ControllerPairingProtocol.version]) else { throw ControllerPairingError.malformed }
        try self.init(controllerKey: try ControllerPairingWire.key(f[1]),
                      name: try ControllerPairingWire.text(f[2], maxBytes: ControllerPairingProtocol.maxNameBytes),
                      model: try ControllerPairingWire.text(f[3], maxBytes: ControllerPairingProtocol.maxModelBytes))
    }

    var encoded: Data {
        ControllerPairingWire.encode(.hello, [Data([ControllerPairingProtocol.version]), controllerKey.x963Representation,
                                              Data(name.utf8), Data(model.utf8)])
    }
}

/// P2.
struct ControllerPairingCommit {
    let windowID: Data
    let hostKey: P256.Signing.PublicKey
    let hostName: String
    let commitment: Data

    init(windowID: Data, hostKey: P256.Signing.PublicKey, hostName: String, commitment: Data) throws {
        guard windowID.count == ControllerPairingProtocol.windowIDSize, commitment.count == 32,
              (1...ControllerPairingProtocol.maxNameBytes).contains(hostName.utf8.count) else { throw ControllerPairingError.malformed }
        self.windowID = windowID; self.hostKey = hostKey; self.hostName = hostName; self.commitment = commitment
    }

    init(_ frame: Data) throws {
        let f = try ControllerPairingWire.decode(frame, .commit, count: 4)
        try self.init(windowID: f[0], hostKey: try ControllerPairingWire.key(f[1]),
                      hostName: try ControllerPairingWire.text(f[2], maxBytes: ControllerPairingProtocol.maxNameBytes), commitment: f[3])
    }

    var encoded: Data {
        ControllerPairingWire.encode(.commit, [windowID, hostKey.x963Representation, Data(hostName.utf8), commitment])
    }
}

/// P3.
struct ControllerPairingReveal {
    let nonce: Data
    let attestation: Data, attestationKeyID: Data

    init(nonce: Data, attestation: Data, attestationKeyID: Data) throws {
        guard nonce.count == ControllerPairingProtocol.nonceSize,
              attestation.isEmpty == attestationKeyID.isEmpty,
              attestationKeyID.isEmpty || attestationKeyID.count == ControllerPairingProtocol.attestationKeyIDSize else {
            throw ControllerPairingError.malformed
        }
        self.nonce = nonce; self.attestation = attestation; self.attestationKeyID = attestationKeyID
    }

    init(_ frame: Data) throws {
        let f = try ControllerPairingWire.decode(frame, .reveal, count: 3)
        try self.init(nonce: f[0], attestation: f[1], attestationKeyID: f[2])
    }

    var encoded: Data { ControllerPairingWire.encode(.reveal, [nonce, attestation, attestationKeyID]) }
}

/// P4.
struct ControllerPairingOpening {
    let nonce: Data

    init(nonce: Data) throws {
        guard nonce.count == ControllerPairingProtocol.nonceSize else { throw ControllerPairingError.malformed }
        self.nonce = nonce
    }

    init(_ frame: Data) throws { try self.init(nonce: try ControllerPairingWire.decode(frame, .open, count: 1)[0]) }

    var encoded: Data { ControllerPairingWire.encode(.open, [nonce]) }
}

/// P5.
struct ControllerPairingDecision {
    static let approve: UInt8 = 1, refuse: UInt8 = 2
    /// nil is a refusal.
    let grant: ControllerPairingGrant?
    let signature: Data

    init(_ frame: Data) throws {
        let f = try ControllerPairingWire.decode(frame, .decision, count: 3)
        guard f[0].count == 1, f[1].count == 1 else { throw ControllerPairingError.malformed }
        switch (f[0][f[0].startIndex], f[1][f[1].startIndex]) {
        case (Self.approve, let raw): guard let grant = ControllerPairingGrant(rawValue: raw) else { throw ControllerPairingError.malformed }
                                      self.grant = grant
        case (Self.refuse, 0): grant = nil
        default: throw ControllerPairingError.malformed
        }
        _ = try ControllerPairingWire.signature(f[2])
        signature = f[2]
    }

    init(grant: ControllerPairingGrant?, signature: Data) { self.grant = grant; self.signature = signature }

    var decisionByte: UInt8 { grant == nil ? Self.refuse : Self.approve }
    var grantByte: UInt8 { grant?.rawValue ?? 0 }
    var encoded: Data { ControllerPairingWire.encode(.decision, [Data([decisionByte]), Data([grantByte]), signature]) }
}

/// P6 and P7: one signature each.
struct ControllerPairingSigned {
    let signature: Data
    init(signature: Data) { self.signature = signature }
    init(_ frame: Data, _ tag: ControllerPairingTag) throws {
        signature = try ControllerPairingWire.decode(frame, tag, count: 1)[0]
        _ = try ControllerPairingWire.signature(signature)
    }
    func encoded(_ tag: ControllerPairingTag) -> Data { ControllerPairingWire.encode(tag, [signature]) }
}

// MARK: - Transcript

/// Everything that decides T, as each side saw it. Two sides with one T agree on every field; a machine in the middle
/// leaves them with two.
public struct ControllerPairingTranscript: Sendable, Equatable {
    let windowID: Data
    let controllerKey: Data, controllerName: Data, controllerModel: Data
    let hostKey: Data, hostName: Data
    let controllerNonce: Data, hostNonce: Data
    /// T.
    public let hash: Data

    init(windowID: Data, controllerKey: Data, controllerName: Data, controllerModel: Data, hostKey: Data, hostName: Data,
         controllerNonce: Data, hostNonce: Data) {
        self.windowID = windowID
        self.controllerKey = controllerKey; self.controllerName = controllerName; self.controllerModel = controllerModel
        self.hostKey = hostKey; self.hostName = hostName
        self.controllerNonce = controllerNonce; self.hostNonce = hostNonce
        hash = sha256(LengthPrefixed.encode([ControllerPairingMath.label, windowID, controllerKey, controllerName, controllerModel,
                                             hostKey, hostName, controllerNonce, hostNonce]))
    }

    init(hello: ControllerPairingHello, commit: ControllerPairingCommit, controllerNonce: Data, hostNonce: Data) {
        self.init(windowID: commit.windowID, controllerKey: hello.controllerKey.x963Representation, controllerName: Data(hello.name.utf8),
                  controllerModel: Data(hello.model.utf8), hostKey: commit.hostKey.x963Representation, hostName: Data(commit.hostName.utf8),
                  controllerNonce: controllerNonce, hostNonce: hostNonce)
    }

    /// Code ①: A shows it, the person types it at B.
    public var controllerCode: String { ControllerPairingMath.code("sas-controller", hash) }
    /// Code ②: B shows it, the person types it at A.
    public var hostCode: String { ControllerPairingMath.code("sas-host", hash) }
}

enum ControllerPairingMath {
    static let label = Data(ControllerPairingProtocol.label.utf8)
    static let decisionLabel = Data((ControllerPairingProtocol.label + " host decision").utf8)
    static let confirmLabel = Data((ControllerPairingProtocol.label + " controller confirm").utf8)
    static let storedLabel = Data((ControllerPairingProtocol.label + " host stored").utf8)

    /// C_B: every field but the label and "commit" has a fixed size, so plain concatenation is unambiguous.
    static func commitment(windowID: Data, controllerKey: Data, hostKey: Data, hostNonce: Data) -> Data {
        sha256(label + Data("commit".utf8) + windowID + controllerKey + hostKey + hostNonce)
    }

    /// App Attest's clientDataHash for A's attestation of K_A (S-K2).
    static func attestationHash(windowID: Data, controllerKey: Data, controllerName: Data, controllerModel: Data, hostKey: Data,
                                commitment: Data, controllerNonce: Data) -> Data {
        sha256(LengthPrefixed.encode([label, Data("attest".utf8), windowID, controllerKey, controllerName, controllerModel, hostKey,
                                      commitment, controllerNonce]))
    }

    /// uint32_be(SHA256(L‖purpose‖T)[0..4]) mod 10⁶, six digits.
    static func code(_ purpose: String, _ transcript: Data) -> String {
        let digest = sha256(label + Data(purpose.utf8) + transcript)
        let value = digest.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) } % 1_000_000
        let digits = String(value)
        return String(repeating: "0", count: ControllerPairingProtocol.codeDigits - digits.count) + digits
    }

    static func decisionData(_ transcript: Data, decision: UInt8, grant: UInt8) -> Data { decisionLabel + transcript + Data([decision, grant]) }
    static func confirmData(_ transcript: Data) -> Data { confirmLabel + transcript }
    static func storedData(_ transcript: Data) -> Data { storedLabel + transcript }

    static func verify(_ signature: Data, _ data: Data, by key: P256.Signing.PublicKey) -> Bool {
        guard let parsed = try? ControllerPairingWire.signature(signature) else { return false }
        return key.isValidSignature(parsed, for: data)
    }

    /// What a person typed, as a code: six ASCII digits once spaces are dropped, else nil.
    static func typed(_ text: String) -> String? {
        let digits = text.filter { $0 != " " }
        guard digits.utf8.count == ControllerPairingProtocol.codeDigits, digits.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
        return digits
    }

    /// Compares without stopping at the first difference.
    static func same(_ typed: String, _ expected: String) -> Bool {
        let a = Array(typed.utf8), b = Array(expected.utf8)
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

// MARK: - B: the window

/// B's pairing window: one per click on 「다른 Mac 추가…」. It takes the first well-formed P1 and answers every later
/// one with busy. A window that took a P1, or closed, never takes another: reopening makes a new window and a new
/// number.
public final class ControllerPairingHost: Sendable {
    public let windowID: Data
    public let opened: Date
    public var expires: Date { opened.addingTimeInterval(ControllerPairingProtocol.windowLifetime) }
    public var serviceName: String { ControllerPairingProtocol.serviceName(windowID: windowID) }
    public var windowNumber: String { ControllerPairingProtocol.windowNumber(windowID) }
    public let hostName: String
    let signer: any TranscriptSigner
    let verifier: any AppAttestationVerifying
    let requiresAttestation: Bool
    let decisionTimeout: Duration
    let attestationTimeout: Duration
    private enum State { case open, taken, closed }
    private let state = OSAllocatedUnfairLock(initialState: State.open)

    /// `signer` is B's identity (`ScreenStore.identity()`); `hostName` the name B shows the other Mac, one
    /// `RegistrationInvite.isShowableName` accepts.
    public convenience init(signer: any TranscriptSigner, hostName: String, verifier: any AppAttestationVerifying = ControllerPairingProtocol.viewerVerifier,
                requiresAttestation: Bool = ControllerPairingProtocol.requiresAttestation, now: Date = Date()) throws {
        try self.init(signer: signer, hostName: hostName, verifier: verifier, requiresAttestation: requiresAttestation, now: now,
                      windowID: randomBytes(ControllerPairingProtocol.windowIDSize))
    }

    init(signer: any TranscriptSigner, hostName: String, verifier: any AppAttestationVerifying, requiresAttestation: Bool, now: Date,
         windowID: Data, decisionTimeout: Duration = ControllerPairingProtocol.decisionTimeout,
         attestationTimeout: Duration = ControllerPairingProtocol.attestationTimeout) throws {
        guard RegistrationInvite.isShowableName(hostName), windowID.count == ControllerPairingProtocol.windowIDSize else {
            throw ControllerPairingError.malformed
        }
        self.signer = signer; self.hostName = hostName; self.verifier = verifier
        self.requiresAttestation = requiresAttestation; opened = now; self.windowID = windowID
        self.decisionTimeout = decisionTimeout; self.attestationTimeout = attestationTimeout
    }

    /// Open and untaken, before its 120 seconds are up.
    public func isOpen(at now: Date = Date()) -> Bool { state.withLock { $0 == .open } && now < expires }

    /// A P1 took this window: every later one is answered busy.
    public var isTaken: Bool { state.withLock { $0 == .taken } }

    /// Takes no P1 from now on (expiry, a session starting, the person closing it). A pairing it already took is
    /// the caller's to refuse.
    public func close() { state.withLock { if $0 == .open { $0 = .closed } } }

    private enum Take { case taken, busy, closed }

    private func take(at now: Date) -> Take {
        state.withLock { current in
            switch current {
            case .taken: return .busy
            case .closed: return .closed
            case .open:
                guard now < expires else { current = .closed; return .closed }
                current = .taken
                return .taken
            }
        }
    }

    /// Runs one connection up to the person's decision: P1 (already read by the caller, or read here), P2, P3 with its
    /// attestation, P4. The window is taken by the first well-formed P1, whatever happens after it; a later P1 gets busy.
    public func accept(over framed: any ScreenFrameTransport, first: Data? = nil) async throws -> PendingControllerPairing {
        let frame: Data
        if let first { frame = first } else { framed.setMaxFrame(ControllerPairingProtocol.maxFirstFrame); frame = try await framed.receive() }
        let hello: ControllerPairingHello
        do { hello = try ControllerPairingHello(frame) } catch { framed.cancel(); throw error }
        switch take(at: Date()) {
        case .taken: break
        case .busy:
            try? await framed.send(ControllerPairingWire.busy)
            framed.cancel()
            throw ControllerPairingError.windowBusy
        case .closed:
            framed.cancel()
            throw ControllerPairingError.expired
        }
        return try await PendingControllerPairing.start(hello: hello, host: self, framed: framed)
    }
}

/// A taken window waiting for the person at B. Code ① first, once; then 「승인」 (the caller has passed the person's
/// Touch ID or Watch) or 「거절」. Every path ends the connection; nothing is ever sent twice.
public final class PendingControllerPairing: Sendable {
    public let windowID: Data
    public let controllerKey: P256.Signing.PublicKey
    /// As A sent them. Screens show them through `ControllerPairingText`.
    public let controllerName: String
    public let controllerModel: String
    /// The verified attestation, or nil when A brought none (allowed only while `requiresAttestation` is off).
    public let attestation: AppAttestation?
    /// When the person must have decided (P1 + 180 s).
    public let deadline: ContinuousClock.Instant
    public var displayName: String { ControllerPairingText.showable(controllerName) }
    public var displayModel: String? { ControllerPairingText.showableModel(controllerModel) }
    public var controllerFingerprint: Data { ScreenControlIdentity.fingerprint(of: controllerKey) }
    public var shortFingerprint: String { ScreenControlIdentity.shortFingerprint(of: controllerKey) }
    public var attested: Bool { attestation != nil }

    let transcript: ControllerPairingTranscript
    private let framed: any ScreenFrameTransport
    private let signer: any TranscriptSigner
    /// `storing`: P6 verified and `complete`'s store is running; a refusal from then on only ends the connection.
    private enum Phase { case awaitingCode, codeAccepted, deciding, approved, storing, finished }
    private let phase: OSAllocatedUnfairLock<Phase>
    /// A's next frame after P4, read from the start so a dropped connection shows at once. It must be P6, after P5.
    private let incoming: Task<Data, Error>
    private let watchdog: Task<Void, Never>

    private init(hello: ControllerPairingHello, attestation: AppAttestation?, transcript: ControllerPairingTranscript,
                 framed: any ScreenFrameTransport, signer: any TranscriptSigner, deadline: ContinuousClock.Instant) {
        windowID = transcript.windowID
        controllerKey = hello.controllerKey; controllerName = hello.name; controllerModel = hello.model
        self.attestation = attestation; self.transcript = transcript
        self.framed = framed; self.signer = signer; self.deadline = deadline
        let phase = OSAllocatedUnfairLock(initialState: Phase.awaitingCode)
        self.phase = phase
        incoming = Task {
            let frame = try await framed.receive()
            guard phase.withLock({ $0 == .approved }) else { framed.cancel(); throw ControllerPairingError.malformed }
            return frame
        }
        watchdog = Task {
            guard (try? await Task.sleep(until: deadline, clock: .continuous)) != nil else { return }
            framed.cancel()
        }
    }

    static func start(hello: ControllerPairingHello, host: ControllerPairingHost, framed: any ScreenFrameTransport) async throws -> PendingControllerPairing {
        let deadline = ContinuousClock.now + host.decisionTimeout
        let step = Task {
            guard (try? await Task.sleep(until: min(deadline, .now + host.attestationTimeout), clock: .continuous)) != nil else { return }
            framed.cancel()
        }
        defer { step.cancel() }
        do {
            framed.setMaxFrame(ControllerPairingProtocol.maxFrame)
            let hostNonce = randomBytes(ControllerPairingProtocol.nonceSize)
            let controllerKey = hello.controllerKey.x963Representation, hostKey = host.signer.publicKey.x963Representation
            let commitment = ControllerPairingMath.commitment(windowID: host.windowID, controllerKey: controllerKey, hostKey: hostKey,
                                                              hostNonce: hostNonce)
            let commit = try ControllerPairingCommit(windowID: host.windowID, hostKey: host.signer.publicKey, hostName: host.hostName,
                                                     commitment: commitment)
            try await framed.send(commit.encoded)
            let reveal = try ControllerPairingReveal(try await framed.receive())
            let attestation = try verify(reveal, hello: hello, commitment: commitment, host: host)
            try await framed.send(try ControllerPairingOpening(nonce: hostNonce).encoded)
            let transcript = ControllerPairingTranscript(hello: hello, commit: commit, controllerNonce: reveal.nonce, hostNonce: hostNonce)
            return PendingControllerPairing(hello: hello, attestation: attestation, transcript: transcript, framed: framed,
                                            signer: host.signer, deadline: deadline)
        } catch {
            framed.cancel()
            throw error is ControllerPairingError ? error : (ContinuousClock.now >= deadline ? ControllerPairingError.expired : error)
        }
    }

    /// A present attestation must verify against this registration; a missing one is refused when the build requires it.
    static func verify(_ reveal: ControllerPairingReveal, hello: ControllerPairingHello, commitment: Data,
                       host: ControllerPairingHost) throws -> AppAttestation? {
        guard !reveal.attestation.isEmpty else {
            if host.requiresAttestation { throw ControllerPairingError.attestationRequired }
            return nil
        }
        let hash = ControllerPairingMath.attestationHash(windowID: host.windowID, controllerKey: hello.controllerKey.x963Representation,
                                                         controllerName: Data(hello.name.utf8), controllerModel: Data(hello.model.utf8),
                                                         hostKey: host.signer.publicKey.x963Representation, commitment: commitment,
                                                         controllerNonce: reveal.nonce)
        do {
            return try host.verifier.verify(reveal.attestation, keyID: reveal.attestationKeyID, clientDataHash: hash, at: Date())
        } catch let error as AppAttestError {
            throw ControllerPairingError.untrustedViewer(error)
        } catch {
            throw ControllerPairingError.untrustedViewer(.malformed)
        }
    }

    /// Code ① as the person typed it at B with this Mac's keys (a `ControllerPairingCodeEntry` submission, SR-29), once.
    /// A wrong code refuses the pairing (signed) and ends it.
    public func enterControllerCode(_ submission: ControllerPairingCodeEntry.Submission) async -> Bool {
        await enterControllerCode(submission.text)
    }

    /// The same for a code as text: this module's checks only, never another module's caller.
    func enterControllerCode(_ text: String) async -> Bool {
        guard phase.withLock({ phase in
            guard phase == .awaitingCode else { return false }
            phase = .deciding
            return true
        }) else { return false }
        guard ContinuousClock.now < deadline else {
            end()
            return false
        }
        if let typed = ControllerPairingMath.typed(text), ControllerPairingMath.same(typed, transcript.controllerCode) {
            phase.withLock { $0 = .codeAccepted }
            return true
        }
        await sendRefusal()
        return false
    }

    /// The person approved, after code ① and their Touch ID or Watch. Sends P5 and returns code ② for B to show.
    public func approve(grant: ControllerPairingGrant) async throws -> String {
        guard phase.withLock({ phase in
            guard phase == .codeAccepted else { return false }
            phase = .approved
            return true
        }) else { throw ControllerPairingError.refused }
        guard ContinuousClock.now < deadline else {
            end()
            throw ControllerPairingError.expired
        }
        do {
            let data = ControllerPairingMath.decisionData(transcript.hash, decision: ControllerPairingDecision.approve, grant: grant.rawValue)
            let signature = try await signer.signature(for: data).rawRepresentation
            try await framed.send(ControllerPairingDecision(grant: grant, signature: signature).encoded)
            return transcript.hostCode
        } catch {
            end()
            throw ContinuousClock.now >= deadline ? ControllerPairingError.expired : error
        }
    }

    /// Waits for P6 and checks it with A's key; then `store` keeps the controller and P7 tells A. Nothing is stored
    /// unless P6 verified and the pairing was still approved at that moment: a `refuse()` that came first, even after
    /// P6 arrived, throws `.refused` here instead. When `store` throws, A hears nothing and keeps its target as 「확인 필요」
    /// (SR-31). `store` itself must still check that its caller wants the row, since a refusal can come while it runs.
    public func complete(store: @Sendable () async throws -> Void) async throws {
        defer { end() }
        guard phase.withLock({ $0 == .approved }) else { throw ControllerPairingError.refused }
        let frame: Data
        do { frame = try await incoming.value } catch {
            throw error is ControllerPairingError ? error : (ContinuousClock.now >= deadline ? ControllerPairingError.expired : error)
        }
        let confirm = try ControllerPairingSigned(frame, .confirm)
        guard ControllerPairingMath.verify(confirm.signature, ControllerPairingMath.confirmData(transcript.hash), by: controllerKey) else {
            throw ControllerPairingError.badSignature
        }
        guard phase.withLock({ phase in
            guard phase == .approved else { return false }
            phase = .storing
            return true
        }) else { throw ControllerPairingError.refused }
        try await store()
        // A refusal while the store ran ended the pairing: no P7 then, A keeps 「확인 필요」.
        guard phase.withLock({ $0 == .storing }),
              let signature = try? await signer.signature(for: ControllerPairingMath.storedData(transcript.hash)).rawRepresentation,
              phase.withLock({ $0 == .storing }) else { return }
        try? await framed.send(ControllerPairingSigned(signature: signature).encoded(.stored))
    }

    /// 「거절」, an expired decision or a session starting (SR-37): a signed refusal if nothing was decided yet, then the
    /// connection ends. After an approval it only ends the connection: `complete` stores nothing from then on, even for
    /// a P6 that already arrived. Once `complete`'s store is running it cannot be called back; the connection still ends
    /// and no P7 is sent, so A keeps 「확인 필요」 (SR-31), and the store's own check decides.
    public func refuse() async {
        if phase.withLock({ phase in
            guard phase == .awaitingCode || phase == .codeAccepted else { return false }
            phase = .deciding
            return true
        }) {
            await sendRefusal()
        } else {
            end()
        }
    }

    /// Waits until A's next frame arrives or the connection ends. True when it ended without one: A left, the deadline
    /// passed, or this pairing was refused. The window's screen closes on it.
    public func waitForEnd() async -> Bool {
        do { _ = try await incoming.value; return false } catch { return true }
    }

    private func sendRefusal() async {
        let data = ControllerPairingMath.decisionData(transcript.hash, decision: ControllerPairingDecision.refuse, grant: 0)
        if let signature = try? await signer.signature(for: data).rawRepresentation {
            try? await framed.send(ControllerPairingDecision(grant: nil, signature: signature).encoded)
        }
        end()
    }

    private func end() {
        phase.withLock { $0 = .finished }
        watchdog.cancel()
        incoming.cancel()
        framed.cancel()
    }
}

// MARK: - A: the Viewer

/// What A learned and keeps for B.
public struct ControllerPairingResult: Sendable {
    public enum State: String, Sendable, CaseIterable {
        /// P7 verified: B said it stored this key.
        case confirmed
        /// P6 went out and P7 did not come back verified. Kept, never resent (SR-31); the person checks B's list.
        case needsCheck
    }
    public let host: PinnedMac
    /// As B sent it; screens show it through `ControllerPairingText.showable`.
    public let hostName: String
    public let grant: ControllerPairingGrant
    public let state: State
    public let windowID: Data
    /// K_A's four characters, the ones B's controller list shows (SR-20).
    public let controllerShortFingerprint: String
    public var hostShortFingerprint: String { ScreenControlIdentity.shortFingerprint(of: host.publicKey) }
}

/// App Attest's answer for K_A: the attestation object and its key ID (S-K2).
public struct ControllerPairingAttestation: Sendable {
    public let attestation: Data
    public let keyID: Data
    public init(attestation: Data, keyID: Data) { self.attestation = attestation; self.keyID = keyID }
}

/// What the Viewer asks of the person and of App Attest during a pairing.
public struct ControllerPairingPrompts: Sendable {
    /// Attests K_A for `clientDataHash`; nil in a build without App Attest.
    public var attest: @Sendable (_ clientDataHash: Data) async throws -> ControllerPairingAttestation?
    /// Shows code ① with K_A's four characters: 「B에 이 숫자를 입력하세요」.
    public var showControllerCode: @Sendable (_ code: String, _ controllerShortFingerprint: String) async -> Void
    /// B approved with `grant`: ask for code ② from this Mac's keyboard alone, once (a `ControllerPairingCodeEntry`
    /// submission). nil when the person gave up.
    public var enterHostCode: @Sendable (_ grant: ControllerPairingGrant) async -> ControllerPairingCodeEntry.Submission?

    public init(attest: @escaping @Sendable (Data) async throws -> ControllerPairingAttestation?,
                showControllerCode: @escaping @Sendable (String, String) async -> Void,
                enterHostCode: @escaping @Sendable (ControllerPairingGrant) async -> ControllerPairingCodeEntry.Submission?) {
        self.attest = attest; self.showControllerCode = showControllerCode; self.enterHostCode = enterHostCode
    }
}

public enum ControllerPairingClient {
    /// Pairs with the window `windowID` names, under K_A (`signer`, made for this B alone). Any thrown error means
    /// nothing was registered as far as A knows: the caller deletes K_A. A wrong code ② sends nothing.
    public static func pair(over framed: any ScreenFrameTransport, windowID: Data, signer: any TranscriptSigner,
                            name: String, model: String, prompts: ControllerPairingPrompts,
                            timeout: Duration = ControllerPairingProtocol.exchangeTimeout,
                            decisionTimeout: Duration = ControllerPairingProtocol.decisionTimeout,
                            storedTimeout: Duration = ControllerPairingProtocol.storedTimeout) async throws -> ControllerPairingResult {
        framed.setMaxFrame(ControllerPairingProtocol.maxFrame)
        let deadline = OSAllocatedUnfairLock(initialState: ContinuousClock.now + timeout)
        let watchdog = Task {
            while true {
                let until = deadline.withLock { $0 }
                guard (try? await Task.sleep(until: until, clock: .continuous)) != nil else { return }
                if deadline.withLock({ $0 }) <= .now { return framed.cancel() }
            }
        }
        defer {
            watchdog.cancel()
            framed.cancel()
        }
        func expired(_ error: Error) -> Error {
            error is ControllerPairingError ? error : (deadline.withLock({ $0 }) <= .now ? ControllerPairingError.expired : error)
        }
        do {
            return try await withTaskCancellationHandler {
                let hello = try ControllerPairingHello(controllerKey: signer.publicKey, name: name, model: model)
                let commit: ControllerPairingCommit, opening: ControllerPairingOpening, controllerNonce: Data
                do {
                    try await framed.send(hello.encoded)
                    commit = try ControllerPairingCommit(try await framed.receive())
                    guard commit.windowID == windowID else { throw ControllerPairingError.windowMismatch }
                    controllerNonce = randomBytes(ControllerPairingProtocol.nonceSize)
                    let hash = ControllerPairingMath.attestationHash(windowID: windowID, controllerKey: signer.publicKey.x963Representation,
                                                                     controllerName: Data(name.utf8), controllerModel: Data(model.utf8),
                                                                     hostKey: commit.hostKey.x963Representation, commitment: commit.commitment,
                                                                     controllerNonce: controllerNonce)
                    // App Attest asks Apple's server: its own step, not the machine's ten seconds.
                    deadline.withLock { $0 = .now + ControllerPairingProtocol.attestationTimeout }
                    let attestation = try await prompts.attest(hash)
                    deadline.withLock { $0 = .now + timeout }
                    try await framed.send(try ControllerPairingReveal(nonce: controllerNonce, attestation: attestation?.attestation ?? Data(),
                                                                      attestationKeyID: attestation?.keyID ?? Data()).encoded)
                    opening = try ControllerPairingOpening(try await framed.receive())
                } catch { throw expired(error) }
                let expected = ControllerPairingMath.commitment(windowID: windowID, controllerKey: signer.publicKey.x963Representation,
                                                                hostKey: commit.hostKey.x963Representation, hostNonce: opening.nonce)
                guard expected == commit.commitment else { throw ControllerPairingError.commitmentMismatch }
                let transcript = ControllerPairingTranscript(hello: hello, commit: commit, controllerNonce: controllerNonce, hostNonce: opening.nonce)
                deadline.withLock { $0 = .now + decisionTimeout }
                await prompts.showControllerCode(transcript.controllerCode, ScreenControlIdentity.shortFingerprint(of: signer.publicKey))
                let decision: ControllerPairingDecision
                do { decision = try ControllerPairingDecision(try await framed.receive()) } catch { throw expired(error) }
                let signed = ControllerPairingMath.decisionData(transcript.hash, decision: decision.decisionByte, grant: decision.grantByte)
                guard ControllerPairingMath.verify(decision.signature, signed, by: commit.hostKey) else { throw ControllerPairingError.badSignature }
                guard let grant = decision.grant else { throw ControllerPairingError.refused }
                guard let submission = await prompts.enterHostCode(grant) else { throw ControllerPairingError.cancelled }
                guard let typed = ControllerPairingMath.typed(submission.text), ControllerPairingMath.same(typed, transcript.hostCode) else {
                    throw ControllerPairingError.codeMismatch
                }
                // Past B's deadline B has already closed: no Touch ID for a P6 nobody reads.
                guard deadline.withLock({ $0 }) > .now else { throw ControllerPairingError.expired }
                // K_A's first use: the person's Touch ID (or Watch) signs P6.
                let confirmation = try await signer.signature(for: ControllerPairingMath.confirmData(transcript.hash)).rawRepresentation
                do { try await framed.send(ControllerPairingSigned(signature: confirmation).encoded(.confirm)) } catch { throw expired(error) }
                deadline.withLock { $0 = .now + storedTimeout }
                var state = ControllerPairingResult.State.needsCheck
                if let frame = try? await framed.receive(), let stored = try? ControllerPairingSigned(frame, .stored),
                   ControllerPairingMath.verify(stored.signature, ControllerPairingMath.storedData(transcript.hash), by: commit.hostKey) {
                    state = .confirmed
                }
                return ControllerPairingResult(host: try PinnedMac(publicKey: commit.hostKey, fingerprint: ScreenControlIdentity.fingerprint(of: commit.hostKey)),
                                               hostName: commit.hostName, grant: grant, state: state, windowID: windowID,
                                               controllerShortFingerprint: ScreenControlIdentity.shortFingerprint(of: signer.publicKey))
            } onCancel: { framed.cancel() }
        } catch {
            throw ControllerPairingError.afterGivingUp(error)
        }
    }
}

extension ControllerPairingError {
    /// What a pairing that ended in `error` reports when its task may have been cancelled: the person gave up
    /// (「그만두기」, the sheet closed) and the cut connection is not B's doing, so `.cancelled`. A busy window keeps its
    /// alarm whatever the person did.
    static func afterGivingUp(_ error: Error) -> Error {
        guard Task.isCancelled, error as? ControllerPairingError != .windowBusy else { return error }
        return ControllerPairingError.cancelled
    }
}

// MARK: - Code entry

/// A six-digit code field that only this Mac's keyboard fills (SR-29): every key-down passes `ScreenInputOrigin.humanKey`
/// first, and an accessibility value write (`AXSetValue`), a paste or a programmatic set never changes it. One submission
/// per field; a pairing gives each code one try.
public struct ControllerPairingCodeEntry: Sendable, Equatable {
    public enum Key: Sendable, Equatable {
        case digit(UInt8)
        case delete
        case submit
    }

    public enum Outcome: Sendable, Equatable {
        /// Nothing changed; the refusal says why, nil when the key had nothing to do (a seventh digit).
        case ignored(ScreenInputRefusal?)
        case changed
        /// The code, once. The field takes nothing after it.
        case submitted(Submission)
    }

    /// A code that came in through `key` from hardware key-downs alone. Only this module makes one, so the calls that
    /// take a typed code (`ScreenControllerPairing.enterCode`, the Viewer's code ②) cannot be handed a string from
    /// accessibility, a paste or a program (SR-29).
    public struct Submission: Sendable, Equatable {
        public let text: String
        init(text: String) { self.text = text }
    }

    public private(set) var digits: [UInt8] = []
    public private(set) var submitted = false
    public var text: String { String(decoding: digits.map { $0 + 48 }, as: UTF8.self) }

    public init() {}

    /// A key-down the field received. `event` is what the caller read from `NSApp.currentEvent` for it, nil when no event
    /// ran it.
    public mutating func key(_ key: Key, event: ScreenInputEvent?, ownPid: Int64, screenPid: Int64?,
                             calibration: ScreenInputCalibration = .current) -> Outcome {
        guard !submitted else { return .ignored(nil) }
        if let refusal = ScreenInputOrigin.humanKey(event, inControl: true, ownPid: ownPid, screenPid: screenPid, calibration: calibration) {
            return .ignored(refusal)
        }
        switch key {
        case .digit(let value):
            guard value <= 9, digits.count < ControllerPairingProtocol.codeDigits else { return .ignored(nil) }
            digits.append(value)
            return .changed
        case .delete:
            guard !digits.isEmpty else { return .ignored(nil) }
            digits.removeLast()
            return .changed
        case .submit:
            guard digits.count == ControllerPairingProtocol.codeDigits else { return .ignored(nil) }
            submitted = true
            return .submitted(Submission(text: text))
        }
    }

    /// An accessibility value write, a paste or any programmatic set: never the person's keys, so never taken.
    public func setValue(_ text: String) -> Outcome { .ignored(.noCurrentEvent) }
}
