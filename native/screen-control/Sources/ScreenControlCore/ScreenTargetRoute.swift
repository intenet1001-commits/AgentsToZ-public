import Foundation
import Network

// How the AgentsToZ Viewer (Mac A) reaches a registered Mac B and what it tells the person about the session
// (docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.4, 6.5, 8절, 12절, SR-26). The order is fixed:
//
//   1. the route plan from the stored target alone — nothing is probed or looked up on the network;
//   2. the person's biometric approval of this target's key (one signature, SR-26) — no socket before it;
//   3. one path at a time: nearby `az-screen-<fp12>` for 3 s, then the saved private-network address for 10 s. Opening a
//      path sends nothing; only an opening failure moves on;
//   4. the key exchange as a Mac controller (`DeviceHandshake(peerClass: .controller)`: offers 5, goes on only at 5). From
//      its first byte nothing falls back to another path, whatever happens.
//
// What the Mac says before it signs anything (a pre-authentication notice, a close with no reason) is for wording only.
// Pure apart from `ScreenTargetOpener.network`, which the Viewer passes; checks pass their own.

/// One way to reach a target.
public enum ScreenTargetPath: Equatable, Sendable {
    /// Bonjour/AWDL `_atzscreen._tcp` under the target's own service name.
    case nearby(serviceName: String)
    /// The saved RFC 1918 address (Cloudflare private network) on the fixed screen port.
    case privateNetwork(ScreenPrivateNetworkRoute)
    /// Explicit community protocol6 over authenticated native WSS. It is never a fallback from legacy authentication.
    case communityCloudflare(deviceId: String)

    public var isNearby: Bool { if case .nearby = self { return true }; return false }
}

public struct ScreenTargetAttempt: Equatable, Sendable {
    public let path: ScreenTargetPath
    /// How long opening the path may take. The key exchange has its own five seconds after it.
    public let timeout: Duration
}

public enum ScreenTargetRoute {
    public static let nearbyTimeout: Duration = .seconds(3)
    public static let privateNetworkTimeout: Duration = .seconds(10)

    /// The paths to try, in order, from what is stored. A private path exists only for an address the person saved.
    public static func plan(_ target: ViewerTarget) -> [ScreenTargetAttempt] {
        let nearby = ScreenTargetAttempt(path: .nearby(serviceName: target.screenService), timeout: nearbyTimeout)
        let saved = target.privateNetwork.map { ScreenTargetAttempt(path: .privateNetwork($0), timeout: privateNetworkTimeout) }
        switch target.route {
        case .auto: return [nearby] + [saved].compactMap { $0 }
        case .nearby: return [nearby]
        case .private: return [saved].compactMap { $0 }
        }
    }
}

/// Opens a path and sends nothing on it.
public struct ScreenTargetOpener: Sendable {
    let open: @Sendable (ScreenTargetAttempt) async throws -> any ScreenFrameTransport

    public init(_ open: @escaping @Sendable (ScreenTargetAttempt) async throws -> any ScreenFrameTransport) { self.open = open }

    /// The network: the nearby service with peer-to-peer Wi-Fi, or TCP to the saved private address on 52741.
    public static let network = ScreenTargetOpener { attempt in
        switch attempt.path {
        case .nearby(let serviceName):
            try await ScreenNearby.open(serviceName: serviceName, maxFrame: ScreenListener.preAuthMaxFrame, timeout: attempt.timeout)
        case .privateNetwork(let route):
            try await ScreenClient.open(privateNetwork: route, maxFrame: ScreenListener.preAuthMaxFrame, timeout: attempt.timeout)
        case .communityCloudflare: throw ScreenCommunityError.malformed // CommunityScreenConnector owns this path.
        }
    }
}

/// Why a path that opened gave no session. Only `macTooOld` and `notThisMac` come from a checked signature; the rest
/// are what anyone on the path could cause, and change nothing stored.
public enum ScreenTargetRefusal: Equatable, Sendable {
    /// A version-5 Mac's unauthenticated reason (DESIGN 7.7).
    case notice(PreAuthNotice)
    /// Closed or timed out before the Mac signed anything (DESIGN 6.4 6번): no registration, a short block, another
    /// connection, or an older AgentsToZ Screen — the Viewer cannot tell which.
    case unanswered
    /// The pinned Mac signed a version below 5 (DESIGN 6.4 4번). Refused before this Mac signed anything.
    case macTooOld
    /// The answer did not verify as the pinned Mac.
    case notThisMac
    /// The approved key would not sign (used, or its biometric approval lapsed).
    case approvalUnusable
    case failed(String)

