#if os(macOS)
import AppKit
import ScreenControlCore

// The one way the Viewer changes enrollment, permissions or a session (DESIGN SR-26, SR-29). Every protected control is
// a `HumanButton` (there are no pop-ups: their choice arrives from the menu's own window). Its only action is
// `HumanActions.fire`, which runs the control's handler only when the event that ran it was this Mac's hardware acting
// on that control: a fresh mouse-up inside it, or a key-down it received as the keyboard focus
// (`ViewerControlActuation`, over `ScreenInputOrigin.humanClick` / `humanKey`). Input for B is let through only by
// `HumanActions.forwardProof` (`ScreenInputOrigin.forward`). Either way the caller gets a `HumanProof`, which nothing
// outside this file can make, and every function that sends a record or control message to B takes one
// (ViewerSession.swift). An accessibility action (AXPress), an AppleScript `click button`, a synthetic or remote-desktop
// event, a click that is not a fresh mouse-up inside the control, or a key-down that reached another view gets
// `ScreenInputOriginText.notInFront` instead. ViewerRouteChecks' source contract keeps it so.

/// Evidence that the person in front of this Mac, with its own hardware, ran the action at hand.
struct HumanProof: Sendable {
    fileprivate init() {}
}

/// What `HumanActions` decided about one event.
enum HumanVerdict: Sendable {
    case human(HumanProof)
    case refused(ScreenInputRefusal)
}

/// A control the Viewer runs through `HumanActions.fire`.
@MainActor protocol HumanControlled: AnyObject {
    func runHandler(_ proof: HumanProof)
}

@MainActor
final class HumanButton: NSButton, HumanControlled {
    private let handler: (HumanProof) -> Void
    private let guarded: () -> Bool
    private(set) var tracksOwnMouseDown = false
    private(set) var guardedAtMouseDown = false
    var requiresGuardedActuation: Bool { guarded() }

