import ScreenControlCore
import SwiftUI

// Remote stop and notifications in the UI (DESIGN 「알림·원격 차단」): the Mac row's menu in ScreenMacsSection, the
// confirmation and progress sheet, and what a tapped notification offers. Shown only when the build has a push
// endpoint (ScreenPushConfig). Each stop asks for Face ID; turning screen control back on stays at the Mac.

/// The Mac row's long-press menu.
struct ScreenRemoteStopMenu: View {
    let mac: SavedScreenMac
    let ask: (ScreenRemoteStopRequest) -> Void
    let notice: (String) -> Void
    private var center: ScreenPushCenter { .shared }

    var body: some View {
        if ScreenPushConfig.isEnabled {
            Section("원격 차단 · Face ID") {
                Button(role: .destructive) { ask(.init(mac: mac, action: .endSession)) } label: {
                    Label { Text("지금 끊기"); Text("이 Mac에 연결된 화면 보기를 끝냅니다") } icon: { Image(systemName: "xmark.circle") }
                }
                Button(role: .destructive) { ask(.init(mac: mac, action: .revokeConnected)) } label: {
                    Label { Text("이 기기 해지"); Text("지금 이 Mac에 연결된 기기의 등록을 지웁니다") } icon: { Image(systemName: "person.crop.circle.badge.xmark") }
                }
                Button(role: .destructive) { ask(.init(mac: mac, action: .turnOff)) } label: {
                    Label { Text("화면 제어 전체 끄기"); Text("다시 켜려면 Mac에서 켜야 합니다") } icon: { Image(systemName: "power") }
                }
            }
            Section("알림") {
                if center.subscribed.contains(mac.pushKey) && !center.stale.contains(mac.pushKey) {
                    Button("알림 끄기", systemImage: "bell.slash") { Task { notice(await center.unsubscribe(mac)) } }
                } else {
                    Button(center.stale.contains(mac.pushKey) ? "알림 다시 켜기 · Face ID" : "알림 받기 · Face ID", systemImage: "bell") {
                        Task { notice(await center.subscribe(mac)) }
                    }
                }
            }
        }
    }
}

extension View {
    /// Confirms a remote stop (unless already chosen), then Face ID, sending and the Mac's answer in a small sheet.
    func screenRemoteStop(_ request: Binding<ScreenRemoteStopRequest?>) -> some View {
        modifier(ScreenRemoteStopPresenter(request: request))
    }

    /// What a tapped notification offers, when the pinned Mac signed its event. Attach once, at the app's root.
    func screenPushTaps() -> some View { modifier(ScreenPushTapPresenter()) }
}

private struct ScreenRemoteStopPresenter: ViewModifier {
    @Binding var request: ScreenRemoteStopRequest?
    @State private var running: ScreenRemoteStopRequest?

    func body(content: Content) -> some View {
        content
            .confirmationDialog(request.map { "\($0.mac.macName)에 「\(ScreenPushCenter.title(of: $0.action))」" } ?? "",
                                isPresented: Binding(get: { request.map { !$0.confirmed } ?? false }, set: { if !$0 { request = nil } }),
                                titleVisibility: .visible, presenting: request) { pending in
                Button("Face ID로 보내기", role: .destructive) {
                    request = nil
                    start(pending)
                }
                Button("취소", role: .cancel) { request = nil }
            } message: { pending in
                Text(Self.explanation(pending.action))
            }
            .onChange(of: request?.id) { _, _ in
                guard let pending = request, pending.confirmed else { return }
                request = nil
                start(pending)
            }
            .sheet(item: $running) { pending in
                ScreenRemoteStopProgress(request: pending)
                    .presentationDetents([.medium])
            }
    }

    /// After the dialog has gone: iOS drops a sheet presented while another presentation is still going away.
    private func start(_ pending: ScreenRemoteStopRequest) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            running = pending
        }
    }

    static func explanation(_ action: RemoteStopAction) -> String {
        switch action {
        case .endSession: "지금 연결된 화면 보기를 Mac이 끝냅니다. 보낸 뒤 새로 시작된 연결은 끊지 않습니다."
        case .revokeConnected: "지금 이 Mac에 연결된 기기의 등록을 Mac이 지웁니다. 그 기기는 다시 등록해야 연결할 수 있습니다."
        case .revokeDevice: "그 기기의 등록을 Mac이 지웁니다. 그 기기는 다시 등록해야 연결할 수 있습니다."
        case .turnOff: "Mac의 화면 제어를 끕니다. 다시 켜려면 Mac 앞에서 직접 켜야 합니다. 휴대폰으로는 켤 수 없습니다."
        }
    }
}

private struct ScreenRemoteStopProgress: View {
    let request: ScreenRemoteStopRequest
    @Environment(\.dismiss) private var dismiss
    @State private var phase: RemoteStopPhase = .approving

    var body: some View {
        VStack(spacing: 16) {
            Text("\(request.mac.macName) · \(ScreenPushCenter.title(of: request.action))").font(.headline)
            if !phase.isFinished { ProgressView() }
            Text(ScreenPushCenter.message(phase, action: request.action))
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("remoteStopStatus")
            Button(phase.isFinished ? "닫기" : "기다리지 않고 닫기") { dismiss() }
                .buttonStyle(.bordered)
        }
        .padding()
        .task {
            await ScreenPushCenter.shared.send(request.action, to: request.mac) { phase = $0 }
        }
    }
}

private struct ScreenPushTapPresenter: ViewModifier {
    @State private var center = ScreenPushCenter.shared
    @State private var request: ScreenRemoteStopRequest?

    func body(content: Content) -> some View {
        content
            .confirmationDialog(center.tapped.map(Self.title) ?? "",
                                isPresented: Binding(get: { center.tapped != nil }, set: { if !$0 { center.tapped = nil } }),
                                titleVisibility: .visible, presenting: center.tapped) { tapped in
                Button("지금 끊기 · Face ID", role: .destructive) { choose(.endSession, tapped) }
                Button("‘\(tapped.event.actorName)’ 해지 · Face ID", role: .destructive) { choose(.revokeDevice(tapped.event.actorID), tapped) }
                Button("화면 제어 전체 끄기 · Face ID", role: .destructive) { choose(.turnOff, tapped) }
                Button("괜찮아요", role: .cancel) { center.tapped = nil }
            } message: { _ in
                Text("본인이 한 일이 아니면 막을 수 있습니다. 화면 제어 전체 끄기는 다시 켜려면 Mac에서 켜야 합니다.")
            }
            .screenRemoteStop($request)
    }

    private func choose(_ action: RemoteStopAction, _ tapped: TappedScreenEvent) {
        center.tapped = nil
        request = ScreenRemoteStopRequest(mac: tapped.mac, action: action, confirmed: true)
    }

    static func title(_ tapped: TappedScreenEvent) -> String {
        let time = tapped.event.date.formatted(date: .omitted, time: .shortened)
        return switch tapped.event.kind {
        case .connected: "‘\(tapped.event.actorName)’이(가) \(tapped.mac.macName)에 연결했습니다 (\(time))"
        case .registered: "‘\(tapped.event.actorName)’이(가) \(tapped.mac.macName)에 새로 등록되었습니다 (\(time))"
        }
    }
}