    init(_ error: Error) {
        switch error {
        case HandshakeError.preAuthNotice(let notice): self = .notice(notice)
        case HandshakeError.versionBelowMinimum: self = .macTooOld
        case HandshakeError.badSignature, HandshakeError.badConfirmation, HandshakeError.fingerprintMismatch,
             HandshakeError.malformed: self = .notThisMac
        case HandshakeError.alreadyUsed: self = .approvalUnusable
        case is TransportError: self = .unanswered
        default: self = .failed("\(error)")
        }
    }
}

public enum ScreenTargetConnectError: Error, Equatable, Sendable {
    /// The route allows no path (「인터넷만」 with no saved address). Nothing was asked or opened.
    case noRoute
    /// No path opened; no authentication byte left this Mac.
    case unreachable([ScreenTargetPath])
    /// `path` opened and the key exchange ran on it; no other path was tried after.
    case refused(ScreenTargetPath, ScreenTargetRefusal)
}

public enum ScreenTargetConnector {
    public struct Connected: Sendable {
        public let viewer: ScreenViewer
        public let path: ScreenTargetPath
        /// Paths that did not open before this one.
        public let unreachable: [ScreenTargetPath]
    }

    /// Connects to `target` as a Mac controller. `approve` asks the person (Touch ID, or Apple Watch when the key allows
    /// it) and returns this connection's one-use signer; it runs before any socket, and its failure opens nothing.
    public static func connect(_ target: ViewerTarget, approve: @Sendable () async throws -> any TranscriptSigner,
                               opener: ScreenTargetOpener = .network,
                               progress: @Sendable (ScreenConnectionPhase) async -> Void = { _ in }) async throws -> Connected {
        let plan = ScreenTargetRoute.plan(target)
        guard !plan.isEmpty else { throw ScreenTargetConnectError.noRoute }
        let mac = try target.pinnedMac()
        await progress(.approval)
        try Task.checkCancellation()
        let signer = try await approve()
        var unreachable: [ScreenTargetPath] = []
        for attempt in plan {
            try Task.checkCancellation()
            let transport: any ScreenFrameTransport
            await progress(attempt.path.isNearby ? .nearby : .privateNetwork)
            try Task.checkCancellation()
            do {
                transport = try await opener.open(attempt)
            } catch {
                try Task.checkCancellation()
                unreachable.append(attempt.path)
                continue
            }
            // Authentication bytes leave on this path from here: whatever happens, no other path is tried (SR-26).
            do {
                await progress(.authenticatingMac)
                try Task.checkCancellation()
                let viewer = try await ScreenViewer.connect(over: transport, mac: mac, signer: signer, peerClass: .controller)
                return Connected(viewer: viewer, path: attempt.path, unreachable: unreachable)
            } catch {
                transport.cancel()
                try Task.checkCancellation()
                throw ScreenTargetConnectError.refused(attempt.path, ScreenTargetRefusal(error))
            }
        }
        throw ScreenTargetConnectError.unreachable(unreachable)
    }
}

/// The nearby advertisement's `pv` TXT entry (DESIGN 7.7): a version-5 Screen sets `pv=5`. Wording only.
public enum ScreenNearbyVersionHint: Equatable, Sendable {
    case current
    /// Advertised without `pv=5`: the Mac's AgentsToZ may be older.
    case older
    /// Not looked up, or not found.
    case unknown

    public static func from(txt: [String: String]) -> ScreenNearbyVersionHint {
        guard let value = txt["pv"], let version = UInt16(value) else { return .older }
        return version >= 5 ? .current : .older
    }
}

// MARK: - During a session

/// Whether the Viewer sends anything to B from the person's keyboard and pointer: the build allows control (S-M3,
/// `ScreenInputCalibration.allowsControl`), the Mac granted control in this session and takes input now, and the person
/// has not paused input here.
public enum ViewerInputGate {
    public static func allows(_ state: ScreenMacState, pausedHere: Bool,
                              calibration: ScreenInputCalibration = .current) -> Bool {
        calibration.allowsControl && state.grant == .control && state.canSendInput && !pausedHere
    }

