import ScreenControlCore
import SwiftUI

/// 「Mac 화면」 on the home screen: the Macs this device registered, each opening its screen after Face ID, and
/// registering another from the QR AgentsToZ Screen shows. `scannedInvite` carries a registration QR the home
/// screen's own scanner read.
struct ScreenMacsSection: View {
    @Binding var scannedInvite: String?
    @State private var macs = ScreenMacStore.load()
    /// One sheet for the whole registration: the scanner turns into the registration in place. Closing the scanner
    /// and presenting the registration as a second sheet lost the second one — iOS ignores a presentation while
    /// another sheet is still going away — so a scan only closed the scanner (2026-10-25, iPad mini).
    @State private var registering = false
    @State private var invite: RegistrationInvite?
    @State private var viewing: SavedScreenMac?
    @State private var notice: String?
    @State private var remoteStop: ScreenRemoteStopRequest? // push hook: remote stop (ScreenRemoteStopMenu.swift)

    var body: some View {
        Section {
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
                .contextMenu { ScreenRemoteStopMenu(mac: mac, ask: { remoteStop = $0 }, notice: { notice = $0 }) } // push hook
            }
            .onDelete { offsets in
                for mac in offsets.map({ macs[$0] }) { Task { await ScreenPushCenter.shared.unsubscribe(mac) } } // push hook: no more notifications for it
                macs.remove(atOffsets: offsets)
                try? ScreenMacStore.save(macs)
            }
            // The presentations hang off this one row, which is always there: modifiers on a List section reach
            // each of its rows, and several rows bound to the same sheet state fight over presenting it.
            Button("Mac 화면 등록 · QR 스캔", systemImage: "qrcode.viewfinder") {
                invite = nil
                notice = nil
                registering = true
            }
            .accessibilityIdentifier("registerScreenMac")
            .sheet(isPresented: $registering, onDismiss: { invite = nil }) {
                if let invite {
                    ScreenRegistrationSheet(invite: invite) { saved in
                        macs.removeAll { $0.id == saved.id && $0.deviceName == saved.deviceName }
                        macs.append(saved)
                        do { try ScreenMacStore.save(macs) } catch { notice = "등록을 이 기기에 저장하지 못했습니다." }
                    }
                } else {
                    QRScannerSheet(accepts: { (try? RegistrationInvite(text: $0)) != nil },
                                   rejectedHint: "AgentsToZ Screen의 등록 QR이 아닙니다. Mac의 「기기 등록…」 창에 뜬 QR을 비춰 주세요.") { text in
                        open(text)
                    }
                }
            }
            .fullScreenCover(item: $viewing) { mac in
                ScreenViewerView(mac: mac)
            }
            .screenRemoteStop($remoteStop) // push hook
            // The home screen and the workspace's 「Mac 화면」 sheet each hold a copy; a Mac registered in one shows in the other.
            .onAppear { macs = ScreenMacStore.load() }
            .onChange(of: scannedInvite) { _, text in
                guard let text else { return }
                scannedInvite = nil
                open(text)
            }
            if let notice { Text(notice).font(.subheadline).foregroundStyle(.secondary) }
        } header: {
            Text("Mac 화면")
        } footer: {
            Text("Mac의 AgentsToZ에서 근무 모드 → 「AgentsToZ Screen 열기」(또는 메뉴 막대의 화면 아이콘)를 눌러 화면 제어를 켜고 「기기 등록…」을 누르면 QR이 뜹니다. 그 QR을 여기서 찍으세요(주소를 Safari에 입력하지 않습니다). 같은 Wi‑Fi에서만 연결합니다. 목록에서 지워도 Mac 쪽 등록은 남으니, Mac에서도 해지하세요.")
            // push hook: only in a build with a push endpoint.
            if ScreenPushConfig.isEnabled {
                Text("Mac을 길게 누르면 알림을 켜거나, 연결을 끊거나, 기기를 해지하거나, 화면 제어를 끌 수 있습니다(매번 Face ID). 다시 켜는 것은 Mac에서만 됩니다.")
            }
        }
    }

    /// From this section's scanner the open sheet turns into the registration; from the home screen's scanner (which
    /// hands the QR over only after its own sheet has gone) it opens the sheet straight on the registration.
    private func open(_ text: String) {
        do {
            invite = try RegistrationInvite(text: text)
            notice = nil
            registering = true
        } catch {
            notice = "AgentsToZ Screen의 등록 QR이 아닙니다."
            registering = false
        }
    }
}

private struct IdentifiedInvite: Identifiable {
    let invite: RegistrationInvite
    var id: Data { invite.code.id }
}
