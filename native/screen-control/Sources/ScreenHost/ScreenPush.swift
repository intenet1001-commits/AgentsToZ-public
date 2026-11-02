#if os(macOS)
import CryptoKit
import Foundation
import os
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
/// - In the same rounds, the main AgentsToZ app's weekly allowance alerts (`WeeklyUsageOutbox`) go to the same devices,
///   signed with the same key: the Mac's name, the provider and the 10% boundary — never an account or a token.
///
/// - Mac controllers (docs/design/mac-to-mac-2026-11-01 7.6, 6.6): a controller's enrolment and each of its connections
///   are told as kinds 4 and 3, the controller's fingerprint as the actor, to the phones still in use; and a phone's remote
///   끊기, 해지 and 전체 끄기 reach a controller's session and row as they reach a phone's.
/// - Each round that reached the relay with a phone in it keeps the push gate open for 30 minutes; a round with none
///   closes it (`PushLiveness`, DESIGN 9절).
///
/// ScreenService calls it from a few marked lines (`push?.…`), so the service itself stays as it was.
@MainActor
final class ScreenPush {
    /// The same event from the same device again within this long is told once: a phone that reconnects (the session
    /// replaced) should not ring the others each time.
    static let coalescing: TimeInterval = 120

    private let client: ScreenPushClient
    /// Whether rounds are reaching the relay: the push gate (DESIGN 9절). Shared with the key lookup, which reads it off
    /// the main actor.
    let liveness: PushLiveness
    private weak var service: ScreenService?
    private var identity: (any TranscriptSigner)?
    /// One per process, so commands already handled stay handled across turning off and on.
    private var poller: RemoteStopPoller?
    private var polling: Task<Void, Never>?
    private var onSince: Date?
    private var told: [String: Date] = [:]
    /// Weekly allowance alerts sent in the last hour, capped like the relay's `usage` budget.
    private var weeklyBudget = WeeklyUsageBudget()

    init(client: ScreenPushClient, liveness: PushLiveness = PushLiveness()) {
        self.client = client
        self.liveness = liveness
    }

    static func fromBundle(_ bundle: Bundle = .main, liveness: PushLiveness = PushLiveness()) -> ScreenPush? {
        guard let endpoint = PushEndpoint(bundle.object(forInfoDictionaryKey: "AgentsToZScreenPushURL") as? String) else { return nil }
        return ScreenPush(client: ScreenPushClient(endpoint: endpoint), liveness: liveness)
    }

    // MARK: Hooks from ScreenService

