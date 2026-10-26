#if os(macOS)
import CoreGraphics
import Foundation
import os
import ScreenControlCore

/// Posts the phone's input to this Mac as HID events (DESIGN 「입력」). It only ever sees events `InputReceiver`
/// already decoded and admitted. Needs Accessibility permission for AgentsToZ Screen alone.
public final class InputInjector: Sendable {
    private struct State {
        /// The display the phone sees, in global coordinates.
        var bounds: CGRect
        var location: CGPoint
        var held = Set<MouseButton>()
        var lastDown: (button: MouseButton, at: TimeInterval, location: CGPoint, count: Int64)?
    }

    private let doubleClick: TimeInterval
    private let state: OSAllocatedUnfairLock<State>

    public static var isAllowed: Bool { CGPreflightPostEventAccess() }

    /// Shows the system prompt the first time; afterwards the person enables it in System Settings.
    public static func request() { _ = CGRequestPostEventAccess() }

    /// Seconds since the HID system last saw an input event of `kind`, from the Mac's own mouse and keyboard or, as far
    /// as anyone documents, from this injector: `LocalPriority` tells the two apart by when it injected (DESIGN
    /// 「로컬 입력이 이긴다」). Reads a timestamp only; no event content, and no Input Monitoring permission.
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
        case let .text(text):
            // Typed as Unicode characters, never pasted: the clipboard stays out of it (SR-17).
            let units = Array(text.utf16)
            for start in stride(from: 0, to: units.count, by: 20) {
                let chunk = Array(units[start..<min(start + 20, units.count)])
                for isDown in [true, false] {
                    let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: isDown)
                    event?.flags = []
                    chunk.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
                    post(event)
                }
            }
        }
    }

    private func post(_ event: CGEvent?) { event?.post(tap: .cghidEventTap) }

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
        return flags
    }
}
#endif