    /// The locked-Mac entry (DESIGN D-3, SR-28): the conditions are the build, B's control grant and B saying it is
    /// locked; the person's own pause does not apply to this one explicit send. A lock screen holds Secure Event Input
    /// itself, so a locked B reports `.secureInput` (and pauses remote input) for that reason alone: that does not close
    /// the entry. Anything else B names (view only, missing permissions, no input monitor, someone at B) does, and so does
    /// silence about B's input. Whether B accepts the text under its lock screen is B's (wp-screen-host, S0-2): a refusal
    /// comes back as `textAndReturnResult(.blocked)` and the Viewer says 「잠긴 B에는 입력할 수 없음」(ViewerSessionModel).
    public static func allowsLockedEntry(_ state: ScreenMacState, calibration: ScreenInputCalibration = .current) -> Bool {
        guard calibration.allowsControl, state.grant == .control, state.locked == true, !state.inputHeldAtMac else { return false }
        switch state.inputAvailability {
        case .ready?: return !state.inputPaused
        case .secureInput?: return true
        case .permissionsRequired?, .monitorUnavailable?, .localActivity?, .viewOnly?, .notificationsUnconfirmed?,
             .controlNotInThisBuild?, nil: return false
        }
    }
}

/// The Viewer's own keys (DESIGN 5.1, M-6): ⌃⌥⌘, ends the session and ⌃⌥⌘. is B's own; neither goes to B.
public enum ViewerKeyRoute: Equatable, Sendable {
    case forward
    case endSession
    case swallow

    static let comma: UInt16 = 0x2B, period: UInt16 = 0x2F

    public static func route(keyCode: UInt16, isDown: Bool, modifiers: KeyModifiers) -> ViewerKeyRoute {
        guard modifiers.isSuperset(of: [.control, .option, .command]), keyCode == comma || keyCode == period else { return .forward }
        return keyCode == comma && isDown ? .endSession : .swallow
    }
}

/// The locked-Mac entry's buffer (SR-28). Filled only by hardware key-downs that passed `ScreenInputOrigin.forward`: the
/// caller passes that verdict with each key. Nothing reads a text field's value into it.
public struct ViewerSecureBuffer: Sendable {
    private var characters: [Character] = []

    public init() {}

    public var count: Int { characters.count }
    public var isEmpty: Bool { characters.isEmpty }

    /// Adds typed characters when `refusal` is nil and the result stays plain text within `InputCodec.maxTextBytes`.
    @discardableResult
    public mutating func type(_ text: String, refusal: ScreenInputRefusal?) -> Bool {
        guard refusal == nil, !text.isEmpty, isPlainText(String(characters) + text, maxBytes: InputCodec.maxTextBytes) else {
            return false
        }
        characters.append(contentsOf: text)
        return true
    }

    @discardableResult
    public mutating func deleteBackward(refusal: ScreenInputRefusal?) -> Bool {
        guard refusal == nil, !characters.isEmpty else { return false }
        characters.removeLast()
        return true
    }

    /// The one `textAndReturn` event to send, emptying the buffer; nil when empty.
    public mutating func take(id: UInt32) -> InputEvent? {
        guard !characters.isEmpty, id != 0 else { return nil }
        defer { clear() }
        return .textAndReturn(id: id, text: String(characters))
    }

    public mutating func clear() { characters.removeAll(keepingCapacity: false) }
}

/// When the session's limit runs out, as far as A can tell (DESIGN 6.5): B decides on its own monotonic clock from the
/// limits it told (`sessionLimits`); A counts from the session's start and the last input it sent, which only ever
/// makes its estimate early. The Viewer tells the person `warningLead` before.
public struct ViewerLimitWatch: Equatable, Sendable {
    public static let warningLead: Duration = .seconds(5 * 60)

    public let started: ContinuousClock.Instant
    public private(set) var limits: SessionLimits?
    public private(set) var lastInputSent: ContinuousClock.Instant?

    public init(started: ContinuousClock.Instant) { self.started = started }

    public mutating func hear(_ notice: ScreenNotice) {
        if case .sessionLimits(_, let limits) = notice { self.limits = limits }
    }

    public mutating func sentInput(at now: ContinuousClock.Instant) { lastInputSent = max(lastInputSent ?? now, now) }

