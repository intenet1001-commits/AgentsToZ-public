// Compiled only by check-ui.py --screen-gestures into a disposable simulator app.
// Exercises the production SurfaceView; never authenticates or connects to a Mac.
import SwiftUI
import UIKit
import ScreenControlCore

@main struct AgentsToZMobileApp: App {
    var body: some Scene { WindowGroup { GestureProbe() } }
}

private struct GestureProbe: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ controller: Controller, context: Context) {}

    final class Controller: UIViewController {
        private let surface = ScreenSurface.SurfaceView(hosted: CALayer())
        private let result = UILabel()
        private var left = 0
        private var right = 0
        private let resyncProbe = ProcessInfo.processInfo.arguments.contains("--trackpad-resync")
        private var allowed = true
        private var pointer = ScreenPointerPosition(x: 13107, y: 52428)
        private var sentPointer = ScreenPointerPosition(x: 0, y: 0)
        private let pause = UIButton(type: .system)
        private let resume = UIButton(type: .system)
        private func updateSurface() {
            surface.update(videoSize: CGSize(width: 1920, height: 1080), mode: resyncProbe ? .trackpad : .touch, zoomReset: 0,
                           canSendInput: allowed, macPointer: resyncProbe ? pointer : nil)
        }

        override func viewDidLoad() {
            super.viewDidLoad()
            if ProcessInfo.processInfo.arguments.contains("--space-controls") {
                let hosted = UIHostingController(rootView: SpaceBarProbe())
                addChild(hosted)
                hosted.view.frame = view.bounds
                hosted.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                view.addSubview(hosted.view)
                hosted.didMove(toParent: self)
                return
            }
            if ProcessInfo.processInfo.arguments.contains("--compose-return") { return }
            if ProcessInfo.processInfo.arguments.contains("--keyboard-enter-codes") {
                let usages = [0x28, 0x58, 0x9E, 0xFFFF]
                let codes = usages.map { usage in
                    UIKeyboardHIDUsage(rawValue: usage).flatMap { MacKeyCode.code(for: $0) }.map(String.init) ?? "none"
                }
                result.text = codes.joined(separator: ",")
                result.accessibilityIdentifier = "keyboardEnterCodes"
                view.addSubview(result)
                return
            }
            surface.backgroundColor = .systemIndigo
            surface.isAccessibilityElement = true
            surface.accessibilityIdentifier = "gestureProbeSurface"
            surface.videoSize = { CGSize(width: 1920, height: 1080) }
            surface.send = { [weak self] event in
                guard let self else { return }
                if case .button(.left, true) = event { left += 1 }
                if case .button(.right, true) = event { right += 1 }
                if case let .pointerMove(x, y) = event {
                    sentPointer = .init(x: UInt16((x * 65535).rounded()), y: UInt16((y * 65535).rounded()))
                }
                result.text = "left=\(left) right=\(right)" + (resyncProbe ? " x=\(sentPointer.x) y=\(sentPointer.y)" : "")
            }
            view.addSubview(surface)
            result.text = "left=0 right=0"
            result.accessibilityIdentifier = "gestureDelivery"
            result.backgroundColor = .white
            view.addSubview(result)
            if resyncProbe {
                pause.setTitle("Mac takeover", for: .normal); pause.accessibilityIdentifier = "probePause"
                pause.addAction(UIAction { [weak self] _ in self?.allowed = false; self?.updateSurface() }, for: .touchUpInside)
                resume.setTitle("Mac resume", for: .normal); resume.accessibilityIdentifier = "probeResume"
                resume.addAction(UIAction { [weak self] _ in
                    self?.pointer = .init(x: 52428, y: 13107); self?.allowed = true; self?.updateSurface()
                }, for: .touchUpInside)
                for button in [pause, resume] { button.backgroundColor = .white; view.addSubview(button) }
            }
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            if ProcessInfo.processInfo.arguments.contains("--compose-return") && result.superview == nil {
                let field = ScreenComposeTextField(frame: CGRect(x: 20, y: 100, width: 240, height: 44))
                view.addSubview(field)
                var submissions = 0
                var composing = false
                var text = ""
                var firstSubmitted = ""
                let parent = ScreenComposeField(placeholder: "", text: Binding(get: { text }, set: { text = $0 }), focused: .constant(true),
                                                composing: Binding(get: { composing }, set: { composing = $0 }), locked: false) {
                    submissions += 1
                    if submissions == 1 { firstSubmitted = text }
                }
                let delegate = ScreenComposeField.Coordinator(parent: parent)
                field.delegate = delegate
                field.compositionChanged = { composing = $0 }
                field.composingReturn = { delegate.commitAndSubmit($0) }
                field.becomeFirstResponder()
                field.setMarkedText("ㅎ", selectedRange: NSRange(location: 1, length: 0))
                let marked = field.markedTextRange != nil
                let canSendWhileMarked = ScreenComposeRules.maySend(isComposing: composing, waiting: false, uncertain: false)
                let handled = field.submitMarkedTextOnReturn()
                let duringComposition = submissions
                let canSendAfterCommit = ScreenComposeRules.maySend(isComposing: composing, waiting: false, uncertain: false)
                _ = delegate.textFieldShouldReturn(field)
                field.editingLocked = true
                delegate.parent = ScreenComposeField(placeholder: "", text: .constant(""), focused: .constant(true),
                                                      composing: .constant(false), locked: true) { submissions += 1 }
                field.setMarkedText("ㄱ", selectedRange: NSRange(location: 1, length: 0))
                let locked = field.markedTextRange == nil && !delegate.textField(field, shouldChangeCharactersIn: NSRange(location: 0, length: 0), replacementString: "a")
                result.text = "marked=\(marked) handled=\(handled) composing=\(duringComposition) text=\(firstSubmitted) committed=\(submissions) sends=\(canSendWhileMarked),\(canSendAfterCommit) locked=\(locked)"
                result.accessibilityIdentifier = "composeReturnResult"
                view.addSubview(result)
                view.setNeedsLayout()
                return
            }
            if ProcessInfo.processInfo.arguments.contains("--return-draft") {
                var draft = ScreenTextReturnDraft()
                draft.begin(id: 1, text: "초안")
                let blocked = draft.shouldClear(after: .blocked(1), currentText: "초안")
                draft.begin(id: 2, text: "초안")
                let unknown = draft.shouldClear(after: .uncertain(2), currentText: "초안")
                draft.begin(id: 3, text: "초안")
                let stale = draft.shouldClear(after: .posted(2), currentText: "초안")
                let edited = draft.shouldClear(after: .posted(3), currentText: "나중 입력")
                draft.begin(id: 4, text: "초안")
                let posted = draft.shouldClear(after: .posted(4), currentText: "초안")
                let retryBefore = ScreenComposeRules.maySend(isComposing: false, waiting: false, uncertain: true)
                let retryAfter = ScreenComposeRules.maySend(isComposing: false, waiting: false, uncertain: false)
                let disconnected = ScreenViewerModel().canSendText
                let allowDisconnected = ScreenComposeRules.maySend(isComposing: false, waiting: false, uncertain: false, admitted: disconnected)
                result.text = "blocked=\(blocked) unknown=\(unknown) stale=\(stale) edited=\(edited) posted=\(posted) retry=\(retryBefore),\(retryAfter) disconnected=\(allowDisconnected)"
                result.accessibilityIdentifier = "returnDraftResult"
                view.addSubview(result)
                return
            }
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            if ProcessInfo.processInfo.arguments.contains("--keyboard-enter-codes") || ProcessInfo.processInfo.arguments.contains("--compose-return") || ProcessInfo.processInfo.arguments.contains("--return-draft") {
                result.frame = CGRect(x: 20, y: view.safeAreaInsets.top + 8, width: min(600, view.bounds.width - 40), height: 44)
                return
            }
            surface.frame = view.bounds
            updateSurface()
            result.frame = CGRect(x: 20, y: view.safeAreaInsets.top + 8, width: min(600, view.bounds.width - 40), height: 44)
            pause.frame = CGRect(x: 20, y: view.safeAreaInsets.top + 60, width: 140, height: 44)
            resume.frame = CGRect(x: 180, y: view.safeAreaInsets.top + 60, width: 140, height: 44)
        }
    }
}

private struct SpaceBarProbe: View {
    @State private var result = "ready"
    @State private var disabled = false
    var body: some View {
        VStack {
            ScreenSpaceBar(disabled: disabled, navigate: { result = "navigation=\($0.rawValue)" }, selectDesktop: { number in
                let expected: UInt16 = [1: 0x12, 2: 0x13, 3: 0x14][number] ?? 0
                let events = ScreenDesktopShortcut.events(for: number)
                let valid = events == [.key(code: expected, isDown: true, modifiers: .control),
                                       .key(code: expected, isDown: false, modifiers: [])]
                result = "desktop=\(number) sequence=\(valid)"
            })
            Text(result).accessibilityIdentifier("spaceBarResult")
            Button("Disable") { disabled = true }.accessibilityIdentifier("disableSpaceBar")
        }.padding()
    }
}
