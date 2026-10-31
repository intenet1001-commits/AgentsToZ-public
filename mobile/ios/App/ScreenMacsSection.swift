import ScreenControlCore
import SwiftUI

/// 「Mac 화면」 on the home screen: the Macs this device registered, each opening its screen after Face ID, and
/// registering another from the QR AgentsToZ Screen shows. `scannedInvite` carries a registration QR the home
/// screen's own scanner read, or that the iPhone Camera opened the app with (`RegistrationInvite.scheme`).
struct ScreenMacsSection: View {
    /// The row the presentations hang off; the home screen scrolls to it so a handed-over QR reaches a live row.
    static let registerRowID = "registerScreenMac"
    @Binding var scannedInvite: String?
    /// Whether this section's registration sheet (scanner or registration) is up, for the home screen not to cover it
    /// with the saved workspace when the app comes back to the front.
    var registrationOpen: Binding<Bool> = .constant(false)
    @State private var macs = ScreenMacStore.load()
    /// One sheet for the whole registration: the scanner turns into the registration in place. Closing the scanner
    /// and presenting the registration as a second sheet lost the second one — iOS ignores a presentation while
    /// another sheet is still going away — so a scan only closed the scanner (2026-10-25, iPad mini).
    @State private var registering = false
    @State private var invite: RegistrationInvite?
    /// The open registration has started (key, App Attest, the Mac's answer) and not yet ended.
    @State private var registrationBusy = false
    @State private var viewing: SavedScreenMac?
    @AppStorage("screenControl.connectionRoute") private var connectionRoute = ScreenConnectionRoute.automatic
    @State private var notice: String?
    @State private var deleting: [SavedScreenMac] = []
    @State private var privateNetworkSetup: SavedScreenMac?
    @State private var remoteStop: ScreenRemoteStopRequest? // push hook: remote stop (ScreenRemoteStopMenu.swift)

