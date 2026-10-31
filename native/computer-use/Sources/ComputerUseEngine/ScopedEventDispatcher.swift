import AppKit
import Carbon
import ComputerUseControlCore
import CoreGraphics
import Foundation

/// Low-level event generation only. The future scoped service must bind `validate` to freshly collected OS evidence,
/// grant/snapshot state and exact input-target/overlay checks. Nothing here creates or approves a grant.
@MainActor
protocol ScopedEventSink { func post(_ event: CGEvent) }
@MainActor
struct ScopedSessionEventSink: ScopedEventSink {
    private let postEvent: (CGEvent, CGEventTapLocation) -> Void
    init(postEvent: @escaping (CGEvent, CGEventTapLocation) -> Void = { event, location in event.post(tap: location) }) {
        self.postEvent = postEvent
    }
    // This is remote-control input in a login session, not a hardware device. Injecting at the HID
    // entry point can also feed the state that our physical-input guard observes. Keep the private
    // event source and post after that boundary; never subtract or ignore changes in HID evidence.
    func post(_ event: CGEvent) { postEvent(event, .cgSessionEventTap) }
}

/// Diagnostic only. Reads the HID idle age and physical counters — the values the guard compares — immediately before
/// an action's first event, at the start of each guard after an event (the last one is kept) and when a guard refuses.
/// It never changes what is posted, a threshold, the exact counter comparison or an outcome, and it cannot tell whether
/// a change came from a person or from this process's own events: that needs the real-device comparison.
@MainActor
final class ScopedGuardProbe {
    struct Reading { let idleSeconds: Double; let counters: [UInt32]? }
    private let observed: [UInt32]?
    private let read: () -> Reading
    private let clock: () -> TimeInterval
    private var lastPost: TimeInterval?
    private var before: ScopedGuardSample?, after: ScopedGuardSample?, refusal: ScopedGuardSample?
    init(observed: [UInt32]?, read: @escaping () -> Reading, clock: @escaping () -> TimeInterval) {
        self.observed = observed; self.read = read; self.clock = clock
    }
    /// The OS values the guard reads, against the counters of the observation the action consumed.
    static func live(observedEvidence: String) -> ScopedGuardProbe {
        ScopedGuardProbe(observed: ScopedOSGuard.physicalCounters(evidence: observedEvidence),
                         read: { Reading(idleSeconds: ComputerUseEngine.secondsSinceHumanInput(), counters: ScopedOSGuard.physicalCounters()) },
                         clock: { ProcessInfo.processInfo.systemUptime })
    }
    private func sample() -> ScopedGuardSample {
        let reading = read()
        return ScopedGuardSample(idleSeconds: reading.idleSeconds, sincePostSeconds: lastPost.map { clock() - $0 },
                                 counters: reading.counters, observed: observed)
    }
    /// The post time is taken just before the event is handed to the OS, so `sincePostMs` bounds its age from above.
    func willPost() { if lastPost == nil { before = sample() }; lastPost = clock() }
    func guardStarts() { if lastPost != nil { after = sample() } }
    func guardRefused() { if refusal == nil { refusal = sample() } }
    var samples: ScopedGuardSamples? { ScopedGuardSamples(before: before, after: after, refusal: refusal) }
}

/// The engine's own event marker, also read by the control bar to refuse a hand-back the engine itself posted.
public enum ScopedSyntheticEvents { public static let tag: Int64 = 0x41545A53434F5045 }

@MainActor
final class ScopedEventDispatcher {
    let sink: any ScopedEventSink
    /// Called before every event and after the last. Its argument says whether this action already posted an event:
    /// from then on the HID idle age measures the action's own input (1호 2026-10-31: 32 s idle and unchanged counters
    /// before, idle 15 ms at 25 ms after our key event), so a caller checks the person through the counters instead.
    let validate: (_ afterPost: Bool) throws -> Void
    let probe: ScopedGuardProbe?
    private var posted = false
    /// Non-secret marker for diagnostics and future event attribution; it is not authentication and can be forged.
    static let syntheticTag: Int64 = ScopedSyntheticEvents.tag
    private let source: CGEventSource?
    init(sink: any ScopedEventSink, probe: ScopedGuardProbe? = nil, validate: @escaping (_ afterPost: Bool) throws -> Void) {
        self.sink = sink; self.probe = probe; self.validate = validate
        source = CGEventSource(stateID: .privateState)
        source?.userData = Self.syntheticTag
    }

