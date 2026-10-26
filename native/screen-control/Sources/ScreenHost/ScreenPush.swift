#if os(macOS)
import Foundation
import ScreenControlCore

/// Notifications and remote stop at the Mac (DESIGN 「알림·원격 차단」). OFF unless the app was built with a push relay
/// endpoint (Info.plist `AgentsToZScreenPushURL`, written by `scripts/build-screen-app.ts` only when
/// `AGENTSTOZ_SCREEN_PUSH_URL` is set): without one `fromBundle()` is nil and nothing is sent or polled.
///
/// - When a device connects or a new one is registered, the Mac's other devices hear about it: the Mac's name, what
///   happened, when, and which device — never screen content, codes or keys (`ScreenEvent`).
/// - While screen control is on, and only then, the Mac polls for remote-stop commands, acts on the ones its own
///   registry vouches for (`RemoteStopPoller`, `RemoteCommandVerifier`, `RemoteStopDecision`) and answers each with a
///   signed result. A remote command only ever takes access away; turning on stays here, behind Touch ID.
///
/// ScreenService calls it from a few marked lines (`push?.…`), so the service itself stays as it was.
@MainActor
final class ScreenPush {
    /// The same event from the same device again within this long is told once: a phone that reconnects (the session
    /// replaced) should not ring the others each time.
    static let coalescing: TimeInterval = 120

    private let client: ScreenPushClient
    private weak var service: ScreenService?
    private var identity: (any TranscriptSigner)?
    /// One per process, so commands already handled stay handled across turning off and on.
    private var poller: RemoteStopPoller?
    private var polling: Task<Void, Never>?
    private var onSince: Date?
    private var told: [String: Date] = [:]

    init(client: ScreenPushClient) {
        self.client = client
    }

    static func fromBundle(_ bundle: Bundle = .main) -> ScreenPush? {
        guard let endpoint = PushEndpoint(bundle.object(forInfoDictionaryKey: "AgentsToZScreenPushURL") as? String) else { return nil }
        return ScreenPush(client: ScreenPushClient(endpoint: endpoint))
    }

    // MARK: Hooks from ScreenService

    /// Screen control turned on (after Touch ID at the Mac): start polling for remote stops.
    func started(service: ScreenService, identity: any TranscriptSigner, keys: RegisteredDeviceKeys) {
        self.service = service
        self.identity = identity
        onSince = Date()
        let poller = poller ?? RemoteStopPoller(
            client: client, signer: identity,
            verifier: RemoteCommandVerifier(macFingerprint: ScreenControlIdentity.fingerprint(of: identity.publicKey)) { keys.key(for: $0) })
        self.poller = poller
        polling?.cancel()
        polling = Task { [weak self] in
            let apply: @Sendable (RemoteCommand) async -> RemoteCommandOutcome = { [weak self] command in
                await MainActor.run { self?.apply(command) ?? .nothingToDo }
            }
            while !Task.isCancelled {
                guard let ids = self?.deviceIDs() else { return }
                let added = (try? await poller.round(deviceIDs: ids, apply: apply)) ?? 0
                if added > 0 {
                    // At once, so the phone hears within seconds. In a task of its own: a remote 「화면 제어 전체 끄기」 has
                    // just cancelled this one, and its sender should still hear that it worked.
                    await Task.detached { try? await poller.deliverResults(deviceIDs: ids) }.value
                }
                try? await Task.sleep(for: RemoteStopPoller.interval)
            }
        }
    }

    /// Screen control turned off, however: no more polling.
    func stopped() {
        polling?.cancel()
        polling = nil
        onSince = nil
    }

    /// A device connected, or a new one was registered: tell the others.
    func notify(_ kind: ScreenEventKind, by device: RegisteredDevice, among devices: [RegisteredDevice]) {
        guard let identity, let actor = Self.bytes(hex: device.id) else { return }
        let now = Date()
        let key = "\(kind.rawValue):\(device.id)"
        told = told.filter { now.timeIntervalSince($0.value) < Self.coalescing }
        guard told[key] == nil else { return }
        let recipients = ScreenEvent.recipients(registered: Self.inUse(devices, at: now), actor: actor)
        guard !recipients.isEmpty,
              let event = try? ScreenEvent(macKey: identity.publicKey, kind: kind, at: now, macName: ScreenService.macName,
                                           actorID: actor, actorName: device.name, recipients: recipients) else { return }
        told[key] = now
        let client = client
        // Nothing waits on it: a notification that does not go out changes nothing at the Mac.
        Task { _ = try? await client.notify(event, signer: identity) }
    }

    // MARK: Remote stop

    private func deviceIDs() -> [Data] {
        Array(Self.inUse(service?.devices ?? [], at: Date()).prefix(16))
    }

    /// Acts on a command the verifier accepted, unless something newer at the Mac supersedes it.
    private func apply(_ command: RemoteCommand) -> RemoteCommandOutcome {
        guard let service, service.isOn else { return .nothingToDo }
        let devices = service.devices.filter { !$0.isExpired() }
        let state = RemoteStopState(
            onSince: onSince,
            session: service.session.flatMap { session in
                Self.bytes(hex: session.deviceID).map { .init(deviceID: $0, since: session.since) }
            },
            registeredAt: Dictionary(devices.compactMap { device in Self.bytes(hex: device.id).map { ($0, device.registeredAt) } },
                                     uniquingKeysWith: max))
        let decision = RemoteStopDecision.decide(command, state: state)
        let sender = devices.first { $0.id == ScreenService.hex(command.deviceID) }?.name ?? "등록된 기기"
        switch decision.effect {
        case .endSession: service.disconnect()
        case .revoke(let id):
            guard let device = service.devices.first(where: { $0.id == ScreenService.hex(id) }) else { return .nothingToDo }
            service.revoke(device)
        case .turnOff: service.turnOff(reason: "‘\(sender)’에서 화면 제어를 껐습니다. 다시 켜려면 이 Mac에서 켜 주세요.")
        case nil: break
        }
        return decision.outcome
    }

    // MARK: Helpers

    /// Device IDs of the registrations still in use, the most recently used first.
    static func inUse(_ devices: [RegisteredDevice], at now: Date) -> [Data] {
        devices.filter { !$0.isExpired(at: now) }
            .sorted { RegistrationLifetime.lastUse(registeredAt: $0.registeredAt, lastConnectedAt: $0.lastConnectedAt)
                > RegistrationLifetime.lastUse(registeredAt: $1.registeredAt, lastConnectedAt: $1.lastConnectedAt) }
            .compactMap { bytes(hex: $0.id) }
    }

    static func bytes(hex: String) -> Data? {
        guard hex.utf8.count == 64 else { return nil }
        var data = Data(capacity: 32)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            data.append(byte)
            index = next
        }
        return data
    }
}
#endif
