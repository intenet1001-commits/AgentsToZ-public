#if os(macOS)
import CoreGraphics
import Foundation
import os
import ScreenControlCore

/// Operations are synchronous and ordered under the receiver's admission lock. An interrupted sequence is uncertain:
/// text may have reached the foreground app even when Return is withheld.
func performPreparedTextAndReturn(postText: () -> Bool, mayPostReturn: () -> Bool,
                                  postReturn: () -> Void) -> ScreenTextReturnResult {
    guard postText(), mayPostReturn() else { return .unknown }
    postReturn()
    return .posted
}

/// Keep each Unicode scalar intact when splitting the UTF-16 accepted by CGEvent.
/// In particular, a supplementary scalar must not be split into separate key events.
func screenTextUTF16Chunks(_ text: String) -> [[UInt16]] {
    let units = Array(text.utf16)
    var chunks: [[UInt16]] = []
    var start = 0
    while start < units.count {
        var end = min(start + 20, units.count)
        if end < units.count, (0xD800...0xDBFF).contains(units[end - 1]),
           (0xDC00...0xDFFF).contains(units[end]) {
            end -= 1
        }
        chunks.append(Array(units[start..<end]))
        start = end
    }
    return chunks
}

/// Posts the phone's input to this Mac as HID events (DESIGN 「입력」). It only ever sees events `InputReceiver`
/// already decoded and admitted. Needs Accessibility permission for AgentsToZ Screen alone.
public final class InputInjector: Sendable {
    private struct State {
        /// The display the phone sees, in global coordinates.
        var bounds: CGRect
        var location: CGPoint
        var held = Set<MouseButton>()
        var lastDown: (button: MouseButton, at: TimeInterval, location: CGPoint, count: Int64)?
        var remoteCapsLock: Bool?
    }

    private let doubleClick: TimeInterval
    private let state: OSAllocatedUnfairLock<State>

    public static var canPostEvents: Bool { CGPreflightPostEventAccess() }
    public static var isAllowed: Bool { canPostEvents && LocalInputMonitor.isAllowed }

    /// Shows the system prompt the first time; afterwards the person enables it in System Settings.
    public static func request() { _ = CGRequestPostEventAccess() }

    public var remoteCapsLock: Bool {
        state.withLockUnchecked { $0.remoteCapsLock } ?? CGEventSource.flagsState(.hidSystemState).contains(.maskAlphaShift)
    }
    public func setRemoteCapsLock(_ enabled: Bool) { state.withLockUnchecked { $0.remoteCapsLock = enabled } }

    /// Legacy diagnostic for compatibility checks. Production arbitration uses LocalInputMonitor's tagged passive
    /// observations; a shared HID clock cannot distinguish simultaneous human and injected events of the same kind.
    public static func secondsSinceHIDEvent(_ kind: LocalInputKind) -> Double? {
        let types: [CGEventType] = switch kind {
        case .pointer: [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        case .button: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        case .scroll: [.scrollWheel]
        // Modifier keys arrive as flagsChanged, not keyDown.
        case .key: [.keyDown, .flagsChanged]
        }
        return types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }
            .filter { $0.isFinite && $0 >= 0 }.min()
    }

    /// `displayID` is the display the phone sees; pointer positions are fractions of it.
    public init(displayID: CGDirectDisplayID) {
        let bounds = CGDisplayBounds(displayID)
        // The person's own double-click speed (System Settings → Mouse).
        doubleClick = UserDefaults.standard.object(forKey: "com.apple.mouse.doubleClickThreshold") as? Double ?? 0.5
        state = OSAllocatedUnfairLock(uncheckedState: State(bounds: bounds, location: CGPoint(x: bounds.midX, y: bounds.midY)))
    }

    /// The phone now sees `displayID` (HostCapture changed display): pointer fractions map onto it, and a click before
    /// the next move lands in its middle rather than on the display before.
    public func setDisplay(_ displayID: CGDirectDisplayID) {
        let bounds = CGDisplayBounds(displayID)
        state.withLockUnchecked { state in
            guard state.bounds != bounds else { return }
            state.bounds = bounds
            state.location = CGPoint(x: bounds.midX, y: bounds.midY)
        }
    }

    /// Reconciles the client arrow only at session start, display selection and local-priority resume.
    public func currentPointerPosition() -> ScreenPointerPosition? {
        guard let point = CGEvent(source: nil)?.location, point.x.isFinite, point.y.isFinite else { return nil }
        return state.withLockUnchecked { state in
            guard state.bounds.width > 1, state.bounds.height > 1, state.held.isEmpty else { return nil }
            let x = min(1, max(0, (point.x - state.bounds.minX) / (state.bounds.width - 1)))
            let y = min(1, max(0, (point.y - state.bounds.minY) / (state.bounds.height - 1)))
            state.location = CGPoint(x: state.bounds.minX + x * (state.bounds.width - 1),
                                     y: state.bounds.minY + y * (state.bounds.height - 1))
            return .init(x: UInt16((x * Double(UInt16.max)).rounded()), y: UInt16((y * Double(UInt16.max)).rounded()))
        }
    }

