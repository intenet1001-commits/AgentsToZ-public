#if os(macOS)
import CryptoKit
import Foundation
import IOKit
import LocalAuthentication
import Network
import Observation
import ScreenControlCore

// B's controller pairing window (docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.3, SR-20, SR-22, SR-29, SR-37): opened by
// the person's hardware click on 「다른 Mac 추가…」, never during a session or with the lid closed, for 120 seconds.
// The person types A's code ① once (hardware keys only), picks the grant (「조작」 only once S-M3 has passed), may replace
// a row of the same name and model (off unless they turn it on), and approves with Touch ID or Apple Watch, never the
// password. The approval turns 「다른 Mac 연결 허용」 on and adds the row in one change, after A's P6 verified and only while
// the window is still open: one closed first (the person, a session) stores nothing, even for a P6 already in hand.
// A session starting closes the window and refuses a pairing waiting for the person (SR-37). Nothing here is reachable
// from an AI path: every opening and raising call carries the click or key judgement of `ScreenInputOrigin` (SR-23).
//
// `ScreenService.makeControllerPairing()` builds it on the keychain, the identity key and the service's own session.
// wp-screen-host calls `sessionStarted()` from `accept` before the first frame streams; the observation it sets up here
// is the backstop. It also routes `onEvent` to the controller log (SR-30) and push kind 4 (7.6).

/// What the window did that the log and the push relay hear about.
public enum ScreenControllerPairingEvent: Equatable, Sendable {
    /// Stored, the switch on: log 「등록」 and push `.controllerRegistered`.
    case enrolled(RegisteredController)
    /// A pairing ended without a row: logged as 「거절」 (SR-30). `controllerID` is the hex fingerprint of the key that
    /// asked (`RegisteredController.id`), nil when it failed before B learned one (a Viewer that could not prove itself).
    case refused(name: String, reason: ScreenControllerPairingRefusal, controllerID: String?)
}

/// Why a pairing ended without a row. The raw value is the fixed word the controller log keeps (SR-30, never text from
/// A); the 「다른 Mac에서 이 Mac 보기」 history says it in Korean (`ControllerSectionModel.pairingWord`).
public enum ScreenControllerPairingRefusal: String, Sendable, CaseIterable {
    /// 「거절」 at this Mac.
    case refusedAtMac = "pairingRefused"
    /// The window closed with a pairing waiting for the person.
    case windowClosed = "pairingWindowClosed"
    /// A session started (SR-37).
    case sessionStarted = "pairingSessionStarted"
    /// Code ① as typed here did not match.
    case codeMismatch = "pairingCodeMismatch"
    /// The registries could not be read to review it.
    case registryUnreadable = "pairingRegistryUnreadable"
    /// A phone holds the key (SR-22).
    case registeredAsPhone = "pairingRegisteredAsPhone"
    /// A left, or the 180-second decision ran out while the person was asked.
    case disconnected = "pairingDisconnected"
    /// The genuine Viewer's proof was required and missing or wrong.
    case untrustedViewer = "pairingUntrustedViewer"
    /// A's P6 did not verify.
    case badSignature = "pairingBadSignature"
    case expired = "pairingExpired"
    /// The row to replace was not one the window offered.
    case notAReplacement = "pairingNotAReplacement"
}

@MainActor @Observable
public final class ScreenControllerPairing {
    public enum Phase: Equatable, Sendable {
        /// No window. `notice` says how the last one ended, if it should.
        case closed(notice: String?)
        /// Waiting for A: 「A의 Viewer에서 ‘<B 이름> · 창 번호 <번호>’를 고르세요」.
        case open(hostName: String, windowNumber: String, until: Date)
        /// A got to P4: type the code A shows.
        case reviewing(Review)
        /// Code ① was right: grant, replacement and 「승인」.
        case approving(Review)
        /// P5 is out: show code ② until A confirms.
        case showingHostCode(code: String, review: Review)
    }

    /// The controller asking, as B's window shows it.
    public struct Review: Equatable, Sendable {
        public let name: String
        public let model: String?
        public let shortFingerprint: String
        /// 「정품 AgentsToZ Viewer: 확인됨/확인할 수 없음」.
        public let attested: Bool
        public let windowNumber: String
        /// Rows of the same name and model, each with its own fingerprint beside the new one (「기존 항목 바꾸기」).
        public let replacements: [Replacement]
        /// S-M3's build flag: 「조작」 is not offered until it passed.
        public let allowsControl: Bool
    }

