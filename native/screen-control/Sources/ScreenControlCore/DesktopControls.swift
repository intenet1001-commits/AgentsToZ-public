import Foundation

/// Version 3 exposes only bounded keyboard state, never input-source identifiers or application names.
public enum ScreenInputLanguage: UInt8, Sendable, CaseIterable { case other = 0, latin, korean }
public enum ScreenKeyboardAction: UInt8, Sendable, CaseIterable { case latin = 1, korean, capsOff, capsOn }
public enum ScreenControlResult: UInt8, Sendable { case observed = 0, applied, unavailable, blocked }

public struct ScreenKeyboardState: Equatable, Sendable {
    public let language: ScreenInputLanguage
    /// Capitalization of remote key events. It does not change the Mac's physical keyboard LED.
    public let capsLock: Bool
    public let canSelectLatin: Bool
    public let canSelectKorean: Bool

    public init(language: ScreenInputLanguage, capsLock: Bool, canSelectLatin: Bool, canSelectKorean: Bool) {
        self.language = language; self.capsLock = capsLock
        self.canSelectLatin = canSelectLatin; self.canSelectKorean = canSelectKorean
    }
    var encoded: Data {
        Data([language.rawValue, (capsLock ? 1 : 0) | (canSelectLatin ? 2 : 0) | (canSelectKorean ? 4 : 0)])
    }
    init(bytes: ArraySlice<UInt8>) throws {
        let b = Array(bytes)
        guard b.count == 2, let language = ScreenInputLanguage(rawValue: b[0]), b[1] & ~7 == 0 else {
            throw ScreenControlWireError.malformed
        }
        self.init(language: language, capsLock: b[1] & 1 != 0, canSelectLatin: b[1] & 2 != 0, canSelectKorean: b[1] & 4 != 0)
    }
}

/// These use the person's configured macOS shortcuts; a sent shortcut is not proof that a Space changed.
public enum ScreenSpaceAction: UInt8, Sendable, CaseIterable {
    case previous = 1, next, missionControl

    /// macOS marks the arrow keys as function keys in its Mission Control shortcut definitions.
    public var shortcut: (code: UInt16, modifiers: KeyModifiers) {
        let code: UInt16 = switch self { case .previous: 0x7B; case .next: 0x7C; case .missionControl: 0x7E }
        return (code, [.control, .function])
    }
}

public enum ScreenVideoQuality: UInt8, Sendable, CaseIterable {
    case saver = 1, balanced, sharp
    public var maximumWidth: Int { switch self { case .saver: 1280; case .balanced: 1600; case .sharp: 1920 } }
    public var framesPerSecond: Int { switch self { case .saver: 15; case .balanced: 20; case .sharp: 30 } }
    public var bitRate: Int { switch self { case .saver: 1_000_000; case .balanced: 2_000_000; case .sharp: 4_000_000 } }
}

/// Tap Caps Lock to switch Korean/Latin; hold to change remote capitalization. Duplicate downs do not toggle twice.
/// The next ordinary key resolves a held Caps first, so it can be queued behind the keyboard-state acknowledgement.
/// Cancellation never switches the Mac's language. Times are monotonic seconds supplied by the UI, not wire data.
public struct ScreenCapsLockPress: Sendable {
    private var began: Double?
    public init() {}
    public mutating func down(at time: Double) { if began == nil { began = time } }
    public mutating func cancel() { began = nil }
    public mutating func resolve(at time: Double, state: ScreenKeyboardState) -> ScreenKeyboardAction? {
        guard let began else { return nil }
        self.began = nil
        if time - began >= 0.65 { return state.capsLock ? .capsOff : .capsOn }
        if state.language == .korean { return state.canSelectLatin ? .latin : nil }
        return state.canSelectKorean ? .korean : nil
    }
}

/// Route choice happens before native authentication. A failed authentication never falls back to another route.
public enum ScreenConnectionRoute: String, Sendable, CaseIterable { case automatic, nearby, internet, privateNetwork }

public struct ScreenRelayRetry: Sendable {
    private var failures = 0
    public init() {}
    public mutating func reset() { failures = 0 }
    public mutating func delay(randomUnit: Double) -> Duration {
        failures = min(7, failures + 1)
        let base = min(30, pow(2, Double(failures - 1)))
        let jitter = 0.8 + min(1, max(0, randomUnit)) * 0.4
        return .milliseconds(Int(min(30, base * jitter) * 1000))
    }
}

/// Bounded first-character fence. While a keyboard change is in flight, input waits for that exact reply.
/// Failed/unknown replies never replay uncertain keystrokes. The UI ends the session on overflow or timeout.
public struct ScreenKeyboardInputFence: Sendable {
    public static let maximumEvents = 64
    public private(set) var pending: UInt32?
    private var sequence: UInt32 = 0
    private var events: [InputEvent] = []
    public init() {}
    public mutating func begin() -> UInt32? {
        guard pending == nil, sequence < UInt32.max else { return nil }
        sequence += 1; pending = sequence
        return sequence
    }
    /// nil is overflow; an empty array is waiting; otherwise these events can be sent now.
    public mutating func submit(_ event: InputEvent) -> [InputEvent]? {
        guard pending != nil else { return [event] }
        // A source change can take a second. Keep only the newest consecutive pointer position,
        // without dropping a button/key boundary or replaying a trail of stale pointer movements.
        if case .pointerMove = event, let last = events.last, case .pointerMove = last {
            events[events.count - 1] = event
            return []
        }
        guard events.count < Self.maximumEvents else { return nil }
        events.append(event)
        return []
    }
    public mutating func reply(id: UInt32, result: ScreenControlResult) -> [InputEvent] {
        guard id != 0, id == pending else { return [] }
        defer { pending = nil; events.removeAll(keepingCapacity: false) }
        return result == .applied ? events : []
    }
    public mutating func cancel() { pending = nil; events.removeAll(keepingCapacity: false) }
}

/// A bounded pointer location on the shared display, quantized to 16 bits per axis. No global desktop coordinates.
public struct ScreenPointerPosition: Equatable, Sendable {
    public let x: UInt16
    public let y: UInt16
    public init(x: UInt16, y: UInt16) { self.x = x; self.y = y }
    public var unitX: Double { Double(x) / Double(UInt16.max) }
    public var unitY: Double { Double(y) / Double(UInt16.max) }
}
