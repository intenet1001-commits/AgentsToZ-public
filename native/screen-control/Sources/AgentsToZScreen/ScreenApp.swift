#if os(macOS)
import AppKit
import Carbon.HIToolbox
import CoreImage.CIFilterBuiltins
import ScreenControlCore
import ScreenHost
import ServiceManagement
import SwiftUI

/// How this launch was asked for: `--show` (the main app's 「AgentsToZ Screen 열기」) opens the status window.
enum ScreenLaunch {
    nonisolated(unsafe) static var showWindow = false
}

/// The one service of this process, shared by the menu, the windows and the app delegate.
@MainActor enum ScreenShared {
    static let service = ScreenService()
}

/// AgentsToZ Screen in the menu bar: on and off, the device registration window, registered devices, and the two
/// permissions it alone holds. The status window says the same in plain view; it opens when the main app or Finder
/// opens AgentsToZ Screen, so the person sees where the switch is instead of nothing.
struct ScreenMenuApp: App {
    @NSApplicationDelegateAdaptor(ScreenAppDelegate.self) private var delegate
    private let service = ScreenShared.service

    var body: some Scene {
        MenuBarExtra {
            ScreenMenu(service: service)
        } label: {
            Image(systemName: service.session != nil ? "rectangle.inset.filled.and.person.filled"
                  : service.isOn ? "display" : service.isWaiting ? "wifi.exclamationmark" : "display.and.arrow.down")
        }
        .menuBarExtraStyle(.menu)
    }
}

/// ⌃⌥⌘. ends the session from the Mac keyboard (DESIGN 「3) 세션 동안」). Registered only while a device is
/// connected, so the keys belong to other apps the rest of the time. A Carbon hot key needs no permission.
@MainActor
enum EndSessionHotKey {
    static let label = "⌃⌥⌘."
    private static var registered: EventHotKeyRef?
    private static var handler: EventHandlerRef?

    static func update(active: Bool) {
        if active, registered == nil {
            if handler == nil {
                var pressed = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
                InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
                    DispatchQueue.main.async { MainActor.assumeIsolated { ScreenShared.service.disconnect() } }
                    return noErr
                }, 1, &pressed, nil, &handler)
            }
            RegisterEventHotKey(UInt32(kVK_ANSI_Period), UInt32(cmdKey | optionKey | controlKey),
                                EventHotKeyID(signature: 0x415A_5353, id: 1), GetApplicationEventTarget(), 0, &registered)
        } else if !active, let key = registered {
            UnregisterEventHotKey(key)
            registered = nil
        }
    }
}

@MainActor
final class ScreenAppDelegate: NSObject, NSApplicationDelegate {
    private var refresh: Timer?

    /// Follows the session so the end-session hot key exists only while someone is connected.
    private func watchSession() {
        withObservationTracking {
            EndSessionHotKey.update(active: ScreenShared.service.session != nil)
        } onChange: {
            Task { @MainActor [weak self] in self?.watchSession() }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        watchSession()
        // A login item opens quietly in the menu bar; the main app, Finder or `open` show where things are.
        if ScreenLaunch.showWindow || !Self.launchedAsLoginItem { PanelWindows.showStatus() }
        // Permissions change in System Settings without telling this app. The status is written only when it changed.
        refresh = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
            MainActor.assumeIsolated { ScreenShared.service.publishStatus() }
        }
    }

    /// Opening AgentsToZ Screen again while it runs (the main app's button, Finder, Spotlight) shows the status window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        PanelWindows.showStatus()
        return false
    }

    private static var launchedAsLoginItem: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == kAEOpenApplication else { return false }
        return event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }
}

/// The two windows, kept by AppKit so the app delegate can open them too. Closing one drops it; the next opening
/// starts fresh. Closing the registration window refuses whatever was waiting (the QR closes with it).
@MainActor
enum PanelWindows {
    private static var open: [String: NSWindow] = [:]
    private final class Closer: NSObject, NSWindowDelegate {
        let id: String
        let onClose: () -> Void
        init(id: String, onClose: @escaping () -> Void) { self.id = id; self.onClose = onClose }
        func windowWillClose(_ notification: Notification) {
            MainActor.assumeIsolated {
                PanelWindows.open[id] = nil
                PanelWindows.closers[id] = nil
                onClose()
            }
        }
    }
    private static var closers: [String: Closer] = [:]

    static func showStatus() {
        show(id: "status", title: "AgentsToZ Screen") { StatusPanel(service: ScreenShared.service) }
    }

    static func showRegistration() {
        let service = ScreenShared.service
        Task { await service.startRegistration() }
        show(id: "registration", title: "Mac 화면 기기 등록", onClose: {
            if service.registration != nil { service.cancelRegistration() }
        }) { RegistrationPanel(service: service) { close("registration") } }
    }