    public struct Replacement: Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let shortFingerprint: String
        public let registeredAt: Date
    }

    /// Everything the window reads or changes outside itself. `live` is the app's; the tests hand in memory and loopback.
    public struct Dependencies {
        public var identity: () throws -> any TranscriptSigner
        public var hostName: () -> String
        public var controllers: () throws -> ScreenControllers
        public var saveControllers: (ScreenControllers) throws -> Void
        public var phones: () throws -> [RegisteredDevice]
        /// `.deviceOwnerAuthenticationWithBiometricsOrWatch`; false when the person cancels.
        public var authenticate: (String) async throws -> Bool
        public var sessionActive: () -> Bool
        public var lidClosed: () -> Bool
        public var verifier: any AppAttestationVerifying
        public var requiresAttestation: Bool
        /// S-M3's build flag as the service decides it (`ScreenService.controlChoiceOffered`). No default: every builder
        /// says where it comes from, so the window never offers 「조작」 where the service's list would not.
        public var allowsControl: Bool
        public var listen: (ControllerPairingHost) throws -> ControllerPairingListener

        public init(identity: @escaping () throws -> any TranscriptSigner, hostName: @escaping () -> String,
                    controllers: @escaping () throws -> ScreenControllers, saveControllers: @escaping (ScreenControllers) throws -> Void,
                    phones: @escaping () throws -> [RegisteredDevice], authenticate: @escaping (String) async throws -> Bool,
                    sessionActive: @escaping () -> Bool, lidClosed: @escaping () -> Bool,
                    verifier: any AppAttestationVerifying = ControllerPairingProtocol.viewerVerifier,
                    requiresAttestation: Bool = ControllerPairingProtocol.requiresAttestation,
                    allowsControl: Bool,
                    listen: @escaping (ControllerPairingHost) throws -> ControllerPairingListener = { try ControllerPairingListener(host: $0) }) {
            self.identity = identity; self.hostName = hostName; self.controllers = controllers; self.saveControllers = saveControllers
            self.phones = phones; self.authenticate = authenticate; self.sessionActive = sessionActive; self.lidClosed = lidClosed
            self.verifier = verifier; self.requiresAttestation = requiresAttestation; self.allowsControl = allowsControl; self.listen = listen
        }
    }

    public private(set) var phase: Phase = .closed(notice: nil)
    /// A refusal of the person's own action (not in front of this Mac, Touch ID cancelled), shown under the window.
    public private(set) var notice: String?
    /// 「승인」 is running (Touch ID or Watch up, then P5): a second press does nothing and the window disables the button.
    public private(set) var approvalInProgress = false
    /// The controller log and push hook (SR-30, 7.6). wp-screen-host sets it.
    public var onEvent: (ScreenControllerPairingEvent) -> Void = { _ in }

    private let dependencies: Dependencies
    private(set) var window: ControllerPairingHost?
    private var listener: ControllerPairingListener?
    private(set) var port: NWEndpoint.Port?
    private var pending: PendingControllerPairing?
    private var tasks: [Task<Void, Never>] = []
    /// Each window's own number, so a task of a closed window never touches the next.
    private var generation = 0
    /// Set once this window stored its controller: closing it from then on reports the addition, never a refusal.
    private var enrolledNotice: String?

    public init(dependencies: Dependencies) { self.dependencies = dependencies }

    public static let authenticationReason = "다른 Mac 연결 허용을 켜고 ‘%@’을(를) 추가합니다"
    static let sessionNotice = "화면 연결이 시작돼 등록 창을 닫았습니다"
    static let replacementNotice = "바꿀 항목이 맞지 않습니다 · 목록에서 다시 고르세요"
    static func addedNotice(_ review: Review) -> String { "‘\(review.name)’을(를) 추가했습니다 · 키 지문 \(review.shortFingerprint)" }

    // MARK: Person's actions

    /// 「다른 Mac 추가…」. `click` is `ScreenInputOrigin.humanClick` for the click that ran it (SR-29).
    public func open(click: ScreenInputRefusal?) async {
        guard click == nil else { notice = ScreenInputOriginText.notInFront; return }
        guard !dependencies.sessionActive() else { notice = "화면 연결이 있는 동안에는 등록 창을 열 수 없습니다"; return }
        guard !dependencies.lidClosed() else { notice = "덮개를 연 상태에서 등록 창을 여세요"; return }
        close(notice: nil, refusal: nil)
        generation += 1
        let current = generation
        notice = nil
        do {
            let host = try ControllerPairingHost(signer: try dependencies.identity(), hostName: dependencies.hostName(),
                                                 verifier: dependencies.verifier, requiresAttestation: dependencies.requiresAttestation)
            let listener = try dependencies.listen(host)
            window = host
            self.listener = listener
            let port = try await listener.start()
            guard current == generation else { return listener.stop() }
            self.port = port
            phase = .open(hostName: host.hostName, windowNumber: host.windowNumber, until: host.expires)
            tasks.append(Task { [weak self] in
                for await outcome in listener.outcomes {
                    guard let self, current == self.generation else { return }
                    await self.handle(outcome)
                }
            })
            tasks.append(Task { [weak self] in
                guard (try? await Task.sleep(for: .seconds(host.expires.timeIntervalSinceNow))) != nil else { return }
                guard let self, current == self.generation, case .open = self.phase else { return }
                self.close(notice: ControllerPairingText.windowClosed, refusal: nil)
            })
        } catch {
            guard current == generation else { return }
            close(notice: "등록 창을 열지 못했습니다: \(error)", refusal: nil)
        }
    }

    /// Code ① as the person typed it here. Only `ControllerPairingCodeEntry` makes a submission, from hardware key-downs
    /// alone (SR-29), so no text from accessibility, a paste or a program reaches this.
    public func enterCode(_ submission: ControllerPairingCodeEntry.Submission) async {
        guard case .reviewing(let review) = phase, let pending else { return }
        let current = generation
        let accepted = await pending.enterControllerCode(submission)
        guard current == generation else { return }
        if accepted {
            phase = .approving(review)
        } else {
            close(notice: ControllerPairingText.codeMismatch, refusal: (review.name, .codeMismatch))
        }
    }

    /// 「승인」 with the grant and, only when the person turned 「기존 항목 바꾸기」 on, the row it replaces. `click` is the
    /// hardware click judgement; then Touch ID or Apple Watch. 「조작」 becomes 「보기」 until S-M3 has passed.
    public func approve(click: ScreenInputRefusal?, grant: ScreenControllerGrant, replacing: String? = nil) async {
        guard case .approving(let review) = phase, let pending, !approvalInProgress else { return }
        guard click == nil else { notice = ScreenInputOriginText.notInFront; return }
        guard replacing == nil || review.replacements.contains(where: { $0.id == replacing }) else {
            notice = Self.replacementNotice
            return
        }
        let granted: ScreenControllerGrant = dependencies.allowsControl ? grant : .view
        let current = generation
        // One approval at a time: a second press while Touch ID is up would refuse the first (`approve` takes one call).
        approvalInProgress = true
        defer { if current == generation { approvalInProgress = false } }
        let approved: Bool
        do {
            approved = try await dependencies.authenticate(String(format: Self.authenticationReason, review.name))
        } catch {
            guard current == generation else { return }
            notice = "이 Mac에서 Touch ID나 Apple Watch를 쓸 수 없습니다"
            return
        }
        guard current == generation, case .approving = phase else { return }
        guard approved else { notice = "인증을 취소해 승인하지 않았습니다"; return }
        notice = nil
        do {
            let code = try await pending.approve(grant: granted == .control ? .control : .view)
            guard current == generation else { return }
            phase = .showingHostCode(code: code, review: review)
            let attestation = pending.attestation
            let key = pending.controllerKey, name = pending.controllerName, model = pending.controllerModel
            try await pending.complete { [weak self] in
                try await MainActor.run {
                    // P6 verified, but the window may have closed (the person, a session: SR-37) since: then nothing.
                    guard let self, current == self.generation, self.pending === pending else { throw ControllerPairingError.refused }
                    try self.store(key: key, name: name, model: model, grant: granted, attestation: attestation, replacing: replacing)
                    // Stored: closing the window from here on reports the addition and leaves P7 to reach A.
                    self.enrolledNotice = Self.addedNotice(review)
                    self.pending = nil
                }
            }
            guard current == generation else { return }
            close(notice: Self.addedNotice(review), refusal: nil)
        } catch {
            guard current == generation else { return }
            close(notice: "등록하지 않았습니다: \(Self.describe(error))", refusal: (review.name, Self.refusal(for: error)))
        }
    }

    /// 「거절」: immediately, no click or authentication needed to lower anything.
    public func refuse() {
        let name = review?.name
        close(notice: name.map { "‘\($0)’을(를) 거절했습니다" }, refusal: name.map { ($0, .refusedAtMac) })
    }

    /// The window's close button.
    public func close() { close(notice: nil, refusal: review.map { ($0.name, .windowClosed) }) }

    /// SR-37: a phone or controller session started. Closes the window and refuses a pairing waiting for the person, so
    /// neither code ② nor the approval screen travels in the stream.
    public func sessionStarted() {
        guard window != nil else { return }
        close(notice: Self.sessionNotice, refusal: review.map { ($0.name, .sessionStarted) })
    }

    // MARK: Internals

    private var review: Review? {
        switch phase {
        case .reviewing(let review), .approving(let review), .showingHostCode(_, let review): review
        case .closed, .open: nil
        }
    }

    private func handle(_ outcome: ControllerPairingListener.Outcome) async {
        switch outcome {
        case .pending(let pending):
            guard case .open = phase, self.pending == nil else { return await pending.refuse() }
            let fingerprint = pending.controllerFingerprint
            let controllers: ScreenControllers, phones: [RegisteredDevice]
            do {
                controllers = try dependencies.controllers()
                phones = try dependencies.phones()
            } catch {
                await pending.refuse()
                return close(notice: "등록 목록을 읽지 못해 받지 않았습니다", refusal: (pending.displayName, .registryUnreadable),
                             controller: fingerprint)
            }
            // One key never in both sets (SR-22).
            guard !phones.holds(fingerprint) else {
                await pending.refuse()
                return close(notice: "이 키는 이미 폰으로 등록돼 있어 받지 않았습니다", refusal: (pending.displayName, .registeredAsPhone),
                             controller: fingerprint)
            }
            self.pending = pending
            let review = Review(name: pending.displayName, model: pending.displayModel, shortFingerprint: pending.shortFingerprint,
                                attested: pending.attested, windowNumber: ControllerPairingProtocol.windowNumber(pending.windowID),
                                replacements: controllers.replacementCandidates(name: pending.controllerName, model: pending.controllerModel,
                                                                                excluding: fingerprint)
                                    .map { Replacement(id: $0.id, name: $0.displayName, shortFingerprint: $0.keyFingerprint, registeredAt: $0.registeredAt) },
                                allowsControl: dependencies.allowsControl)
            phase = .reviewing(review)
            let current = generation
            tasks.append(Task { [weak self] in
                guard await pending.waitForEnd() else { return }
                guard let self, current == self.generation, self.pending === pending else { return }
                switch self.phase {
                case .reviewing, .approving:
                    self.close(notice: "A의 연결이 끊겼거나 결정 기한(180초)이 지나 등록하지 않았습니다", refusal: (review.name, .disconnected))
                default: break
                }
            })
        case .busy:
            // The window's screen already names the first; the late A raises its own alarm.
            break
        case .failed(_, let error):
            guard case .open = phase else { return }
            switch error {
            case .attestationRequired, .untrustedViewer:
                close(notice: ControllerPairingText.untrustedViewer, refusal: (ControllerPairingText.unnamed, .untrustedViewer))
            default: close(notice: ControllerPairingText.windowClosed, refusal: nil)
            }
        }
    }

    /// The row and the switch in one change (`ScreenControllers.enrolling`), after P6 verified.
    private func store(key: P256.Signing.PublicKey, name: String, model: String, grant: ScreenControllerGrant, attestation: AppAttestation?,
                       replacing: String?) throws {
        let controller = RegisteredController(publicKey: key, name: name, model: model, grant: grant,
                                              enrollment: try ControllerEnrollment.directSAS(attestation: attestation))
        let updated = try dependencies.controllers().enrolling(controller, replacing: replacing, phones: try dependencies.phones())
        try dependencies.saveControllers(updated)
        onEvent(.enrolled(controller))
    }

    /// `controller` is the key that asked, when it is not the pending pairing's yet (refused before the review).
    private func close(notice: String?, refusal: (name: String, reason: ScreenControllerPairingRefusal)?, controller: Data? = nil) {
        // A window that already stored its controller ended in an addition, whatever closed it afterwards.
        let enrolled = enrolledNotice
        let controllerID = (controller ?? pending?.controllerFingerprint).map(RegisteredController.hex)
        enrolledNotice = nil
        generation += 1
        approvalInProgress = false
        if let pending { Task { await pending.refuse() } }
        pending = nil
        window?.close()
        window = nil
        listener?.stop()
        listener = nil
        port = nil
        tasks.forEach { $0.cancel() }
        tasks = []
        phase = .closed(notice: enrolled ?? notice)
        if enrolled == nil, let refusal { onEvent(.refused(name: refusal.name, reason: refusal.reason, controllerID: controllerID)) }
    }

    /// The log's word for what `describe` says.
    static func refusal(for error: Error) -> ScreenControllerPairingRefusal {
        switch error as? ControllerPairingError {
        case .badSignature: .badSignature
        case .expired: .expired
        case .refused: .windowClosed
        default:
            switch error as? ScreenControllerError {
            case .registeredAsPhone: .registeredAsPhone
            case .notAReplacementCandidate: .notAReplacement
            default: .disconnected
            }
        }
    }

    static func describe(_ error: Error) -> String {
        switch error as? ControllerPairingError {
        case .badSignature: "A의 확인 서명이 맞지 않습니다"
        case .expired: "결정 기한(180초)이 지났습니다"
        case .refused: "등록 창이 닫혔습니다"
        default:
            switch error as? ScreenControllerError {
            case .registeredAsPhone: "이 키는 이미 폰으로 등록돼 있습니다"
            case .notAReplacementCandidate: "바꿀 항목이 맞지 않습니다"
            default: "A의 연결이 끊겼습니다"
            }
        }
    }
}