    init(title: String, guarded: @escaping () -> Bool = { true }, handler: @escaping (HumanProof) -> Void) {
        self.handler = handler
        self.guarded = guarded
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded
        setButtonType(.momentaryPushIn)
        HumanActions.shared.adopt(self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func runHandler(_ proof: HumanProof) { handler(proof) }

    override func mouseDown(with event: NSEvent) {
        let wasTracking = tracksOwnMouseDown, wasGuarded = guardedAtMouseDown
        tracksOwnMouseDown = true; guardedAtMouseDown = requiresGuardedActuation
        defer { tracksOwnMouseDown = wasTracking; guardedAtMouseDown = wasGuarded }
        super.mouseDown(with: event)
    }

    /// Protected actions cannot borrow an unrelated current event through AX or programmatic activation.
    override func accessibilityPerformPress() -> Bool {
        guard !requiresGuardedActuation else { HumanActions.shared.refused(.notTheControl); return false }
        return super.accessibilityPerformPress()
    }

    override func performClick(_ sender: Any?) {
        guard !requiresGuardedActuation else { HumanActions.shared.refused(.notTheControl); return }
        super.performClick(sender)
    }

    /// Keep the design's focused hardware-key path without routing it through programmatic activation.
    override func keyDown(with event: NSEvent) {
        guard requiresGuardedActuation else { super.keyDown(with: event); return }
        let modifiers = event.modifierFlags.intersection([.command, .control, .option])
        guard ViewerControlActuation.buttonKey(event.keyCode, repeated: event.isARepeat, commandControlOrOption: !modifiers.isEmpty) else {
            super.keyDown(with: event); return
        }
        HumanActions.shared.fireKey(self, event: event)
    }
}

@MainActor
final class HumanActions: NSObject {
    static let shared = HumanActions()
    /// Shown when a control was run by anything but this Mac's hardware.
    var refused: (ScreenInputRefusal) -> Void = { _ in }
    /// Runs after every press, run or refused, so a control's look follows the model and not the press.
    var settled: () -> Void = {}

    func adopt(_ control: NSControl & HumanControlled) {
        control.target = self
        control.action = #selector(HumanActions.fire(_:))
    }

    /// The only action that can issue a protected proof in the Viewer.
    @objc func fire(_ sender: Any?) {
        guard let control = sender as? NSControl & HumanControlled else { return }
        defer { settled() }
        // Guarded keyboard actions are admitted only by keyDown's direct, focused event path below.
        if let button = control as? HumanButton, button.requiresGuardedActuation, NSApp.currentEvent?.type == .keyDown {
            refused(.notTheControl); return
        }
        if let refusal = Self.verdict(for: control, event: NSApp.currentEvent) {
            refused(refusal)
            return
        }
        control.runHandler(HumanProof())
    }

    /// A focused button's real keyDown, judged directly rather than using a retained current event.
    func fireKey(_ control: HumanButton, event: NSEvent) {
        defer { settled() }
        switch Self.keyProof(for: event, in: control) {
        case .human(let proof): control.runHandler(proof)
        case .refused(let refusal): refused(refusal)
        }
    }

    /// Whether the current event ran `control` from this Mac's hardware (SR-29). nil runs it. A key counts only when it
    /// reached `control` itself, the keyboard focus: a key-down elsewhere in the same window ran no control
    /// (`ViewerControlActuation`, which judges with `ScreenInputOrigin.humanClick` / `humanKey`).
    static func verdict(for control: NSView, event: NSEvent?) -> ScreenInputRefusal? {
        let window = control.window
        let sameWindow = window != nil && event?.window === window
        let insideControl = event.map { event in
            event.type != .keyDown && control.bounds.contains(control.convert(event.locationInWindow, from: nil))
        } ?? false
        let button = control as? HumanButton
        let mouseUp = event?.type == .leftMouseUp
        return ViewerControlActuation.refusal(event.map(ViewerEvent.read), sameWindow: sameWindow, insideControl: insideControl,
                                              controlHasFocus: window?.firstResponder === control, ownPid: ViewerEvent.ownPid,
                                              screenPid: ViewerEvent.screenPid(), requiresTrackedClick: button?.requiresGuardedActuation == true,
                                              trackedOwnMouseDown: button?.tracksOwnMouseDown == true && button?.guardedAtMouseDown == true,
                                              clickCount: mouseUp ? event?.clickCount ?? 0 : 0)
    }

    /// Whether `event` may go to B (SR-26): only what this Mac's hardware produced.
    static func forwardProof(for event: NSEvent) -> HumanVerdict {
        let read = ViewerEvent.read(event)
        if let refusal = ScreenInputOrigin.forward(sourcePid: read.sourcePid, ownPid: ViewerEvent.ownPid,
                                                   screenPid: ViewerEvent.screenPid(), keyboardType: read.keyboardType,
                                                   sourceState: read.sourceState) {
            return .refused(refusal)
        }
        return .human(HumanProof())
    }

    /// A key-down that ran a control holding the keyboard focus (the locked-Mac entry's Return), as `humanKey` judges it.
    static func keyProof(for event: NSEvent, in control: NSView) -> HumanVerdict {
        if let refusal = verdict(for: control, event: event) { return .refused(refusal) }
        return .human(HumanProof())
    }
}

/// What the Viewer reads from an event: the fields `ScreenInputOrigin` judges, nothing else.
enum ViewerEvent {
    static let screenBundleIdentifier = "com.intenet.agentstozbycs.screen"
    static let ownPid = Int64(ProcessInfo.processInfo.processIdentifier)

    /// AgentsToZ Screen's pid on this Mac when it runs: its injected input is another device's, never this person's.
    @MainActor static func screenPid() -> Int64? {
        NSRunningApplication.runningApplications(withBundleIdentifier: screenBundleIdentifier).first.map { Int64($0.processIdentifier) }
    }

    static func read(_ event: NSEvent) -> ScreenInputEvent {
        let kind: ScreenInputEvent.Kind = switch event.type {
        case .leftMouseDown: .leftMouseDown
        case .leftMouseUp: .leftMouseUp
        case .keyDown: .keyDown
        case .keyUp: .keyUp
        default: .other
        }
        // An event with no CGEvent behind it was made by a program: it reads as no hardware at all.
        guard let cg = event.cgEvent else {
            return ScreenInputEvent(kind: kind, ageSeconds: .infinity, sourcePid: -1, keyboardType: 0, sourceState: 0)
        }
        return ScreenInputEvent(kind: kind, ageSeconds: ProcessInfo.processInfo.systemUptime - event.timestamp,
                                sourcePid: cg.getIntegerValueField(.eventSourceUnixProcessID),
                                keyboardType: cg.getIntegerValueField(.keyboardEventKeyboardType),
                                sourceState: cg.getIntegerValueField(.eventSourceStateID))
    }
}
#endif
