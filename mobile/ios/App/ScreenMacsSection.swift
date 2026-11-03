import ScreenControlCore
import AgentsToZCore
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
    @State private var community = MobileScreenCommunity.shared
    private var availableMacs: [SavedScreenMac] {
        let common = Set(community.unified.screenTargets.map(\.id))
        let legacy = Set(macs.map(\.id))
        return macs.filter { !common.contains($0.id) } + community.macs.filter { !community.unified.hasEnrollmentPlan && !legacy.contains($0.id) && !common.contains($0.id) }
    }
    /// One sheet for the whole registration: the scanner turns into the registration in place. Closing the scanner
    /// and presenting the registration as a second sheet lost the second one — iOS ignores a presentation while
    /// another sheet is still going away — so a scan only closed the scanner (2026-10-25, iPad mini).
    @State private var actionsOpen = false
    @State private var registering = false
    @State private var invite: RegistrationInvite?
    /// The open registration has started (key, App Attest, the Mac's answer) and not yet ended.
    @State private var registrationBusy = false
    @State private var viewing: SavedScreenMac?
    @State private var commonViewing: MobileCommunityScreenTarget?
    @AppStorage("screenControl.connectionRoute") private var connectionRoute = ScreenConnectionRoute.automatic
    @State private var notice: String?
    @State private var deleting: [SavedScreenMac] = []
    @State private var privateNetworkSetup: SavedScreenMac?
    // Local display names are separate from the signed community directory and the pinned Mac identity.
    @AppStorage("screenControl.macDisplayNames") private var displayNamesJSON = "{}"
    @State private var renaming: ScreenMacRenameTarget?
    @State private var remoteStop: ScreenRemoteStopRequest? // push hook: remote stop (ScreenRemoteStopMenu.swift)

    var body: some View {
        Section {
            ScreenCommunityControls()
            Button("커뮤니티 기능 · Teams·CLI·브라우저",systemImage:"rectangle.connected.to.line.below") {
                registrationOpen.wrappedValue = true; actionsOpen = true
            }
            .accessibilityIdentifier("communityActionsOpen")
            .sheet(isPresented:$actionsOpen,onDismiss:{ registrationOpen.wrappedValue = registering }) { CommunityActionsView() }
            Picker("화면 연결 경로", selection: $connectionRoute) {
                Text("자동").tag(ScreenConnectionRoute.automatic)
                Text("근거리").tag(ScreenConnectionRoute.nearby)
                Text("자체 중계 서버").tag(ScreenConnectionRoute.internet)
                Text("사설망 · Cloudflare").tag(ScreenConnectionRoute.privateNetwork)
            }
            .accessibilityIdentifier("screenConnectionRoute")
            Text("이 경로 선택은 공통 등록 Mac에는 적용되지 않습니다. 공통 등록은 자동으로 연결합니다.")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(community.unified.screenTargets) { target in
                HStack {
                    Button { commonViewing = target } label: {
                        Label {
                            VStack(alignment: .leading) {
                                Text(displayName(for: target.mac))
                                Text("공통 등록 · Cloudflare · 사용 세션 인증 공유").font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "display") }
                    }.accessibilityIdentifier("openCommonScreen")
                    Spacer()
                    renameMenu(for: target.mac, includeConnectionActions: false)
                }.buttonStyle(.borderless)
            }
            ForEach(availableMacs) { mac in
                HStack {
                    Button { viewing = mac } label: {
                        Label {
                            VStack(alignment: .leading) {
                                Text(displayName(for: mac))
                                Text("화면 보기 · 조작").font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "display") }
                    }
                    .accessibilityIdentifier("openScreen")
                    Spacer()
                    renameMenu(for: mac, includeConnectionActions: true)
                }.buttonStyle(.borderless)
                .contextMenu {
                    Button("이름 변경…", systemImage: "pencil") { beginRename(mac) }
                    Button("사설망 연결 설정…", systemImage: "network.badge.shield.half.filled") { privateNetworkSetup = mac }
                    if mac.communityID == nil { ScreenRemoteStopMenu(mac: displayMac(mac), ask: { remoteStop = $0 }, notice: { notice = $0 }) }
                }
            }
            .onDelete { offsets in
                let selected = offsets.map { availableMacs[$0] }
                deleting = selected.filter { $0.communityID == nil }
                if selected.contains(where: { $0.communityID != nil }) { notice = "커뮤니티 기기의 접근 권한은 관리 기기에서 등록을 해제해 주세요." }
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
                    if mac.communityID != nil { try community.saveRoute(for: mac, route: route); return }
                    var latest = try ScreenMacStore.loadForUpdate()
                    guard let index = latest.firstIndex(of: mac) else { throw RegistrationError.malformed }
                    latest[index].privateNetwork = route
                    try ScreenMacStore.save(latest)
                    macs = latest
                }
            }
            .sheet(item: $renaming) { target in
                ScreenMacRenameSheet(target: target) { name in
                    displayNamesJSON = try ScreenMacDisplayNames.updating(json: displayNamesJSON, id: target.id, name: name)
                }
            }
            .fullScreenCover(item: $commonViewing) { target in
                ScreenViewerView(mac: displayMac(target.mac), route: .automatic, communityTarget: target.peer)
            }
            .fullScreenCover(item: $viewing) { mac in
                ScreenViewerView(mac: displayMac(mac), route: connectionRoute)
            }
            .onChange(of: community.macs.map(\.id)) { _, ids in
                if let current = viewing, current.communityID != nil, !ids.contains(current.id) { viewing = nil }
            }
            .onChange(of: community.unified.screenTargets.map(\.id)) { _, ids in
                if let current = commonViewing, !ids.contains(current.id) { commonViewing = nil }
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
            Text("Mac의 AgentsToZ에서 근무 모드 → 「AgentsToZ Screen 열기」(또는 메뉴 막대의 화면 아이콘)를 눌러 화면 제어를 켜고 「기기 등록…」을 누르면 QR이 뜹니다. 그 QR을 여기서 찍으세요(주소를 Safari에 입력하지 않습니다). Mac 옆의 더 보기에서 이 기기에 표시할 이름을 바꿀 수 있습니다. 근거리에서는 두 기기의 Wi‑Fi를 켜세요. 밖에서는 Mac을 길게 눌러 「사설망 연결 설정…」을 저장하고 경로를 ‘사설망 · Cloudflare’로 고르세요. 목록에서 지워도 Mac 쪽 등록은 남으니, Mac에서도 해지하세요.")
            // push hook: only in a build with a push endpoint.
            if ScreenPushConfig.isEnabled {
                Text("QR로 개별 등록한 Mac을 길게 누르면 알림·연결 끊기·화면 제어 끄기를 사용할 수 있습니다. 커뮤니티 기기의 접근 해제는 위의 ‘등록 기기 관리’에서 합니다. 화면 제어를 다시 켜는 것은 Mac에서만 됩니다.")
            }
        }
    }

    private func displayName(for mac: SavedScreenMac) -> String {
        ScreenMacDisplayNames.displayName(json: displayNamesJSON, id: mac.id, fallback: mac.macName)
    }

    private func displayMac(_ mac: SavedScreenMac) -> SavedScreenMac {
        var copy = mac
        copy.macName = displayName(for: mac)
        return copy
    }

    private func beginRename(_ mac: SavedScreenMac) {
        renaming = ScreenMacRenameTarget(id: mac.id, originalName: mac.macName, currentName: displayName(for: mac))
    }

    private func renameMenu(for mac: SavedScreenMac, includeConnectionActions: Bool) -> some View {
        Menu {
            Button("이름 변경…", systemImage: "pencil") { beginRename(mac) }
            if includeConnectionActions {
                Button("사설망 연결 설정…", systemImage: "network.badge.shield.half.filled") { privateNetworkSetup = mac }
                if mac.communityID == nil { ScreenRemoteStopMenu(mac: displayMac(mac), ask: { remoteStop = $0 }, notice: { notice = $0 }) }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("\(displayName(for: mac)) 더 보기")
        .accessibilityIdentifier("screenMacMore")
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

private struct ScreenMacRenameTarget: Identifiable {
    let id: String
    let originalName: String
    let currentName: String
}

private struct ScreenMacRenameSheet: View {
    let target: ScreenMacRenameTarget
    let save: (String?) throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var problem: String?

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var validName: Bool {
        ScreenMacDisplayNames.valid(name)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("이 기기에 표시할 이름") {
                    TextField("Mac 이름", text: $name)
                        .accessibilityIdentifier("screenMacRenameField")
                    Text("이 이름은 이 기기의 Mac 화면 목록과 화면 보기에 표시됩니다. 커뮤니티 기능의 Mac 선택에는 원래 이름이 표시되며 Mac의 이름과 등록 권한은 그대로 유지됩니다.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("원래 이름: \(target.originalName)").font(.caption).foregroundStyle(.secondary)
                    if !validName { Text("이름은 1~64자로 입력하고 줄바꿈은 제외해 주세요.").font(.caption).foregroundStyle(.secondary) }
                    Button("원래 이름으로 되돌리기") { update(nil) }
                }
                if let problem { Section { Text(problem).foregroundStyle(.red) } }
            }
            .navigationTitle("Mac 이름 변경")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("취소") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("저장") { update(trimmedName) }.disabled(!validName) }
            }
            .onAppear { name = target.currentName }
        }
    }

    private func update(_ value: String?) {
        do { try save(value); dismiss() }
        catch { problem = "이름을 저장하지 못했습니다. 기존 이름은 유지됩니다." }
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
