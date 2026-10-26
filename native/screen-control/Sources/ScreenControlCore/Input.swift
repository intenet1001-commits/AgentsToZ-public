import Foundation
import os

public enum MouseButton: UInt8, Sendable, Hashable, Comparable {
    case left = 0, right = 1, middle = 2
    public static func < (a: MouseButton, b: MouseButton) -> Bool { a.rawValue < b.rawValue }
}

public struct KeyModifiers: OptionSet, Sendable, Hashable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue = rawValue }
    public static let shift = KeyModifiers(rawValue: 1 << 0)
    public static let control = KeyModifiers(rawValue: 1 << 1)
    public static let option = KeyModifiers(rawValue: 1 << 2)
    public static let command = KeyModifiers(rawValue: 1 << 3)
    public static let function = KeyModifiers(rawValue: 1 << 4)
    static let known: KeyModifiers = [.shift, .control, .option, .command, .function]
}

/// The only things a remote device can ask the Mac to do (SR-7): move, click, scroll, press a key, or type
/// text. There is no "run a command" event, and no clipboard (SR-17).
public enum InputEvent: Equatable, Sendable {
    /// Position as a fraction of the shared display, 0...1 on each axis.
    case pointerMove(x: Double, y: Double)
    case button(MouseButton, isDown: Bool)
    case scroll(dx: Double, dy: Double)
    /// A macOS virtual key code.
    case key(code: UInt16, isDown: Bool, modifiers: KeyModifiers)
    /// Composed text (Korean included), typed as Unicode characters rather than pasted.
    case text(String)
}

public enum InputError: Error, Equatable, Sendable {
    case malformed, outOfRange
}

public enum InputCodec {
    public static let maxScrollDelta = 4000.0
    public static let maxTextBytes = 256
    public static let maxKeyCode: UInt16 = 0x7F

    private enum Tag: UInt8 { case pointerMove = 1, button = 2, scroll = 3, key = 4, text = 5 }

    public static func encode(_ event: InputEvent) -> Data {
        switch event {
        case let .pointerMove(x, y): Data([Tag.pointerMove.rawValue]) + x.bitPattern.bigEndianData + y.bitPattern.bigEndianData
        case let .button(button, isDown): Data([Tag.button.rawValue, button.rawValue, isDown ? 1 : 0])
        case let .scroll(dx, dy): Data([Tag.scroll.rawValue]) + dx.bitPattern.bigEndianData + dy.bitPattern.bigEndianData
        case let .key(code, isDown, modifiers):
            Data([Tag.key.rawValue]) + code.bigEndianData + Data([isDown ? 1 : 0, modifiers.rawValue])
        case let .text(text): Data([Tag.text.rawValue]) + Data(text.utf8)
        }
    }

    /// Strict decoding: exact lengths, booleans exactly 0 or 1, no unknown modifier bits, finite and
    /// bounded numbers, and text without control characters.
    public static func decode(_ data: Data) throws -> InputEvent {
        let bytes = [UInt8](data)
        guard let first = bytes.first, let tag = Tag(rawValue: first) else { throw InputError.malformed }
        let body = Array(bytes.dropFirst())
        func double(_ at: Int) -> Double {
            Double(bitPattern: body[at..<at + 8].reduce(UInt64(0)) { $0 << 8 | UInt64($1) })
        }
        func flag(_ byte: UInt8) throws -> Bool {
            guard byte <= 1 else { throw InputError.malformed }
            return byte == 1
        }
        switch tag {
        case .pointerMove:
            guard body.count == 16 else { throw InputError.malformed }
            let x = double(0), y = double(8)
            guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y) else { throw InputError.outOfRange }
            return .pointerMove(x: x, y: y)
        case .button:
            guard body.count == 2, let button = MouseButton(rawValue: body[0]) else { throw InputError.malformed }
            return .button(button, isDown: try flag(body[1]))
        case .scroll:
            guard body.count == 16 else { throw InputError.malformed }
            let dx = double(0), dy = double(8)
            guard dx.isFinite, dy.isFinite, abs(dx) <= maxScrollDelta, abs(dy) <= maxScrollDelta else {
                throw InputError.outOfRange
            }
            return .scroll(dx: dx, dy: dy)
        case .key:
            guard body.count == 4 else { throw InputError.malformed }
            let code = UInt16(body[0]) << 8 | UInt16(body[1])
            let modifiers = KeyModifiers(rawValue: body[3])
            guard code <= maxKeyCode else { throw InputError.outOfRange }
            guard KeyModifiers.known.isSuperset(of: modifiers) else { throw InputError.malformed }
            return .key(code: code, isDown: try flag(body[2]), modifiers: modifiers)
        case .text:
            guard let text = String(bytes: body, encoding: .utf8), isPlainText(text, maxBytes: maxTextBytes) else {
                throw InputError.malformed
            }
            return .text(text)
        }
    }
}

/// The Mac's one entry point for remote input: whether to inject an event now, and what to release when the session
/// ends (SR-7, SR-16). Releasing something still held always passes, so the rate limit can never leave Command or a
/// drag pressed; every other event spends the token bucket. Only admitted events change what counts as held.
public struct InputGate: Sendable {
    private var limiter: TokenBucket
    private var held = HeldInputTracker()

