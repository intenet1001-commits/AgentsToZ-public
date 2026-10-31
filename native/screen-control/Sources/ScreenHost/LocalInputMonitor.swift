#if os(macOS)
import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import os
import ScreenControlCore

struct LocalInputLedger: Sendable {
    var available = true
    var lastEvent: ContinuousClock.Instant?
    var keys = Set<Int64>()
    var buttons = Set<Int64>()
    var wasSecureInput = false

    mutating func secureInputChanged(_ secure: Bool, at now: ContinuousClock.Instant) {
        // The tap may miss key releases during Secure Event Input. A new session is required after such a gap;
        // guessing which held keys belong to the person could resume a drag or modifier over their input.
        if wasSecureInput && !secure { available = false }
        wasSecureInput = secure
        if secure { lastEvent = now }
    }

    mutating func record(_ type: CGEventType, code: Int64 = 0, button: Int64 = 0, flags: UInt64 = 0,
                         marker: Int64 = 0, at now: ContinuousClock.Instant) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { available = false; return }
        guard marker != LocalInputMonitor.injectionMarker else { return }
        lastEvent = now
        switch type {
        case .keyDown:
            guard (0...Int64(UInt16.max)).contains(code) else { available = false; return }
            keys.insert(code)
        case .keyUp: keys.remove(code)
        case .flagsChanged:
            let modifiers: [(CGEventFlags, Set<Int64>)] = [(.maskShift, [56,60]), (.maskControl, [59,62]),
                (.maskAlternate, [58,61]), (.maskCommand, [54,55]), (.maskSecondaryFn, [63])]
            for (flag, codes) in modifiers where codes.contains(code) {
                if flags & flag.rawValue != 0 { keys.insert(code) } else { keys.subtract(codes) }
            }
        case .leftMouseDown: buttons.insert(0)
        case .leftMouseUp: buttons.remove(0)
        case .rightMouseDown: buttons.insert(1)
        case .rightMouseUp: buttons.remove(1)
        case .otherMouseDown:
            guard (0...31).contains(button) else { available = false; return }
            buttons.insert(button)
        case .otherMouseUp: buttons.remove(button)
        default: break
        }
    }
}

private final class LocalInputContext: Sendable {
    let state = OSAllocatedUnfairLock(initialState: LocalInputLedger())
    func record(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            state.withLock { $0.available = false }; return
        }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let button = event.getIntegerValueField(.mouseEventButtonNumber)
        let flags = event.flags.rawValue
        let marker = event.getIntegerValueField(.eventSourceUserData)
        let now = ContinuousClock.now
        state.withLock { $0.record(type, code: code, button: button, flags: flags, marker: marker, at: now) }
    }
}

/// Keep the callback context alive until invalidation runs on the tap's own run loop. No raw `self` pointer outlives
/// the monitor if the last streaming task releases it on a different executor.
private final class LocalInputCleanup: @unchecked Sendable {
    let context: LocalInputContext
    let tap: CFMachPort
    let source: CFRunLoopSource
    init(context: LocalInputContext, tap: CFMachPort, source: CFRunLoopSource) {
        self.context = context; self.tap = tap; self.source = source
    }
    @MainActor func invalidate() {
        withExtendedLifetime(context) {
            CFMachPortInvalidate(tap)
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
    }
}

/// A session-scoped passive listener. Only activity time and held key/button codes are retained in memory;
/// characters, pointer positions and event payloads are never exposed or saved. The tap never modifies an event.
public final class LocalInputMonitor: @unchecked Sendable {
    /// Every event emitted by this helper carries one process-local marker. This is origin bookkeeping, not a grant.
    static let injectionMarker = Int64.random(in: 1...Int64.max)
    private let context = LocalInputContext()
    // Installed once on the main run loop; teardown retains its separate callback context through invalidation.
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    public static var isAllowed: Bool { CGPreflightListenEventAccess() }
    public static func request() { _ = CGRequestListenEventAccess() }

    @MainActor public init?() {
        guard Self.isAllowed else { return nil }
        let types: [CGEventType] = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
            .scrollWheel, .keyDown, .keyUp, .flagsChanged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, context in
                    guard let context else { return Unmanaged.passUnretained(event) }
                    Unmanaged<LocalInputContext>.fromOpaque(context).takeUnretainedValue().record(type, event)
                    return Unmanaged.passUnretained(event)
                }, userInfo: Unmanaged.passUnretained(context).toOpaque()) else { return nil }
        guard let loopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
            CFMachPortInvalidate(port); return nil
        }
        tap = port; source = loopSource
        // Before this session injects anything, held system input belongs to the person at the Mac.
        context.state.withLock { s in
            // A fresh observer has no history before installation. Start with a short quiet window rather than
            // assuming the person at the Mac was idle just before the tap became available.
            s.lastEvent = .now
            for code in 0...127 where CGEventSource.keyState(.hidSystemState, key: CGKeyCode(code)) { s.keys.insert(Int64(code)) }
            let pressed = NSEvent.pressedMouseButtons
            for button in 0..<32 where pressed & (1 << button) != 0 {
                s.buttons.insert(Int64(button))
            }
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), loopSource, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
    }

    deinit {
        if let tap, let source {
            let cleanup = LocalInputCleanup(context: context, tap: tap, source: source)
            DispatchQueue.main.async { cleanup.invalidate() }
        }
    }

    public var isRunning: Bool {
        let enabled = tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false
        return context.state.withLock { $0.available && enabled } && Self.isAllowed && CGPreflightPostEventAccess()
    }

    public func snapshot() -> PhysicalInputSnapshot {
        let enabled = tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false
        let permitted = Self.isAllowed && CGPreflightPostEventAccess()
        let secure = IsSecureEventInputEnabled()
        let now = ContinuousClock.now
        return context.state.withLock { s in
            s.secureInputChanged(secure, at: now)
            return .init(available: s.available && enabled && permitted, lastEvent: s.lastEvent,
                         held: !s.keys.isEmpty || !s.buttons.isEmpty, secureInput: secure)
        }
    }
}
#endif