    /// The earliest moment B may end the session; nil until B told its limits.
    public var deadline: ContinuousClock.Instant? {
        guard let limits else { return nil }
        let idle = (lastInputSent ?? started) + limits.idle
        guard let maximum = limits.maximum else { return idle }
        return min(idle, started + maximum)
    }

    public var warningAt: ContinuousClock.Instant? { deadline.map { max(started, $0 - Self.warningLead) } }

    public func warns(at now: ContinuousClock.Instant) -> Bool { warningAt.map { now >= $0 } ?? false }
}

/// A point in the video as the fraction of B's display it covers; nil outside the picture (the band, the bars).
public enum ViewerPointer {
    public static func unit(x: Double, y: Double, videoX: Double, videoY: Double, videoWidth: Double,
                            videoHeight: Double) -> (x: Double, y: Double)? {
        guard videoWidth > 0, videoHeight > 0, x.isFinite, y.isFinite else { return nil }
        let unitX = (x - videoX) / videoWidth, unitY = (y - videoY) / videoHeight
        guard (0...1).contains(unitX), (0...1).contains(unitY) else { return nil }
        return (unitX, unitY)
    }

    /// The nearest point of the picture: where a button held down on B is let go, or a drag goes on, when the pointer
    /// left the picture (the band, the bars, outside the window). nil only when there is no picture.
    public static func clampedUnit(x: Double, y: Double, videoX: Double, videoY: Double, videoWidth: Double,
                                   videoHeight: Double) -> (x: Double, y: Double)? {
        guard videoWidth > 0, videoHeight > 0, x.isFinite, y.isFinite else { return nil }
        return (min(max((x - videoX) / videoWidth, 0), 1), min(max((y - videoY) / videoHeight, 0), 1))
    }
}

/// What the person's hardware holds down on B: every key (modifiers included) and button that went down there and has
/// not come up. When the session window stops taking input (it lost the keyboard focus, the person paused, B or the
/// build closed the gate), the Viewer lets all of it go, so nothing stays pressed on B. Caps Lock is a lock, not a held
/// key: it is never let go by this.
public struct ViewerHeldInput: Equatable, Sendable {
    public private(set) var keys: Set<UInt16> = []
    public private(set) var buttons: Set<MouseButton> = []

    static let capsLock: UInt16 = 0x39
    /// The modifier each modifier key holds, left and right.
    static let modifierKeys: [UInt16: KeyModifiers] = [0x37: .command, 0x36: .command, 0x38: .shift, 0x3C: .shift,
                                                       0x3A: .option, 0x3D: .option, 0x3B: .control, 0x3E: .control,
                                                       0x3F: .function]

    public init() {}

    public var isEmpty: Bool { keys.isEmpty && buttons.isEmpty }

    /// Records an event that went to B.
    public mutating func note(_ event: InputEvent) {
        switch event {
        case let .key(code, isDown, _) where code != Self.capsLock:
            if isDown { keys.insert(code) } else { keys.remove(code) }
        case let .button(button, isDown):
            if isDown { buttons.insert(button) } else { buttons.remove(button) }
        default:
            break
        }
    }

    /// Releases for everything held, emptying it: buttons, then other keys, then modifiers. Only ever releases.
    public mutating func releaseAll() -> [InputEvent] {
        var events: [InputEvent] = buttons.sorted().map { .button($0, isDown: false) }
        let modifierCodes = keys.filter { Self.modifierKeys[$0] != nil }.sorted()
        var modifiers = KeyModifiers()
        for code in modifierCodes { modifiers.insert(Self.modifierKeys[code] ?? []) }
        for code in keys.subtracting(modifierCodes).sorted() { events.append(.key(code: code, isDown: false, modifiers: modifiers)) }
        for (index, code) in modifierCodes.enumerated() {
            var still = KeyModifiers()
            for other in modifierCodes[(index + 1)...] { still.insert(Self.modifierKeys[other] ?? []) }
            events.append(.key(code: code, isDown: false, modifiers: still))
        }
        keys.removeAll()
        buttons.removeAll()
        return events
    }
}

