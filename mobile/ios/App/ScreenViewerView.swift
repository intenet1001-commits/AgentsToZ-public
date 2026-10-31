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
    var route: ScreenConnectionRoute = .automatic

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @State private var model = ScreenViewerModel()
    /// A preference, nothing sensitive: the next session opens in the same mode.
    @AppStorage("screenControl.inputMode") private var inputMode = ScreenInputMode.touch
    @State private var panel = Panel.none
    @State private var text = ""
    @State private var textReturnDraft = ScreenTextReturnDraft()
    @State private var textIsComposing = false
    /// ⌘⌥⌃⇧ chosen on the bar, applied to the next special key or single letter, then cleared.
    @State private var latched: KeyModifiers = []
    @State private var secret = SecretFieldController()
    @State private var zoomed = false
    @State private var zoomReset = 0
    @State private var toolbarHidden = false
    @AppStorage("screenControl.controlsGuideSeen") private var controlsGuideSeen = false
    @State private var showingControlsGuide = false
    @State private var keyboardAfterGuide = false
    @State private var hint: String?
    @State private var confirmingTurnOff = false
    /// When this session may stay and when it must end (`ScreenViewerLifecycle`, AgentsToZCore). Face ID's own sheet
    /// and the return to the active phase arrive in either order on a real device, so the decision is one tested
    /// state machine here rather than a remembered phase read after a fixed wait.
    @State private var lifecycle = ScreenViewerLifecycle()
    /// The bounded wait this decision armed; its task carries the token back so a stale deadline decides nothing.
    @State private var graceToken: UInt64?
    @State private var textFocused = false

    enum Panel { case none, keyboard, password, scroll }

    private var screenContent: some View {
        VStack(spacing: 0) {
            macSignalBand
            ZStack {
                ScreenSurface(model: model, mode: inputMode, zoomReset: zoomReset, keepsTextFocus: panel == .keyboard || panel == .password) { zoomed = $0 }
                if let status = model.status {
                    VStack(spacing: 12) {
                        Text(status).foregroundStyle(.white).multilineTextAlignment(.center)
                        if model.ended {
                            if model.needsBiometricRecovery {
                                Button("\(BiometricApproval.methodName) 잠김 해제") { Task { await model.recoverBiometricLockout() } }
                                    .buttonStyle(.borderedProminent).disabled(model.authenticating)
                                    .accessibilityIdentifier("recoverScreenBiometrics")
                            }
                            Button("닫기") { dismiss() }.buttonStyle(.borderedProminent).disabled(model.authenticating)
                        }
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
            case .scroll: scrollPad
            }
        }
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        // An edge swipe reaches the Mac first instead of pulling down Control Center mid-drag.
        .defersSystemGestures(on: .all)
    }

    private var runningContent: some View {
        screenContent
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
            await model.run(mac: mac, route: route)
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
            if showing {
                if hint == nil { hint = inputMode.hint }
                if !controlsGuideSeen { showingControlsGuide = true }
            }
        }
        .onChange(of: model.textReturnCompletion) { _, completion in applyTextReturnCompletion(completion) }
    }

    var body: some View {
        runningContent
        .sheet(isPresented: $showingControlsGuide, onDismiss: {
            controlsGuideSeen = true
            if keyboardAfterGuide { keyboardAfterGuide = false; show(.keyboard) }
        }) {
            controlsGuide
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
            Button("기기 인증으로 확인하고 끄기", role: .destructive) {
                Task { if let failure = await model.turnOffScreenControl(macName: mac.macName, authentication: mac.authentication) { hint = failure } }
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
            if let path = model.connectionPath {
                Text("연결 경로: \(path)").font(.caption).foregroundStyle(.white).padding(4)
            }
            if model.macState.locked == true {
                MacSignalRow(text: "Mac이 잠겨 있습니다. 보안 입력 중에는 원격 조작이 제한될 수 있습니다.", symbol: "lock.fill", tint: .blue)
            } else {
                MacSignalRow(text: model.macState.locked == false ? "Mac은 잠겨 있지 않습니다." : "Mac 잠김 상태를 확인하지 못했습니다.",
                             symbol: "display", tint: .gray)
            }
            if let reason = model.macState.inputAvailability, reason != .ready {
                MacSignalRow(text: reason.viewerMessage, symbol: "hand.raised", tint: .orange)
            } else if model.macState.inputPaused {
                MacSignalRow(text: "Mac에서 조작을 잠시 멈췄습니다. Mac의 입력·권한 상태를 확인하세요.", symbol: "hand.raised", tint: .orange)
            }
            if let notice = model.desktopNotice {
                MacSignalRow(text: notice, symbol: "keyboard", tint: .gray)
            }
        }
        .frame(minHeight: 44)
        .background(.black)
        .accessibilityElement(children: .combine)
        .allowsHitTesting(false)
    }

    private var toolbar: some View {
        ViewThatFits(in: .horizontal) {
            toolbarActions(showLabels: true)
            toolbarActions(showLabels: false)
        }
        .font(.title3)
        .padding(8)
        .foregroundStyle(.white)
        .background(.black.opacity(0.6), in: Capsule())
    }

    private func toolbarActions(showLabels: Bool) -> some View {
        HStack(spacing: showLabels ? 10 : 4) {
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
            Button { show(.keyboard) } label: {
                if showLabels {
                    Label("텍스트 입력", systemImage: panel == .keyboard ? "keyboard.fill" : "keyboard")
                        .font(.subheadline)
                } else { Image(systemName: panel == .keyboard ? "keyboard.fill" : "keyboard") }
            }
            .accessibilityLabel("텍스트 입력 · 키보드")
            Button { show(.scroll) } label: {
                if showLabels { Label("스크롤", systemImage: "arrow.up.and.down.and.arrow.left.and.right").font(.subheadline) }
                else { Image(systemName: "arrow.up.and.down.and.arrow.left.and.right") }
            }
            .accessibilityLabel("스크롤 버튼 열기")
            .accessibilityIdentifier("screenScrollPad")
            Button {
                panel = .none
                textIsComposing = false
                textFocused = false
                showingControlsGuide = true
            } label: {
                if showLabels { Label("조작법", systemImage: "questionmark.circle").font(.subheadline) }
                else { Image(systemName: "questionmark.circle") }
            }
            .accessibilityLabel("Mac 화면 조작법")
            .accessibilityIdentifier("screenControlsGuide")
            if model.macState.choosesDisplay {
                Button { model.nextDisplay() } label: {
                    Label("\(model.macState.currentDisplay + 1)/\(model.macState.displayCount)", systemImage: "display.2")
                        .labelStyle(.titleAndIcon).font(.subheadline)
                }
                .accessibilityLabel("디스플레이 \(model.macState.currentDisplay + 1)/\(model.macState.displayCount)")
                .accessibilityHint("누르면 다음 디스플레이를 봅니다")
            }
            if model.sessionControls == true {
                if model.desktopControls {
                    Menu {
                        Button("이전 Space", systemImage: "arrow.left") { model.navigateSpace(.previous) }
                        Button("다음 Space", systemImage: "arrow.right") { model.navigateSpace(.next) }
                        ForEach(1...3, id: \.self) { number in
                            Button("데스크탑 \(number)") { model.selectDesktop(number) }
                        }
                        Button("전체 Spaces · Mission Control", systemImage: "rectangle.3.group") { model.navigateSpace(.missionControl) }
                        Text("Mac의 활성 화면과 Mission Control 단축키 설정을 따릅니다. 여러 디스플레이에서는 원하는 화면을 먼저 클릭하세요.")
                    } label: { Image(systemName: "rectangle.3.group") }
                    .accessibilityLabel("Spaces 전환")
                    .accessibilityIdentifier("screenSpaces")
                    .disabled(!model.macState.canSendInput || model.macState.locked != false)
                }
                Menu {
                    if model.desktopControls {
                        Picker("영상 품질", selection: Binding(get: { model.macState.videoQuality ?? .sharp }, set: { model.setVideoQuality($0) })) {
                            Text("데이터 절약 · 1Mbps").tag(ScreenVideoQuality.saver)
                            Text("균형 · 2Mbps").tag(ScreenVideoQuality.balanced)
                            Text("선명 · 4Mbps").tag(ScreenVideoQuality.sharp)
                        }
                    }
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
        .frame(minHeight: 44)
        .fixedSize(horizontal: true, vertical: false)
    }

    private var controlsGuide: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("입력 방식", selection: $inputMode) {
                        Text("터치").tag(ScreenInputMode.touch)
                        Text("트랙패드").tag(ScreenInputMode.trackpad)
                    }
                    .pickerStyle(.segmented)
                    Text(inputMode == .touch ? "Mac 화면에서 누른 위치를 바로 클릭합니다."
                         : "화면 전체를 트랙패드처럼 쓰고, 포인터가 있는 곳을 클릭합니다.")
                } header: { Text("현재 모드: \(inputMode.title)") }
                Section("클릭 · 이동") {
                    Label(inputMode == .touch ? "한 손가락으로 원하는 곳 톡: 클릭"
                          : "한 손가락으로 밀기: 포인터 이동 · 톡: 클릭", systemImage: inputMode.symbol)
                    Label("두 번 톡: 더블클릭 · 두 손가락으로 톡: 우클릭", systemImage: "computermouse")
                    Label("한 손가락으로 길게 누른 채 움직이기: 드래그", systemImage: "hand.draw")
                }
                Section("스크롤 · 확대") {
                    Label("두 손가락을 함께 위아래 또는 좌우로 밀기: Mac 창 스크롤", systemImage: "arrow.up.and.down.and.arrow.left.and.right")
                    Text(inputMode == .trackpad ? "스크롤할 창 위로 포인터를 먼저 옮기세요."
                         : "스크롤할 Mac 창 위에 두 손가락을 대세요.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("두 손가락 조작이 어렵다면 「스크롤」 버튼을 열어 위·아래·왼쪽·오른쪽 화살표를 누르세요. 스크롤할 창을 먼저 클릭해야 합니다.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Label("두 손가락 벌리기·모으기: 화면 확대·축소", systemImage: "arrow.up.left.and.arrow.down.right")
                    Text("두 손가락으로 두 번 톡 누르면 원래 크기로 돌아갑니다. 터치 모드에서는 확대한 화면을 한 손가락으로 밀어 이동합니다.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                Section("텍스트 입력") {
                    Text("1. Mac의 입력할 칸을 먼저 클릭하세요.\n2. 「텍스트 입력」을 열고 글자를 입력한 뒤 「보내기」를 누르세요.\n3. Mac에서 Enter를 누르려면 특수키 줄의 「⏎」를 누르세요.")
                    Text("한글도 조합을 마친 글자가 전달됩니다. 연결된 하드웨어 키보드도 사용할 수 있습니다. 암호는 열쇠 버튼의 전용 입력칸을 사용하세요.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("새 Mac 버전에서는 화면을 클릭한 상태에서 Caps Lock을 짧게 누르면 Mac의 한영을, 길게 누르면 원격 대문자 잠금을 바꿉니다. 한영 상태는 Mac의 응답을 표시합니다. iPad가 Caps Lock을 먼저 처리하는 키보드에서는 아래 한/영 버튼을 사용하세요. 휴대폰의 텍스트 입력칸에서는 휴대폰 키보드로 조합합니다.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button("텍스트 입력 열기", systemImage: "keyboard") {
                        keyboardAfterGuide = true
                        showingControlsGuide = false
                    }
                }
            }
            .navigationTitle("Mac 화면 조작법")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("완료") { showingControlsGuide = false } } }
        }
        .presentationDetents([.large])
    }

    private func show(_ next: Panel) {
        panel = panel == next ? .none : next
        if panel != .keyboard { textIsComposing = false }
        textFocused = panel == .keyboard
    }

    private var scrollPad: some View {
        VStack(spacing: 8) {
            Text("스크롤할 Mac 창을 먼저 클릭하세요").font(.caption)
            Button("위로", systemImage: "arrow.up") { model.send(.scroll(dx: 0, dy: 160)) }
            HStack(spacing: 24) {
                Button("왼쪽", systemImage: "arrow.left") { model.send(.scroll(dx: 160, dy: 0)) }
                Button("닫기") { panel = .none }
                Button("오른쪽", systemImage: "arrow.right") { model.send(.scroll(dx: -160, dy: 0)) }
            }
            Button("아래로", systemImage: "arrow.down") { model.send(.scroll(dx: 0, dy: -160)) }
        }
        .buttonStyle(.bordered)
        .frame(minWidth: 280)
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .padding(8)
    }

    private var keyboardBar: some View {
        VStack(spacing: 8) {
            Text("Mac의 입력칸을 먼저 클릭 → 글자 입력 → 보내기 · 입력 결과는 Mac 화면에서 확인")
                .font(.caption).foregroundStyle(.secondary)
            if model.desktopControls {
                ScreenSpaceBar(disabled: !model.canSwitchSpaces, navigate: { model.navigateSpace($0) },
                               selectDesktop: { model.selectDesktop($0) })
            }
            if model.desktopControls, let state = model.macState.keyboard {
                HStack {
                    Text(state.language == .korean ? "Mac 한글" : state.language == .latin ? "Mac 영문" : "Mac 기타 입력기")
                        .font(.caption)
                    Button("한/영") { model.switchInputLanguage() }
                        .disabled(model.keyboardPending || !state.canSelectLatin || !state.canSelectKorean || model.macState.locked != false || !model.macState.canSendInput)
                        .accessibilityIdentifier("screenInputLanguage")
                    Button(state.capsLock ? "원격 Caps 켜짐" : "원격 Caps 꺼짐") { model.changeKeyboard(state.capsLock ? .capsOff : .capsOn) }
                        .disabled(model.keyboardPending || model.macState.locked != false || !model.macState.canSendInput)
                        .accessibilityIdentifier("screenCapsLock")
                }
                .buttonStyle(.bordered)
            }
            HStack {
                ScreenComposeField(placeholder: latched.isEmpty ? "Mac에 입력할 글자" : "조합할 글자 하나 (예: c)",
                                   text: $text, focused: $textFocused, composing: $textIsComposing,
                                   locked: model.textReturnWaiting) { submitTextAndReturn() }
                    .frame(height: 36)
                Button("보내기") { sendText() }
                    .disabled(text.isEmpty || !ScreenComposeRules.maySend(isComposing: textIsComposing,
                                                                             waiting: model.textReturnWaiting,
                                                                             uncertain: model.textReturnUncertain,
                                                                             admitted: model.canSendText))
            }
            if textIsComposing { Text("글자 조합을 완료한 뒤 보내세요.").font(.caption) }
            if model.textReturnUncertain {
                Button("Mac 화면 확인 후 다시 시도") { model.acknowledgeTextReturnUncertainty() }
                    .buttonStyle(.bordered)
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
                        .disabled(textIsComposing || model.textReturnWaiting || model.textReturnUncertain)
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
        guard ScreenComposeRules.maySend(isComposing: textIsComposing, waiting: model.textReturnWaiting,
                                         uncertain: model.textReturnUncertain, admitted: model.canSendText) else {
            model.showTextReturnNotice("Mac 입력 상태를 확인한 뒤 다시 시도하세요. 작성한 글자는 남아 있습니다.")
            return
        }
        if !latched.isEmpty, text.count == 1, let code = MacKeyCode.code(for: Character(text.lowercased())) {
            model.press(code, modifiers: latched)
        } else {
            model.type(text)
        }
        latched = []
        text = ""
    }

    private func submitTextAndReturn() {
        guard !textIsComposing else { return }
        guard latched.isEmpty else {
            model.showTextReturnNotice("조합 키가 선택되어 있습니다. 보내기 또는 ⏎ 버튼을 사용하세요.")
            return
        }
        switch model.submitTextAndReturn(text) {
        case .refused: break
        case .sent: text = ""
        case let .waiting(id): textReturnDraft.begin(id: id, text: text)
        }
        textFocused = true
    }

    private func applyTextReturnCompletion(_ completion: ScreenTextReturnCompletion?) {
        if textReturnDraft.shouldClear(after: completion, currentText: text) { text = "" }
    }

    private func sendSecret(thenReturn: Bool) {
        let typed = secret.take()
        guard !typed.isEmpty else { return }
        model.type(typed)
        if thenReturn { model.press(SpecialKey.returnKey) }
    }
}

/// The Mac interprets Control-1/2/3 using its own Mission Control shortcut settings.
enum ScreenDesktopShortcut {
    static func events(for number: Int) -> [InputEvent] {
        let code: UInt16
        switch number {
        case 1: code = 0x12
        case 2: code = 0x13
        case 3: code = 0x14
        default: return []
        }
        return [.key(code: code, isDown: true, modifiers: .control),
                .key(code: code, isDown: false, modifiers: [])]
    }
}

/// Available beside the composition field so moving between desktops does not require closing the keyboard panel.
struct ScreenSpaceBar: View {
    let disabled: Bool
    let navigate: (ScreenSpaceAction) -> Void
    let selectDesktop: (Int) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Text("Space").font(.caption)
                Button { navigate(.previous) } label: { Image(systemName: "chevron.left") }
                    .accessibilityLabel("이전 Space").accessibilityIdentifier("screenKeyboardSpacePrevious")
                ForEach(1...3, id: \.self) { number in
                    Button("\(number)") { selectDesktop(number) }
                        .accessibilityLabel("데스크탑 \(number)").accessibilityIdentifier("screenKeyboardSpace\(number)")
                }
                Button { navigate(.next) } label: { Image(systemName: "chevron.right") }
                    .accessibilityLabel("다음 Space").accessibilityIdentifier("screenKeyboardSpaceNext")
            }
            .buttonStyle(.bordered)
            .disabled(disabled)
        }
        .accessibilityHint("Mac의 Mission Control 단축키 설정과 활성 디스플레이를 따릅니다.")
    }
}

