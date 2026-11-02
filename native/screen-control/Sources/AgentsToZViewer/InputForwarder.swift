#if os(macOS)
import AppKit
import ScreenControlCore

// The session window's keyboard and pointer, for B (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.1, SR-26). A local
// monitor sees raw key codes, modifier changes, the pointer and the wheel while the session window is key; nothing calls
// `interpretKeyEvents`, so B's own input method composes Korean. Every event passes `HumanActions.forwardProof` first:
// only this Mac's hardware goes to B, never this process's own events, AgentsToZ Screen's injected input, a remote
// desktop or any other program. ⌃⌥⌘, ends the session and ⌃⌥⌘. stays here; neither goes to B.
//
// Nothing stays pressed on B: a button held there is let go at the picture's edge when the person releases it over the
// band, the bars or outside the window, a drag follows along that edge, and when the window loses the keyboard focus
// (⌘Tab here, another window) every key and button B holds is let go (`ViewerSession.releaseHeld`). The session's own
// gate does the same when it closes.

@MainActor
final class InputForwarder {
    private weak var window: NSWindow?
    private weak var video: VideoView?
    private let session: ViewerSession
    private var monitor: Any?
    private var resignObserver: NSObjectProtocol?
    /// The keyboard focus is on the locked-Mac entry: its keys are its own (SecureEntryView), never B's input.
    var entryHasFocus: () -> Bool = { false }

    init(window: NSWindow, video: VideoView, session: ViewerSession) {
        self.window = window
        self.video = video
        self.session = session
    }

    func start() {
        guard monitor == nil else { return }
        let mask: NSEvent.EventTypeMask = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown,
                                           .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged,
                                           .rightMouseDragged, .otherMouseDragged, .scrollWheel]
        monitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            // AppKit calls local monitors on the main thread.
            nonisolated(unsafe) let event = event
            let consumed = MainActor.assumeIsolated { self?.consumes(event) ?? false }
            return consumed ? nil : event
        }
        resignObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: window,
                                                                queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.session.releaseHeld() }
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
        resignObserver = nil
    }

    /// True consumes the event here; otherwise it goes on to the Viewer's own controls.
    private func consumes(_ event: NSEvent) -> Bool {
        guard let window, event.window === window, window.isKeyWindow, !session.isOver else { return false }
        switch event.type {
        case .keyDown, .keyUp:
            if entryHasFocus() { return false }
            let modifiers = Self.modifiers(event.modifierFlags)
            switch ViewerKeyRoute.route(keyCode: event.keyCode, isDown: event.type == .keyDown, modifiers: modifiers) {
            case .endSession:
                session.end(.here)
                return true
            case .swallow:
                return true
            case .forward:
                deliver(event, .key(code: event.keyCode, isDown: event.type == .keyDown, modifiers: modifiers))
                return true
            }
        case .flagsChanged:
            if entryHasFocus() { return false }
            guard let flag = Self.modifierFlag(forKeyCode: event.keyCode) else { return true }
            deliver(event, .key(code: event.keyCode, isDown: event.modifierFlags.contains(flag),
                                modifiers: Self.modifiers(event.modifierFlags)))
            return true
        case .scrollWheel:
            guard pointer(for: event) != nil else { return false }
            let limit = InputCodec.maxScrollDelta
            deliver(event, .scroll(dx: min(max(Double(event.scrollingDeltaX), -limit), limit),
                                   dy: min(max(Double(event.scrollingDeltaY), -limit), limit)))
            return true
        default:
            let button = Self.button(event)
            if let point = pointer(for: event) {
                deliver(event, .pointerMove(x: point.x, y: point.y))
                if let button { deliver(event, .button(button.0, isDown: button.1)) }
                return true
            }
            // Outside the picture: only what B holds down still goes, at the picture's nearest edge.
            if let button, !button.1, session.holds(button.0), let edge = edgePointer(for: event) {
                deliver(event, .pointerMove(x: edge.x, y: edge.y))
                deliver(event, .button(button.0, isDown: false))
                return true
            }
            if Self.isDrag(event), session.holdsAnyButton, let edge = edgePointer(for: event) {
                deliver(event, .pointerMove(x: edge.x, y: edge.y))
                return true
            }
            return false
        }
    }

    /// Sends when the hardware check passes and the session takes input; a dropped event is told once per session.
    private func deliver(_ event: NSEvent, _ input: InputEvent) {
        switch HumanActions.forwardProof(for: event) {
        case .human(let proof): session.send(input, proof: proof)
        case .refused: session.noteDroppedInput()
        }
    }

    private func pointer(for event: NSEvent) -> (x: Double, y: Double)? {
        guard let video else { return nil }
        let point = video.convert(event.locationInWindow, from: nil)
        let rect = video.videoRect
        // AppKit's y grows upward; B's display is counted from the top.
        guard let unit = ViewerPointer.unit(x: point.x, y: point.y, videoX: rect.minX, videoY: rect.minY,
                                            videoWidth: rect.width, videoHeight: rect.height) else { return nil }
        return (unit.x, 1 - unit.y)
    }

    /// The nearest point of the picture, for a button or drag B holds while the pointer is outside it.
    private func edgePointer(for event: NSEvent) -> (x: Double, y: Double)? {
        guard let video else { return nil }
        let point = video.convert(event.locationInWindow, from: nil)
        let rect = video.videoRect
        guard let unit = ViewerPointer.clampedUnit(x: point.x, y: point.y, videoX: rect.minX, videoY: rect.minY,
                                                   videoWidth: rect.width, videoHeight: rect.height) else { return nil }
        return (unit.x, 1 - unit.y)
    }

    private static func isDrag(_ event: NSEvent) -> Bool {
        [.leftMouseDragged, .rightMouseDragged, .otherMouseDragged].contains(event.type)
    }

    private static func button(_ event: NSEvent) -> (MouseButton, Bool)? {
        switch event.type {
        case .leftMouseDown: (.left, true)
        case .leftMouseUp: (.left, false)
        case .rightMouseDown: (.right, true)
        case .rightMouseUp: (.right, false)
        case .otherMouseDown: (.middle, true)
        case .otherMouseUp: (.middle, false)
        default: nil
        }
    }

    static func modifiers(_ flags: NSEvent.ModifierFlags) -> KeyModifiers {
        var modifiers = KeyModifiers()
        if flags.contains(.shift) { modifiers.insert(.shift) }
        if flags.contains(.control) { modifiers.insert(.control) }
        if flags.contains(.option) { modifiers.insert(.option) }
        if flags.contains(.command) { modifiers.insert(.command) }
        if flags.contains(.function) { modifiers.insert(.function) }
        return modifiers
    }

    /// The flag a modifier key sets, so a change reads as that key going down or up.
    static func modifierFlag(forKeyCode code: UInt16) -> NSEvent.ModifierFlags? {
        switch code {
        case 0x37, 0x36: .command
        case 0x38, 0x3C: .shift
        case 0x3A, 0x3D: .option
        case 0x3B, 0x3E: .control
        case 0x39: .capsLock
        case 0x3F: .function
        default: nil
        }
    }
}
#endif