/// Whether the event that ran one of the Viewer's controls was this Mac's hardware acting on that very control (SR-29),
/// from what AppKit says about the event and the control. A click is a fresh hardware mouse-up inside the control. A key
/// runs a control only while that control holds the keyboard focus (Space on a focused button, Return on the locked-Mac
/// entry): no Viewer control has a key equivalent, so a key-down anywhere else in the window ran nothing, and an AX press
/// or `click button` that lands while the person is typing elsewhere is refused.
public enum ViewerControlActuation {
    public static func refusal(_ event: ScreenInputEvent?, sameWindow: Bool, insideControl: Bool, controlHasFocus: Bool,
                               ownPid: Int64, screenPid: Int64?,
                               requiresTrackedClick: Bool = false, trackedOwnMouseDown: Bool = false, clickCount: Int = 0,
                               calibration: ScreenInputCalibration = .current) -> ScreenInputRefusal? {
        guard let event, sameWindow else {
            return ScreenInputOrigin.humanClick(event, inControl: false, ownPid: ownPid, screenPid: screenPid, calibration: calibration)
        }
        if event.kind == .keyDown {
            return ScreenInputOrigin.humanKey(event, inControl: controlHasFocus, ownPid: ownPid, screenPid: screenPid,
                                              calibration: calibration)
        }
        if requiresTrackedClick && (!trackedOwnMouseDown || clickCount != 1) { return .notTheControl }
        return ScreenInputOrigin.humanClick(event, inControl: insideControl, ownPid: ownPid, screenPid: screenPid,
                                            calibration: calibration)
    }

    /// A focused button's explicit keyboard activation; repeated or modified keys must not repeat a state change.
    public static func buttonKey(_ keyCode: UInt16, repeated: Bool, commandControlOrOption: Bool) -> Bool {
        !repeated && !commandControlOrOption && [UInt16(0x31), 0x24, 0x4c].contains(keyCode)
    }
}

/// The locked-Mac entry's row (DESIGN 6.5 잠긴 B, 11절 가짜 잠금 화면).
public enum ViewerLockedEntry: Equatable, Sendable {
    /// No row: B has not said it is locked, and nothing typed here goes to B.
    case hidden
    /// The field and its 「보내기」.
    case open
    /// B says it is locked but this session cannot type there (view only, this build, B's refusal): the words only.
    case unavailable
    /// B signed that it is not locked while keys go to B: a lock screen in the picture may be drawn by a program.
    case notLockedWarning
}

/// Everything the Viewer's session decides apart from AppKit (DESIGN 5.1, 6.5, 8절, 12절): B's signed notices and
/// what they change in the stored row, this Mac's limit watch and its warning, the person's pause, the address offer,
/// what B holds down, the locked-Mac entry and what failed. `ViewerSession` (Sources/AgentsToZViewer) keeps one, sends
/// what it admits and shows `bandLines`.
public struct ViewerSessionModel: Equatable, Sendable {
    public let path: ScreenTargetPath
    public private(set) var state = ScreenMacState()
    public private(set) var watch: ViewerLimitWatch
    public private(set) var pausedHere = false
    public private(set) var addressOffer = ViewerAddressOffer.none
    public private(set) var held = ViewerHeldInput()
    /// Set once per session, the first time forwarded input was dropped (DESIGN 12절).
    public private(set) var droppedInputTold = false
    /// The five-minute warning as last shown. `tick` reads it again from `watch` each time, so input that moves B's
    /// deadline later takes it down again.
    public private(set) var limitWarningShown = false
    /// B answered this session's locked-Mac entry with `blocked`: B cannot take it (S0-2) until it unlocks and locks again.
    public private(set) var lockedEntryRefused = false
    /// A write to the stored list that failed, in words; cleared by the next one that works.
    public private(set) var storeFailure: String?
    private var lastLockedEntryID: UInt32?
    private var nextTextID: UInt32 = 1
    let calibration: ScreenInputCalibration

    public init(path: ScreenTargetPath, started: ContinuousClock.Instant) {
        self.init(path: path, started: started, calibration: .current)
    }

    init(path: ScreenTargetPath, started: ContinuousClock.Instant, calibration: ScreenInputCalibration) {
        self.path = path
        watch = ViewerLimitWatch(started: started)
        self.calibration = calibration
    }

    /// Whether the person's keyboard and pointer go to B now.
    public var sendsInput: Bool { ViewerInputGate.allows(state, pausedHere: pausedHere, calibration: calibration) }

