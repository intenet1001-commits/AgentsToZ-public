import AgentsToZCore
import AVFoundation
import LocalAuthentication
import Network
import ScreenControlCore
import SwiftUI
import UIKit

extension ScreenViewerLifecycle.Phase {
    /// SwiftUI's phase as the decision needs it. A phase this build does not know is treated as inactive: the
    /// session is kept for one bounded wait rather than torn down at once, and a real background still ends it.
    init(_ phase: ScenePhase) {
        switch phase {
        case .active: self = .active
        case .inactive: self = .inactive
        case .background: self = .background
        @unknown default: self = .inactive
        }
    }
}

/// A Mac's screen on the phone (DESIGN 「screen-control」). Face ID comes first, then the connection, so the Mac's
/// five-second key-exchange deadline covers the network, not the person. Leaving the foreground ends the session at
/// once (SR-12). Two input modes, as in Jump Desktop, remembered between sessions: touch (click where you tap) and
/// trackpad (the phone draws a cursor the finger pushes). Both pinch to zoom 1x–4x and scroll with two fingers. A
/// hardware keyboard types straight through; the on-screen bar sends composed text (Korean included) and a few special
/// keys, and the password bar types a secret without the clipboard (SR-17). A version-2 Mac also tells its lock state
/// (in a band above the picture that the picture never reaches, SR-15) and its displays, leaves its cursor out of the
/// picture in trackpad mode, and can be turned off from here after Face ID.
struct ScreenViewerView: View {
    let mac: SavedScreenMac

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var model = ScreenViewerModel()
    /// A preference, nothing sensitive: the next session opens in the same mode.
    @AppStorage("screenControl.inputMode") private var inputMode = ScreenInputMode.touch
    @State private var panel = Panel.none
    @State private var text = ""
    /// ⌘⌥⌃⇧ chosen on the bar, applied to the next special key or single letter, then cleared.
    @State private var latched: KeyModifiers = []
    @State private var secret = SecretFieldController()
    @State private var zoomed = false
    @State private var zoomReset = 0
    @State private var toolbarHidden = false
    @State private var hint: String?
    @State private var confirmingTurnOff = false
    /// When this session may stay and when it must end (`ScreenViewerLifecycle`, AgentsToZCore). Face ID's own sheet
    /// and the return to the active phase arrive in either order on a real device, so the decision is one tested
    /// state machine here rather than a remembered phase read after a fixed wait.
    @State private var lifecycle = ScreenViewerLifecycle()
    /// The bounded wait this decision armed; its task carries the token back so a stale deadline decides nothing.
    @State private var graceToken: UInt64?
    @FocusState private var textFocused: Bool

    enum Panel { case none, keyboard, password }