    var body: some View {
        Section {
            Picker("화면 연결 경로", selection: $connectionRoute) {
                Text("자동").tag(ScreenConnectionRoute.automatic)
                Text("근거리").tag(ScreenConnectionRoute.nearby)
                Text("자체 중계 서버").tag(ScreenConnectionRoute.internet)
                Text("사설망 · Cloudflare").tag(ScreenConnectionRoute.privateNetwork)
            }
            .accessibilityIdentifier("screenConnectionRoute")
            ForEach(macs) { mac in
                Button { viewing = mac } label: {
                    Label {
                        VStack(alignment: .leading) {
                            Text(mac.macName)
                            Text("화면 보기 · 조작").font(.caption).foregroundStyle(.secondary)
                        }
                    } icon: { Image(systemName: "display") }
                }
                .accessibilityIdentifier("openScreen")
                .contextMenu {
                    Button("사설망 연결 설정…", systemImage: "network.badge.shield.half.filled") { privateNetworkSetup = mac }
                    ScreenRemoteStopMenu(mac: mac, ask: { remoteStop = $0 }, notice: { notice = $0 })
                }
            }
            .onDelete { offsets in
                deleting = offsets.map { macs[$0] }
            }
            // The presentations hang off this one row, which is always there: modifiers on a List section reach
            // each of its rows, and several rows bound to the same sheet state fight over presenting it.
            Button("Mac 화면 등록 · QR 스캔", systemImage: "qrcode.viewfinder") {
                invite = nil
                notice = nil
                presentRegistration(true)
            }
            .accessibilityIdentifier("registerScreenMac")
            .id(Self.registerRowID)
            .sheet(isPresented: $registering, onDismiss: {
                invite = nil; registrationBusy = false; registrationOpen.wrappedValue = false
            }) {
                if let invite {
                    // A new QR starts a new registration: without the identity the sheet kept the last one's state
                    // (a failed or finished registration) under the new invitation.
                    ScreenRegistrationSheet(invite: invite, busy: $registrationBusy) { saved in
                        macs = try ScreenMacStore.register(saved)
                    }
                    .id(invite.code.id)
                } else {
                    QRScannerSheet(accepts: { (try? RegistrationInvite(deviceRegistrationText: $0)) != nil },
                                   rejectedHint: "Mac의 「기기 등록…」 QR을 비춰 주세요. Mac 컨트롤러 전용 QR은 이 화면에서 등록할 수 없습니다.") { text in
                        open(text)
                    }
                }
            }
            .confirmationDialog("이 기기의 Mac 목록에서 지울까요?", isPresented: Binding(
                get: { !deleting.isEmpty }, set: { if !$0 { deleting = [] } }
            ), titleVisibility: .visible) {
                Button("이 기기 목록에서만 지우기", role: .destructive) { removeFromThisDevice() }
                Button("취소", role: .cancel) { deleting = [] }
            } message: {
                Text("Mac의 등록 권한은 남습니다. 연결 권한도 지우려면 Mac의 AgentsToZ Screen 상태 창에서 해당 기기의 ‘등록 해지’를 누르세요.")
            }
            .sheet(item: $privateNetworkSetup) { mac in
                ScreenPrivateNetworkSettings(mac: mac) { route in
                    var latest = try ScreenMacStore.loadForUpdate()
                    guard let index = latest.firstIndex(of: mac) else { throw RegistrationError.malformed }
                    latest[index].privateNetwork = route
                    try ScreenMacStore.save(latest)
                    macs = latest
                }
            }
            .fullScreenCover(item: $viewing) { mac in
                ScreenViewerView(mac: mac, route: connectionRoute)
            }
            .screenRemoteStop($remoteStop) // push hook
            // The home screen and the workspace's 「Mac 화면」 sheet each hold a copy; a Mac registered in one shows in the other.
            .onAppear {
                macs = ScreenMacStore.load { count in notice = "읽지 못한 Mac 연결 정보 \(count)건이 있습니다. 다른 등록은 유지했습니다. 해당 Mac만 다시 등록해 주세요." }
            }
            // `initial`: a QR handed over before this row existed (the list builds rows as they scroll into view) is
            // read when the row appears, not lost.
            .onChange(of: scannedInvite, initial: true) { _, text in
                guard let text else { return }
                scannedInvite = nil
                open(text)
            }
            if let notice { Text(notice).font(.subheadline).foregroundStyle(.secondary) }
        } header: {
            Text("Mac 화면")
        } footer: {
            Text("Mac의 AgentsToZ에서 근무 모드 → 「AgentsToZ Screen 열기」(또는 메뉴 막대의 화면 아이콘)를 눌러 화면 제어를 켜고 「기기 등록…」을 누르면 QR이 뜹니다. 그 QR을 여기서 찍으세요(주소를 Safari에 입력하지 않습니다). 근거리에서는 두 기기의 Wi‑Fi를 켜세요. 밖에서는 Mac을 길게 눌러 「사설망 연결 설정…」을 저장하고 경로를 ‘사설망 · Cloudflare’로 고르세요. 목록에서 지워도 Mac 쪽 등록은 남으니, Mac에서도 해지하세요.")
            // push hook: only in a build with a push endpoint.
            if ScreenPushConfig.isEnabled {
                Text("Mac을 길게 누르면 알림을 켜거나, 연결을 끊거나, 기기를 해지하거나, 화면 제어를 끌 수 있습니다. 기기 인증이 필요한 동작은 등록 시 선택한 방식으로 승인합니다. 다시 켜는 것은 Mac에서만 됩니다.")
            }
        }
    }

    private func removeFromThisDevice() {
        let removed = deleting
        let removedRows = Set(removed)
        do {
            // Read again: another screen may have registered a Mac since this list appeared.
            let remaining = try ScreenMacStore.loadForUpdate().filter { !removedRows.contains($0) }
            try ScreenMacStore.save(remaining)
            macs = remaining
            deleting = []
            notice = "이 기기 목록에서 지웠습니다. Mac의 등록 권한은 남아 있으니 필요하면 Mac에서 등록을 해지하세요."
            for mac in removed { Task { await ScreenPushCenter.shared.unsubscribe(mac) } }
        } catch {
            deleting = []
            notice = "목록을 저장하지 못해 지우지 않았습니다. 다시 시도해 주세요."
        }
    }