extension ScreenService {
    /// The pairing window on this Mac's keychain and identity, closed by this service's sessions (SR-37).
    public func makeControllerPairing() -> ScreenControllerPairing {
        let pairing = ScreenControllerPairing(dependencies: controllerPairingDependencies())
        follow(sessionsInto: pairing)
        return pairing
    }

    /// What `makeControllerPairing` builds the window on. 「조작」 is offered exactly where the service's own list offers it
    /// (`controlChoiceOffered`, from `ScreenBuildFlags.macControl`): one decision for S-M3, not one per window.
    func controllerPairingDependencies() -> ScreenControllerPairing.Dependencies {
        .init(
            identity: { try ScreenStore().identity() },
            hostName: { ScreenService.macName },
            controllers: { try ScreenStore().controllers() },
            saveControllers: { try ScreenStore().saveControllers($0) },
            phones: { try ScreenStore().devices() },
            authenticate: { try await ScreenControllerPairing.authenticateBiometricsOrWatch($0) },
            sessionActive: { [weak self] in self?.session != nil },
            lidClosed: { ScreenControllerPairing.isLidClosed() },
            allowsControl: controlChoiceOffered)
    }

    private func follow(sessionsInto pairing: ScreenControllerPairing) {
        withObservationTracking { _ = session } onChange: { [weak self, weak pairing] in
            Task { @MainActor in
                guard let self, let pairing else { return }
                if self.session != nil { pairing.sessionStarted() }
                self.follow(sessionsInto: pairing)
            }
        }
    }
}

extension ScreenControllerPairing {
    /// Touch ID or a paired Apple Watch, never the password (5.2, F7). False when the person cancels.
    nonisolated static func authenticateBiometricsOrWatch(_ reason: String) async throws -> Bool {
        do {
            return try await LAContext().evaluatePolicy(.deviceOwnerAuthenticationWithBiometricsOrWatch, localizedReason: reason)
        } catch let error as LAError where [.userCancel, .appCancel, .systemCancel].contains(error.code) {
            return false
        }
    }

    /// The built-in display's lid, as the power manager reports it (`AppleClamshellState`). False when unknown.
    nonisolated static func isLidClosed() -> Bool {
        let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard root != 0 else { return false }
        defer { IOObjectRelease(root) }
        let value = IORegistryEntryCreateCFProperty(root, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
        return (value as? Bool) == true
    }
}
#endif