    /// Input stopped going to B while something is still held there: the caller lets it go (`releaseHeld`).
    public var needsRelease: Bool { !sendsInput && !held.isEmpty }

    public var lockedEntry: ViewerLockedEntry {
        if ViewerInputGate.allowsLockedEntry(state, calibration: calibration), !lockedEntryRefused { return .open }
        if state.locked == true { return .unavailable }
        if state.locked == false, sendsInput { return .notLockedWarning }
        return .hidden
    }

    public var bandLines: [String] {
        var lines = ScreenTargetText.band(state, pausedHere: pausedHere, calibration: calibration)
        if limitWarningShown { lines.insert(ScreenTargetText.limitWarning, at: 0) }
        if droppedInputTold { lines.append(ScreenInputOriginText.droppedInput) }
        if let storeFailure { lines.append(storeFailure) }
        return lines
    }

    /// The address the person may save now, from B's hint.
    public var offeredAddress: ScreenPrivateNetworkRoute? {
        switch addressOffer {
        case .save(let route), .changed(_, let route): route
        case .none: nil
        }
    }

    /// One notice inside B's signed session. Returns the row to store when the notice changed `stored` (only the grant
    /// in `sessionLimits` does; an address is saved by the person alone).
    public mutating func hear(_ notice: ScreenNotice, stored: ViewerTarget) -> ViewerTarget? {
        state.hear(notice)
        watch.hear(notice)
        switch notice {
        case .addressHint(let routes):
            addressOffer = ViewerAddressOffer.offer(saved: stored.privateNetwork, hint: routes, path: path)
        case .textAndReturnResult(let id, .blocked) where id == lastLockedEntryID:
            lockedEntryRefused = true
        case .macUnlocked:
            lockedEntryRefused = false
        default:
            break
        }
        let updated = stored.after(hearing: notice)
        return updated == stored ? nil : updated
    }

    /// Reads the limit warning again at `now`; true when it came up or went down.
    public mutating func tick(at now: ContinuousClock.Instant) -> Bool {
        let warns = watch.warns(at: now)
        defer { limitWarningShown = warns }
        return warns != limitWarningShown
    }

    /// Whether `event`, which this Mac's hardware made, goes to B now. When it does it counts for B's idle limit and for
    /// what B holds down.
    public mutating func admit(_ event: InputEvent, at now: ContinuousClock.Instant) -> Bool {
        guard sendsInput else { return false }
        watch.sentInput(at: now)
        held.note(event)
        return true
    }

    /// Whether a toolbar control message (Mission Control, Spaces) goes to B now.
    public mutating func admitControl(at now: ContinuousClock.Instant) -> Bool {
        guard sendsInput else { return false }
        watch.sentInput(at: now)
        return true
    }

    /// The locked-Mac entry's one `textAndReturn`, emptying `buffer`; nil, leaving it as it was, while the entry is
    /// not open.
    public mutating func takeLockedEntry(_ buffer: inout ViewerSecureBuffer, at now: ContinuousClock.Instant) -> InputEvent? {
        guard lockedEntry == .open, let event = buffer.take(id: nextTextID) else { return nil }
        lastLockedEntryID = nextTextID
        nextTextID = nextTextID == .max ? 1 : nextTextID + 1
        watch.sentInput(at: now)
        return event
    }

    /// Releases for everything held on B, emptying it.
    public mutating func releaseHeld() -> [InputEvent] { held.releaseAll() }

    /// 「입력 일시 정지」 / 「입력 재개」. Pausing sends nothing new; what is held is let go (`needsRelease`).
    public mutating func setPausedHere(_ paused: Bool) { pausedHere = paused }

    /// True the first time forwarded input was dropped in this session.
    public mutating func noteDroppedInput() -> Bool {
        guard !droppedInputTold else { return false }
        droppedInputTold = true
        return true
    }

    /// The offered address was stored: the offer is done.
    public mutating func addressSaved() {
        addressOffer = .none
        storeFailure = nil
    }

    /// A write to the stored list failed; the offer, if any, stays so the person can try again.
    public mutating func storeWriteFailed(_ text: String) { storeFailure = text }
}

// MARK: - Wording