    /// Screen control turned on (after Touch ID at the Mac): start polling for remote stops. `onSince` is when the person
    /// last turned it on at this Mac; nil means now. Turning on by itself after a restart (켜 두기, SR-27) passes the
    /// time keeping on was chosen, so a phone's remote 끄기 sent meanwhile still applies.
    func started(service: ScreenService, identity: any TranscriptSigner, keys: RegisteredDeviceKeys, onSince: Date? = nil) {
        self.service = service
        self.identity = identity
        self.onSince = onSince ?? Date()
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
                self?.deliverWeeklyUsage()
                guard let ids = self?.deviceIDs() else { return }
                var added = 0
                do {
                    added = try await poller.round(deviceIDs: ids, apply: apply)
                    // The relay answered this round: with a phone in it, the push gate stays open for the next 30
                    // minutes; with none, it closes (PushLiveness).
                    self?.roundAnswered(reaching: ids.count)
                } catch {}
                if added > 0 {
                    // At once, so the phone hears within seconds. In a task of its own: a remote 「화면 제어 전체 끄기」 has
                    // just cancelled this one, and its sender should still hear that it worked.
                    await Task.detached { try? await poller.deliverResults(deviceIDs: ids) }.value
                }
                try? await Task.sleep(for: RemoteStopPoller.interval)
            }
        }
    }

    /// The Mac's identity for notifications sent while screen control is off (a controller enrolled then): the same key
    /// `started` gets. Nothing is polled until `started`.
    func adopt(identity: any TranscriptSigner) {
        if self.identity == nil { self.identity = identity }
    }

    private func roundAnswered(reaching phones: Int) {
        // A client without an endpoint answers every round without asking anyone: that opens nothing.
        guard client.isEnabled else { return }
        liveness.noteRound(reaching: phones)
        service?.pushLivenessChanged()
    }

    /// Screen control turned off, however: no more polling. The gate stays as the last rounds left it and closes by itself.
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
                                           actorID: actor, actorName: device.displayName, recipients: recipients) else { return }
        told[key] = now
        let client = client
        // Nothing waits on it: a notification that does not go out changes nothing at the Mac.
        Task { _ = try? await client.notify(event, signer: identity) }
    }

    /// A Mac controller enrolled (kind 4) or connected (kind 3): tell the phones still in use, the controller's fingerprint as
    /// the actor and its name as this Mac shows it. Once, like a phone's event: a failure is neither sent again nor told as
    /// kind 1 or 2 (DESIGN 7.6).
    func notify(_ kind: ScreenEventKind, controller: RegisteredController, among devices: [RegisteredDevice]) {
        guard let identity else { return }
        let now = Date()
        let key = "\(kind.rawValue):\(controller.id)"
        told = told.filter { now.timeIntervalSince($0.value) < Self.coalescing }
        guard told[key] == nil,
              let event = Self.controllerEvent(kind, controller: controller, devices: devices, macKey: identity.publicKey,
                                               macName: ScreenService.macName, at: now) else { return }
        told[key] = now
        let client = client
        // Nothing waits on it: a notification that does not go out changes nothing at the Mac.
        Task { _ = try? await client.notify(event, signer: identity) }
    }

    func notify(_ peer: ScreenCommunityPeerAdmission, among devices: [RegisteredDevice]) {
        guard let identity else { return }
        let now = Date(), actor = ScreenControlIdentity.fingerprint(of: peer.key)
        let kind: ScreenEventKind = peer.member.platform == "ios" ? .connected : .controllerConnected
        let key = "community:\(kind.rawValue):\(peer.member.enrollmentID)"
        told = told.filter { now.timeIntervalSince($0.value) < Self.coalescing }
        let recipients = devices.filter { !$0.isExpired(at: now) }.compactMap { device in
            (try? P256.Signing.PublicKey(x963Representation: device.publicKey)).map(ScreenControlIdentity.fingerprint(of:))
        }.filter { $0 != actor }
        guard told[key] == nil, !recipients.isEmpty,
              let event = try? ScreenEvent(macKey: identity.publicKey, kind: kind, at: now, macName: ScreenService.macName,
                                          actorID: actor, actorName: peer.member.name, recipients: recipients) else { return }
        told[key] = now; let client = client
        Task { _ = try? await client.notify(event, signer: identity) }
    }

    /// Protocol-6 community sessions have no legacy controller/phone row. Project the verified admission directly
    /// into the existing signed H10 event; do not create a registration or widen remote-stop authority.
    func notify(_ admission: CommunityScreenAdmission, among devices: [RegisteredDevice], at now: Date = Date()) {
        guard let identity, let notice = ScreenCommunityConnectionNotification(admission:admission,receivingKey:identity.publicKey,at:now) else { return }
        told = told.filter { now.timeIntervalSince($0.value) < Self.coalescing }
        guard told[notice.coalescingKey] == nil,
              let event = notice.event(macKey:identity.publicKey,macName:ScreenService.macName,devices:devices,at:now) else { return }
        told[notice.coalescingKey] = now
        let client = client
        Task { _ = try? await client.notify(event,signer:identity) } // One attempt; an unknown delivery is never replayed.
    }

    /// The event for a controller, or nil for a kind that is not a controller's or when no phone is left to tell.
    static func controllerEvent(_ kind: ScreenEventKind, controller: RegisteredController, devices: [RegisteredDevice],
                                macKey: P256.Signing.PublicKey, macName: String, at now: Date) -> ScreenEvent? {
        guard kind == .controllerConnected || kind == .controllerRegistered, let actor = bytes(hex: controller.id) else { return nil }
        let recipients = ScreenEvent.recipients(registered: inUse(devices, at: now), actor: actor)
        guard !recipients.isEmpty else { return nil }
        return try? ScreenEvent(macKey: macKey, kind: kind, at: now, macName: macName, actorID: actor,
                                actorName: controller.displayName, recipients: recipients)
    }

    /// The main app's weekly allowance alerts (`WeeklyUsageOutbox`), told to this Mac's registered devices in use. Only while
    /// screen control is on (also while it waits for an approved network), once per polling round: the identity key was taken
    /// out by turning on here, and the relay knows this Mac's devices from these polls. Each hand-off is removed before its
    /// alert is sent; a send that fails is not retried.
    func deliverWeeklyUsage(now: Date = Date()) {
        guard onSince != nil, let identity, let service else { return }
        let handoffs = WeeklyUsageOutbox.take()
        guard !handoffs.isEmpty else { return }
        let events = WeeklyUsageEvent.plan(handoffs, macKey: identity.publicKey, macName: ScreenService.macName,
                                           recipients: Self.inUse(service.devices, at: now), budget: &weeklyBudget, at: now)
        let client = client
        for event in events {
            // Nothing waits on it: a weekly alert that does not go out changes nothing at the Mac.
            Task { _ = try? await client.notify(event, signer: identity) }
        }
    }

    // MARK: Remote stop

    private func deviceIDs() -> [Data] {
        Array(Self.inUse(service?.devices ?? [], at: Date()).prefix(16))
    }

    /// Acts on a command the verifier accepted, unless something newer at the Mac supersedes it.
    private func apply(_ command: RemoteCommand) -> RemoteCommandOutcome {
        guard let service else { return .nothingToDo }
        return Self.apply(command, to: service, onSince: onSince)
    }

    /// What a verified command does at `service` (`onSince`: when screen control was last turned on here). Every effect
    /// only takes access away: the session ends, a phone's or a controller's registration goes, screen control turns
    /// off and keeping on with it (SR-27).
    static func apply(_ command: RemoteCommand, to service: ScreenService, onSince: Date?, at now: Date = Date()) -> RemoteCommandOutcome {
        // On, or on but waiting for a network (a kept-on Mac on a network it did not save): a command only takes access
        // away, so it applies to both.
        guard service.isOn || service.isWaiting else { return .nothingToDo }
        let devices = service.devices.filter { !$0.isExpired(at: now) }
        let state = Self.remoteStopState(onSince: onSince, session: service.session.map { ($0.deviceID, $0.since) },
                                         devices: devices, controllers: service.controllers, at: now)
        let decision = RemoteStopDecision.decide(command, state: state)
        let sender = devices.first { $0.id == ScreenService.hex(command.deviceID) }?.displayName ?? "등록된 기기"
        switch decision.effect {
        case .endSession: service.disconnect()
        case .revoke(let id):
            let hex = ScreenService.hex(id)
            if let device = service.devices.first(where: { $0.id == hex }) {
                service.revoke(device)
            } else if service.controllers.contains(where: { $0.id == hex }) {
                // A phone's 해지 reaches a controller's row as it reaches a phone's (DESIGN 6.6).
                service.removeController(hex)
            } else {
                return .nothingToDo
            }
        case .turnOff: service.turnOff(reason: "‘\(sender)’에서 화면 제어를 껐습니다. 다시 켜려면 이 Mac에서 켜 주세요.")
        case nil: break
        }
        return decision.outcome
    }

    /// What a remote command may still reach: the session, whoever holds it, and every registration still in use, a
    /// controller's beside the phones' (DESIGN 6.6). A controller's row is approved at this Mac like a phone's, so its
    /// `registeredAt` supersedes a command sent before it the same way.
    static func remoteStopState(onSince: Date?, session: (deviceID: String, since: Date)?, devices: [RegisteredDevice],
                                controllers: [RegisteredController], at now: Date) -> RemoteStopState {
        let phones = devices.filter { !$0.isExpired(at: now) }.compactMap { device in
            bytes(hex: device.id).map { ($0, device.registeredAt) }
        }
        let macs = controllers.filter { !$0.isExpired(at: now) }.compactMap { controller in
            bytes(hex: controller.id).map { ($0, controller.registeredAt) }
        }
        return RemoteStopState(
            onSince: onSince,
            session: session.flatMap { session in bytes(hex: session.deviceID).map { .init(deviceID: $0, since: session.since) } },
            registeredAt: Dictionary(phones + macs, uniquingKeysWith: max))
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

#if os(macOS)
/// Whether the remote-stop rounds are reaching the relay for some phone (DESIGN 9절 「출시 관문」): open for `window`
/// after the last round that succeeded with at least one phone in it, closed before the first one, after a long silence,
/// and at once by a round with no phone to tell or to stop the Mac from. A phone that can no longer stop a Mac controller
/// from afar is the reason controllers wait for it: while it is closed, a controller whose binding was never proven is
/// not looked up, control is not offered and keeping on is hidden. (The key lookup also asks for a phone in use at that
/// moment, `ScreenPeerKeys.pushGateOpen`.)
///
/// Read on any thread (the key lookup runs off the main actor); written by the polling loop.
public final class PushLiveness: Sendable {
    /// How long one successful round keeps the gate open.
    public static let window: TimeInterval = 30 * 60

    private let lastSuccess = OSAllocatedUnfairLock(initialState: Date?.none)
    private let now: @Sendable () -> Date

    public init(now: @escaping @Sendable () -> Date = { Date() }) { self.now = now }

    /// A round the relay answered, for `phones` device IDs. With none it proves nothing the gate stands for (nobody hears
    /// a connection, nobody can stop one), so it closes the gate instead of opening it.
    public func noteRound(reaching phones: Int) {
        let date = phones > 0 ? now() : nil
        lastSuccess.withLock { $0 = date }
    }

    public var isLive: Bool {
        guard let last = lastSuccess.withLock({ $0 }) else { return false }
        let age = now().timeIntervalSince(last)
        return age >= 0 && age < Self.window
    }
}
#endif
