#if os(macOS)
import AppKit
import ScreenControlCore
import ScreenHost
import SwiftUI

// B's 「다른 Mac 추가」 window (docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.3, 5.2, SR-20, SR-29, SR-37). The menu's
// 「다른 Mac 추가…」 calls `ControllerPairingWindow.show()`; every control that opens, types or approves here reads the
// event that ran it and passes `ScreenInputOrigin` (a hardware click inside the control, a hardware key-down in the
// field), so an accessibility action, a program or a remote desktop never moves the pairing forward. Lowering controls
// (「거절」, closing) act at once. The window is kept out of screen capture where macOS honours it, and a session
// starting closes it anyway (SR-37).

@MainActor
enum ControllerPairingWindow {
    private static var window: NSWindow?
    private static var closer: Closer?
    private(set) static var pairing: ScreenControllerPairing = ScreenShared.service.makeControllerPairing()

    /// Shows the window; the person opens the pairing window inside it with a hardware click.
    static func show() {
        if let window {
            NSApp.activate()
            return window.makeKeyAndOrderFront(nil)
        }
        let window = NSWindow(contentViewController: NSHostingController(rootView: ControllerPairingPanel(pairing: pairing)))
        window.title = "다른 Mac 추가"
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        // Code ② and the approval screen stay out of capture where the system honours it (S-M2); SR-37 is the guarantee.
        window.sharingType = .none
        let closer = Closer()
        window.delegate = closer
        self.closer = closer
        self.window = window
        window.center()
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    private final class Closer: NSObject, NSWindowDelegate {
        func windowWillClose(_ notification: Notification) {
            MainActor.assumeIsolated {
                ControllerPairingWindow.pairing.close()
                ControllerPairingWindow.window = nil
                ControllerPairingWindow.closer = nil
            }
        }
    }
}

/// What this process reads about the event that ran a control.
@MainActor
enum PairingInputReader {
    static var ownPid: Int64 { Int64(ProcessInfo.processInfo.processIdentifier) }

    /// `NSApp.currentEvent` as `ScreenInputOrigin` judges it; nil when no event ran the control (an AX action).
    static func read(_ event: NSEvent?) -> ScreenInputEvent? {
        guard let event, let cg = event.cgEvent else { return nil }
        let kind: ScreenInputEvent.Kind = switch event.type {
        case .leftMouseDown: .leftMouseDown
        case .leftMouseUp: .leftMouseUp
        case .keyDown: .keyDown
        case .keyUp: .keyUp
        default: .other
        }
        return ScreenInputEvent(kind: kind, ageSeconds: ProcessInfo.processInfo.systemUptime - event.timestamp,
                                sourcePid: cg.getIntegerValueField(.eventSourceUnixProcessID),
                                keyboardType: cg.getIntegerValueField(.keyboardEventKeyboardType),
                                sourceState: cg.getIntegerValueField(.eventSourceStateID))
    }

    /// The click that ran `view`: a hardware left mouse-up inside it. This process is AgentsToZ Screen, the one program
    /// on this Mac that injects another device's input, so its own pid is also the injector's.
    static func click(in view: NSView) -> ScreenInputRefusal? {
        let event = NSApp.currentEvent
        let inside = event.map { $0.window === view.window && view.bounds.contains(view.convert($0.locationInWindow, from: nil)) } ?? false
        return ScreenInputOrigin.humanClick(read(event), inControl: inside, ownPid: ownPid, screenPid: ownPid)
    }
}

/// A push button whose action receives the judgement of the click that ran it (SR-29).
struct HardwareButton: NSViewRepresentable {
    let title: String
    var prominent = false
    var enabled = true
    let action: (ScreenInputRefusal?) -> Void

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(title: title, target: context.coordinator, action: #selector(Coordinator.run(_:)))
        button.bezelStyle = .push
        if prominent { button.bezelColor = .controlAccentColor }
        button.isEnabled = enabled
        return button
    }