    public init(perSecond: Double = 240, burst: Double = 480) {
        limiter = TokenBucket(perSecond: perSecond, burst: burst)
    }

    public mutating func admit(_ event: InputEvent, at now: ContinuousClock.Instant) -> Bool {
        guard held.isRelease(event) || limiter.admit(at: now) else { return false }
        held.record(event)
        return true
    }

    /// Release events for everything still held, to inject when the session ends.
    public mutating func releaseAll() -> [InputEvent] { held.releaseAll() }
}

/// The Mac's input path for one session: strict decoding, then the gate, then `inject`. A malformed record ends the
/// session (the caller closes it on the error); an event over the rate limit is dropped, and so is everything while
/// someone at the Mac is using it (`checkLocalInput`). `finish` releases whatever is still held and refuses all later
/// input; it must run when the session ends, however it ends (SR-16).
///
/// Every injection happens under one lock, so a release can never be overtaken by a press admitted just before it.
public final class InputReceiver: Sendable {
    private struct State {
        var gate = InputGate()
        var priority: LocalPriority
        var finished = false

        /// Lets go of everything held, as injected events.
        mutating func release(_ inject: (InputEvent) -> Void, at now: ContinuousClock.Instant) {
            for event in gate.releaseAll() {
                inject(event)
                priority.noteInjected(event.localKind, at: now)
            }
        }
    }

    public let localPriority: LocalPriority.Policy
    private let state: OSAllocatedUnfairLock<State>
    private let inject: @Sendable (InputEvent) -> Void

    public init(localPriority: LocalPriority.Policy = .init(), inject: @escaping @Sendable (InputEvent) -> Void) {
        self.localPriority = localPriority
        state = OSAllocatedUnfairLock(initialState: State(priority: LocalPriority(policy: localPriority)))
        self.inject = inject
    }

    /// Whether remote input is paused because someone at the Mac is using it.
    public var isPaused: Bool { state.withLock { $0.priority.isPaused } }

    public func receive(_ payload: Data, at now: ContinuousClock.Instant = .now) throws {
        let event = try InputCodec.decode(payload)
        state.withLock { [inject] state in
            guard !state.finished, !state.priority.isPaused, state.gate.admit(event, at: now) else { return }
            inject(event)
            state.priority.noteInjected(event.localKind, at: now)
        }
    }

    /// Reads the Mac's own input through `probe`. Pausing lets go of everything the phone holds, so the person at the
    /// Mac never fights a held Command key or a drag. Returns the change to tell the phone, if any.
    public func checkLocalInput(_ probe: LocalInputProbe, at now: ContinuousClock.Instant) -> LocalPriority.Change? {
        state.withLock { [inject] state in
            guard !state.finished else { return nil }
            let change = state.priority.update(probe, at: now)
            if change == .paused { state.release(inject, at: now) }
            return change
        }
    }

    public func finish(at now: ContinuousClock.Instant = .now) {
        state.withLock { [inject] state in
            state.finished = true
            state.release(inject, at: now)
        }
    }
}

/// Token bucket over a monotonic clock, for remote input and for connection attempts.
struct TokenBucket: Sendable {
    let perSecond: Double
    let burst: Double
    private var tokens: Double
    private var last: ContinuousClock.Instant?

    init(perSecond: Double = 240, burst: Double = 480) {
        self.perSecond = perSecond
        self.burst = burst
        tokens = burst
    }

    mutating func admit(at now: ContinuousClock.Instant) -> Bool {
        if let last { tokens = min(burst, tokens + max(0, seconds(now - last)) * perSecond) }
        last = now
        guard tokens >= 1 else { return false }
        tokens -= 1
        return true
    }

    /// Whether the bucket has refilled completely, so forgetting it loses nothing.
    func isFull(at now: ContinuousClock.Instant) -> Bool {
        guard let last else { return true }
        return tokens + max(0, seconds(now - last)) * perSecond >= burst
    }
}

func seconds(_ duration: Duration) -> Double {
    Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
}

/// What is held down right now, so ending a session releases it (SR-16). An unattended Mac must never be
/// left with Command or a drag still pressed.
struct HeldInputTracker: Sendable {
    private(set) var keys = Set<UInt16>()
    private(set) var buttons = Set<MouseButton>()

    /// Whether `event` lets go of something held now.
    func isRelease(_ event: InputEvent) -> Bool {
        switch event {
        case let .key(code, isDown, _): !isDown && keys.contains(code)
        case let .button(button, isDown): !isDown && buttons.contains(button)
        case .pointerMove, .scroll, .text: false
        }
    }

    mutating func record(_ event: InputEvent) {
        switch event {
        case let .key(code, isDown, _): if isDown { keys.insert(code) } else { keys.remove(code) }
        case let .button(button, isDown): if isDown { buttons.insert(button) } else { buttons.remove(button) }
        case .pointerMove, .scroll, .text: break
        }
    }

    /// Release events for everything still held, buttons first, then clears the record.
    mutating func releaseAll() -> [InputEvent] {
        let events = buttons.sorted().map { InputEvent.button($0, isDown: false) }
            + keys.sorted().map { InputEvent.key(code: $0, isDown: false, modifiers: []) }
        keys.removeAll()
        buttons.removeAll()
        return events
    }
}