/// Everything the Viewer says about reaching B and about the session (DESIGN 12절), one language as in Screen.
public enum ScreenTargetText {
    public static let unreachable = "B에 닿지 않습니다: B의 AgentsToZ Screen이 켜져 있고 깨어 있는지 확인하세요"
    public static let unreachableInternet = "Cloudflare One이 연결돼 있는지도 확인하세요"
    public static let unanswered = "B가 연결을 받지 않았습니다. 등록 없음·잠시 차단·다른 연결 중·옛 버전 중 하나입니다. B에서 등록과 허용을 확인하세요"
    public static let olderScreen = "B의 AgentsToZ가 옛 버전일 수 있습니다"
    public static let noticeNotAccepted = "B에 등록이 없거나 허용이 꺼져 있거나 알림 연결 전입니다"
    public static let noticeLater = "잠시 뒤 다시 시도하세요(최대 10분)"
    public static let noticeBusy = "B가 다른 연결을 확인 중입니다"
    public static let macTooOld = "B의 AgentsToZ를 업데이트하세요"
    public static let notThisMac = "등록한 B의 신원이 확인되지 않아 연결하지 않았습니다"
    public static let approvalUnusable = "생체 인증이 끝나 연결하지 못했습니다. 다시 연결하세요"
    public static let noRoute = "인터넷 경로로 저장한 주소가 없습니다. 근거리에서 연결해 주소를 저장하세요"
    public static let limitWarning = "5분 뒤 연결이 끝납니다. 계속하려면 끝난 뒤 다시 연결하세요(생체 인증)"
    public static let viewOnlyByBuild = "이 빌드는 보기만 합니다 · 입력 출처 실측(S-M3) 전에는 조작을 열지 않습니다"
    public static let viewOnly = "보기만 됩니다: 권한이 보기이거나, B의 입력 보호 권한이 없거나, B의 알림·원격 차단 연결 확인 전입니다"
    /// B granted control but holds it to watching until its notifications and remote stop reach the owner's phones
    /// (`ScreenInputAvailability.notificationsUnconfirmed`, DESIGN 9절 관문).
    public static let notificationsUnconfirmed = "B의 알림·원격 차단 연결 확인 전이라 보기만 됩니다"
    /// B granted control but B's AgentsToZ Screen does not open control to another Mac yet (S-M3,
    /// `ScreenInputAvailability.controlNotInThisBuild`).
    public static let controlNotInThisBuild = "B의 AgentsToZ Screen이 아직 다른 Mac에 조작을 열지 않아 보기만 됩니다"
    public static let remoteInputPaused = "B 앞에서 사람이 쓰고 있어 입력을 보내지 않습니다"
    public static let inputHeldAtMac = "B에서 직접 조작 중 — B에서 다시 넘겨야 조작할 수 있습니다"
    public static let secureInput = "B에서 보안 입력 중이라 입력을 보내지 않습니다"
    public static let permissionsRequired = "B의 손쉬운 사용·입력 모니터링 권한이 없어 입력을 보내지 않습니다. B 앞에서 권한을 확인하세요"
    public static let monitorUnavailable = "B의 입력 우선 보호가 멈춰 입력을 보내지 않습니다. B 앞에서 권한을 확인하세요"
    public static let inputPausedHere = "입력 일시 정지 중 · 「입력 재개」를 누르면 다시 보냅니다"
    public static let macLocked = "B가 잠겨 있습니다(B가 알림)"
    public static let notLockedWarning = "B가 잠겼다고 알리지 않았습니다. 잠금 화면처럼 보여도 가짜일 수 있으니 암호를 입력하지 마세요"
    public static let lockedEntryUnavailable = "잠긴 B에는 입력할 수 없음"
    /// Pinned in the band until S-M2 shows the session window is left out of other capture tools (SR-23).
    public static let otherCapture = "이 Mac의 다른 화면 기록 앱에 B 화면이 보일 수 있습니다"
    public static let addressSave = "이 주소를 인터넷 경로로 저장할까요?"
    public static let addressChanged = "B의 주소가 바뀌었습니다. Cloudflare의 /32도 함께 바꾸세요"
    public static let removedHere = "이 Mac에서 지웠습니다. B에는 남아 있습니다. B에서도 지우세요"
    public static let unenrolled = "B에 이 Mac의 등록 삭제를 요청했습니다"
    public static let biometryUnavailable = "이 Mac에서 Touch ID를 쓸 수 없습니다"
    public static let biometryChanged = "이 Mac의 지문 등록이 바뀌어 이 키를 쓸 수 없습니다. B 앞에서 다시 등록하세요"
    public static let storeUnreadable = "저장된 Mac 목록을 읽지 못했습니다. 목록을 바꾸지 않았습니다"
    public static let addressSaveFailed = "주소를 저장하지 못했습니다. 저장된 Mac 목록을 바꾸지 않았습니다. 다시 누르세요"
    public static let listUpdateFailed = "저장된 Mac 목록을 갱신하지 못했습니다. 연결은 그대로입니다"
    /// The list's 「연결」 did not finish before this Mac locked, slept or switched users, or the person removed the Mac.
    public static let connectGuardTripped = "연결하는 동안 이 Mac이 잠기거나 잠들어 연결하지 않았습니다. 다시 연결하려면 생체 인증을 하세요"
    public static let guardTripped = "이 Mac이 잠기거나 잠들어 연결을 끝냈습니다. 다시 연결하려면 생체 인증을 하세요"