/// The draft stays visible until a matching posted receipt. A later edit is never cleared by an older receipt.
struct ScreenTextReturnDraft {
    private var pending: (id: UInt32, text: String)?
    mutating func begin(id: UInt32, text: String) { pending = (id, text) }
    mutating func shouldClear(after completion: ScreenTextReturnCompletion?, currentText: String) -> Bool {
        guard let completion, let pending, completion.id == pending.id else { return false }
        self.pending = nil
        return completion.isPosted && currentText == pending.text
    }
}

enum ScreenTextReturnCompletion: Equatable {
    case posted(UInt32), blocked(UInt32), uncertain(UInt32)
    var id: UInt32 { switch self { case let .posted(id), let .blocked(id), let .uncertain(id): id } }
    var isPosted: Bool { if case .posted = self { true } else { false } }
}

enum ScreenTextReturnSubmission { case refused, sent, waiting(UInt32) }

enum ScreenComposeRules {
    static func maySend(isComposing: Bool, waiting: Bool, uncertain: Bool, admitted: Bool = true) -> Bool {
        !isComposing && !waiting && !uncertain && admitted
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
    private(set) var status: String? = "기기 인증으로 이번 연결을 승인해 주세요."
    private(set) var connectionPath: String?
    private(set) var ended = false
    private(set) var needsBiometricRecovery = false
    private var recoveryAttempt: UUID?
    /// What the Mac tells beside the picture: a pause while someone uses it, and from a version-2 Mac its lock state and
    /// displays. Each notice changes only its own part (`ScreenMacState`).
    private(set) var macState = ScreenMacState()
    /// Once connected: whether the Mac takes display, cursor and turn-off requests and tells its lock state (version 2).
    private(set) var sessionControls: Bool?
    private(set) var desktopControls = false
    private(set) var desktopNotice: String?
    private var keyboardFence = ScreenKeyboardInputFence()
    private var keyboardDeadline: Task<Void, Never>?
    private var textReturnSequence: UInt32 = 0
    private var textReturnPending: UInt32?
    private var textReturnDeadline: Task<Void, Never>?
    private(set) var textReturnCompletion: ScreenTextReturnCompletion?
    private(set) var textReturnUncertain = false
    private var capsPress = ScreenCapsLockPress()
    var keyboardPending: Bool { keyboardFence.pending != nil }
    var textReturnWaiting: Bool { textReturnPending != nil }
    var canSendText: Bool {
        viewer != nil && macState.canSendInput && !keyboardPending && !textReturnWaiting && !textReturnUncertain
    }
    var canSwitchSpaces: Bool {
        viewer != nil && desktopControls && macState.locked == false && macState.canSendInput
            && !keyboardPending && !textReturnWaiting
    }
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

    func run(mac: SavedScreenMac, route: ScreenConnectionRoute = .automatic) async {
        guard let pinned = mac.pinned else { return finish("등록 정보가 손상되었습니다. 다시 등록해 주세요.") }
        if route == .internet, mac.relay?.matches(fingerprint: pinned.fingerprint) != true {
            return finish("이 Mac에는 자체 중계 경로가 없습니다. 밖에서는 ‘사설망 · Cloudflare’, 가까이에서는 근거리 경로를 선택하세요.")
        }
        if route == .privateNetwork, mac.privateNetwork == nil {
            return finish("이 Mac의 사설망 경로가 없습니다. Mac 목록에서 길게 눌러 ‘사설망 연결 설정’을 열고, Cloudflare One Agent에 등록한 뒤 연결하세요.")
        }
        // This attempt's generation: `end()` abandons it, so neither Face ID nor the key exchange can come back and
        // hand a live Mac session to a view that is already gone.
        let attempt = gate.start()
        do {
            let signer = try await withBiometrics(.connection) {
                try await FaceIDApprovedSigner.approve(dataRepresentation: mac.deviceKey, reason: "\(mac.macName) 화면에 연결합니다", authentication: mac.authentication)
            }
            guard gate.owns(attempt), !Task.isCancelled else { return }
            status = "Mac에 연결하는 중…"
            let (viewer, internet) = try await Self.connect(mac: mac, pinned: pinned, signer: signer, route: route)
            // The session arrived for an attempt nobody owns any more: close the Mac's session instead of keeping it.
            guard gate.accepts(attempt), !Task.isCancelled else { return await viewer.close() }
            self.viewer = viewer
            connectionPath = route == .privateNetwork ? "사설망 · Cloudflare" : internet ? "자체 중계" : "근거리"
            sessionControls = viewer.macHasSessionControls
            desktopControls = viewer.protocolVersion >= 3
            if desktopControls, internet { try viewer.desktopControl(.setVideoQuality(.balanced)) }
            // The Mac's capture starts with its cursor in the picture.
            if hidesMacCursor { request { try await viewer.setMacCursorHidden(true) } }
            let notices = Task { [weak self] in
                for await notice in viewer.notices {
                    guard let self, self.gate.owns(attempt) else { return }
                    self.hear(notice)
                }
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
            needsBiometricRecovery = (error as? LAError)?.code == .biometryLockout
            finish(Self.message(for: error))
        }
    }

    /// Recovery grants no Mac authority. Keep the failed connection ended; the person must close this view and
    /// explicitly select the Mac again for a fresh biometric key approval. Its passcode context is never reused.
    func recoverBiometricLockout() async {
        guard ended, needsBiometricRecovery, !authenticating else { return }
        let attempt = UUID()
        recoveryAttempt = attempt
        authPurpose = .connection
        authenticating = true
        do {
            try await BiometricApproval.recoverLockout(reason: "\(BiometricApproval.methodName) 잠김을 해제합니다. Mac 연결은 이후 새 생체 인증으로 승인합니다.")
            guard recoveryAttempt == attempt else { return }
            needsBiometricRecovery = false
            status = "\(BiometricApproval.methodName)를 다시 사용할 수 있습니다. 닫은 뒤 Mac을 다시 선택하고 새 생체 인증으로 연결을 승인해 주세요. 지문·얼굴 정보를 바꿨다면 새 Mac QR로 다시 등록해 주세요."
        } catch {
            guard recoveryAttempt == attempt else { return }
            if Self.cancelled(error) {
                status = "잠김 해제를 취소했습니다. Mac에는 연결하지 않았습니다."
            } else if (error as? LAError)?.code == .biometryLockout {
                status = "기기 암호 인증 뒤에도 iPad가 \(BiometricApproval.methodName) 잠김을 반환했습니다. 기기 잠금 화면에서도 지문·얼굴 인증이 되는지 확인해 주세요. 생체 정보를 다시 등록했다면 새 Mac QR로 다시 등록해야 합니다."
            } else {
                status = Self.message(for: error)
            }
        }
        // This is still a failed CONNECTION approval, even when OS lockout recovery succeeded. The lifecycle
        // tolerates its system prompt without treating the recovery result as permission to open a session.
        lastApproval = .failed
        authenticating = false
        recoveryAttempt = nil
    }

    /// The address from registration first; the Bonjour host name when the Mac's address has changed. A second try
    /// only follows a failure before the key exchange, where the one-time Face ID approval is still unused.
    private static func connect(mac: SavedScreenMac, pinned: PinnedMac, signer: FaceIDApprovedSigner,
                                route: ScreenConnectionRoute) async throws -> (ScreenViewer, Bool) {
        let transport: any ScreenFrameTransport
        var internet = false
        if route == .privateNetwork {
            guard let privateNetwork = mac.privateNetwork else { throw RegistrationError.malformed }
            transport = try await ScreenClient.open(privateNetwork: privateNetwork, maxFrame: 1024)
            internet = true
        } else if route == .internet {
            guard let relay = mac.relay, relay.matches(fingerprint: pinned.fingerprint) else { throw ScreenRelayError.offline }
            transport = try await ScreenRelayTransport.open(route: relay, purpose: .screen)
            internet = true
        } else {
            func openNearby() async throws -> any ScreenFrameTransport {
                if let nearby = mac.nearbyService { return try await ScreenNearby.open(serviceName: nearby, maxFrame: 1024) }
                guard let port = NWEndpoint.Port(rawValue: mac.port) else { throw RegistrationError.malformed }
                do { return try await ScreenClient.open(to: .hostPort(host: .init(mac.address), port: port), maxFrame: 1024) }
                catch {
                    try Task.checkCancellation()
                    return try await ScreenClient.open(to: .hostPort(host: .init(mac.hostName), port: port), maxFrame: 1024)
                }
            }
            do { transport = try await openNearby() }
            catch {
                try Task.checkCancellation()
                guard route == .automatic, let relay = mac.relay, relay.matches(fingerprint: pinned.fingerprint) else { throw error }
                transport = try await ScreenRelayTransport.open(route: relay, purpose: .screen)
                internet = true
            }
        }
        guard !Task.isCancelled else { transport.cancel(); throw CancellationError() }
        // From this point the one-use biometric signer is committed to this transport. Never fall back on auth failure.
        return (try await ScreenViewer.connect(over: transport, mac: pinned, signer: signer), internet)
    }

    func send(_ event: InputEvent) {
        guard macState.canSendInput else { return }
        guard let events = keyboardFence.submit(event) else { finish("한영 전환 중 입력이 너무 많이 쌓여 연결을 끝냈습니다. 새로 연결해 주세요."); return }
        for event in events { viewer?.input(event) }
    }

    private func hear(_ notice: ScreenNotice) {
        macState.hear(notice)
        if !macState.canSendInput {
            keyboardDeadline?.cancel(); keyboardDeadline = nil; keyboardFence.cancel(); capsPress.cancel()
        }
        switch notice {
        case let .textAndReturnResult(id, result) where id == textReturnPending:
            textReturnDeadline?.cancel(); textReturnDeadline = nil; textReturnPending = nil
            switch result {
            case .posted:
                textReturnCompletion = .posted(id)
                desktopNotice = "Mac에 글자와 Enter를 보냈습니다. Mac 화면에서 결과를 확인하세요."
            case .blocked:
                textReturnCompletion = .blocked(id)
                desktopNotice = "Mac이 입력을 거절했습니다. 작성한 글자는 남아 있습니다."
            case .unknown:
                textReturnUncertain = true; textReturnCompletion = .uncertain(id)
                desktopNotice = "입력 결과를 확인할 수 없습니다. 다시 보내기 전에 Mac 화면을 확인하세요."
            }
        case let .keyboardState(id, _, result) where id != 0 && id == keyboardFence.pending:
            keyboardDeadline?.cancel(); keyboardDeadline = nil
            let events = keyboardFence.reply(id: id, result: result)
            if result != .applied { desktopNotice = "Mac 입력기를 바꾸지 못했습니다. 전환 중 입력은 보내지 않았습니다. Mac의 한글 입력기와 로컬 사용 여부를 확인하세요." }
            else { desktopNotice = nil }
            for event in events { viewer?.input(event) }
        case .spaceResult(_, let result):
            desktopNotice = result == .applied ? "Spaces 단축키를 보냈습니다. 화면을 확인하세요. 반응이 없으면 Mac의 Mission Control 단축키를 확인하세요."
                : "Mac이 잠겨 있거나 로컬에서 사용 중이어서 Spaces를 바꾸지 않았습니다."
        case .spaceChanged:
            desktopNotice = "Mac에서 Spaces 변경을 감지했습니다. 현재 영상에서 원하는 공간인지 확인하세요."
        default: break
        }
    }

    func switchInputLanguage() {
        guard let state = macState.keyboard else { return }
        changeKeyboard(state.language == .korean ? .latin : .korean)
    }

    func changeKeyboard(_ action: ScreenKeyboardAction) {
        guard let viewer, desktopControls, macState.locked == false, macState.canSendInput,
              let id = keyboardFence.begin() else { return }
        do { try viewer.desktopControl(.keyboardAction(id: id, action)) }
        catch { keyboardFence.cancel(); return }
        keyboardDeadline?.cancel()
        keyboardDeadline = Task { [weak self] in
            guard (try? await Task.sleep(for: .seconds(3))) != nil, let self, self.keyboardFence.pending == id else { return }
            self.finish("Mac의 한영 전환 응답을 받지 못해 연결을 끝냈습니다. 입력을 다시 보내지는 않았습니다.")
        }
    }

    func hardwareKey(_ code: UInt16, isDown: Bool, modifiers: KeyModifiers, cancelled: Bool = false) {
        guard macState.canSendInput else { capsPress.cancel(); return }
        if desktopControls, code == 0x39, macState.keyboard == nil {
            desktopNotice = "Mac의 한영 상태를 확인하는 중입니다. 확인 뒤 Caps Lock을 다시 눌러 주세요."
            return
        }
        if desktopControls, let state = macState.keyboard {
            if code == 0x39 {
                if cancelled { capsPress.cancel() }
                else if isDown { capsPress.down(at: ProcessInfo.processInfo.systemUptime) }
                else if let action = capsPress.resolve(at: ProcessInfo.processInfo.systemUptime, state: state) { changeKeyboard(action) }
                return
            }
            if isDown, let action = capsPress.resolve(at: ProcessInfo.processInfo.systemUptime, state: state) { changeKeyboard(action) }
        }
        send(.key(code: code, isDown: isDown, modifiers: modifiers))
    }

    func navigateSpace(_ action: ScreenSpaceAction) {
        guard let viewer, canSwitchSpaces else { return }
        try? viewer.desktopControl(.navigateSpace(action))
    }

    func selectDesktop(_ number: Int) {
        guard canSwitchSpaces else { return }
        let events = ScreenDesktopShortcut.events(for: number)
        guard !events.isEmpty else { return }
        for event in events { send(event) }
        desktopNotice = "Mac의 데스크탑 \(number) 전환을 요청했습니다. 화면과 Mission Control 단축키 설정을 확인하세요."
    }

    func setVideoQuality(_ quality: ScreenVideoQuality) {
        guard let viewer, desktopControls else { return }
        try? viewer.desktopControl(.setVideoQuality(quality))
    }

    func press(_ code: UInt16, modifiers: KeyModifiers = []) {
        send(.key(code: code, isDown: true, modifiers: modifiers))
        send(.key(code: code, isDown: false, modifiers: modifiers))
    }

    func showTextReturnNotice(_ notice: String) { desktopNotice = notice }
    func acknowledgeTextReturnUncertainty() {
        textReturnUncertain = false
        desktopNotice = "Mac 화면을 확인했습니다. 필요하면 직접 다시 보내세요."
    }

    /// `.waiting` means the request was handed to the local input queue, not that the target app applied it. Queue
    /// overflow or a lost response is uncertain and must not be replayed automatically.
    func submitTextAndReturn(_ text: String) -> ScreenTextReturnSubmission {
        guard let viewer, macState.canSendInput, !keyboardPending, textReturnPending == nil, !textReturnUncertain else {
            desktopNotice = "Mac 입력 상태를 확인한 뒤 다시 시도하세요."
            return .refused
        }
        guard !text.isEmpty else { press(SpecialKey.returnKey); return .sent }
        guard viewer.protocolVersion >= 4 else {
            type(text)
            desktopNotice = "이 Mac에는 글자만 전송 요청했습니다. 화면에서 확인한 뒤 ⏎를 누르세요."
            return .sent
        }
        guard text.utf8.count <= InputCodec.maxTextBytes,
              !text.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }),
              textReturnSequence < UInt32.max else {
            desktopNotice = "글자는 256바이트 이내로 입력하고 제어 문자를 제외해 주세요."
            return .refused
        }
        textReturnSequence += 1
        let id = textReturnSequence
        textReturnPending = id
        viewer.input(.textAndReturn(id: id, text: text))
        textReturnDeadline = Task { [weak self, weak viewer] in
            guard (try? await Task.sleep(for: .seconds(5))) != nil, let self,
                  self.viewer === viewer, self.textReturnPending == id else { return }
            self.textReturnPending = nil
            self.textReturnUncertain = true
            self.textReturnCompletion = .uncertain(id)
            self.desktopNotice = "입력 결과를 확인할 수 없습니다. 다시 보내기 전에 Mac 화면을 확인하세요."
        }
        return .waiting(id)
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
    func turnOffScreenControl(macName: String, authentication: ScreenDeviceAuthentication) async -> String? {
        guard let viewer, viewer.macHasSessionControls else { return "이 Mac은 휴대폰에서 끌 수 없습니다. Mac 앞에서 꺼 주세요." }
        let approval: BiometricApproval
        do {
            approval = try await withBiometrics(.sessionControl) { try await BiometricApproval.request(reason: "\(macName)의 화면 제어를 끕니다", authentication: authentication) }
        } catch let error as LAError where error.code == .userCancel || error.code == .appCancel || error.code == .systemCancel {
            return "기기 인증을 취소해 끄지 않았습니다."
        } catch {
            return "기기 인증으로 승인하지 못해 끄지 않았습니다."
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
        keyboardDeadline?.cancel(); keyboardDeadline = nil
        if let id = textReturnPending { textReturnCompletion = .uncertain(id); textReturnUncertain = true }
        textReturnDeadline?.cancel(); textReturnDeadline = nil; textReturnPending = nil
        keyboardFence.cancel(); capsPress.cancel()
        desktopNotice = nil
        connectionPath = nil
        recoveryAttempt = nil
        guard let viewer else { return }
        self.viewer = nil
        Task { await viewer.close() }
    }

    private func finish(_ message: String) {
        let textReturnWasUncertain = textReturnPending != nil || textReturnUncertain
        if let id = textReturnPending { textReturnCompletion = .uncertain(id); textReturnUncertain = true }
        end()
        ended = true
        macState = ScreenMacState()
        sessionControls = nil
        desktopControls = false
        status = textReturnWasUncertain ? message + " 글자와 Enter의 전달 결과는 Mac 화면에서 확인하세요." : message
    }

    /// Runs one Face ID approval and records its outcome before `authenticating` turns off, so the view's decision
    /// sees the answer and the flag change together.
    private func withBiometrics<T>(_ purpose: ScreenViewerLifecycle.AuthPurpose, _ approve: () async throws -> T) async rethrows -> T {
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
        case .idle?: "오랫동안 조작이 없어 연결을 끝냈습니다."
        case .timeLimit?: "Mac의 연결 시간 제한에 도달해 끝났습니다. 다시 연결하면 한 번 더 승인합니다."
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
            "기기 인증을 취소했습니다."
        case let error as LAError where error.code == .biometryLockout:
            "\(BiometricApproval.methodName)가 잠겼습니다. 「\(BiometricApproval.methodName) 잠김 해제」를 누르고 기기 암호로 복구한 뒤 다시 생체 인증해 주세요."
        case let error as LAError where error.code == .biometryNotEnrolled:
            "이 기기에 등록된 생체 정보가 없습니다. 설정에서 \(BiometricApproval.methodName)를 등록한 뒤 다시 연결해 주세요."
        case let error as LAError where error.code == .notInteractive || error.code == .invalidContext:
            "\(BiometricApproval.methodName) 확인을 연결 키에 적용하지 못했습니다. 화면을 닫고 다시 연결해 주세요."
        case is LAError:
            "기기 인증으로 승인하지 못했습니다. 등록한 인증 방식을 확인해 주세요."
        case TransportError.timedOut, TransportError.failed:
            "Mac에 연결하지 못했습니다. Mac의 AgentsToZ Screen과 두 기기의 Wi‑Fi가 켜져 있는지 확인해 주세요. 밖에서는 Cloudflare One Agent 연결과 사설망 경로를 확인해 주세요."
        case ScreenRelayError.offline: "자체 중계에서 대기 중인 Mac을 찾지 못했습니다. Mac의 「고급 · 자체 중계 서버」와 새 QR로 저장한 경로를 확인해 주세요."
        case ScreenRelayError.busy: "다른 기기가 이 Mac의 자체 중계 화면 연결을 사용 중입니다."
        case ScreenRelayError.unavailable: "화면 중계에 연결할 수 없거나 사용량 한도에 도달했습니다. 잠시 뒤 다시 연결해 주세요."
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
        view.isAccessibilityElement = true
        view.accessibilityIdentifier = "screenRemoteSurface"
        view.accessibilityLabel = "Mac 화면"
        view.send = { [weak model, weak view] event in
            guard view?.remoteInputEnabled == true else { return }; model?.send(event)
        }
        view.hardwareKey = { [weak model] in model?.hardwareKey($0, isDown: $1, modifiers: $2, cancelled: $3) }
        view.videoSize = { [weak model] in model?.videoSize ?? .zero }
        return view
    }

    func updateUIView(_ view: SurfaceView, context: Context) {
        view.accessibilityValue = model.status == nil ? "연결됨" : "연결 대기"
        view.zoomChanged = zoomChanged
        view.keepsTextFocus = keepsTextFocus
        // Reading videoSize here makes SwiftUI call again when the Mac changes resolution.
        view.update(videoSize: model.videoSize, mode: mode, zoomReset: zoomReset,
                    canSendInput: model.macState.canSendInput, macPointer: model.macState.pointerPosition)
    }

    final class SurfaceView: UIView, UIGestureRecognizerDelegate {
        private let hosted: CALayer
        private let cursorLayer = CAShapeLayer()
        var send: @MainActor (InputEvent) -> Void = { _ in }
        var hardwareKey: @MainActor (UInt16, Bool, KeyModifiers, Bool) -> Void = { _, _, _, _ in }
        var videoSize: @MainActor () -> CGSize = { .zero }
        var zoomChanged: @MainActor (Bool) -> Void = { _ in }
        var keepsTextFocus = false

        private var mode = ScreenInputMode.touch
        private var viewport = ScreenViewport()
        private var reportedZoomed = false
        private var appliedZoomReset = 0
        /// The Mac position last sent: where the Mac's pointer is, and the trackpad cursor.
        private var cursor = CGPoint(x: 0.5, y: 0.5)
        private var lastMacPointer: ScreenPointerPosition?
        private(set) var remoteInputEnabled = true

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
            // buttonMaskRequired only filters indirect devices. Without this touch-type restriction,
            // a finger tap also satisfies this recognizer and competes with the primary tap.
            secondaryClick.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
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

        func update(videoSize: CGSize, mode: ScreenInputMode, zoomReset: Int,
                    canSendInput: Bool = true, macPointer: ScreenPointerPosition? = nil) {
            let resumed = !remoteInputEnabled && canSendInput
            if remoteInputEnabled != canSendInput || macPointer != lastMacPointer {
                // Never replay motion/holds from before takeover or from the previous capture display. Keep local
                // pinch zoom available, but a remote drag needs a fresh gesture after control resumes.
                remoteInputEnabled = false
                pendingMove = nil; momentum = nil; scroller = ScrollScaler(maximumDelta: InputCodec.maxScrollDelta)
                holding = false; pointerDragging = false; lastHold = nil; lastPan = .zero; lastScroll = .zero
                tapSnap.reset()
                for recognizer in [tap, secondaryClick, twoFingerTap, hold, oneFinger, twoFingerPan] {
                    recognizer.isEnabled = false; recognizer.isEnabled = true
                }
            }
            if let macPointer, macPointer != lastMacPointer || resumed {
                cursor = CGPoint(x: macPointer.unitX, y: macPointer.unitY)
                lastMacPointer = macPointer
            }
            remoteInputEnabled = canSendInput
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
            guard remoteInputEnabled else { return }
            cursor = mac.clampedToUnit
            pendingMove = cursor
            wake()
        }

        private func flushMotion() {
            guard remoteInputEnabled else { pendingMove = nil; _ = scroller.take(); return }
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
            if !remoteInputEnabled && [tap, secondaryClick, twoFingerTap, hold, oneFinger].contains(recognizer) { return false }
            if !remoteInputEnabled && recognizer === twoFingerPan && !viewport.isZoomed { return false }
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
            if !forward(presses, isDown: false, cancelled: true) { super.pressesCancelled(presses, with: event) }
        }

        private func forward(_ presses: Set<UIPress>, isDown: Bool, cancelled: Bool = false) -> Bool {
            var handled = false
            // UIKit supplies a Set. If Caps and the first letter share an event, resolve Caps first deterministically.
            for press in presses.sorted(by: { ($0.key?.keyCode.rawValue == 0x39 ? 0 : ($0.key?.keyCode.rawValue ?? 0) + 1)
                < ($1.key?.keyCode.rawValue == 0x39 ? 0 : ($1.key?.keyCode.rawValue ?? 0) + 1) }) {
                guard let key = press.key, let code = MacKeyCode.code(for: key.keyCode) else { continue }
                if !handled { flushMotion() }
                hardwareKey(code, isDown, MacKeyCode.modifiers(key.modifierFlags), cancelled)
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

/// Return commits any marked text first, then submits the committed text once for that physical press.
final class ScreenComposeTextField: UITextField {
    private(set) var consumedComposingReturn = false
    var editingLocked = false
    var compositionChanged: ((Bool) -> Void)?
    var composingReturn: ((UITextField) -> Void)?
    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        guard !editingLocked else { return }
        super.setMarkedText(markedText, selectedRange: selectedRange)
        compositionChanged?(markedTextRange != nil)
    }
    override func unmarkText() {
        super.unmarkText()
        compositionChanged?(markedTextRange != nil)
    }
    @discardableResult func submitMarkedTextOnReturn() -> Bool {
        guard markedTextRange != nil else { return false }
        if !editingLocked {
            unmarkText()
            if markedTextRange == nil { composingReturn?(self) }
        }
        return true
    }
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let containsReturn = presses.contains { press in
            guard let usage = press.key?.keyCode.rawValue else { return false }
            return usage == 0x28 || usage == 0x58 || usage == 0x9E
        }
        if containsReturn && consumedComposingReturn { return }
        if containsReturn && markedTextRange != nil {
            consumedComposingReturn = true
            _ = submitMarkedTextOnReturn()
            return
        }
        super.pressesBegan(presses, with: event)
    }
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if consumedComposingReturn && presses.contains(where: { [0x28, 0x58, 0x9E].contains($0.key?.keyCode.rawValue ?? -1) }) {
            DispatchQueue.main.async { [weak self] in self?.consumedComposingReturn = false }
            return
        }
        super.pressesEnded(presses, with: event)
    }
    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if consumedComposingReturn { consumedComposingReturn = false; return }
        super.pressesCancelled(presses, with: event)
    }
}

struct ScreenComposeField: UIViewRepresentable {
    let placeholder: String
    @Binding var text: String
    @Binding var focused: Bool
    @Binding var composing: Bool
    let locked: Bool
    let submit: @MainActor () -> Void

    func makeUIView(context: Context) -> ScreenComposeTextField {
        let field = ScreenComposeTextField()
        field.borderStyle = .roundedRect
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.delegate = context.coordinator
        field.compositionChanged = { [weak coordinator = context.coordinator] marked in coordinator?.parent.composing = marked }
        field.composingReturn = { [weak coordinator = context.coordinator] field in coordinator?.commitAndSubmit(field) }
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return field
    }
    func updateUIView(_ field: ScreenComposeTextField, context: Context) {
        context.coordinator.parent = self
        field.placeholder = placeholder
        field.editingLocked = locked
        if field.markedTextRange == nil, field.text != text { field.text = text }
        if focused && !field.isFirstResponder { field.becomeFirstResponder() }
        else if !focused && field.isFirstResponder { field.resignFirstResponder() }
    }
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: ScreenComposeField
        init(parent: ScreenComposeField) { self.parent = parent }
        @objc func changed(_ field: UITextField) { parent.text = field.text ?? "" }
        func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            !parent.locked
        }
        func textFieldDidBeginEditing(_ textField: UITextField) { parent.focused = true }
        func textFieldDidEndEditing(_ textField: UITextField) { parent.focused = false }
        func commitAndSubmit(_ textField: UITextField) {
            guard !parent.locked else { return }
            if textField.markedTextRange != nil { textField.unmarkText() }
            guard textField.markedTextRange == nil else { return }
            parent.composing = false
            parent.text = textField.text ?? ""
            parent.submit()
        }
        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            guard (textField as? ScreenComposeTextField)?.consumedComposingReturn != true else { return false }
            commitAndSubmit(textField)
            return false
        }
    }
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
            // Keypad Enter has its own Mac key code; some keyboards also report the separate HID Return usage.
            0x58: 0x4C, 0x9E: 0x24,
        ]
        for (index, code) in letters.enumerated() { table[0x04 + index] = code }
        for (index, code) in digits.enumerated() { table[0x1E + index] = code }
        for (index, code) in functions.enumerated() { table[0x3A + index] = code }
        return table
    }()
}

private extension ScreenInputAvailability {
    var viewerMessage: String {
        switch self {
        case .ready: "Mac을 조작할 수 있습니다."
        case .permissionsRequired: "화면 보기만 가능합니다. Mac의 손쉬운 사용·입력 모니터링 권한을 확인하고 다시 연결하세요."
        case .secureInput: "Mac의 보안 입력 중이라 조작을 멈췄습니다. Mac에서 보안 입력을 마친 뒤 다시 연결하세요."
        case .monitorUnavailable: "Mac 입력 우선 보호가 중단되어 화면만 보여줍니다. Mac의 권한을 확인하고 다시 연결하세요."
        case .localActivity: "Mac에서 입력 중이거나 입력 상태를 확인하고 있습니다. 잠시 뒤 조작이 다시 가능합니다."
        }
    }
}
