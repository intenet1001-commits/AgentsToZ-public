import Foundation

// What happens during a session (DESIGN 「3) 세션 동안」): how long it may last, why the Mac ended it, and local input
// winning over remote input. The Mac enforces all of it on its own monotonic clock, never the phone's. Ending is final:
// the next session is a new key exchange and a new Face ID on the phone.

/// Why the Mac ended a session: the one-byte payload of its `.close` record. The record is sealed like any other, so
/// only the Mac the phone pinned can name a reason. The phone's own goodbye carries no payload.
public enum SessionEndReason: UInt8, Sendable, CaseIterable {
    /// No input from the phone for `SessionLimits.idle`.
    case idle = 1
    /// The session reached `SessionLimits.maximum`.
    case timeLimit = 2
    /// The person at the Mac disconnected this device, or the Mac stopped listening on that network (it left the
    /// approved network, or the network was removed from the approved list).
    case endedAtMac = 3
    /// Screen control was turned off at the Mac: by hand, or because the app quit.
    case turnedOff = 4
    /// This device's registration was revoked at the Mac.
    case revoked = 5
    /// The same device connected again, and the new connection took over.
    case replaced = 6
    /// Version 2: the phone of this session turned screen control off (`ControlMessage.turnOff`), as the menu's 끄기
    /// does. A version-1 session never carries it; its phone would hear `turnedOff`.
    case turnedOffFromDevice = 7

    public var encoded: Data { Data([rawValue]) }

    /// The first session version that names this reason.
    public var minimumVersion: UInt16 { self == .turnedOffFromDevice ? 2 : 1 }

    /// The `.close` payload for a session of `version`: the nearest reason that version knows, so an older phone never
    /// reads a reason it would not recognise.
    public func closePayload(version: UInt16) -> Data {
        minimumVersion <= version ? encoded : SessionEndReason.turnedOff.encoded
    }

    /// The reason a `.close` payload names: nil for the phone's empty goodbye, and for anything this version does not
    /// know, which still ends the session.
    public init?(closePayload: Data) {
        guard closePayload.count == 1, let reason = SessionEndReason(rawValue: closePayload[closePayload.startIndex]) else { return nil }
        self = reason
    }
}

/// 결정 3: a session ends after ten minutes without input from the phone and after sixty minutes in all.
public struct SessionLimits: Sendable, Equatable {
    public static let standard = SessionLimits(idle: .seconds(10 * 60), maximum: .seconds(60 * 60))

    public var idle: Duration
    public var maximum: Duration

    public init(idle: Duration, maximum: Duration) {
        self.idle = idle
        self.maximum = maximum
    }
}

/// Both limits as one deadline. Only input from the phone keeps a session alive: the Mac's video and the phone's
/// keyframe requests flow without anyone there.
public struct SessionTimer: Sendable {
    public let limits: SessionLimits
    public let started: ContinuousClock.Instant
    public private(set) var lastInput: ContinuousClock.Instant

    public init(limits: SessionLimits, started: ContinuousClock.Instant) {
        self.limits = limits
        self.started = started
        lastInput = started
    }

    public mutating func noteInput(at now: ContinuousClock.Instant) { lastInput = max(lastInput, now) }

    /// When the next limit runs out, and which one.
    public var deadline: (at: ContinuousClock.Instant, reason: SessionEndReason) {
        let idle = lastInput + limits.idle, maximum = started + limits.maximum
        return maximum <= idle ? (maximum, .timeLimit) : (idle, .idle)
    }

    public func expired(at now: ContinuousClock.Instant) -> SessionEndReason? {
        let next = deadline
        return now >= next.at ? next.reason : nil
    }
}

/// The time a session runs on: the continuous clock, or one a check moves by hand.
public struct SessionClock: Sendable {
    public let now: @Sendable () -> ContinuousClock.Instant
    /// Returns at `deadline` or throws when the task is cancelled.
    public let sleep: @Sendable (_ deadline: ContinuousClock.Instant) async throws -> Void

    public init(now: @escaping @Sendable () -> ContinuousClock.Instant,
                sleep: @escaping @Sendable (_ deadline: ContinuousClock.Instant) async throws -> Void) {
        self.now = now
        self.sleep = sleep
    }