    static func close(_ id: String) { open[id]?.close() }

    private static func show<Content: View>(id: String, title: String, onClose: @escaping () -> Void = {},
                                            @ViewBuilder content: () -> Content) {
        if let window = open[id] {
            NSApp.activate()
            return window.makeKeyAndOrderFront(nil)
        }
        let window = NSWindow(contentViewController: NSHostingController(rootView: content()))
        window.title = title
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        let closer = Closer(id: id, onClose: onClose)
        window.delegate = closer
        closers[id] = closer
        open[id] = window
        window.center()
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }
}

struct ScreenMenu: View {
    let service: ScreenService

    var body: some View {
        switch service.power {
        case .off(let reason):
            Text("화면 제어: 꺼짐")
            if let reason { Text(reason) }
            Button("켜기 (Touch ID)…") { Task { await service.turnOn() } }
        case .starting:
            Text("켜는 중…")
        case .on(let address):
            Text("화면 제어: 켜짐 · \(address)")
            if let network = service.listeningNetwork { Text("승인된 네트워크: \(network.label)") }
            Button("끄기") { service.turnOff() }
        case .waiting(let waiting):
            let text = NetworkText(waiting)
            Text("화면 제어: \(text.title)")
            Text(text.detail)
            if text.canApprove {
                Button("이 네트워크 승인 (Touch ID)…") { Task { await service.approveCurrentNetwork() } }
            }
            Button("끄기") { service.turnOff() }
        }
        if let session = service.session {
            Divider()
            Text("보는 기기: \(session.deviceName)\(session.canControl ? "" : " (보기만)")")
            Button("연결 끊기 (\(EndSessionHotKey.label))") { service.disconnect() }
        } else if let ended = service.lastEnded {
            Divider()
            Text(ended)
        }
        Divider()
        Button("기기 등록…") { PanelWindows.showRegistration() }
            .disabled(!service.isOn || service.session != nil)
        Menu("등록된 기기 (\(service.devices.count))") {
            if service.devices.isEmpty { Text("없음") }
            ForEach(service.devices) { device in
                // SR-13: 90 days without use. The key exchange refuses an expired device whatever this shows.
                let expired = device.isExpired()
                Menu("\(device.name) · \(device.model)\(expired ? " · 만료됨" : "")") {
                    Text("등록 \(device.registeredAt.formatted(date: .abbreviated, time: .omitted))")
                    if let last = device.lastConnectedAt {
                        Text("마지막 연결 \(last.formatted(date: .abbreviated, time: .shortened))")
                    }
                    if expired {
                        Text("90일 동안 쓰지 않아 만료되었습니다. 이 Mac 앞에서 다시 등록하세요.")
                    } else {
                        Text("\(device.expiresAt.formatted(date: .abbreviated, time: .omitted))까지 연결하지 않으면 만료")
                    }
                    Button(expired ? "목록에서 지우기" : "등록 해지") { service.revoke(device) }
                }
            }
        }
        ApprovedNetworksMenu(service: service)
        Divider()
        if ScreenRecordingPermission.current == .granted {
            Text("화면 기록 권한: 허용됨")
        } else {
            Button("화면 기록 권한 허용하기…") {
                ScreenRecordingPermission.request()
                Self.openSettings("Privacy_ScreenCapture")
            }
        }
        if InputInjector.isAllowed {
            Text("손쉬운 사용 권한: 허용됨 (조작 가능)")
        } else {
            Button("손쉬운 사용 권한 허용하기 (조작에 필요)…") {
                InputInjector.request()
                Self.openSettings("Privacy_Accessibility")
            }
        }
        if let problem = service.problem {
            Divider()
            Text(problem)
        }
        Divider()
        Button("상태 창 열기…") { PanelWindows.showStatus() }
        LoginItemToggle(service: service)
        Button("AgentsToZ Screen 종료") {
            // Lets go of held input at once, then gives the phone up to a second to hear why before quitting.
            Task {
                await service.quit()
                NSApp.terminate(nil)
            }
        }
    }

    static func openSettings(_ anchor: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)") { NSWorkspace.shared.open(url) }
    }
}

/// How the menu and the status window say why screen control is on but not listening (결정 4).
struct NetworkText {
    let title: String
    let detail: String
    let canApprove: Bool