    // The probe only reads at these boundaries; every event and every decision is the same without it.
    convenience init(sink: any ScopedEventSink, probe: ScopedGuardProbe? = nil, validate: @escaping () throws -> Void) {
        self.init(sink: sink, probe: probe, validate: { _ in try validate() })
    }

    private func send(_ event: CGEvent) { probe?.willPost(); posted = true; sink.post(event) }
    private func check() throws {
        probe?.guardStarts()
        do { try validate(posted) } catch { probe?.guardRefused(); throw error }
    }
    private func checkPoint(_ point: CGPoint, _ validatePoint: (CGPoint) throws -> Void) throws {
        do { try validatePoint(point) } catch { probe?.guardRefused(); throw error }
    }

    /// Every synthetic event is unconfirmed: CGEventPost does not report what the target actually did.
    /// `validate` must include human activity, lock/secure input, protected overlay and target identity each time.
    private func pair(_ down: CGEvent?, _ up: CGEvent?) -> MutationResult {
        guard let down, let up else { return .refused("event-unavailable") }
        do { try check() } catch { return .refused("guard-refused") }
        send(down)
        do { try check(); send(up); return .dispatchedUnverified }
        catch { send(up); return .humanTakeover }
    }

    /// Convert window-independent display-relative points to CoreGraphics coordinates, including negative origins.
    static func point(display: CGRect, x: Double, y: Double) -> CGPoint? {
        guard display.origin.x.isFinite, display.origin.y.isFinite, display.width.isFinite, display.height.isFinite,
              display.width > 0, display.height > 0, x.isFinite, y.isFinite,
              x >= 0, y >= 0, x < display.width, y < display.height else { return nil }
        return CGPoint(x: display.origin.x + x, y: display.origin.y + y)
    }

