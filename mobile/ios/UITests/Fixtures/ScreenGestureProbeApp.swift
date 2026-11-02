// Compiled only by check-ui.py --screen-gestures into a disposable simulator app.
// Exercises the production SurfaceView. The gesture modes never connect anywhere. `--screen-viewer` (J2-SCREEN-SIM,
// 「Core + 표면만」) connects only to the fixture Screen host on this Mac's loopback (127.0.0.1), with keys that host
// made for this run; it never authenticates with Face ID, the Secure Enclave or the keychain, and never reaches a real Mac.
import AVFoundation
import CoreMedia
import CryptoKit
import SwiftUI
import UIKit
import ScreenControlCore

@main struct AgentsToZMobileApp: App {
    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.arguments.contains("--screen-viewer") { ScreenViewerProbe() } else { GestureProbe() }
        }
    }
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

// MARK: - Viewer mode (J2-SCREEN-SIM, 「Core + 표면만」)

/// `--screen-viewer`: ScreenControlCore's public viewer (`ScreenViewer.connect(over:mac:signer:)`) over the in-probe
/// `LoopbackFrameTransport`, signed by an in-memory software key, its pictures shown by the production
/// `ScreenSurface.SurfaceView` and the surface's input sent to the fixture Screen host (synthetic capture, record-only
/// input). Out of scope here: ScreenViewerModel, Face ID, route selection and ScreenService's canControl decision.
/// The UI test passes the fixture's pins in the launch environment; nothing is stored.
private struct ScreenViewerProbe: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> ScreenViewerProbeController { ScreenViewerProbeController() }
    func updateUIViewController(_ controller: ScreenViewerProbeController, context: Context) {}
}

/// A transcript signer with an in-memory P-256 key: no Secure Enclave, keychain or Face ID.
private struct ProbeSoftwareSigner: TranscriptSigner {
    let key: P256.Signing.PrivateKey
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for: data) }
}

private struct ScreenViewerProbeFailure: Error, CustomStringConvertible {
    let description: String
}

/// The fixture Mac and this probe's key, from the launch environment the UI test set.
private struct ScreenViewerProbeConfiguration {
    let port: UInt16
    let mac: PinnedMac
    let key: P256.Signing.PrivateKey
    /// `device` (the key the fixture pinned) or `impostor` (a key it never pinned).
    let role: String

    init(_ environment: [String: String]) throws {
        guard let portText = environment["SCREEN_FIXTURE_PORT"], let port = UInt16(portText),
              let macText = environment["SCREEN_FIXTURE_MAC_PUBLIC_KEY"], let macData = Data(base64Encoded: macText),
              let fingerprintText = environment["SCREEN_FIXTURE_MAC_FINGERPRINT"], let fingerprint = Self.data(hex: fingerprintText),
              let keyText = environment["SCREEN_FIXTURE_SIGNING_KEY"], let keyData = Data(base64Encoded: keyText),
              let role = environment["SCREEN_FIXTURE_ROLE"], ["device", "impostor"].contains(role) else {
            throw ScreenViewerProbeFailure(description: "incompleteFixturePins")
        }
        self.port = port
        mac = try PinnedMac(publicKey: try P256.Signing.PublicKey(x963Representation: macData), fingerprint: fingerprint)
        key = try P256.Signing.PrivateKey(rawRepresentation: keyData)
        self.role = role
    }

    static func data(hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        return out
    }
}