    public func inject(_ event: InputEvent) {
        let source = CGEventSource(stateID: .hidSystemState)
        switch event {
        case let .pointerMove(x, y):
            let (point, held) = state.withLockUnchecked { state -> (CGPoint, Set<MouseButton>) in
                let bounds = state.bounds
                state.location = CGPoint(x: bounds.minX + x * (bounds.width - 1), y: bounds.minY + y * (bounds.height - 1))
                return (state.location, state.held)
            }
            let type: CGEventType = held.contains(.left) ? .leftMouseDragged
                : held.contains(.right) ? .rightMouseDragged : held.contains(.middle) ? .otherMouseDragged : .mouseMoved
            post(CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: cgButton(held.min() ?? .left)))
        case let .button(button, isDown):
            let (location, count) = state.withLockUnchecked { state -> (CGPoint, Int64) in
                let now = ProcessInfo.processInfo.systemUptime
                var count: Int64 = 1
                if isDown {
                    if let last = state.lastDown, last.button == button, now - last.at <= doubleClick,
                       hypot(last.location.x - state.location.x, last.location.y - state.location.y) <= 4 {
                        count = last.count + 1
                    }
                    state.lastDown = (button, now, state.location, count)
                    state.held.insert(button)
                } else {
                    count = state.lastDown.map { $0.button == button ? $0.count : 1 } ?? 1
                    state.held.remove(button)
                }
                return (state.location, count)
            }
            let type: CGEventType = switch (button, isDown) {
            case (.left, true): .leftMouseDown
            case (.left, false): .leftMouseUp
            case (.right, true): .rightMouseDown
            case (.right, false): .rightMouseUp
            case (.middle, true): .otherMouseDown
            case (.middle, false): .otherMouseUp
            }
            let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: location, mouseButton: cgButton(button))
            event?.setIntegerValueField(.mouseEventClickState, value: count)
            post(event)
        case let .scroll(dx, dy):
            post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                         wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0))
        case let .key(code, isDown, modifiers):
            let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: isDown)
            event?.flags = flags(modifiers)
            post(event)
        case .textAndReturn:
            // Compound requests are handled only by injectTextAndReturn after one admission.
            return
        case let .text(text):
            // Typed as Unicode characters, never pasted: the clipboard stays out of it (SR-17).
            for chunk in screenTextUTF16Chunks(text) {
                for isDown in [true, false] {
                    let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown)
                    event?.flags = []
                    chunk.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
                    post(event)
                }
            }
        }
    }

    /// Preallocate every event, then post text before Return. `posted` is not an application receipt.
    /// A physical input or Secure Event Input observed after text prevents Return and reports uncertainty.
    public func injectTextAndReturn(_ text: String, physicalInput: PhysicalInputProbe) -> ScreenTextReturnResult {
        let before = physicalInput()
        guard before.available, !before.secureInput, !before.held, Self.canPostEvents,
              before.lastEvent.map({ ContinuousClock.now >= $0 + .seconds(3) }) ?? true else { return .blocked }
        let source = CGEventSource(stateID: .hidSystemState)
        var textEvents: [CGEvent] = []
        for chunk in screenTextUTF16Chunks(text) {
            for isDown in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown) else { return .blocked }
                event.flags = []
                chunk.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
                textEvents.append(event)
            }
        }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0x24, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0x24, keyDown: false) else { return .blocked }
        down.flags = []; up.flags = []
        func noTakeover() -> Bool {
            let after = physicalInput()
            return after.available && !after.secureInput && !after.held && Self.canPostEvents
                && after.lastEvent == before.lastEvent
        }
        return performPreparedTextAndReturn(postText: {
            for index in stride(from: 0, to: textEvents.count, by: 2) {
                guard noTakeover() else { return false }
                // Never strand a synthetic key-down if a physical event arrives between the pair.
                post(textEvents[index]); post(textEvents[index + 1])
            }
            return true
        }, mayPostReturn: noTakeover, postReturn: { post(down); post(up) })
    }

    /// Cleanup must not warp the person's cursor back to the remote session's last pointer location.
    public func releaseHeld(_ event: InputEvent) {
        if case .button(_, isDown: false) = event, let current = CGEvent(source: nil)?.location {
            state.withLockUnchecked { $0.location = current }
        }
        inject(event)
    }

    private func post(_ event: CGEvent?) {
        event?.setIntegerValueField(.eventSourceUserData, value: LocalInputMonitor.injectionMarker)
        event?.post(tap: .cghidEventTap)
    }

    private func cgButton(_ button: MouseButton) -> CGMouseButton {
        switch button {
        case .left: .left
        case .right: .right
        case .middle: .center
        }
    }

    private func flags(_ modifiers: KeyModifiers) -> CGEventFlags {
        var flags: CGEventFlags = []
        if modifiers.contains(.shift) { flags.insert(.maskShift) }
        if modifiers.contains(.control) { flags.insert(.maskControl) }
        if modifiers.contains(.option) { flags.insert(.maskAlternate) }
        if modifiers.contains(.command) { flags.insert(.maskCommand) }
        if modifiers.contains(.function) { flags.insert(.maskSecondaryFn) }
        // iOS may consume Caps Lock for its own IME. Capitalization comes from the acknowledged Mac session state,
        // rather than the phone's unrelated alphaShift flag. The physical Mac's lock state is left alone.
        if remoteCapsLock { flags.insert(.maskAlphaShift) }
        return flags
    }
}
#endif