    var body: some View {
        VStack(spacing: 0) {
            macSignalBand
            ZStack {
                ScreenSurface(model: model, mode: inputMode, zoomReset: zoomReset, keepsTextFocus: panel != .none) { zoomed = $0 }
                if let status = model.status {
                    VStack(spacing: 12) {
                        Text(status).foregroundStyle(.white).multilineTextAlignment(.center)
                        if model.ended { Button("닫기") { dismiss() }.buttonStyle(.borderedProminent) }
                    }
                    .padding()
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .clipped()
            // The phone's own controls and tips float over the picture, below the band.
            .overlay(alignment: toolbarHidden ? .top : .topTrailing) {
                VStack(alignment: .trailing, spacing: 6) {
                    if toolbarHidden {
                        Button { toolbarHidden = false } label: { Image(systemName: "chevron.compact.down").frame(width: 44, height: 22) }
                            .accessibilityLabel("도구 막대 펼치기")
                            .foregroundStyle(.white)
                            .background(.black.opacity(0.45), in: Capsule())
                    } else {
                        toolbar
                    }
                    if let hint {
                        Text(hint)
                            .font(.caption)
                            .foregroundStyle(.white)
                            .padding(8)
                            .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
                            .frame(maxWidth: 320, alignment: .trailing)
                            .allowsHitTesting(false)
                    }
                }
                .padding(8)
            }
        }
        .background { Color.black.ignoresSafeArea() }
        .overlay(alignment: .bottom) {
            switch panel {
            case .none: EmptyView()
            case .keyboard: keyboardBar
            case .password: passwordBar
            }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        // An edge swipe reaches the Mac first instead of pulling down Control Center mid-drag.
        .defersSystemGestures(on: .all)
        .task {
            // Starting waits here for the scene to be on screen, and takes at most one start. A sheet that is still
            // dismissing leaves this view inactive for a moment, and raising Face ID behind it would connect to a
            // screen nobody sees; returning early instead would never come back when the scene does, because
            // SwiftUI does not re-run a task that already finished. The wait is bounded by the decision itself: if
            // the scene never comes back, its grace ends the session and this loop stops.
            while !Task.isCancelled {
                let start = lifecycle.claimSessionStart(phase: .init(scenePhase))
                apply(start.effect)
                if start.starts { break }
                guard !lifecycle.hasEnded, !lifecycle.hasStarted else { return }
                try? await Task.sleep(for: .milliseconds(100))
            }
            guard !Task.isCancelled, lifecycle.hasStarted else { return }
            model.hideMacCursor(inputMode == .trackpad)
            await model.run(mac: mac)
        }
        .task(id: graceToken) {
            // A scene that is not active yet is tolerated for this long and no longer. Cancelled with the view, and
            // replaced whenever a newer wait is armed, so a session that is already gone is never ended again.
            guard let token = graceToken else { return }
            guard (try? await Task.sleep(for: .seconds(ScreenViewerLifecycle.graceSeconds))) != nil else { return }
            apply(lifecycle.graceExpired(token: token))
        }
        .task(id: hint) {
            // A newer hint cancels this wait; only a wait that ran out clears it.
            guard hint != nil, (try? await Task.sleep(for: .seconds(4))) != nil else { return }
            hint = nil
        }
        .onChange(of: model.status == nil) { _, showing in
            if showing, hint == nil { hint = inputMode.hint }
        }
        .onChange(of: inputMode) { _, mode in model.hideMacCursor(mode == .trackpad) }
        .onChange(of: model.macState.currentDisplay) { _, current in
            if model.macState.choosesDisplay { hint = "지금 보는 디스플레이: \(current + 1)/\(model.macState.displayCount)" }
        }
        .onDisappear { apply(lifecycle.viewDisappeared()) }
        .onChange(of: scenePhase) { _, phase in apply(lifecycle.sceneChanged(to: .init(phase))) }
        .onChange(of: model.authenticating) { _, asking in
            // Face ID's reply and the return to the active phase arrive in either order; the decision waits for the
            // scene within a bound instead of guessing after a fixed delay. Leaving for real still ends at once, and
            // a cancelled 「화면 제어 끄기」 inside a live session is not read as 「there is no session」.
            apply(asking ? lifecycle.authenticationStarted(for: model.authPurpose)
                         : lifecycle.authenticationFinished(model.lastApproval))
        }
        .onChange(of: model.sessionControls == nil) { _, pending in
            if !pending { lifecycle.sessionConnected() }
        }
        .confirmationDialog("\(mac.macName)의 화면 제어를 끌까요?", isPresented: $confirmingTurnOff, titleVisibility: .visible) {
            Button("Face ID로 확인하고 끄기", role: .destructive) {
                Task { if let failure = await model.turnOffScreenControl(macName: mac.macName) { hint = failure } }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("Mac의 화면 제어가 꺼지고 이 연결도 끝납니다. AgentsToZ Screen은 Mac의 메뉴 막대에 그대로 있고, 다시 켜려면 Mac 앞에서 켜야 합니다.")
        }
    }

    /// Leaving the foreground ends the session at once (SR-12). An inactive scene — Face ID's own sheet, or the
    /// moment before it hands the scene back — is tolerated within one bounded wait, and a view that is already
    /// going away is not dismissed again. This performs what the decision asked for and nothing else: the foreground
    /// gate is never relaxed here, so nothing keeps a session alive in the background.
    private func apply(_ effect: ScreenViewerLifecycle.Effect) {
        switch effect {
        case .none:
            break
        case .armGrace(let token):
            graceToken = token
        case .endNow(let reason):
            graceToken = nil
            secret.clear()
            model.end()
            // `viewDismissed` means the view is already leaving; dismissing it again would fight its own transition.
            if reason != .viewDismissed { dismiss() }
        }
    }

    /// What the Mac itself says, in a band of its own at the top: its lock state (version 2) and a pause while someone
    /// uses it. An unlocked or unknown Mac still has a neutral row, so this slot never collapses. The band is stacked above the picture's surface, and the surface clips the picture to its own bounds, so
    /// no pixel the Mac sends lands here at any orientation or zoom. A lock screen some process draws on an unlocked Mac
    /// cannot put this band on the phone (DESIGN 「잠김 상태 배너」, SR-15).
    @ViewBuilder
    private var macSignalBand: some View {
        VStack(spacing: 0) {
            if model.macState.locked == true {
                MacSignalRow(text: "Mac이 잠겨 있습니다. 암호는 열쇠 버튼의 입력칸으로 보내세요.", symbol: "lock.fill", tint: .blue)
            } else {
                MacSignalRow(text: model.macState.locked == false ? "Mac은 잠겨 있지 않습니다." : "Mac 잠김 상태를 확인하지 못했습니다.",
                             symbol: "display", tint: .gray)
            }
            if model.macState.inputPaused {
                MacSignalRow(text: "Mac 앞에서 마우스나 키보드를 쓰는 중이라 조작을 잠시 멈췄습니다.", symbol: "hand.raised", tint: .orange)
            }
        }
        .frame(minHeight: 44)
        .background(.black)
        .accessibilityElement(children: .combine)
        .allowsHitTesting(false)
    }

    private var toolbar: some View {
        HStack(spacing: 14) {
            Button { toolbarHidden = true } label: { Image(systemName: "chevron.compact.up") }
                .accessibilityLabel("도구 막대 접기")
            if zoomed {
                Button { zoomReset += 1 } label: { Image(systemName: "arrow.down.right.and.arrow.up.left") }
                    .accessibilityLabel("확대 원래대로")
            }
            Button {
                inputMode = inputMode == .touch ? .trackpad : .touch
                hint = inputMode.hint
            } label: {
                Label(inputMode.title, systemImage: inputMode.symbol).labelStyle(.titleAndIcon).font(.subheadline)
            }
            .accessibilityLabel("입력 방식: \(inputMode.title)")
            .accessibilityHint("누르면 \(inputMode == .touch ? ScreenInputMode.trackpad.title : ScreenInputMode.touch.title)(으)로 바꿉니다")
            Button { show(.password) } label: { Image(systemName: panel == .password ? "key.fill" : "key") }
                .accessibilityLabel("암호 입력")
            Button { show(.keyboard) } label: { Image(systemName: panel == .keyboard ? "keyboard.fill" : "keyboard") }
                .accessibilityLabel("키보드")
            if model.macState.choosesDisplay {
                Button { model.nextDisplay() } label: {
                    Label("\(model.macState.currentDisplay + 1)/\(model.macState.displayCount)", systemImage: "display.2")
                        .labelStyle(.titleAndIcon).font(.subheadline)
                }
                .accessibilityLabel("디스플레이 \(model.macState.currentDisplay + 1)/\(model.macState.displayCount)")
                .accessibilityHint("누르면 다음 디스플레이를 봅니다")
            }
            if model.sessionControls == true {
                Menu {
                    if model.macState.choosesDisplay {
                        Picker("디스플레이", selection: Binding(get: { model.macState.currentDisplay },
                                                            set: { model.selectDisplay($0) })) {
                            ForEach(0..<model.macState.displayCount, id: \.self) { Text("디스플레이 \($0 + 1)").tag($0) }
                        }
                        .pickerStyle(.inline)
                    }
                    Button(role: .destructive) { confirmingTurnOff = true } label: {
                        Label("Mac 화면 제어 끄기…", systemImage: "power")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("더 보기")
            }
            Button { model.end(); dismiss() } label: { Image(systemName: "xmark") }
                .accessibilityLabel("닫기")
        }
        .font(.title3)
        .padding(10)
        .foregroundStyle(.white)
        .background(.black.opacity(0.45), in: Capsule())
    }

    private func show(_ next: Panel) {
        panel = panel == next ? .none : next
        textFocused = panel == .keyboard
    }

    private var keyboardBar: some View {
        VStack(spacing: 8) {
            HStack {
                TextField(latched.isEmpty ? "Mac에 입력할 글자" : "조합할 글자 하나 (예: c)", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .focused($textFocused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { sendText(); textFocused = true }
                Button("보내기") { sendText() }.disabled(text.isEmpty)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(SpecialKey.modifiers, id: \.label) { modifier in
                        Toggle(modifier.label, isOn: Binding(
                            get: { latched.contains(modifier.flag) },
                            set: { on in if on { latched.insert(modifier.flag) } else { latched.remove(modifier.flag) } }))
                            .toggleStyle(.button)
                    }
                    ForEach(SpecialKey.all, id: \.label) { key in
                        Button(key.label) {
                            model.press(key.code, modifiers: latched)
                            latched = []
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
        .padding(10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(8)
    }

    /// The Mac's lock screen or a login field: typed as characters, never pasted, gone from the phone once sent. The
    /// Return key sends and then presses Return on the Mac, as typing the password there would.
    private var passwordBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SecretTextField(controller: secret, placeholder: "Mac에 입력할 암호") { sendSecret(thenReturn: true) }
                    .frame(height: 36)
                Button("보내기") { sendSecret(thenReturn: false) }.disabled(secret.isEmpty)
            }
            if let lock = lockLine {
                Label(lock.text, systemImage: lock.symbol)
                    .font(.caption)
                    .foregroundStyle(lock.warns ? AnyShapeStyle(.orange) : AnyShapeStyle(.primary))
            }
            Text("Mac에서 입력할 칸을 먼저 누르세요. 보내는 즉시 이 칸을 비우고, 자동 완성·받아쓰기·클립보드를 쓰지 않습니다. 키보드의 보내기는 Mac에서 Return까지 누릅니다.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(8)
    }

    /// Where a password goes, the Mac's own word on its lock state: a lock screen in the picture while the Mac says it
    /// is not locked was drawn by some process on it (DESIGN 「잠김 상태 배너」).
    private var lockLine: (text: String, symbol: String, warns: Bool)? {
        switch (model.sessionControls, model.macState.locked) {
        case (nil, _): nil
        case (false?, _): ("이 Mac은 잠김 상태를 알려 주지 않습니다. 화면의 잠금 화면이 진짜인지 이 휴대폰에서는 확인할 수 없습니다.", "lock.slash", true)
        case (true?, true?): ("Mac이 잠겨 있습니다. Mac이 직접 알려 온 상태입니다.", "lock.fill", false)
        case (true?, false?): ("Mac은 잠겨 있지 않습니다. 화면에 잠금 화면이 보이면 가짜일 수 있으니 Mac 암호를 입력하지 마세요.", "exclamationmark.triangle", true)
        case (true?, nil): ("Mac의 잠김 상태를 아직 받지 못했습니다.", "lock.trianglebadge.exclamationmark", true)
        }
    }

    private func sendText() {
        if !latched.isEmpty, text.count == 1, let code = MacKeyCode.code(for: Character(text.lowercased())) {
            model.press(code, modifiers: latched)
        } else {
            model.type(text)
        }
        latched = []
        text = ""
    }

    private func sendSecret(thenReturn: Bool) {
        let typed = secret.take()
        guard !typed.isEmpty else { return }
        model.type(typed)
        if thenReturn { model.press(SpecialKey.returnKey) }
    }
}

/// One line of the Mac's band: full width and opaque, its colour reaching the screen's edges behind the notch and the
/// Dynamic Island while the words stay inside the safe area.
private struct MacSignalRow: View {
    let text: String
    let symbol: String
    let tint: Color

    var body: some View {
        Label(text, systemImage: symbol)
            .font(.caption)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(tint, ignoresSafeAreaEdges: [.top, .horizontal])
    }
}

/// Touch: the Mac clicks where the finger taps. Trackpad: the finger pushes a cursor the phone draws.
enum ScreenInputMode: String {
    case touch, trackpad

    var title: String { self == .touch ? "터치" : "트랙패드" }
    var symbol: String { self == .touch ? "hand.point.up.left" : "cursorarrow.motionlines" }
    var hint: String {
        switch self {
        case .touch:
            "터치 — 누른 곳 클릭 · 길게 누른 채 끌기 · 두 손가락 탭은 오른쪽 클릭 · 두 손가락으로 스크롤 · 벌려서 확대, 한 손가락으로 화면 이동"
        case .trackpad:
            "트랙패드 — 한 손가락으로 커서 이동 · 탭은 클릭 · 두 손가락 탭은 오른쪽 클릭 · 두 손가락으로 스크롤 · 길게 누른 채 끌기"
        }
    }
}

struct SpecialKey {
    let label: String
    let code: UInt16
    static let returnKey: UInt16 = 0x24
    static let all = [SpecialKey(label: "⏎", code: returnKey), SpecialKey(label: "⌫", code: 0x33), SpecialKey(label: "⇥", code: 0x30),
                      SpecialKey(label: "esc", code: 0x35), SpecialKey(label: "space", code: 0x31),
                      SpecialKey(label: "←", code: 0x7B), SpecialKey(label: "→", code: 0x7C),
                      SpecialKey(label: "↑", code: 0x7E), SpecialKey(label: "↓", code: 0x7D)]
    static let modifiers: [(label: String, flag: KeyModifiers)] = [("⌘", .command), ("⌥", .option), ("⌃", .control), ("⇧", .shift)]
}

@MainActor @Observable
final class ScreenViewerModel {
    let layer = AVSampleBufferDisplayLayer()
    private(set) var status: String? = "Face ID로 이번 연결을 승인해 주세요."
    private(set) var ended = false
    /// What the Mac tells beside the picture: a pause while someone uses it, and from a version-2 Mac its lock state and
    /// displays. Each notice changes only its own part (`ScreenMacState`).
    private(set) var macState = ScreenMacState()
    /// Once connected: whether the Mac takes display, cursor and turn-off requests and tells its lock state (version 2).
    private(set) var sessionControls: Bool?
    /// Face ID is on screen. Its prompt makes the scene inactive for a moment, which must not end the session.
    private(set) var authenticating = false
    /// What Face ID last answered. A person who cancelled, or a failure, must not be read as leaving the foreground:
    /// the view stays so the reason can be read (`ScreenViewerLifecycle`).
    private(set) var lastApproval = ScreenViewerLifecycle.AuthOutcome.approved
    /// What the Face ID on screen is for: the one connection approval, or 「화면 제어 끄기」 inside a live session.
    private(set) var authPurpose = ScreenViewerLifecycle.AuthPurpose.connection
    /// Which attempt owns this model's work. Checked after every `await`, because ending a session that has no
    /// viewer yet cannot stop Face ID or a key exchange that is already in flight.
    private var gate = ScreenViewerSessionGate()
    /// The Mac's picture size, for mapping touches onto it.
    private(set) var videoSize = CGSize.zero
    private var viewer: ScreenViewer?
    /// Trackpad mode draws the phone's own cursor, so the Mac leaves its own out of the picture.
    private var hidesMacCursor = false
    /// Requests to the Mac go one after another, so a quick toggle cannot reach it out of order.
    private var requests: Task<Void, Never>?

    init() { layer.videoGravity = .resizeAspect }

    func run(mac: SavedScreenMac) async {
        guard let pinned = mac.pinned else { return finish("등록 정보가 손상되었습니다. 다시 등록해 주세요.") }
        // This attempt's generation: `end()` abandons it, so neither Face ID nor the key exchange can come back and
        // hand a live Mac session to a view that is already gone.
        let attempt = gate.start()
        do {
            let signer = try await withFaceID(.connection) {
                try await FaceIDApprovedSigner.approve(dataRepresentation: mac.deviceKey, reason: "\(mac.macName) 화면에 연결합니다")
            }
            guard gate.owns(attempt), !Task.isCancelled else { return }
            status = "Mac에 연결하는 중…"
            let viewer = try await Self.connect(mac: mac, pinned: pinned, signer: signer)
            // The session arrived for an attempt nobody owns any more: close the Mac's session instead of keeping it.
            guard gate.accepts(attempt), !Task.isCancelled else { return await viewer.close() }
            self.viewer = viewer
            sessionControls = viewer.macHasSessionControls
            // The Mac's capture starts with its cursor in the picture.
            if hidesMacCursor { request { try await viewer.setMacCursorHidden(true) } }
            let notices = Task { [weak self] in
                for await notice in viewer.notices { self?.macState.hear(notice) }
            }
            defer { notices.cancel() }
            status = "첫 화면을 기다리는 중…"
            for try await picture in viewer.pictures() {
                // The view went away mid-stream: stop rendering into a layer nobody shows and let `end()` close it.
                guard gate.owns(attempt), !Task.isCancelled else { return }
                if let format = CMSampleBufferGetFormatDescription(picture.sample) {
                    let size = CMVideoFormatDescriptionGetDimensions(format)
                    videoSize = CGSize(width: Int(size.width), height: Int(size.height))
                }
                let renderer = layer.sampleBufferRenderer
                if renderer.status == .failed {
                    renderer.flush()
                    try await viewer.requestKeyframe()
                    // `end()` can run while the Mac prepares that keyframe: never render into a view that is gone.
                    guard gate.owns(attempt), !Task.isCancelled else { return }
                }
                renderer.enqueue(picture.sample)
                status = nil
            }
            guard gate.owns(attempt) else { return }
            finish(Self.message(for: viewer.endReason))
        } catch {
            guard gate.owns(attempt) else { return }
            finish(Self.message(for: error))
        }
    }

    /// The address from registration first; the Bonjour host name when the Mac's address has changed. A second try
    /// only follows a failure before the key exchange, where the one-time Face ID approval is still unused.
    private static func connect(mac: SavedScreenMac, pinned: PinnedMac, signer: FaceIDApprovedSigner) async throws -> ScreenViewer {
        let port = NWEndpoint.Port(rawValue: mac.port)!
        do {
            return try await ScreenViewer.connect(to: .hostPort(host: .init(mac.address), port: port), mac: pinned, signer: signer)
        } catch TransportError.timedOut, TransportError.closed, TransportError.failed {
            return try await ScreenViewer.connect(to: .hostPort(host: .init(mac.hostName), port: port), mac: pinned, signer: signer)
        }
    }

    func send(_ event: InputEvent) { viewer?.input(event) }

    func press(_ code: UInt16, modifiers: KeyModifiers = []) {
        send(.key(code: code, isDown: true, modifiers: modifiers))
        send(.key(code: code, isDown: false, modifiers: modifiers))
    }

    /// Composed text in pieces the Mac accepts (256 bytes each, split between characters, no control characters —
    /// the Mac ends the session on a malformed piece).
    func type(_ text: String) {
        for piece in ScreenTextPieces.pieces(of: text, maxBytes: InputCodec.maxTextBytes) { send(.text(piece)) }
    }

    /// Trackpad mode: the phone draws the cursor, so the Mac leaves its own out of the picture; touch mode puts it back.
    /// Remembered before the session starts and sent once it has. A version-1 Mac keeps its cursor.
    func hideMacCursor(_ hidden: Bool) {
        guard hidden != hidesMacCursor else { return }
        hidesMacCursor = hidden
        guard let viewer else { return }
        request { try await viewer.setMacCursorHidden(hidden) }
    }

    /// The Mac's next display (version 2); `macState` names the one shown once the Mac has switched.
    func nextDisplay() {
        guard let viewer, sessionControls == true else { return }
        request { try await viewer.nextDisplay() }
    }

    func selectDisplay(_ index: Int) {
        guard let viewer, sessionControls == true, index != macState.currentDisplay else { return }
        request { try await viewer.selectDisplay(index) }
    }

    /// Turns screen control off at the Mac, as its menu's 「끄기」 does, after Face ID on this phone (biometrics only, no
    /// passcode). The Mac then ends the session with its reason, which `run` shows. Returns what to tell the person
    /// when nothing was turned off.
    func turnOffScreenControl(macName: String) async -> String? {
        guard let viewer, viewer.macHasSessionControls else { return "이 Mac은 휴대폰에서 끌 수 없습니다. Mac 앞에서 꺼 주세요." }
        let approval: BiometricApproval
        do {
            approval = try await withFaceID(.sessionControl) { try await BiometricApproval.request(reason: "\(macName)의 화면 제어를 끕니다") }
        } catch let error as LAError where error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel {
            return "Face ID 승인을 취소해 끄지 않았습니다."
        } catch {
            return "Face ID로 승인하지 못해 끄지 않았습니다. 이 일은 기기 암호로 대신할 수 없습니다."
        }
        guard self.viewer === viewer else { return "연결이 이미 끝나 끄지 않았습니다. Mac 앞에서 꺼 주세요." }
        do {
            try await viewer.turnOffScreenControl(approval: approval)
            return nil
        } catch {
            return "Mac에 끄기 요청을 보내지 못했습니다. Mac 앞에서 꺼 주세요."
        }
    }

    /// Ends this session. The generation is abandoned first, so a Face ID approval or a key exchange still in flight
    /// stops at its next gate check and closes whatever it receives — `viewer` being nil is not 「nothing to stop」.
    func end() {
        gate.invalidate()
        guard let viewer else { return }
        self.viewer = nil
        Task { await viewer.close() }
    }

    private func finish(_ message: String) {
        end()
        ended = true
        macState = ScreenMacState()
        sessionControls = nil
        status = message
    }

    /// Runs one Face ID approval and records its outcome before `authenticating` turns off, so the view's decision
    /// sees the answer and the flag change together.
    private func withFaceID<T>(_ purpose: ScreenViewerLifecycle.AuthPurpose, _ approve: () async throws -> T) async rethrows -> T {
        authPurpose = purpose
        authenticating = true
        do {
            let value = try await approve()
            lastApproval = .approved
            authenticating = false
            return value
        } catch {
            lastApproval = Self.cancelled(error) ? .cancelled : .failed
            authenticating = false
            throw error
        }
    }

    /// A person who dismissed the prompt, or the system taking it away, rather than a biometric failure.
    private static func cancelled(_ error: Error) -> Bool {
        guard let error = error as? LAError else { return false }
        return error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel
    }

    private func request(_ send: @escaping @Sendable () async throws -> Void) {
        let previous = requests
        requests = Task {
            await previous?.value
            // A request that cannot be sent means the connection is gone, and `run` says so.
            try? await send()
        }
    }

    /// The Mac names why it ended the session in its sealed goodbye; an older Mac names nothing.
    static func message(for reason: SessionEndReason?) -> String {
        switch reason {
        case .idle?: "10분 동안 조작이 없어 연결을 끝냈습니다."
        case .timeLimit?: "연결한 지 60분이 지나 끝났습니다. 다시 연결하면 Face ID로 한 번 더 승인합니다."
        case .turnedOff?: "Mac에서 화면 제어를 꺼서 연결이 끝났습니다."
        case .turnedOffFromDevice?: "이 기기에서 Mac 화면 제어를 껐습니다. 다시 켜려면 Mac 앞에서 켜 주세요."
        case .revoked?: "Mac에서 이 기기의 등록을 해지했습니다. 다시 쓰려면 Mac 앞에서 다시 등록해 주세요."
        case .replaced?: "이 기기의 새 연결이 이어받아 이 연결은 끝났습니다."
        case .endedAtMac?, nil: "Mac이 연결을 끝냈습니다."
        }
    }

    static func message(for error: Error) -> String {
        switch error {
        case let error as LAError where error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel:
            "Face ID 승인을 취소했습니다."
        case is LAError:
            "Face ID로 승인하지 못했습니다. 이 연결은 기기 암호로 대신할 수 없습니다."
        case TransportError.timedOut, TransportError.failed:
            "Mac에 연결하지 못했습니다. 같은 Wi‑Fi인지, Mac의 AgentsToZ Screen이 켜져 있는지 확인해 주세요."
        case HandshakeError.unknownDevice:
            // The Mac answers both the same way on purpose.
            "Mac에서 이 기기의 등록이 해지되었거나 90일 동안 쓰지 않아 만료되었습니다. Mac 앞에서 다시 등록해 주세요."
        case HandshakeError.badSignature, HandshakeError.badConfirmation:
            "등록한 Mac이 아닙니다. 연결하지 않았습니다."
        default:
            "연결이 끊겼습니다."
        }
    }
}

/// The picture and the touch surface over it. The gesture math lives in `ScreenViewport` (AgentsToZCore) and is
/// checked there; this only turns UIKit gestures into its calls and its results into input events.
struct ScreenSurface: UIViewRepresentable {
    let model: ScreenViewerModel
    let mode: ScreenInputMode
    /// Bumped by the toolbar's reset button.
    let zoomReset: Int
    /// A bar's text field is open: tapping the Mac (say, its password field) leaves the phone keyboard up.
    let keepsTextFocus: Bool
    let zoomChanged: @MainActor (Bool) -> Void

    func makeUIView(context: Context) -> SurfaceView {
        let view = SurfaceView(hosted: model.layer)
        view.send = { [weak model] in model?.send($0) }
        view.videoSize = { [weak model] in model?.videoSize ?? .zero }
        return view
    }

    func updateUIView(_ view: SurfaceView, context: Context) {
        view.zoomChanged = zoomChanged
        view.keepsTextFocus = keepsTextFocus
        // Reading videoSize here makes SwiftUI call again when the Mac changes resolution.
        view.update(videoSize: model.videoSize, mode: mode, zoomReset: zoomReset)
    }

    final class SurfaceView: UIView, UIGestureRecognizerDelegate {
        private let hosted: CALayer
        private let cursorLayer = CAShapeLayer()
        var send: @MainActor (InputEvent) -> Void = { _ in }
        var videoSize: @MainActor () -> CGSize = { .zero }
        var zoomChanged: @MainActor (Bool) -> Void = { _ in }
        var keepsTextFocus = false

        private var mode = ScreenInputMode.touch
        private var viewport = ScreenViewport()
        private var reportedZoomed = false
        private var appliedZoomReset = 0
        /// The Mac position last sent: where the Mac's pointer is, and the trackpad cursor.
        private var cursor = CGPoint(x: 0.5, y: 0.5)

        // Pointer moves and scrolls wait for the next paced display tick, one of each (`MotionPacer`); clicks and keys
        // send what is waiting first, so they land where the pointer was last seen.
        private var pendingMove: CGPoint?
        private var scroller = ScrollScaler(maximumDelta: InputCodec.maxScrollDelta)
        private var momentum: ScrollMomentum?
        private var pacer = MotionPacer()
        private var lastTick: CFTimeInterval?
        private var displayLink: CADisplayLink?

        private var tapSnap = TapSnap()
        /// The touch that started the current one-finger gesture came from an iPad mouse or trackpad.
        private var pointerTouch = false
        private var lastPan = CGPoint.zero
        private var pointerDragging = false
        private var holding = false
        private var lastHold: (location: CGPoint, time: CFTimeInterval)?
        private var twoFinger = TwoFingerIntent.undecided
        private var lastScroll = CGPoint.zero
        private var wheelScroll = false
        private var lastPinchScale: CGFloat = 1
        private var lastPinchCentre: CGPoint?

        private let tap = UITapGestureRecognizer()
        private let secondaryClick = UITapGestureRecognizer()
        private let twoFingerTap = UITapGestureRecognizer()
        private let twoFingerDoubleTap = UITapGestureRecognizer()
        private let hold = UILongPressGestureRecognizer()
        private let oneFinger = UIPanGestureRecognizer()
        private let twoFingerPan = UIPanGestureRecognizer()
        private let pinch = UIPinchGestureRecognizer()
        private let hover = UIHoverGestureRecognizer()

        init(hosted: CALayer) {
            self.hosted = hosted
            super.init(frame: .zero)
            clipsToBounds = true
            layer.addSublayer(hosted)
            cursorLayer.path = Self.arrow
            cursorLayer.bounds = CGRect(x: 0, y: 0, width: 13, height: 20)
            cursorLayer.anchorPoint = .zero
            cursorLayer.fillColor = UIColor.white.cgColor
            cursorLayer.strokeColor = UIColor.black.cgColor
            cursorLayer.lineWidth = 1
            cursorLayer.shadowOpacity = 0.4
            cursorLayer.shadowRadius = 1.5
            cursorLayer.shadowOffset = CGSize(width: 0, height: 1)
            cursorLayer.isHidden = true
            layer.addSublayer(cursorLayer)

            tap.addTarget(self, action: #selector(tapped))
            secondaryClick.buttonMaskRequired = .secondary
            secondaryClick.addTarget(self, action: #selector(secondaryClicked))
            twoFingerTap.numberOfTouchesRequired = 2
            twoFingerTap.addTarget(self, action: #selector(twoFingerTapped))
            twoFingerDoubleTap.numberOfTouchesRequired = 2
            twoFingerDoubleTap.numberOfTapsRequired = 2
            twoFingerDoubleTap.addTarget(self, action: #selector(twoFingerDoubleTapped))
            twoFingerTap.require(toFail: twoFingerDoubleTap)
            hold.minimumPressDuration = 0.35
            hold.allowableMovement = 12
            hold.addTarget(self, action: #selector(held))
            oneFinger.maximumNumberOfTouches = 1
            oneFinger.addTarget(self, action: #selector(oneFingerPanned))
            twoFingerPan.minimumNumberOfTouches = 2
            twoFingerPan.allowedScrollTypesMask = .all   // trackpad and mouse wheel on iPad
            twoFingerPan.addTarget(self, action: #selector(twoFingerPanned))
            pinch.addTarget(self, action: #selector(pinched))
            hover.addTarget(self, action: #selector(hovered))
            for recognizer in [tap, secondaryClick, twoFingerTap, twoFingerDoubleTap, hold, oneFinger, twoFingerPan, pinch, hover] {
                recognizer.delegate = self
                addGestureRecognizer(recognizer)
            }
        }

        required init?(coder: NSCoder) { nil }

        override func layoutSubviews() {
            super.layoutSubviews()
            syncViewport()
            applyViewport()
        }

        override var canBecomeFirstResponder: Bool { true }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil {
                becomeFirstResponder()
                if displayLink == nil {
                    let link = CADisplayLink(target: LinkTarget(view: self), selector: #selector(LinkTarget.tick(_:)))
                    link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
                    link.isPaused = true
                    link.add(to: .main, forMode: .common)
                    displayLink = link
                }
            } else {
                displayLink?.invalidate()
                displayLink = nil
            }
        }

        func update(videoSize: CGSize, mode: ScreenInputMode, zoomReset: Int) {
            if zoomReset != appliedZoomReset {
                appliedZoomReset = zoomReset
                viewport.reset()
            }
            if mode != self.mode {
                self.mode = mode
                tapSnap.reset()
            }
            viewport.resize(bounds: bounds.size, videoSize: videoSize)
            if mode == .trackpad { viewport.follow(cursor, margin: followMargin) }
            applyViewport()
        }

        // MARK: Mapping and output

        private var followMargin: CGFloat { min(56, min(bounds.width, bounds.height) * 0.15) }

        private func syncViewport() { viewport.resize(bounds: bounds.size, videoSize: videoSize()) }

        private func applyViewport() {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            hosted.frame = bounds.isEmpty ? bounds : viewport.contentFrame
            cursorLayer.isHidden = mode != .trackpad || viewport.pictureRect.isEmpty
            cursorLayer.position = viewport.viewPoint(for: cursor)
            CATransaction.commit()
            if viewport.isZoomed != reportedZoomed {
                reportedZoomed = viewport.isZoomed
                let zoomed = reportedZoomed, report = zoomChanged
                // Not during SwiftUI's update pass, which may be what reset the zoom.
                Task { @MainActor in report(zoomed) }
            }
        }

        private func move(to mac: CGPoint) {
            cursor = mac.clampedToUnit
            pendingMove = cursor
            wake()
        }

        private func flushMotion() {
            if let move = pendingMove {
                pendingMove = nil
                send(.pointerMove(x: Double(move.x), y: Double(move.y)))
            }
            if let delta = scroller.take() { send(.scroll(dx: delta.dx, dy: delta.dy)) }
        }

        private func click(_ button: MouseButton, at mac: CGPoint) {
            move(to: mac)
            flushMotion()
            send(.button(button, isDown: true))
            send(.button(button, isDown: false))
            applyViewport()
        }

        private func wake() { displayLink?.isPaused = false }

        fileprivate func tick(_ link: CADisplayLink) {
            let now = link.timestamp
            let elapsed = lastTick.map { now - $0 } ?? 1.0 / 60
            lastTick = now
            if var glide = momentum {
                if let step = glide.step(elapsed) {
                    scroller.add(step, speed: glide.speed, pixelsPerPoint: viewport.pixelsPerPoint)
                    momentum = glide
                } else {
                    momentum = nil
                }
            }
            if pacer.ready(at: now) { flushMotion() }
            if pendingMove == nil, momentum == nil, scroller.isEmpty {
                link.isPaused = true
                lastTick = nil
            }
        }

        // MARK: Gestures

        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            // Touching the glass stops a glide, as on the phone's own lists.
            momentum = nil
            if recognizer === tap || recognizer === hold || recognizer === oneFinger {
                pointerTouch = touch.type == .indirectPointer
            }
            return true
        }

        func gestureRecognizer(_ recognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            let continuous: [UIGestureRecognizer] = [oneFinger, twoFingerPan, pinch, hover]
            return continuous.contains(recognizer) && continuous.contains(other)
        }

        @objc private func tapped(_ gesture: UITapGestureRecognizer) {
            // Back to the hardware keyboard, unless a bar is open for typing.
            if !keepsTextFocus { becomeFirstResponder() }
            syncViewport()
            if mode == .trackpad, !pointerTouch { return click(.left, at: cursor) }
            let location = gesture.location(in: self)
            guard let mac = viewport.macPoint(at: location) else { return }
            click(.left, at: tapSnap.position(for: mac, at: location, time: CACurrentMediaTime(),
                                              pictureSize: viewport.videoSize))
        }

        /// The secondary button of an iPad mouse or trackpad: a right click where the pointer is.
        @objc private func secondaryClicked(_ gesture: UITapGestureRecognizer) {
            syncViewport()
            guard let mac = viewport.macPoint(at: gesture.location(in: self)) else { return }
            click(.right, at: mac)
        }

        @objc private func twoFingerTapped(_ gesture: UITapGestureRecognizer) {
            syncViewport()
            if mode == .trackpad { return click(.right, at: cursor) }
            guard let mac = viewport.macPoint(at: gesture.location(in: self)) else { return }
            click(.right, at: mac)
        }

        @objc private func twoFingerDoubleTapped(_ gesture: UITapGestureRecognizer) {
            viewport.reset()
            applyViewport()
        }

        /// Hold, then drag: the left button stays down until the finger lifts.
        @objc private func held(_ gesture: UILongPressGestureRecognizer) {
            let location = gesture.location(in: self)
            let now = CACurrentMediaTime()
            switch gesture.state {
            case .began:
                syncViewport()
                let start: CGPoint?
                if mode == .trackpad, !pointerTouch {
                    start = cursor
                } else {
                    start = viewport.macPoint(at: location)
                }
                guard let start else { return }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                move(to: start)
                flushMotion()
                send(.button(.left, isDown: true))
                holding = true
                lastHold = (location, now)
                applyViewport()
            case .changed:
                guard holding else { return }
                if mode == .trackpad, !pointerTouch, let last = lastHold {
                    let delta = CGPoint(x: location.x - last.location.x, y: location.y - last.location.y)
                    let speed = hypot(delta.x, delta.y) / max(now - last.time, 1.0 / 240)
                    pushCursor(by: delta, speed: speed)
                } else if let mac = viewport.macPoint(at: location, clamped: true) {
                    move(to: mac)
                }
                lastHold = (location, now)
                applyViewport()
            default:
                guard holding else { return }
                holding = false
                lastHold = nil
                flushMotion()
                send(.button(.left, isDown: false))
            }
        }

        /// Touch mode: moves the zoomed picture. Trackpad mode: pushes the cursor. An iPad mouse drags with the button
        /// down, as a mouse does.
        @objc private func oneFingerPanned(_ gesture: UIPanGestureRecognizer) {
            let translation = gesture.translation(in: self)
            let delta = CGPoint(x: translation.x - lastPan.x, y: translation.y - lastPan.y)
            lastPan = translation
            switch gesture.state {
            case .began where pointerTouch:
                syncViewport()
                guard let mac = viewport.macPoint(at: gesture.location(in: self)) else { return }
                move(to: mac)
                flushMotion()
                send(.button(.left, isDown: true))
                pointerDragging = true
            case .began, .changed:
                // From .began too: the finger already moved about ten points before the pan began.
                syncViewport()
                if pointerDragging {
                    if let mac = viewport.macPoint(at: gesture.location(in: self), clamped: true) { move(to: mac) }
                } else if isActive(twoFingerPan) || isActive(pinch) {
                    return   // a second finger landed: the two-finger gesture has it
                } else if mode == .trackpad {
                    let velocity = gesture.velocity(in: self)
                    pushCursor(by: delta, speed: hypot(velocity.x, velocity.y))
                } else {
                    viewport.pan(by: delta)
                }
                applyViewport()
            default:
                lastPan = .zero
                guard pointerDragging else { return }
                pointerDragging = false
                flushMotion()
                send(.button(.left, isDown: false))
            }
        }

        private func pushCursor(by delta: CGPoint, speed: CGFloat) {
            let next = PointerAcceleration.trackpad.move(cursor, by: delta, speed: speed, pictureSize: viewport.pictureRect.size)
            move(to: next)
            viewport.follow(next, margin: followMargin)
        }

        /// Two fingers either zoom or scroll, decided once per gesture (`TwoFingerIntent`).
        @objc private func twoFingerPanned(_ gesture: UIPanGestureRecognizer) {
            switch gesture.state {
            case .began:
                if !isActive(pinch) { twoFinger = .undecided }
                momentum = nil
                lastScroll = .zero
                // No touches: a mouse wheel or a two-finger trackpad scroll on iPad, never a pinch.
                wheelScroll = gesture.numberOfTouches == 0
                if wheelScroll { twoFinger = .scroll }
                decideTwoFinger()
                scrollIfDecided(gesture)
            case .changed:
                decideTwoFinger()
                scrollIfDecided(gesture)
            case .ended:
                scrollIfDecided(gesture)
                if twoFinger == .scroll, !wheelScroll {
                    momentum = ScrollMomentum(velocity: gesture.velocity(in: self))
                    wake()
                }
                if !isActive(pinch) { twoFinger = .undecided }
            default:
                if !isActive(pinch) { twoFinger = .undecided }
            }
        }

        @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
            switch gesture.state {
            case .began:
                if !isActive(twoFingerPan) { twoFinger = .undecided }
                momentum = nil
                lastPinchScale = 1
                lastPinchCentre = gesture.numberOfTouches >= 2 ? gesture.location(in: self) : nil
                decideTwoFinger()
                zoomIfDecided(gesture)
            case .changed:
                decideTwoFinger()
                zoomIfDecided(gesture)
            default:
                lastPinchCentre = nil
                if !isActive(twoFingerPan) { twoFinger = .undecided }
            }
        }

        private func decideTwoFinger() {
            guard twoFinger == .undecided else { return }
            let scale = isActive(pinch) ? pinch.scale : 1
            let translation = isActive(twoFingerPan) ? twoFingerPan.translation(in: self) : .zero
            twoFinger = TwoFingerIntent.classify(scale: scale, travel: hypot(translation.x, translation.y))
            // Touch mode scrolls what is under the fingers: the Mac scrolls the view under its pointer.
            if twoFinger == .scroll, mode == .touch, twoFingerPan.numberOfTouches >= 2 {
                syncViewport()
                if let mac = viewport.macPoint(at: twoFingerPan.location(in: self)) { move(to: mac) }
            }
        }

        private func scrollIfDecided(_ gesture: UIPanGestureRecognizer) {
            guard twoFinger == .scroll else { return }
            let translation = gesture.translation(in: self)
            let delta = CGPoint(x: translation.x - lastScroll.x, y: translation.y - lastScroll.y)
            lastScroll = translation
            let velocity = gesture.velocity(in: self)
            syncViewport()
            scroller.add(delta, speed: hypot(velocity.x, velocity.y), pixelsPerPoint: viewport.pixelsPerPoint)
            wake()
        }

        private func zoomIfDecided(_ gesture: UIPinchGestureRecognizer) {
            guard twoFinger == .zoom else { return }
            syncViewport()
            let factor = gesture.scale / lastPinchScale
            lastPinchScale = gesture.scale
            if mode == .trackpad {
                // Around the cursor, which stays put and in view.
                viewport.zoom(by: factor, around: viewport.viewPoint(for: cursor))
                viewport.follow(cursor, margin: followMargin)
            } else {
                // Around the fingers, and the picture moves with them.
                let centre = gesture.location(in: self)
                viewport.zoom(by: factor, around: centre)
                if gesture.numberOfTouches >= 2 {
                    if let last = lastPinchCentre { viewport.pan(by: CGPoint(x: centre.x - last.x, y: centre.y - last.y)) }
                    lastPinchCentre = centre
                } else {
                    lastPinchCentre = nil
                }
            }
            applyViewport()
        }

        private func isActive(_ recognizer: UIGestureRecognizer) -> Bool {
            recognizer.state == .began || recognizer.state == .changed
        }

        /// An iPad mouse or trackpad pointer moves the Mac's pointer to where it is.
        @objc private func hovered(_ gesture: UIHoverGestureRecognizer) {
            guard gesture.state == .began || gesture.state == .changed else { return }
            syncViewport()
            if let mac = viewport.macPoint(at: gesture.location(in: self)) {
                move(to: mac)
                applyViewport()
            }
        }

        // A hardware keyboard: keys go to the Mac by position, with their modifiers, so shortcuts work and the Mac's
        // own input source composes Korean.
        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            if !forward(presses, isDown: true) { super.pressesBegan(presses, with: event) }
        }

        override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            if !forward(presses, isDown: false) { super.pressesEnded(presses, with: event) }
        }

        override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            if !forward(presses, isDown: false) { super.pressesCancelled(presses, with: event) }
        }

        private func forward(_ presses: Set<UIPress>, isDown: Bool) -> Bool {
            var handled = false
            for press in presses {
                guard let key = press.key, let code = MacKeyCode.code(for: key.keyCode) else { continue }
                if !handled { flushMotion() }
                send(.key(code: code, isDown: isDown, modifiers: MacKeyCode.modifiers(key.modifierFlags)))
                handled = true
            }
            return handled
        }

        /// The trackpad cursor, tip at the origin.
        private static let arrow: CGPath = {
            let path = CGMutablePath()
            path.addLines(between: [CGPoint(x: 0, y: 0), CGPoint(x: 0, y: 17), CGPoint(x: 4.2, y: 13.2), CGPoint(x: 7, y: 19.5),
                                    CGPoint(x: 9.8, y: 18.3), CGPoint(x: 7.1, y: 12.2), CGPoint(x: 12.5, y: 12.2)])
            path.closeSubpath()
            return path
        }()
    }
}

/// The display link holds its target strongly; this keeps it from holding the view.
private final class LinkTarget: NSObject {
    private weak var view: ScreenSurface.SurfaceView?
    init(view: ScreenSurface.SurfaceView) { self.view = view }
    @MainActor @objc func tick(_ link: CADisplayLink) { view?.tick(link) }
}

/// Holds the password field so the bar's button can take its text. The text lives only in the field until sent.
@MainActor @Observable
final class SecretFieldController {
    @ObservationIgnored fileprivate weak var field: UITextField?
    fileprivate(set) var isEmpty = true

    /// The typed secret, cleared from the field at once.
    func take() -> String {
        let typed = field?.text ?? ""
        clear()
        return typed
    }

    func clear() {
        field?.text = ""
        isEmpty = true
    }
}

/// A password field that never touches the clipboard (SR-17): no copy, cut or paste, no text drag or drop, no
/// autocorrection, predictions or learning. A secure field also has no dictation.
struct SecretTextField: UIViewRepresentable {
    let controller: SecretFieldController
    let placeholder: String
    var submit: @MainActor () -> Void

    func makeUIView(context: Context) -> NoClipboardTextField {
        let field = NoClipboardTextField()
        field.isSecureTextEntry = true
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        field.inlinePredictionType = .no
        field.textContentType = nil
        field.returnKeyType = .send
        field.borderStyle = .roundedRect
        field.placeholder = placeholder
        field.pasteConfiguration = nil
        field.textDragInteraction?.isEnabled = false
        field.textDropDelegate = context.coordinator
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        controller.field = field
        Task { @MainActor in field.becomeFirstResponder() }
        return field
    }

    func updateUIView(_ field: NoClipboardTextField, context: Context) {
        context.coordinator.submit = submit
    }

    static func dismantleUIView(_ field: NoClipboardTextField, coordinator: Coordinator) {
        coordinator.controller.clear()
        field.text = ""
    }

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller, submit: submit) }

    @MainActor final class Coordinator: NSObject, UITextFieldDelegate, UITextDropDelegate {
        let controller: SecretFieldController
        var submit: @MainActor () -> Void

        init(controller: SecretFieldController, submit: @escaping @MainActor () -> Void) {
            self.controller = controller
            self.submit = submit
        }

        @objc func changed(_ field: UITextField) { controller.isEmpty = field.text?.isEmpty ?? true }

        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            submit()
            return false
        }

        func textDroppableView(_ view: UIView & UITextDroppable, proposalForDrop drop: UITextDropRequest) -> UITextDropProposal {
            UITextDropProposal(operation: .forbidden)
        }
    }
}

final class NoClipboardTextField: UITextField {
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool { false }
    /// No three-finger copy, cut, paste or undo.
    override var editingInteractionConfiguration: UIEditingInteractionConfiguration { .none }
}

/// HID usage → macOS virtual key code, for the keys a remote session needs. Modifier keys travel as flags on the
/// keys they modify, not as keys of their own.
enum MacKeyCode {
    static func code(for usage: UIKeyboardHIDUsage) -> UInt16? { table[usage.rawValue] }

    /// The key for a lowercase ASCII letter or digit, for shortcuts typed on the bar (⌘ then c).
    static func code(for character: Character) -> UInt16? {
        guard let ascii = character.asciiValue else { return nil }
        switch ascii {
        case UInt8(ascii: "a")...UInt8(ascii: "z"): return table[0x04 + Int(ascii - UInt8(ascii: "a"))]
        case UInt8(ascii: "1")...UInt8(ascii: "9"): return table[0x1E + Int(ascii - UInt8(ascii: "1"))]
        case UInt8(ascii: "0"): return table[0x27]
        default: return nil
        }
    }

    static func modifiers(_ flags: UIKeyModifierFlags) -> KeyModifiers {
        var modifiers: KeyModifiers = []
        if flags.contains(.shift) { modifiers.insert(.shift) }
        if flags.contains(.control) { modifiers.insert(.control) }
        if flags.contains(.alternate) { modifiers.insert(.option) }
        if flags.contains(.command) { modifiers.insert(.command) }
        return modifiers
    }

    private static let table: [Int: UInt16] = {
        // Letters a…z (HID 0x04…0x1D) in macOS ANSI key codes.
        let letters: [UInt16] = [0x00, 0x0B, 0x08, 0x02, 0x0E, 0x03, 0x05, 0x04, 0x22, 0x26, 0x28, 0x25, 0x2E,
                                 0x2D, 0x1F, 0x23, 0x0C, 0x0F, 0x01, 0x11, 0x20, 0x09, 0x0D, 0x07, 0x10, 0x06]
        // Digits 1…9, 0 (HID 0x1E…0x27).
        let digits: [UInt16] = [0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19, 0x1D]
        // F1…F12 (HID 0x3A…0x45).
        let functions: [UInt16] = [0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F]
        var table: [Int: UInt16] = [
            0x28: 0x24, 0x29: 0x35, 0x2A: 0x33, 0x2B: 0x30, 0x2C: 0x31, 0x2D: 0x1B, 0x2E: 0x18, 0x2F: 0x21, 0x30: 0x1E,
            0x31: 0x2A, 0x33: 0x29, 0x34: 0x27, 0x35: 0x32, 0x36: 0x2B, 0x37: 0x2F, 0x38: 0x2C, 0x39: 0x39,
            0x4A: 0x73, 0x4B: 0x74, 0x4C: 0x75, 0x4D: 0x77, 0x4E: 0x79, 0x4F: 0x7C, 0x50: 0x7B, 0x51: 0x7D, 0x52: 0x7E,
        ]
        for (index, code) in letters.enumerated() { table[0x04 + index] = code }
        for (index, code) in digits.enumerated() { table[0x1E + index] = code }
        for (index, code) in functions.enumerated() { table[0x3A + index] = code }
        return table
    }()
}