    public static let continuous = SessionClock(now: { .now }, sleep: { try await Task.sleep(until: $0, clock: .continuous) })
}

// MARK: - Local input wins

/// Kinds of input the Mac watches for at its own mouse and keyboard, and that injecting a remote event resembles.
public enum LocalInputKind: CaseIterable, Sendable {
    case pointer, button, scroll, key
}

extension InputEvent {
    /// What injecting this event looks like to the HID system.
    var localKind: LocalInputKind {
        switch self {
        case .pointerMove: .pointer
        case .button: .button
        case .scroll: .scroll
        case .key, .text: .key
        }
    }
}

/// Seconds since the system last saw an input event of a kind, from any source; nil when it cannot tell. The Mac reads
/// CGEventSource's HID system state (ScreenHost/InputInjector.swift); checks pass a stand-in.
public typealias LocalInputProbe = @Sendable (LocalInputKind) -> Double?

/// Local input wins (DESIGN 「3) 세션 동안」): when the person at the Mac uses its own mouse or keyboard, remote input
/// pauses until they have been still for `window`, and the phone is told both ways.
///
/// The system's clock of recent input may include the events this session injected, or may not; nothing documents
/// which. So an event counts as local only when it lies more than `tolerance` away from every event of the same kind
/// the session injected recently. That never takes the session's own input for local input, either way. The price:
/// while the phone streams one kind without pause (dragging, say), local input of that same kind shows only after a
/// pause longer than `tolerance`; a local click or key during a remote drag shows at once.
public struct LocalPriority: Sendable {
    public struct Policy: Sendable, Equatable {
        /// How long remote input stays paused after the last local event.
        public var window: Duration = .seconds(3)
        /// How far an observed event may lie from an injected one and still be taken for it.
        public var tolerance: Duration = .milliseconds(250)
        /// How often the Mac reads the system's clock of recent input.
        public var pollInterval: Duration = .milliseconds(250)

        public init() {}
    }

    public enum Change: Equatable, Sendable { case paused, resumed }

    /// Injected events remembered per kind; at the input rate limit a window holds fewer than this.
    static let maxRemembered = 1024

    public let policy: Policy
    public private(set) var isPaused = false
    private var injected: [LocalInputKind: [ContinuousClock.Instant]] = [:]
    private var lastLocal: ContinuousClock.Instant?

    public init(policy: Policy = Policy()) { self.policy = policy }

    /// Records that the session injected an event of `kind` at `now`.
    public mutating func noteInjected(_ kind: LocalInputKind, at now: ContinuousClock.Instant) {
        var times = injected[kind, default: []]
        times.append(now)
        // Nothing older can explain an event that still matters.
        let horizon = now - policy.window - policy.tolerance
        if let keep = times.firstIndex(where: { $0 >= horizon }) { times.removeFirst(keep) } else { times.removeAll() }
        if times.count > Self.maxRemembered { times.removeFirst(times.count - Self.maxRemembered) }
        injected[kind] = times
    }

    /// Reads the probe at `now` and returns the change to tell the phone, if any.
    public mutating func update(_ probe: LocalInputProbe, at now: ContinuousClock.Instant) -> Change? {
        let window = seconds(policy.window)
        for kind in LocalInputKind.allCases {
            guard let ago = probe(kind), ago.isFinite, ago >= 0, ago < window else { continue }
            let seen = now - .seconds(ago)
            guard !isInjected(kind, near: seen) else { continue }
            if lastLocal.map({ seen > $0 }) ?? true { lastLocal = seen }
        }
        let pause = lastLocal.map { now < $0 + policy.window } ?? false
        defer { isPaused = pause }
        switch (isPaused, pause) {
        case (false, true): return .paused
        case (true, false): return .resumed
        default: return nil
        }
    }

    private func isInjected(_ kind: LocalInputKind, near seen: ContinuousClock.Instant) -> Bool {
        injected[kind]?.contains { seen - $0 <= policy.tolerance && $0 - seen <= policy.tolerance } ?? false
    }
}