    /// From this section's scanner the open sheet turns into the registration; from the home screen's scanner (which
    /// hands the QR over only after its own sheet has gone) it opens the sheet straight on the registration.
    private func open(_ text: String) {
        let next: RegistrationInvite
        do { next = try RegistrationInvite(deviceRegistrationText: text) } catch {
            notice = Self.rejection(for: error)
            // The scanner gives way to the reason; a registration already on screen is not closed by a bad QR.
            if invite == nil { presentRegistration(false) }
            return
        }
        if registering, let current = invite {
            // The same QR again (scanned twice, or opened from the Camera while its registration is up) changes nothing.
            if current.code.id == next.code.id { return }
            // One under way (keys made, the Mac asked) is never dropped for another QR: its outcome is not known yet.
            if registrationBusy {
                notice = Self.busyNotice
                return
            }
        }
        invite = next
        notice = nil
        presentRegistration(true)
    }

    static let busyNotice = "등록이 진행 중이라 새 QR은 열지 않았습니다. 지금 등록을 마치거나 닫은 뒤 다시 찍어 주세요."

    private func presentRegistration(_ open: Bool) {
        registering = open
        // Told at once, not on the next update: the home screen decides on resuming its workspace in between.
        registrationOpen.wrappedValue = open
    }

    /// Why a QR handed to the device registration cannot be used, for every place that receives one.
    static func rejection(for error: Error) -> String {
        if case RegistrationError.wrongPurpose = error {
            return "Mac 컨트롤러 전용 QR은 이 화면에서 등록할 수 없습니다. Mac의 「기기 등록…」 QR을 사용해 주세요."
        }
        return "AgentsToZ Screen의 등록 QR이 아닙니다."
    }
}

/// This changes only the route to a previously registered, pinned Mac. It never registers a new identity, signs in
/// to Cloudflare, enables a VPN or replaces the biometric approval required by the ordinary screen handshake.
private struct ScreenPrivateNetworkSettings: View {
    let mac: SavedScreenMac
    let save: (ScreenPrivateNetworkRoute?) throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section(mac.macName) {
                    Text("먼저 Cloudflare One Agent에 본인 조직으로 로그인하고 VPN 연결을 켜세요. 이 Mac 한 대와 화면 제어 포트만 허용한 경로를 사용합니다.")
                    TextField("Mac의 사설 IPv4 주소", text: $address, prompt: Text("예: 192.168.1.10"))
                        .keyboardType(.decimalPad).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("screenPrivateNetworkAddress")
                    Text("Cloudflare에 등록한 이 Mac의 주소를 입력하세요. Mac의 주소가 바뀌면 Cloudflare 경로와 이 설정을 함께 갱신해야 합니다.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("사설망 경로 저장") { update(remove: false) }
                        .disabled(!ScreenPrivateNetworkRoute.validAddress(address))
                    if mac.privateNetwork != nil {
                        Button("사설망 경로 지우기", role: .destructive) { update(remove: true) }
                    }
                }
                Section {
                    Text("저장 후 ‘화면 연결 경로’에서 ‘사설망 · Cloudflare’를 선택하세요. 자동 연결은 이 경로를 사용하지 않습니다. 기존 Mac 등록과 매 연결 기기 인증은 그대로 필요합니다.")
                    Text("이 설정은 Cloudflare 터널이나 VPN을 만들지 않습니다. Cloudflare에서 접근 권한을 끄려면 해당 터널과 등록 기기를 별도로 해지하세요.")
                }
                if let problem { Section { Text(problem).foregroundStyle(.red) } }
            }
            .navigationTitle("사설망 연결 설정")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("닫기") { dismiss() } } }
            .onAppear { address = mac.privateNetwork?.address ?? (ScreenPrivateNetworkRoute.validAddress(mac.address) ? mac.address : "") }
        }
    }

    private func update(remove: Bool) {
        do {
            try save(remove ? nil : ScreenPrivateNetworkRoute(address: address))
            dismiss()
        } catch {
            problem = "설정을 저장하지 못했습니다. Mac 목록을 다시 열고 등록 상태와 주소를 확인하세요. 기존 설정은 유지했습니다."
        }
    }
}

private struct IdentifiedInvite: Identifiable {
    let invite: RegistrationInvite
    var id: Data { invite.code.id }
}