    func updateNSView(_ button: NSButton, context: Context) {
        button.title = title
        button.isEnabled = enabled
        context.coordinator.action = action
    }

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    final class Coordinator: NSObject {
        var action: (ScreenInputRefusal?) -> Void
        init(action: @escaping (ScreenInputRefusal?) -> Void) { self.action = action }
        @MainActor @objc func run(_ sender: NSButton) { action(PairingInputReader.click(in: sender)) }
    }
}

/// The six-digit field: hardware key-downs only (`ControllerPairingCodeEntry`). Its accessibility value cannot be set,
/// and nothing pastes into it.
struct PairingCodeField: NSViewRepresentable {
    let onSubmit: (ControllerPairingCodeEntry.Submission) -> Void

    func makeNSView(context: Context) -> CodeView {
        let view = CodeView()
        view.onSubmit = onSubmit
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }

    func updateNSView(_ view: CodeView, context: Context) { view.onSubmit = onSubmit }

    final class CodeView: NSView {
        var onSubmit: (ControllerPairingCodeEntry.Submission) -> Void = { _ in }
        private var entry = ControllerPairingCodeEntry()
        private var refused: ScreenInputRefusal?

        override var acceptsFirstResponder: Bool { true }
        override var intrinsicContentSize: NSSize { NSSize(width: 240, height: 44) }

        override func keyDown(with event: NSEvent) {
            guard let key = Self.key(event) else { return }
            let outcome = entry.key(key, event: PairingInputReader.read(event), ownPid: PairingInputReader.ownPid, screenPid: PairingInputReader.ownPid)
            switch outcome {
            case .ignored(let refusal): refused = refusal ?? refused
            case .changed: refused = nil
            case .submitted(let submission): onSubmit(submission)
            }
            needsDisplay = true
        }

        static func key(_ event: NSEvent) -> ControllerPairingCodeEntry.Key? {
            switch event.keyCode {
            case 36, 76: return .submit           // Return, keypad Enter
            case 51, 117: return .delete          // Delete, forward delete
            default:
                guard let scalar = event.charactersIgnoringModifiers?.unicodeScalars.first, ("0"..."9").contains(scalar) else { return nil }
                return .digit(UInt8(scalar.value - 48))
            }
        }

        override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }

        override func draw(_ dirtyRect: NSRect) {
            NSColor.textBackgroundColor.setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
            (window?.firstResponder === self ? NSColor.keyboardFocusIndicatorColor : NSColor.separatorColor).setStroke()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 6, yRadius: 6).stroke()
            let digits = entry.text.padding(toLength: ControllerPairingProtocol.codeDigits, withPad: "·", startingAt: 0)
            let text = NSAttributedString(string: digits, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 24, weight: .semibold), .foregroundColor: NSColor.labelColor, .kern: 6,
            ])
            let size = text.size()
            text.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2))
        }

        override func becomeFirstResponder() -> Bool { needsDisplay = true; return true }
        override func resignFirstResponder() -> Bool { needsDisplay = true; return true }

        // Accessibility reads the digits typed so far; it never writes them.
        override func isAccessibilityElement() -> Bool { true }
        override func accessibilityRole() -> NSAccessibility.Role? { .staticText }
        override func accessibilityValue() -> Any? { entry.text }
        override func setAccessibilityValue(_ value: Any?) { _ = entry.setValue(value as? String ?? "") }
        override func isAccessibilitySelectorAllowed(_ selector: Selector) -> Bool {
            selector != #selector(setAccessibilityValue(_:)) && super.isAccessibilitySelectorAllowed(selector)
        }
    }
}

