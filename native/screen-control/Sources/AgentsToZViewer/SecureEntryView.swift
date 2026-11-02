#if os(macOS)
import AppKit
import Carbon.HIToolbox
import ScreenControlCore

// The locked-Mac entry (docs/design/mac-to-mac-2026-11-01/DESIGN.md D-3, SR-28). Not a text field: the characters live
// in a `ViewerSecureBuffer` filled only by hardware key-downs that pass `HumanActions.forwardProof`, and nothing reads a
// field's value into it, so an accessibility "set value" or a pasted string reaches nothing. Secure Event Input is on
// exactly while it holds the keyboard focus of the key window of the active Viewer (SR-28), so no other process on this
// Mac reads these keys through an event tap; losing any of the three turns it off, and so does the session's end
// (`endEntry`), since closing a window resigns no responder. It shows only a dot per character.

@MainActor
final class SecureEntryView: NSView {
    private(set) var buffer = ViewerSecureBuffer()
    /// Read by `deinit`, which runs off the main actor's isolation; written only on the main thread.
    nonisolated(unsafe) private var secureInputOn = false
    nonisolated(unsafe) private var observers: [NSObjectProtocol] = []
    private var hasFocus = false
    /// Return pressed on this entry by the hardware: send the buffer (the same as its 「보내기」 button).
    var submit: (HumanProof) -> Void = { _ in }
    /// A key that did not come from this Mac's hardware.
    var refused: (ScreenInputRefusal) -> Void = { _ in }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.cgColor
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel("B 잠금 암호 입력칸 · 이 Mac의 실제 키보드로만 입력됩니다")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var acceptsFirstResponder: Bool { true }
    override var intrinsicContentSize: NSSize { NSSize(width: 220, height: 28) }

    deinit {
        if secureInputOn { DisableSecureEventInput() }
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    override func becomeFirstResponder() -> Bool {
        hasFocus = true
        followFocus()
        needsDisplay = true
        return true
    }

    override func resignFirstResponder() -> Bool {
        hasFocus = false
        followFocus()
        needsDisplay = true
        return true
    }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        if newWindow == nil { endEntry() }
        super.viewWillMove(toWindow: newWindow)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        guard let window else { return }
        let center = NotificationCenter.default
        let watched: [(Notification.Name, AnyObject?)] = [
            (NSWindow.didBecomeKeyNotification, window), (NSWindow.didResignKeyNotification, window),
            (NSApplication.didBecomeActiveNotification, NSApp), (NSApplication.didResignActiveNotification, NSApp),
        ]
        for (name, object) in watched {
            observers.append(center.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.followFocus() }
            })
        }
    }

    /// Secure Event Input on while this entry is the keyboard focus of the key window in the active app, off otherwise.
    private func followFocus() {
        if hasFocus, window?.isKeyWindow == true, NSApp.isActive {
            if !secureInputOn { EnableSecureEventInput(); secureInputOn = true }
        } else {
            endSecureInput()
        }
    }

    private func endSecureInput() {
        if secureInputOn { DisableSecureEventInput(); secureInputOn = false }
    }

    /// The session ended or the entry closed: no focus, no Secure Event Input, nothing kept.
    func endEntry() {
        if window?.firstResponder === self { window?.makeFirstResponder(nil) }
        hasFocus = false
        endSecureInput()
        buffer.clear()
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }

    override func keyDown(with event: NSEvent) {
        if case .refused(let refusal) = HumanActions.forwardProof(for: event) {
            refused(refusal)
            return
        }
        switch event.keyCode {
        case 0x24, 0x4C:
            // Return or Enter on this entry: `humanKey` judges it as the control's own key.
            switch HumanActions.keyProof(for: event, in: self) {
            case .human(let proof): submit(proof)
            case .refused(let refusal): refused(refusal)
            }
        case 0x33, 0x75:
            buffer.deleteBackward(refusal: nil)
        default:
            // The typed characters of a hardware key-down; never a field's value. Function keys (arrows and the like,
            // U+F700–U+F8FF) and Command chords type nothing.
            let typed = event.characters ?? ""
            guard !event.modifierFlags.contains(.command),
                  !typed.unicodeScalars.contains(where: { (0xF700...0xF8FF).contains($0.value) }) else { break }
            buffer.type(typed, refusal: nil)
        }
        needsDisplay = true
    }

    /// Hands the buffer to `send`, which empties it.
    func withBuffer(_ send: (inout ViewerSecureBuffer) -> Void) {
        send(&buffer)
        needsDisplay = true
    }

    func clear() {
        buffer.clear()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let dots = String(repeating: "●", count: buffer.count)
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13),
                                                         .foregroundColor: NSColor.labelColor]
        let text = dots.isEmpty && window?.firstResponder !== self ? "여기를 누르고 입력" : dots
        let color = dots.isEmpty ? NSColor.placeholderTextColor : NSColor.labelColor
        NSAttributedString(string: text, attributes: attributes.merging([.foregroundColor: color]) { $1 })
            .draw(at: NSPoint(x: 8, y: (bounds.height - 16) / 2))
    }
}
#endif
