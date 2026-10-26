import CryptoKit
import DeviceCheck
import Network
import ScreenControlCore
import SwiftUI
import UIKit

/// Registers this device with a Mac for screen control (DESIGN 「켜기와 기기 등록」): the QR from AgentsToZ Screen,
/// a new Face ID key, an App Attest attestation, the six digits to compare, and the person at the Mac approves.
struct ScreenRegistrationSheet: View {
    let invite: RegistrationInvite
    var registered: (SavedScreenMac) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var deviceName = UIDevice.current.name
    @State private var phase = Phase.ready

    enum Phase: Equatable {
        case ready, working(String), comparing(String), done, failed(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(invite.macName, systemImage: "desktopcomputer").font(.headline)
                    Text("\(invite.hostName) · \(invite.address)").font(.caption).foregroundStyle(.secondary)
                }
                switch phase {
                case .ready:
                    Section {
                        TextField("이 기기 이름", text: $deviceName)
                        Button("이 기기 등록") { Task { await register() } }
                            .disabled(!RegistrationInvite.isShowableName(deviceName))
                    } footer: {
                        Text("Mac 화면에 이 이름이 뜹니다. 등록 뒤에는 연결할 때마다 Face ID로 승인합니다.")
                    }
                case .working(let step):
                    Section { ProgressView(step) }
                case .comparing(let sas):
                    Section {
                        Text(sas.prefix(3) + " " + sas.suffix(3)).font(.system(size: 44, weight: .semibold, design: .monospaced))
                            .frame(maxWidth: .infinity)
                        Text("Mac 화면의 숫자와 같으면 Mac에서 「승인」을 누르세요. 다르면 Mac에서 거절하세요.")
                    }
                case .done:
                    Section {
                        Label("등록했습니다", systemImage: "checkmark.seal.fill")
                        Button("닫기") { dismiss() }
                    }
                case .failed(let message):
                    Section {
                        Text(message)
                        Button("닫기") { dismiss() }
                    } footer: {
                        Text("다시 하려면 Mac에서 「기기 등록…」으로 새 QR을 띄우세요. QR은 한 번만 쓸 수 있습니다.")
                    }
                }
            }
            .navigationTitle("Mac 화면 등록")
            .toolbar { Button("닫기") { dismiss() } }
            .interactiveDismissDisabled(phase != .ready && phase != .done && !isFailed)
        }
    }

    private var isFailed: Bool { if case .failed = phase { true } else { false } }

    private func register() async {
        do {
            phase = .working("기기 키를 만드는 중…")
            let deviceKey = try FaceIDApprovedSigner.createDeviceKey()
            let publicKey = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: deviceKey).publicKey
            let record = try RegistrationRecord(macFingerprint: invite.macFingerprint, codeID: invite.code.id,
                                                devicePublicKey: publicKey, deviceName: deviceName, deviceModel: Self.model)
            phase = .working("이 앱이 정품인지 확인하는 중…")
            let attestService = DCAppAttestService.shared
            guard attestService.isSupported else { return phase = .failed("이 기기는 App Attest를 지원하지 않아 등록할 수 없습니다.") }
            let keyID = try await attestService.generateKey()
            let attestation = try await attestService.attestKey(keyID, clientDataHash: record.attestationClientDataHash)
            guard let keyIDData = Data(base64Encoded: keyID) else { return phase = .failed("App Attest 키를 읽지 못했습니다.") }
            phase = .working("Mac에 등록을 요청하는 중…")
            let endpoint = NWEndpoint.hostPort(host: .init(invite.address), port: .init(rawValue: invite.registrationPort)!)
            let mac = try await RegistrationClient.register(
                to: endpoint, record: record, code: invite.code, attestation: attestation, attestationKeyID: keyIDData,
                showSAS: { sas in await MainActor.run { phase = .comparing(sas) } })
            let saved = SavedScreenMac(id: mac.fingerprint.map { String(format: "%02x", $0) }.joined(), macName: invite.macName,
                                       macPublicKey: mac.publicKey.x963Representation, hostName: invite.hostName,
                                       address: invite.address, port: invite.screenPort, deviceKey: deviceKey,
                                       deviceName: deviceName, registeredAt: Date())
            registered(saved)
            phase = .done
        } catch {
            phase = .failed(Self.message(for: error))
        }
    }

    static func message(for error: Error) -> String {
        switch error {
        case RegistrationError.refused: "Mac에서 거절했거나 QR이 이미 쓰였습니다."
        case RegistrationError.badAcknowledgement, RegistrationError.mismatch: "QR을 띄운 Mac이 답하지 않았습니다. 등록하지 않았습니다."
        case TransportError.timedOut: "Mac이 제때 답하지 않았습니다. Mac과 같은 Wi‑Fi인지 확인해 주세요."
        case TransportError.closed, TransportError.failed: "Mac에 연결하지 못했습니다. 같은 Wi‑Fi인지, QR이 아직 열려 있는지 확인해 주세요."
        default: "등록하지 못했습니다: \(error.localizedDescription)"
        }
    }

    /// The hardware model, such as iPad14,1.
    static var model: String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        return RegistrationInvite.isShowableName(machine) ? machine : UIDevice.current.model
    }
}