/// Labels the UI test reads (accessibility identifiers):
///   screenViewerState      connecting · connected v<N> path=loopback · ended=<reason> · error=<…>
///                          · impostor=refused|connected|unreachable
///   screenViewerFrames     frames=<pictures handed to the display layer>
///   screenViewerRender     failures=<display layer failures seen> keyframes=<keyframes the probe asked for>
///                          status=<the display layer's status after the last picture: unknown · rendering · failed>
///   screenViewerInput      input=<the Mac's input availability>
///   gestureDelivery        left=<left presses sent> right=<right presses sent>
///   screenViewerTextResult text=<id>:<the Mac's text-and-Return answer>
///   screenViewerSent       every input event sent, in order: M(<x>,<y>) · L+ L- · R+ R- · C+ C- · S · K<code>± · X:<text>
///                          · T:<text>. x and y are the exact fractions sent (Swift's shortest round-trip text), so the
///                          judge compares them with the host's records number for number.
private final class ScreenViewerProbeController: UIViewController {
    private let display = AVSampleBufferDisplayLayer()
    private lazy var surface = ScreenSurface.SurfaceView(hosted: display)
    private let stateLabel = UILabel(), framesLabel = UILabel(), renderLabel = UILabel(), inputLabel = UILabel()
    private let deliveryLabel = UILabel(), textLabel = UILabel(), sentLabel = UILabel()
    private let field = ScreenComposeTextField()
    private var compose: ScreenComposeField.Coordinator?
    private var viewer: ScreenViewer?
    private var macState = ScreenMacState()
    private var videoSize = CGSize.zero
    private var pictures = 0
    /// Each time the display layer was found failed (its picture would not have been shown), and each keyframe the
    /// probe asked for to recover. A good run has none: the count of pictures alone would hide a stream that never shows.
    private var renderFailures = 0
    private var keyframeRequests = 0
    private var left = 0
    private var right = 0
    private var sent: [String] = []
    private var textSequence: UInt32 = 0
    private var session: Task<Void, Never>?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        display.videoGravity = .resizeAspect
        surface.isAccessibilityElement = true
        surface.accessibilityIdentifier = "screenViewerSurface"
        surface.videoSize = { [weak self] in self?.videoSize ?? .zero }
        // As ScreenSurface.makeUIView: nothing leaves while the surface has remote input off.
        surface.send = { [weak self, weak surface] event in
            guard surface?.remoteInputEnabled == true else { return }
            self?.deliver(event)
        }
        view.addSubview(surface)
        let labels: [(UILabel, String, String)] = [
            (stateLabel, "screenViewerState", "connecting"), (framesLabel, "screenViewerFrames", "frames=0"),
            (renderLabel, "screenViewerRender", "failures=0 keyframes=0 status=unknown"),
            (inputLabel, "screenViewerInput", "input=unknown"), (deliveryLabel, "gestureDelivery", "left=0 right=0"),
            (textLabel, "screenViewerTextResult", "text=none"), (sentLabel, "screenViewerSent", "none"),
        ]
        for (label, identifier, text) in labels {
            label.accessibilityIdentifier = identifier
            label.text = text
            label.backgroundColor = .white
            label.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
            view.addSubview(label)
        }
        field.borderStyle = .roundedRect
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.placeholder = "Mac에 입력할 글자"
        field.accessibilityIdentifier = "screenViewerTextField"
        // The production field's Return handling (ScreenComposeField.Coordinator): commit, then submit once.
        let parent = ScreenComposeField(placeholder: "Mac에 입력할 글자", text: .constant(""), focused: .constant(false),
                                        composing: .constant(false), locked: false) { [weak self] in self?.submitText() }
        let coordinator = ScreenComposeField.Coordinator(parent: parent)
        field.delegate = coordinator
        field.composingReturn = { [weak coordinator] field in coordinator?.commitAndSubmit(field) }
        compose = coordinator
        view.addSubview(field)
        session = Task { [weak self] in await self?.run() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        surface.frame = view.bounds
        refreshSurface()
        var y = view.safeAreaInsets.top + 8
        for label in [stateLabel, framesLabel, renderLabel, inputLabel, deliveryLabel, textLabel, sentLabel] {
            label.frame = CGRect(x: 20, y: y, width: view.bounds.width - 40, height: 22)
            y += 24
        }
        field.frame = CGRect(x: 20, y: y + 4, width: min(320, view.bounds.width - 40), height: 36)
    }