struct ControllerPairingPanel: View {
    let pairing: ScreenControllerPairing

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch pairing.phase {
            case .closed(let notice):
                Text("다른 Mac에서 이 Mac을 보려면, 여기서 등록 창을 열고 그 Mac의 AgentsToZ Viewer에서 「Mac 추가」를 누르세요.")
                    .fixedSize(horizontal: false, vertical: true)
                if let notice { Text(notice).foregroundStyle(.secondary) }
                HardwareButton(title: "등록 창 열기 (120초)") { click in Task { await pairing.open(click: click) } }
                    .fixedSize()
            case .open(let hostName, let number, let until):
                Text("A의 Viewer에서 ‘\(hostName) · 창 번호 \(number)’를 고르세요").font(.headline)
                Text("창 번호 \(number)").font(.system(size: 28, weight: .semibold, design: .monospaced))
                Text(until, style: .timer).foregroundStyle(.secondary)
                Button("닫기") { pairing.close() }
            case .reviewing(let review):
                header(review)
                Text("A에 보이는 숫자 6자리를 입력하세요 (한 번만, 이 Mac의 키보드로)").font(.headline)
                PairingCodeField { submission in Task { await pairing.enterCode(submission) } }
                Button("거절") { pairing.refuse() }
            case .approving(let review):
                header(review)
                // Its own view: the grant and 「기존 항목 바꾸기」 start over at 「보기」 and off for every pairing, since
                // leaving this case (any other phase) drops the form's state with it.
                ControllerApprovalForm(pairing: pairing, review: review)
                    .id(review.windowNumber + review.shortFingerprint)
            case .showingHostCode(let code, let review):
                header(review)
                Text("A에 이 숫자를 입력하세요").font(.headline)
                Text(code).font(.system(size: 36, weight: .bold, design: .monospaced)).textSelection(.disabled)
                Text("A가 확인하면 목록에 키 지문 \(review.shortFingerprint)으로 추가됩니다").foregroundStyle(.secondary)
                Button("취소") { pairing.close() }
            }
            if let notice = pairing.notice { Text(notice).foregroundStyle(.red) }
        }
        .padding(20)
        .frame(width: 460, alignment: .leading)
    }

    @ViewBuilder private func header(_ review: ScreenControllerPairing.Review) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Mac 컨트롤러: ‘\(review.name)’\(review.model.map { " (\($0))" } ?? "")").font(.headline)
            Text("키 지문 \(review.shortFingerprint) · 창 번호 \(review.windowNumber)").font(.system(.body, design: .monospaced))
            Text("정품 AgentsToZ Viewer: \(review.attested ? "확인됨" : "확인할 수 없음")")
                .foregroundStyle(review.attested ? Color.primary : Color.orange)
        }
    }
}

/// The grant, 「기존 항목 바꾸기」 and 「승인」 for one pairing. Its state lives only while the window shows this pairing's
/// approval: 「보기」, replacement off and no row chosen each time it appears. While 「승인」 runs (Touch ID or Watch
/// up), its controls are disabled; 「거절」 always acts at once.
struct ControllerApprovalForm: View {
    let pairing: ScreenControllerPairing
    let review: ScreenControllerPairing.Review
    @State private var grant: ScreenControllerGrant = .view
    @State private var replace = false
    @State private var replacing: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("권한", selection: $grant) {
                Text("보기").tag(ScreenControllerGrant.view)
                if review.allowsControl { Text("조작").tag(ScreenControllerGrant.control) }
            }
            .pickerStyle(.segmented)
            .fixedSize()
            .disabled(pairing.approvalInProgress)
            if !review.replacements.isEmpty {
                Toggle("기존 항목 바꾸기", isOn: $replace)
                    .disabled(pairing.approvalInProgress)
                ForEach(review.replacements) { row in
                    HStack {
                        Toggle(isOn: Binding(get: { replacing == row.id }, set: { replacing = $0 ? row.id : nil })) {
                            Text("‘\(row.name)’ · 키 지문 \(row.shortFingerprint) → 새 키 지문 \(review.shortFingerprint)")
                                .font(.system(.body, design: .monospaced))
                        }
                        .disabled(!replace || pairing.approvalInProgress)
                    }
                }
            }
            Text("다른 Mac 연결 허용을 켜고 ‘\(review.name)’을(를) 추가합니다").foregroundStyle(.secondary)
            HStack {
                HardwareButton(title: "승인 (Touch ID 또는 Apple Watch)", prominent: true, enabled: !pairing.approvalInProgress) { click in
                    Task { await pairing.approve(click: click, grant: grant, replacing: replace ? replacing : nil) }
                }
                .fixedSize()
                Button("거절") { pairing.refuse() }
            }
        }
    }
}
#endif
