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
    /// True from the first step (device key) until the registration ends: a QR handed over meanwhile must not replace it.
    var busy: Binding<Bool> = .constant(false)
    var registered: (SavedScreenMac) throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var deviceName = UIDevice.current.name
    @State private var authentication: ScreenDeviceAuthentication = .deviceOwner
    @State private var phase = Phase.ready
    @State private var registrationTask: Task<Void, Never>?

    enum Phase: Equatable {
        case ready, working(String), comparing(String), done, failed(String)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label(invite.macName, systemImage: "desktopcomputer").font(.headline)
                    Text(invite.nearbyRegistrationService == nil ? "\(invite.hostName) · \(invite.address)" : "근거리 직접 연결" + (invite.registrationRelay == nil ? "" : " · 인터넷 연결 가능"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                switch phase {
                case .ready:
                    Section {
                        TextField("이 기기 이름", text: $deviceName)
                        Picker("연결 인증", selection: $authentication) {
                            Text("기기 암호 또는 생체 인증").tag(ScreenDeviceAuthentication.deviceOwner)
                            Text("생체 인증만").tag(ScreenDeviceAuthentication.biometricsOnly)
                        }
                        Button("이 기기 등록") { registrationTask = Task { await register() } }
                            .disabled(invite.purpose != .device || !RegistrationInvite.isShowableName(deviceName))
                    } footer: {
                        Text("연결할 때마다 선택한 방식으로 승인합니다. 인증 방식을 바꾸려면 Mac의 새 QR로 다시 등록한 뒤, Mac의 등록 기기 목록에서 이전 등록을 해지해 주세요. 등록 시각으로 구분할 수 있습니다.")
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
            .interactiveDismissDisabled(isUnderWay)
            .onChange(of: isUnderWay, initial: true) { _, underWay in busy.wrappedValue = underWay }
            .onDisappear { busy.wrappedValue = false; registrationTask?.cancel(); registrationTask = nil }
        }
    }

    private var isFailed: Bool { if case .failed = phase { true } else { false } }
    private var isUnderWay: Bool { phase != .ready && phase != .done && !isFailed }

    private func register() async {
        do {
            // Recheck at the action boundary before creating any key, contacting App Attest or opening a transport.
            try invite.requireDeviceRegistration()
            phase = .working("기기 키를 만드는 중…")
            let deviceKey = try FaceIDApprovedSigner.createDeviceKey(authentication: authentication)
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
            let transport: any ScreenFrameTransport
            if let nearby = invite.nearbyRegistrationService {
                do { transport = try await ScreenNearby.open(serviceName: nearby, maxFrame: 16 * 1024) }
                catch {
                    guard let relay = invite.registrationRelay else { throw error }
                    phase = .working("인터넷으로 Mac을 찾는 중…")
                    transport = try await ScreenRelayTransport.open(route: relay, purpose: .registration)
                }
            } else {
                guard let port = NWEndpoint.Port(rawValue: invite.registrationPort) else { throw RegistrationError.malformed }
                transport = try await ScreenClient.open(to: .hostPort(host: .init(invite.address), port: port), maxFrame: 16 * 1024)
            }
            // Fallback above happens only while opening; never resend a QR proof after an uncertain registration.
            let registrationTransport: any ScreenFrameTransport = invite.nearbyRegistrationService == nil ? transport
                : RegistrationPrivacyTransport(over: transport, code: invite.code, role: .device)
            let mac = try await RegistrationClient.register(
                over: registrationTransport, record: record, code: invite.code, attestation: attestation, attestationKeyID: keyIDData,
                showSAS: { sas in await MainActor.run { phase = .comparing(sas) } })
            let saved = SavedScreenMac(id: mac.fingerprint.map { String(format: "%02x", $0) }.joined(), macName: invite.macName,
                                       macPublicKey: mac.publicKey.x963Representation, hostName: invite.hostName,
                                       address: invite.address, port: invite.screenPort, deviceKey: deviceKey,
                                       deviceName: deviceName, registeredAt: Date(),
                                       nearbyService: invite.nearbyScreenService, relay: invite.screenRelay,
                                       authentication: authentication)
            try Task.checkCancellation()
            try registered(saved)
            phase = .done
        } catch {
            phase = .failed(Self.message(for: error))
        }
    }

    static func message(for error: Error) -> String {
        switch error {
        case RegistrationError.wrongPurpose: "Mac 컨트롤러 전용 QR은 이 기기를 등록하는 데 사용할 수 없습니다."
        case RegistrationError.refused: "Mac에서 거절했거나 QR이 이미 쓰였습니다."
        case RegistrationError.badAcknowledgement, RegistrationError.mismatch: "QR을 띄운 Mac이 답하지 않았습니다. 등록하지 않았습니다."
        case TransportError.timedOut: "Mac이 제때 답하지 않았습니다. Mac의 화면 제어와 QR을 열어 두고, 두 기기의 Wi‑Fi를 켠 채 Mac 가까이에서 등록해 주세요."
        case TransportError.closed, TransportError.failed: "Mac에 연결하지 못했습니다. Mac 화면 제어가 켜져 있고 등록 QR이 아직 열려 있는지 확인해 주세요."
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
