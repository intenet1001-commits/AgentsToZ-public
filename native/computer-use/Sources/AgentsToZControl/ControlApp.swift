import AppKit
import ComputerUseControlCore
import ComputerUseEngine
import ServiceManagement
import SwiftUI

/// AgentsToZ Control: a menu bar app with no Dock icon. launchd starts it as its own LaunchAgent on the main app's
/// first XPC request; then it listens and shows waiting requests in the menu bar. A request never opens or focuses a
/// window, so a person typing or picking elsewhere keeps their focus; the review window opens only when the person
/// chooses it from the menu. Opened from Finder instead, it shows only its settings.
@main @MainActor
enum ControlMain {
    static let delegate = ControlAppDelegate()
    static func main() {
        ScreenRecordingProbe.answerIfAsked()
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.delegate = delegate
        app.run()
    }
}

@MainActor
final class ControlAppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let service = ControlShared.service
    private var listener: ControlListener?
    private var statusItem: NSStatusItem?
    private var timer: Timer?
    private var windows: [String: NSWindow] = [:]
    private var lastPending = -1
    private var controlBar: ControlBar?

    /// launchd starts the agent job with XPC_SERVICE_NAME set to its label. This decides the run mode only; it is not
    /// trust (imitating it only fails the Mach service check-in, and peers are checked by signature).
    static var launchedAsAgent: Bool { ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] == ControlContract.agentLabel }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard Self.launchedAsAgent else { show("settings"); return }
        listener = ControlListener.start()
        service.startedListening()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "hand.raised", accessibilityDescription: "AgentsToZ Control")
        item.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
        controlBar = ControlBar(service: ScopedControlShared.service)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            MainActor.assumeIsolated { ControlMain.delegate.tick() }
        }
        tick()
    }

    /// Expiry, gone owners and the menu bar count, once a second. The review window resolves targets only while open.
    func tick() {
        service.refresh()
        ScopedControlShared.service.refresh()
        controlBar?.update()
        service.watchPermissions()
        if service.restartForScreenRecording { startAgainForScreenRecording() }
        if windows["review"]?.isVisible == true { service.refreshReviews() }
        let count = service.pending.count + ScopedControlShared.service.pending.count
        guard count != lastPending else { return }
        lastPending = count
        statusItem?.button?.title = count > 0 ? " \(count)" : ""
        statusItem?.button?.setAccessibilityLabel(count > 0 ? "AgentsToZ Control, 승인 대기 \(count)건" : "AgentsToZ Control")
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        service.refresh()
        ScopedControlShared.service.refresh()
        menu.removeAllItems()
        let waiting = service.pending.count + ScopedControlShared.service.pending.count
        let review = NSMenuItem(title: waiting > 0 ? "승인 대기 \(waiting)건 검토…" : "승인 요청 없음",
                                action: waiting > 0 ? #selector(openReview) : nil, keyEquivalent: "")
        review.target = self
        menu.addItem(review)
        menu.addItem(.separator())
        let active = service.grants
        menu.addItem(NSMenuItem(title: active.isEmpty ? "제어 중인 창 없음" : "제어 중인 창 \(active.count)개", action: nil, keyEquivalent: ""))
        for grant in active {
            let item = NSMenuItem(title: "중단: \(grant.label)\(grant.halted ? " (멈춤)" : "")", action: #selector(stopOne(_:)), keyEquivalent: "")
            item.representedObject = grant.id
            item.target = self
            item.isEnabled = !grant.halted
            menu.addItem(item)
        }
        if let scoped = ScopedControlShared.service.grant {
            let item = NSMenuItem(title: "중단: \(scoped.label)\(scoped.halted ? " (멈춤)" : "")", action: #selector(stopScope), keyEquivalent: "")
            item.target = self; item.isEnabled = !scoped.halted; menu.addItem(item)
        }
        if !active.isEmpty || ScopedControlShared.service.grant != nil {
            let all = NSMenuItem(title: "모두 중단", action: #selector(stopAll), keyEquivalent: "")
            all.target = self
            menu.addItem(all)
        }
        menu.addItem(.separator())
        let standing = ScopedControlShared.service.standing
        let allowance = NSMenuItem(title: standing == nil ? "상시 허용 켜기…" : "상시 허용 끄기 (전체 Mac · 모든 AgentsToZ AI)",
                                   action: standing == nil ? #selector(enableStanding) : #selector(disableStanding), keyEquivalent: "")
        allowance.target = self; allowance.isEnabled = !ScopedControlShared.service.enablingStanding
        menu.addItem(allowance)
        menu.addItem(.separator())
        let settings = NSMenuItem(title: "설정…", action: #selector(openSettings), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)
        let quit = NSMenuItem(title: "AgentsToZ Control 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)
    }

    @objc private func openReview() { show("review") }
    /// Only the explicit management action may bring this window forward. The activation is asynchronous; an
    /// existing AX window or a successful order request alone does not prove that the person can see it.
    func showReviewForMainWindow(owner: ControlOwner) async throws -> Bool {
        show("review", onPointerScreen: true)
        // macOS activation can settle slowly. Observe passively for at most 1.2 seconds; never reactivate.
        for _ in 0..<12 {
            try await Task.sleep(nanoseconds: 100_000_000)
            guard let window = windows["review"] else { return false }
            let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
            let controlPID = ProcessInfo.processInfo.processIdentifier
            let evidence = ReviewPresentationEvidence(
                visible: window.isVisible, activeSpace: window.isOnActiveSpace, keyWindow: window.isKeyWindow,
                partiallyUnobscured: window.occlusionState.contains(.visible), applicationActive: NSApp.isActive,
                applicationFrontmost: frontmost == controlPID,
                onPointerScreen: Self.onPointerScreen(window)
            )
            switch ReviewPresentationDecision.assess(evidence, ownerAlive: ProcessGeneration.alive(owner),
                                                      frontmost: frontmost, ownerPID: owner.pid, controlPID: controlPID) {
            case .confirmed: return true
            case .abort: return false
            case .wait: continue
            }
        }
        return false
    }
    @objc private func openSettings() { show("settings") }

    /// Screen Recording reaches only a new process. Start again once nothing is pending or granted: the agent exits
    /// and launchd starts it on the main app's next request; a visible settings window comes back in a new instance.
    private func startAgainForScreenRecording() {
        let scoped = ScopedControlShared.service
        guard service.pending.isEmpty, service.grants.isEmpty, scoped.pending.isEmpty, scoped.grant == nil,
              windows["review"]?.isVisible != true, service.approving == nil, scoped.approving == nil else { return }
        guard windows["settings"]?.isVisible == true || !Self.launchedAsAgent else { exit(0) }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, _ in exit(0) }
    }
    @objc private func stopOne(_ sender: NSMenuItem) { if let id = sender.representedObject as? String { service.stop(id) } }
    @objc private func stopAll() { service.stopAll() }
    @objc private func stopScope() { ScopedControlShared.service.stop() }
    @objc private func enableStanding() { Task { await ScopedControlShared.service.enableStanding() } }
    @objc private func disableStanding() { ScopedControlShared.service.disableStanding() }

    /// Windows open only from the person's own action: the menu, Finder or reopening the app.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        show(service.pending.isEmpty && ScopedControlShared.service.pending.isEmpty ? "settings" : "review")
        return false
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { !Self.launchedAsAgent }

    private static func rect(_ r: NSRect) -> ReviewRect {
        ReviewRect(x: Double(r.origin.x), y: Double(r.origin.y), width: Double(r.width), height: Double(r.height))
    }
    private static var screens: [ReviewScreen] { NSScreen.screens.map { ReviewScreen(frame: rect($0.frame), visible: rect($0.visibleFrame)) } }
    /// Whether the window is on the display holding the pointer (AppKit global coordinates on both sides).
    static func onPointerScreen(_ window: NSWindow) -> Bool {
        let pointer = NSEvent.mouseLocation
        return ReviewPlacement.onPointerScreen(rect(window.frame), screens: screens, pointerX: Double(pointer.x), pointerY: Double(pointer.y))
    }
    /// The main app's button was just clicked, so the pointer is on the display the person is looking at.
    private func moveToPointerScreen(_ window: NSWindow) {
        let pointer = NSEvent.mouseLocation
        if let frame = ReviewPlacement.frame(for: Self.rect(window.frame), screens: Self.screens, pointerX: Double(pointer.x), pointerY: Double(pointer.y)) {
            window.setFrame(NSRect(x: frame.x, y: frame.y, width: frame.width, height: frame.height), display: false)
        }
    }

    private func show(_ id: String, onPointerScreen: Bool = false) {
        // Every caller is the person's own action; asking here lists Control so the person only flips the switch.
        if id == "settings" { service.requestMissingPermissions() }
        if let window = windows[id] {
            if id == "review" && window.isMiniaturized { window.deminiaturize(nil) }
            if onPointerScreen { moveToPointerScreen(window) }
            window.makeKeyAndOrderFront(nil); NSApp.activate(); return
        }
        let view: AnyView = id == "review" ? AnyView(ReviewPanel(service: service)) : AnyView(SettingsPanel(service: service))
        let window = NSWindow(contentViewController: NSHostingController(rootView: view))
        window.title = id == "review" ? "AgentsToZ Control — 승인 검토" : "AgentsToZ Control — 설정"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        // A previously opened review can otherwise remain in an inactive Space when explicitly reopened.
        if id == "review" { window.collectionBehavior.insert(.moveToActiveSpace) }
        window.isReleasedWhenClosed = false
        window.center()
        if onPointerScreen { moveToPointerScreen(window) }
        windows[id] = window
        if id == "review" { service.refreshReviews() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }
}

/// Waiting requests and active grants. The app and window names come from Control's own lookup; the task name is the
/// requester's text and is shown as such. Approving needs Touch ID or the login password.
struct ReviewPanel: View {
    let service: ControlService
    private let scoped = ScopedControlShared.service

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let problem = service.problem {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Text(problem).fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button("닫기") { service.dismissProblem() }
                }
                .padding(10).background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }
            if !service.accessibility {
                Label("손쉬운 사용 권한이 없어 지금은 승인할 수 없습니다. 설정에서 확인하세요.", systemImage: "lock")
                    .foregroundStyle(.secondary)
            }
            Text("승인 대기").font(.headline)
            if service.pending.isEmpty && scoped.pending.isEmpty {
                Text("기다리는 요청이 없습니다.").foregroundStyle(.secondary)
            }
            TimelineView(.periodic(from: .now, by: 1)) { context in
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(service.pending, id: \.approvalId) { entry in
                        PendingRow(service: service, entry: entry, info: service.reviews[entry.approvalId], now: context.date)
                    }
                    ForEach(scoped.pending, id: \.approvalId) { entry in
                        ScopedPendingRow(service: scoped, entry: entry, now: context.date)
                    }
                }
            }
            Divider()
            HStack {
                Text("제어 중인 창").font(.headline)
                Spacer()
                if !service.grants.isEmpty || scoped.grant != nil { Button("모두 중단", role: .destructive) { service.stopAll() } }
            }
            if service.grants.isEmpty && scoped.grant == nil { Text("없습니다.").foregroundStyle(.secondary) }
            ForEach(service.grants, id: \.id) { grant in
                HStack {
                    VStack(alignment: .leading) {
                        Text(grant.label)
                        Text("\(grant.caller.sessionId) · \(grant.caller.lane) · \(ControlConsentText.grantAccess(screenAccessApproved: grant.screenAccessApproved))\(grant.halted ? " · 멈춤" : "")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("중단") { service.stop(grant.id) }.disabled(grant.halted)
                }
            }
            if let grant = scoped.grant {
                HStack {
                    VStack(alignment: .leading) {
                        Text(grant.label)
                        Text("\(grant.caller.sessionId) · 화면·마우스·키보드 · \(grant.halted ? "멈춤" : scoped.standing != nil ? "상시 허용" : "컴퓨터 유즈를 끌 때까지")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("중단") { scoped.stop() }.disabled(grant.halted)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .frame(minWidth: 460, minHeight: 360)
    }
}

struct ScopedPendingRow: View {
    let service: ScopedControlService
    let entry: ScopedApprovalEntry
    let now: Date
    var body: some View {
        let seconds = max(0, Int((Double(entry.expiresAt) - now.timeIntervalSince1970 * 1000) / 1000))
        VStack(alignment: .leading, spacing: 6) {
            Text(service.title(entry)).font(.body.weight(.semibold))
            Text("요청: “\(entry.label)”").font(.callout)
            Text("\(entry.caller.sessionId) · \(ControlCountdown.text(secondsLeft: seconds)) · 승인하면 컴퓨터 유즈를 끌 때까지")
                .font(.caption).foregroundStyle(.secondary)
            Text("화면을 읽고 마우스와 키보드를 제어합니다. 앱 전체 범위는 해당 앱의 모든 창에 적용됩니다.")
                .font(.caption).foregroundStyle(.secondary)
            if !service.matches(entry) { Text("요청한 앱이 바뀌었거나 종료됐습니다.").font(.caption).foregroundStyle(.orange) }
            if let problem = service.problem { Text(problem).font(.caption).foregroundStyle(.orange) }
            HStack {
                Button("거부") { service.deny(entry.approvalId) }
                Button("승인…") { Task { await service.approve(entry.approvalId) } }
                    .disabled(!service.matches(entry) || service.approving != nil || service.enablingStanding)
                if StandingAllowance.covers(entry.scope) && service.standing == nil {
                    Button("항상 허용…") { Task { await service.enableStanding(approving: entry.approvalId) } }
                        .disabled(!service.matches(entry) || service.approving != nil || service.enablingStanding)
                }
            }
            if StandingAllowance.covers(entry.scope) && service.standing == nil {
                Text(ControlConsentText.standingOffer).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct PendingRow: View {
    let service: ControlService
    let entry: ApprovalEntry
    let info: ReviewInfo?
    let now: Date
    @State private var allowScreenCapture = false

    var body: some View {
        let seconds = max(0, Int((Double(entry.expiresAt) - now.timeIntervalSince1970 * 1000) / 1000))
        let matches = info?.matches == true
        VStack(alignment: .leading, spacing: 6) {
            Text(info.map { $0.windowTitle.isEmpty ? $0.appName : "\($0.appName) — \($0.windowTitle)" } ?? entry.target.bundleId)
                .font(.body.weight(.semibold))
            Text("요청: “\(entry.label)”").font(.callout)
            Text("\(entry.caller.sessionId) · \(entry.caller.lane) · \(ControlCountdown.text(secondsLeft: seconds)) · 승인하면 10분 동안 이 창 하나만")
                .font(.caption).foregroundStyle(.secondary)
            if info != nil && !matches {
                Text("요청한 창이 바뀌었거나 닫혔습니다. 거부만 할 수 있습니다.").font(.caption).foregroundStyle(.orange)
            }
            Toggle("이 창의 화면 이미지도 볼 수 있도록 허용", isOn: $allowScreenCapture)
                .font(.caption)
            if allowScreenCapture {
                Text("화면 이미지에는 창에 보이는 내용이 포함됩니다. macOS 화면 기록 권한도 필요합니다.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button("거부") { service.deny(entry.approvalId) }
                Button("승인…") { Task { await service.approve(entry.approvalId, screenAccessApproved: allowScreenCapture) } }
                    .disabled(!matches || !service.accessibility || service.approving != nil)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// 상시 허용: on and off here or in the menu. Turning it on needs Touch ID or the login password; off needs nothing.
struct StandingSection: View {
    let service: ScopedControlService
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("상시 허용").font(.headline)
            Text(service.standing.map { ControlConsentText.standingOn(since: Date(timeIntervalSince1970: Double($0.since) / 1000)) } ?? ControlConsentText.standingOff)
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                if service.standing == nil {
                    Button("상시 허용 켜기…") { Task { await service.enableStanding() } }.disabled(service.enablingStanding)
                } else {
                    Button("상시 허용 끄기", role: .destructive) { service.disableStanding() }
                }
            }
            if let problem = service.problem { Text(problem).font(.caption).foregroundStyle(.orange) }
        }
    }
}

/// The background service and the permission this app alone holds. Reading them asks for nothing; every change is
/// the person's button.
struct SettingsPanel: View {
    let service: ControlService

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("백그라운드 실행").font(.headline)
            Text(agentText).foregroundStyle(.secondary)
            HStack {
                Button("백그라운드 실행 등록") { service.registerAgent() }
                    .disabled(service.agentStatus == .enabled)
                Button("등록 해제") { Task { await service.unregisterAgent() } }
                    .disabled(service.agentStatus == .notRegistered || service.agentStatus == .notFound)
                Button("로그인 항목 설정 열기…") { SMAppService.openSystemSettingsLoginItems() }
            }
            Divider()
            Text("손쉬운 사용 · 화면 기록").font(.headline)
            Text(service.accessibility ? "손쉬운 사용 허용됨: 창을 읽고 누르는 동작은 Control 프로세스에서 실행됩니다. 이 허용을 메인 앱이나 에이전트 셸에 자동으로 부여하지 않습니다."
                 : "손쉬운 사용 허용 안 됨: 시스템 설정에서 AgentsToZ Control을 허용해야 제어할 수 있습니다.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text(service.screenRecording ? "화면 기록 허용됨: 승인한 창의 화면 확인과 화면 속 버튼 선택에 씁니다."
                 : "화면 기록 허용 안 됨: 창 화면 확인과 화면 속 버튼 선택에 필요합니다.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("손쉬운 사용 요청") { service.requestAccessibility() }.disabled(service.accessibility)
                Button("화면 기록 요청") { service.requestScreenRecording() }.disabled(service.screenRecording)
            }
            HStack {
                Button("손쉬운 사용 설정 열기…") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                        NSWorkspace.shared.open(url)
                    }
                }
                Button("화면 기록 설정 열기…") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
            if !service.accessibility || !service.screenRecording {
                Text("이 창을 열면 Control이 시스템 설정 목록에 스스로 올라가고 설정 화면이 열립니다. 거기서 AgentsToZ Control 스위치만 켜세요. 화면 기록은 켜면 Control이 알아서 다시 시작해 반영합니다. 목록에 켜져 있는데도 여기서 허용 안 됨이면 이전 빌드로 등록된 항목입니다. 목록에서 AgentsToZ Control을 선택해 −로 지운 뒤 요청을 다시 누르세요.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            StandingSection(service: ScopedControlShared.service)
            Divider()
            Text("승인 키").font(.headline)
            Text("처음 승인할 때 이 Mac의 Secure Enclave에 만들어지고, 승인할 때마다 Touch ID나 로그인 암호가 필요합니다. 키는 밖으로 나가지 않습니다.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Divider()
            Text(service.listening ? "요청 수신 중(백그라운드 서비스)" : "설정 창으로 열림: 요청은 백그라운드 서비스가 받습니다.")
                .font(.caption).foregroundStyle(.secondary)
            if let problem = service.problem { Text(problem).font(.caption).foregroundStyle(.orange) }
            Spacer(minLength: 0)
        }
        .padding(18)
        .frame(minWidth: 460, minHeight: 380)
        .onAppear { service.readAgentStatus(); service.refresh(); service.readScreenRecording() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            service.refresh(); service.readScreenRecording()
        }
    }

    private var agentText: String {
        switch service.agentStatus {
        case .enabled: "켜짐: 메인 앱이 요청할 때 macOS가 이 앱을 백그라운드에서 시작합니다."
        case .requiresApproval: "등록됨, 허용 필요: 로그인 항목 설정에서 AgentsToZ Control을 허용해야 켜집니다."
        case .notFound: "macOS에서 백그라운드 실행 등록을 확인하지 못했습니다. 처음 설정한다면 아래에서 등록하세요. 등록에 실패하면 표시되는 오류를 확인하세요."
        default: "등록 안 됨"
        }
    }
}