    init(_ waiting: ScreenService.Waiting) {
        switch waiting {
        case .noNetwork:
            title = "켜짐 · 네트워크 없음"
            detail = "Wi‑Fi나 유선 네트워크에 연결되어 있지 않습니다. 승인된 네트워크에 연결되면 다시 연결을 받습니다."
            canApprove = false
        case .unidentified(let label):
            title = "켜짐 · 네트워크 확인 중 (\(label))"
            detail = "이 네트워크의 공유기를 아직 확인하지 못해 연결을 받지 않습니다. 잠시 뒤 다시 확인합니다."
            canApprove = false
        case .noRouter(let label):
            title = "켜짐 · 화면 제어에 쓸 수 없는 네트워크 (\(label))"
            detail = "이 네트워크에는 구별할 공유기가 없어 승인할 수 없고, 화면 제어에 쓸 수 없습니다. 승인된 네트워크에 연결되면 다시 연결을 받습니다."
            canApprove = false
        case .unapproved(let label):
            title = "승인되지 않은 네트워크 (\(label))"
            detail = "승인된 네트워크에서만 연결을 받습니다. 이 네트워크에서도 쓰려면 승인하세요."
            canApprove = true
        }
    }
}

/// The approved networks with 「지우기」. Removing never asks for Touch ID: it only narrows where the Mac listens.
struct ApprovedNetworksMenu: View {
    let service: ScreenService

    var body: some View {
        Menu("승인된 네트워크 (\(service.networks.count)/\(NetworkApproval.limit))") {
            if service.networks.isEmpty { Text("없음 · 켤 때 지금 네트워크를 함께 승인합니다") }
            ForEach(service.networks) { network in
                Menu(network.label + (service.listeningNetwork?.id == network.id ? " · 지금 연결을 받는 곳" : "")) {
                    Text("승인 \(network.approvedAt.formatted(date: .abbreviated, time: .omitted))")
                    Button("목록에서 지우기") { service.removeNetwork(network) }
                }
            }
        }
    }
}

/// 「로그인할 때 열기」: the service reads the system's setting again on every status tick, so an approval made in
/// System Settings shows here without reopening the menu.
struct LoginItemToggle: View {
    let service: ScreenService

    var body: some View {
        Toggle("로그인할 때 자동으로 열기", isOn: Binding(get: { service.loginItem != .off }, set: { service.setLoginItem($0) }))
        if service.loginItem == .approval {
            Button("로그인 항목 허용하기…") { SMAppService.openSystemSettingsLoginItems() }
        }
    }
}