    func click(display: CGRect, x: Double, y: Double, right: Bool, count: Int) -> MutationResult {
        guard let source, let p = Self.point(display: display, x: x, y: y), (1...2).contains(count) else { return .refused("coordinate-unavailable") }
        let button: CGMouseButton = right ? .right : .left
        for n in 1...count {
            let down = CGEvent(mouseEventSource: source, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: p, mouseButton: button)
            let up = CGEvent(mouseEventSource: source, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: p, mouseButton: button)
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(n)); up?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            let outcome = pair(down, up)
            if outcome != .dispatchedUnverified { return n == 1 ? outcome : .unknown }
        }
        return .dispatchedUnverified
    }

    func scroll(display: CGRect, x: Double, y: Double, deltaX: Int32, deltaY: Int32) -> MutationResult {
        guard let source, let p = Self.point(display: display, x: x, y: y), abs(Int64(deltaX)) <= 1200, abs(Int64(deltaY)) <= 1200,
              let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                                  wheel1: deltaY, wheel2: deltaX, wheel3: 0) else { return .refused("event-unavailable") }
        do { try check() } catch { return .refused("guard-refused") }
        event.location = p; send(event)
        do { try check(); return .dispatchedUnverified } catch { return .humanTakeover }
    }

    func typeText(_ text: String) -> MutationResult {
        guard let source, !text.isEmpty, !text.utf8.contains(0), text.utf8.count <= ControlLimits.valueBytes else { return .refused("invalid-request") }
        // Split at Unicode scalar boundaries so no UTF-16 surrogate pair crosses an event.
        var chunks: [[UniChar]] = [], current: [UniChar] = []
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16)
            if current.count + units.count > 20 { chunks.append(current); current = [] }
            current.append(contentsOf: units)
        }
        if !current.isEmpty { chunks.append(current) }
        for (index, units) in chunks.enumerated() {
            let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
            units.withUnsafeBufferPointer { buffer in
                down?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                up?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            let outcome = pair(down, up)
            if outcome != .dispatchedUnverified { return index == 0 ? outcome : .unknown }
        }
        return .dispatchedUnverified
    }

    /// A drag releases its button even if task cancellation, a guard failure or event allocation interrupts it.
    func drag(display: CGRect, x: Double, y: Double, endX: Double, endY: Double,
              validatePoint: (CGPoint) throws -> Void) async -> MutationResult {
        guard let source, let start = Self.point(display: display, x: x, y: y), let end = Self.point(display: display, x: endX, y: endY),
              let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left),
              let release = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: start, mouseButton: .left)
        else { return .refused("coordinate-unavailable") }
        do { try check(); try checkPoint(start, validatePoint) } catch { return .refused("guard-refused") }
        send(down)
        defer { send(release) }
        for step in 1...12 {
            do { try await Task.sleep(nanoseconds: 10_000_000); try check() } catch { return .humanTakeover }
            let fraction = CGFloat(step) / 12
            let point = CGPoint(x: start.x + (end.x - start.x) * fraction, y: start.y + (end.y - start.y) * fraction)
            do { try checkPoint(point, validatePoint) } catch { return .humanTakeover }
            guard let movement = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
                                         mouseCursorPosition: point, mouseButton: .left) else { return .unknown }
            send(movement); release.location = point
        }
        do { try check(); return .dispatchedUnverified } catch { return .humanTakeover }
    }

    /// Explicit modifiers are pressed first and always released in reverse order, including after takeover.
    func key(_ name: String, modifiers: [String]) -> MutationResult {
        guard let source, let code = Self.keyCode(name), modifiers.count <= 4, Set(modifiers).count == modifiers.count else {
            return .refused("invalid-request")
        }
        let keys: [String: (CGKeyCode, CGEventFlags)] = ["cmd": (CGKeyCode(kVK_Command), .maskCommand),
            "ctrl": (CGKeyCode(kVK_Control), .maskControl), "alt": (CGKeyCode(kVK_Option), .maskAlternate),
            "shift": (CGKeyCode(kVK_Shift), .maskShift)]
        var prepared: [(CGEvent, CGEvent)] = [], flags: CGEventFlags = []
        for modifier in modifiers {
            guard let (modifierCode, flag) = keys[modifier],
                  let down = CGEvent(keyboardEventSource: source, virtualKey: modifierCode, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: modifierCode, keyDown: false) else {
                return .refused("event-unavailable")
            }
            flags.insert(flag); down.flags = flags; var released = flags; released.remove(flag); up.flags = released
            prepared.append((down, up))
        }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return .refused("event-unavailable") }
        down.flags = flags; up.flags = flags; prepared.append((down, up))
        var releases: [CGEvent] = []
        defer { for release in releases.reversed() { send(release) } }
        for (press, release) in prepared {
            do { try check() } catch { return releases.isEmpty ? .refused("guard-refused") : .humanTakeover }
            send(press); releases.append(release)
        }
        do { try check(); return .dispatchedUnverified } catch { return .humanTakeover }
    }

    private static func keyCode(_ name: String) -> CGKeyCode? {
        let special: [String: Int] = ["Enter": kVK_Return, "Escape": kVK_Escape, "Tab": kVK_Tab,
            "Space": kVK_Space, "Backspace": kVK_Delete, "Delete": kVK_ForwardDelete,
            "ArrowUp": kVK_UpArrow, "ArrowDown": kVK_DownArrow, "ArrowLeft": kVK_LeftArrow,
            "ArrowRight": kVK_RightArrow, "Home": kVK_Home, "End": kVK_End,
            "PageUp": kVK_PageUp, "PageDown": kVK_PageDown]
        if let code = special[name] { return CGKeyCode(code) }
        let ascii: [String: Int] = ["a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D,
            "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I,
            "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
            "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S,
            "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
            "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2,
            "3": kVK_ANSI_3, "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6,
            "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9]
        guard name.utf8.count == 1, let value = ascii[name.lowercased()] else { return nil }
        return CGKeyCode(value)
    }
}