    public static func connectFailure(_ error: ScreenTargetConnectError, nearbyHint: ScreenNearbyVersionHint = .unknown) -> String {
        switch error {
        case .noRoute: return noRoute
        case .unreachable(let paths):
            return paths.contains(where: { !$0.isNearby }) ? unreachable + " · " + unreachableInternet : unreachable
        case .refused(let path, let refusal):
            switch refusal {
            case .unanswered:
                return path.isNearby && nearbyHint == .older ? unanswered + " · " + olderScreen : unanswered
            case .notice(.notAccepted): return noticeNotAccepted
            case .notice(.rateLimited), .notice(.blocked): return noticeLater
            case .notice(.busy): return noticeBusy
            case .macTooOld: return macTooOld
            case .notThisMac: return notThisMac
            case .approvalUnusable: return approvalUnusable
            case .failed: return unanswered
            }
        }
    }

    /// Why the session ended, as B named it in its signed goodbye; nil when it named none.
    public static func ended(_ reason: SessionEndReason?) -> String {
        switch reason {
        case .busy?: "다른 기기가 B를 보고 있습니다"
        case .takenOver?: "등록된 폰이 B에 연결해 끝났습니다"
        case .captureUnavailable?: "B 앞에서 화면 기록 허용이 필요합니다"
        case .idle?, .timeLimit?: "연결 한도가 끝났습니다. 계속하려면 다시 연결하세요(생체 인증)"
        case .endedAtMac?: "B에서 연결을 끝냈습니다"
        case .turnedOff?, .turnedOffFromDevice?: "B에서 화면 제어가 꺼졌습니다"
        case .revoked?: "B에서 이 Mac의 등록을 지웠습니다. 이 목록에서도 지우려면 「이 Mac에서 삭제」를 누르세요"
        case .replaced?: "이 Mac의 새 연결이 이어받았습니다"
        case nil: "연결이 끝났습니다"
        }
    }

    /// The band outside the picture: what limits input now, most specific first.
    public static func band(_ state: ScreenMacState, pausedHere: Bool, calibration: ScreenInputCalibration = .current) -> [String] {
        var lines: [String] = []
        if state.inputHeldAtMac { lines.append(inputHeldAtMac) }
        if !calibration.allowsControl {
            lines.append(viewOnlyByBuild)
        } else if state.grant != .control || state.inputAvailability == .viewOnly {
            lines.append(viewOnly)
        } else if pausedHere {
            lines.append(inputPausedHere)
        } else if !state.inputHeldAtMac, let reason = inputReason(state) {
            lines.append(reason)
        }
        if state.locked == true { lines.append(macLocked) }
        lines.append(otherCapture)
        return lines
    }

    /// Why B does not take this controller's input now, as B named it; nil while it does.
    static func inputReason(_ state: ScreenMacState) -> String? {
        switch state.inputAvailability {
        case .secureInput?: secureInput
        case .permissionsRequired?: permissionsRequired
        case .monitorUnavailable?: monitorUnavailable
        case .localActivity?: remoteInputPaused
        case .viewOnly?: viewOnly
        case .notificationsUnconfirmed?: notificationsUnconfirmed
        case .controlNotInThisBuild?: controlNotInThisBuild
        case .ready?, nil: state.inputPaused ? remoteInputPaused : nil
        }
    }
}