/// The same switches as the menu, in a window: what the main app's 「AgentsToZ Screen 열기」 shows.
struct StatusPanel: View {
    let service: ScreenService
    @State private var permissions = 0   // read again when the window comes back to the front

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("아이폰·아이패드로 이 Mac 보기").font(.title3.bold())
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    switch service.power {
                    case .off(let reason):
                        Label("화면 제어 꺼짐", systemImage: "display.and.arrow.down")
                        if let reason { Text(reason).font(.callout).foregroundStyle(.secondary) }
                        Button("켜기 (Touch ID)") { Task { await service.turnOn() } }.keyboardShortcut(.defaultAction)
                    case .starting:
                        Label("켜는 중…", systemImage: "hourglass")
                    case .on(let address):
                        Label("화면 제어 켜짐 · \(address)", systemImage: "display").foregroundStyle(.green)
                        if let network = service.listeningNetwork {
                            Text("승인된 네트워크: \(network.label)").font(.callout).foregroundStyle(.secondary)
                        }
                        Button("끄기") { service.turnOff() }
                    case .waiting(let waiting):
                        let text = NetworkText(waiting)
                        Label(text.title, systemImage: "wifi.exclamationmark").foregroundStyle(.orange)
                        Text(text.detail).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        HStack {
                            if text.canApprove {
                                Button("이 네트워크 승인 (Touch ID)") { Task { await service.approveCurrentNetwork() } }
                                    .keyboardShortcut(.defaultAction)
                            }
                            Button("끄기") { service.turnOff() }
                        }
                    }
                    if let session = service.session {
                        Divider()
                        Text("보는 기기: \(session.deviceName)\(session.canControl ? "" : " (보기만)")")
                        Button("연결 끊기") { service.disconnect() }
                        Text("Mac 키보드에서 \(EndSessionHotKey.label)를 눌러도 바로 끊깁니다.").font(.callout).foregroundStyle(.secondary)
                    } else if let ended = service.lastEnded {
                        Text(ended).font(.callout).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    let usable = service.devices.filter { !$0.isExpired() }.count
                    Text(usable == 0 ? "아직 연결할 수 있는 기기가 없습니다." : "연결할 수 있는 기기 \(usable)대")
                    Button("기기 등록…") { PanelWindows.showRegistration() }
                        .disabled(!service.isOn || service.session != nil)
                    Text(service.isOn ? "기기마다 한 번, 이 Mac 앞에서 QR을 찍고 Touch ID로 승인합니다."
                         : service.isWaiting ? "기기 등록은 승인된 네트워크에서 합니다."
                         : "기기 등록은 화면 제어를 켠 뒤에 합니다.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    Text("승인된 네트워크 \(service.networks.count)/\(NetworkApproval.limit)")
                    if service.networks.isEmpty {
                        Text("아직 없습니다. 켤 때 지금 네트워크를 함께 승인합니다.").font(.callout).foregroundStyle(.secondary)
                    }
                    ForEach(service.networks) { network in
                        // The approval date tells rows apart even when two labels read alike (the same Wi‑Fi name).
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(network.label).lineLimit(1).truncationMode(.middle)
                                Text("승인 \(network.approvedAt.formatted(date: .abbreviated, time: .shortened))"
                                     + (service.listeningNetwork?.id == network.id ? " · 지금 연결을 받는 곳" : ""))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("지우기") { service.removeNetwork(network) }
                        }
                    }
                    Text("기기는 승인된 네트워크에서만 이 Mac에 연결합니다. 다른 네트워크로 옮기면 연결을 받지 않고, 승인된 네트워크로 돌아오면 다시 받습니다.")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    let _ = permissions
                    if ScreenRecordingPermission.current == .granted {
                        Label("화면 기록 권한: 허용됨", systemImage: "checkmark.circle")
                    } else {
                        Button("화면 기록 권한 허용하기…") {
                            ScreenRecordingPermission.request()
                            ScreenMenu.openSettings("Privacy_ScreenCapture")
                        }
                    }
                    if InputInjector.isAllowed {
                        Label("손쉬운 사용 권한: 허용됨 (조작 가능)", systemImage: "checkmark.circle")
                    } else {
                        Button("손쉬운 사용 권한 허용하기 (조작에 필요)…") {
                            InputInjector.request()
                            ScreenMenu.openSettings("Privacy_Accessibility")
                        }
                    }
                    LoginItemToggle(service: service)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let problem = service.problem { Text(problem).font(.callout).foregroundStyle(.red) }
            Text("아이폰·아이패드: AgentsToZ 앱 홈의 「Mac 화면」에서 이 Mac을 누르고 Face ID로 승인합니다. 같은 Wi‑Fi에서만 연결합니다. 이 창을 닫아도 메뉴 막대의 화면 아이콘에서 계속 쓸 수 있습니다.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(width: 400)
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            permissions += 1
            service.publishStatus()
        }
    }
}

struct RegistrationPanel: View {
    let service: ScreenService
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            switch service.registration {
            case .showing(let invite, let until):
                Text("iPhone·iPad에서 AgentsToZ 앱 → 「Mac 화면 등록」을 누르고 이 QR을 찍으세요.")
                    .multilineTextAlignment(.center)
                if let image = Self.qrImage(invite.text) {
                    Image(nsImage: image).interpolation(.none).resizable().frame(width: 260, height: 260)
                }
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("\(max(0, Int(until.timeIntervalSince(context.date))))초 뒤 닫힘 · QR 하나에 기기 하나")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button("취소") { service.cancelRegistration(); dismiss() }
            case .confirming(let name, let model, let sas):
                Text("‘\(name)’ (\(model))이 등록을 요청했습니다.").font(.headline)
                Text(sas.prefix(3) + " " + sas.suffix(3)).font(.system(size: 44, weight: .semibold, design: .monospaced))
                Text("기기 화면의 숫자와 같을 때만 승인하세요. 다르면 거절하세요.").multilineTextAlignment(.center)
                HStack {
                    Button("거절", role: .destructive) { Task { await service.refusePending() } }
                    Button("승인 (Touch ID)") { Task { await service.approvePending() } }.keyboardShortcut(.defaultAction)
                }
            case .finished(let message):
                Text(message).multilineTextAlignment(.center)
                Button("닫기") { service.cancelRegistration(); dismiss() }
            case nil:
                if service.isOn || service.power == .starting {
                    ProgressView()
                } else if service.isWaiting {
                    Text("기기 등록은 승인된 네트워크에서 합니다. 이 Mac이 승인된 네트워크에 연결되면 다시 시작해 주세요.")
                        .multilineTextAlignment(.center)
                    Button("닫기") { dismiss() }
                } else {
                    Text("먼저 메뉴 막대에서 화면 제어를 켜 주세요.")
                    Button("닫기") { dismiss() }
                }
            }
        }
        .padding(24)
        .frame(width: 380)
    }

    /// The QR as crisp pixels; shown on this screen only.
    static func qrImage(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: output.extent.size)
    }
}
#endif