    private func run() async {
        let configuration: ScreenViewerProbeConfiguration
        do { configuration = try ScreenViewerProbeConfiguration(ProcessInfo.processInfo.environment) } catch {
            stateLabel.text = "error=\(error)"
            return
        }
        let impostor = configuration.role == "impostor"
        let transport: LoopbackFrameTransport
        do { transport = try await LoopbackFrameTransport.open(port: configuration.port, maxFrame: 1024) } catch {
            stateLabel.text = impostor ? "impostor=unreachable \(error)" : "error=transport \(error)"
            return
        }
        let viewer: ScreenViewer
        do {
            viewer = try await ScreenViewer.connect(over: transport, mac: configuration.mac, signer: ProbeSoftwareSigner(key: configuration.key))
        } catch {
            // The key exchange, not the transport, turned this key away.
            stateLabel.text = impostor ? "impostor=refused" : "error=handshake \(error)"
            return
        }
        if impostor {
            await viewer.close()
            stateLabel.text = "impostor=connected"
            return
        }
        self.viewer = viewer
        stateLabel.text = "connected v\(viewer.protocolVersion) path=\(transport.usesLoopback ? "loopback" : "other")"
        let notices = Task { [weak self] in
            for await notice in viewer.notices { self?.hear(notice) }
        }
        defer { notices.cancel() }
        do {
            for try await picture in viewer.pictures() {
                if let format = CMSampleBufferGetFormatDescription(picture.sample) {
                    let size = CMVideoFormatDescriptionGetDimensions(format)
                    let next = CGSize(width: Int(size.width), height: Int(size.height))
                    if next != videoSize {
                        videoSize = next
                        refreshSurface()
                    }
                }
                // As ScreenViewerModel.run: a failed display layer starts again from a keyframe. Counted, so a stream the
                // layer cannot show fails the run instead of passing on the number of pictures received.
                let renderer = display.sampleBufferRenderer
                if renderer.status == .failed {
                    renderFailures += 1
                    renderer.flush()
                    keyframeRequests += 1
                    try await viewer.requestKeyframe()
                }
                renderer.enqueue(picture.sample)
                pictures += 1
                framesLabel.text = "frames=\(pictures)"
                showRender()
            }
            self.viewer = nil
            showRender(final: true)
            stateLabel.text = "ended=\(viewer.endReason.map { "\($0)" } ?? "none")"
        } catch {
            self.viewer = nil
            showRender(final: true)
            stateLabel.text = "error=session \(error)"
        }
    }

    /// The display layer's failures and status. `final`: a failure after the last picture still counts.
    private func showRender(final: Bool = false) {
        let status = display.sampleBufferRenderer.status
        if final, status == .failed { renderFailures += 1 }
        let name = switch status {
        case .rendering: "rendering"
        case .failed: "failed"
        default: "unknown"
        }
        renderLabel.text = "failures=\(renderFailures) keyframes=\(keyframeRequests) status=\(name)"
    }

    private func hear(_ notice: ScreenNotice) {
        macState.hear(notice)
        switch notice {
        case .inputAvailability(let availability): inputLabel.text = "input=\(availability)"
        case let .textAndReturnResult(id, result): textLabel.text = "text=\(id):\(result)"
        default: break
        }
        refreshSurface()
    }

    /// As ScreenSurface.updateUIView in touch mode: the Mac's input state and pointer reach the surface.
    private func refreshSurface() {
        surface.update(videoSize: videoSize, mode: .touch, zoomReset: 0, canSendInput: macState.canSendInput,
                       macPointer: macState.pointerPosition)
    }

    /// As ScreenViewerModel.send: only while the Mac takes input.
    private func deliver(_ event: InputEvent) {
        guard let viewer, macState.canSendInput else { return }
        record(event)
        viewer.input(event)
    }

    /// As ScreenViewerModel.submitTextAndReturn for a version-4 Mac: one admission for the text and its Return.
    private func submitText() {
        guard let viewer, viewer.protocolVersion >= 4, macState.canSendInput, let text = field.text, !text.isEmpty else { return }
        textSequence += 1
        let event = InputEvent.textAndReturn(id: textSequence, text: text)
        record(event)
        viewer.input(event)
        field.text = ""
    }

    private func record(_ event: InputEvent) {
        let token: String
        switch event {
        case let .pointerMove(x, y): token = "M(\(x),\(y))"
        case let .button(button, isDown):
            switch button {
            case .left:
                token = isDown ? "L+" : "L-"
                if isDown { left += 1 }
            case .right:
                token = isDown ? "R+" : "R-"
                if isDown { right += 1 }
            case .middle: token = isDown ? "C+" : "C-"
            }
        case .scroll: token = "S"
        case let .key(code, isDown, _): token = "K\(code)\(isDown ? "+" : "-")"
        case let .text(text): token = "X:\(text)"
        case let .textAndReturn(_, text): token = "T:\(text)"
        }
        sent.append(token)
        sentLabel.text = sent.joined(separator: " ")
        deliveryLabel.text = "left=\(left) right=\(right)"
    }
}
