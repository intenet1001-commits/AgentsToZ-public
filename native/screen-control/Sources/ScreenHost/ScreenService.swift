#if os(macOS)
import AppKit
import CoreGraphics
import CoreWLAN
import Foundation
import LocalAuthentication
import Network
import Observation
import ScreenCaptureKit
import ScreenControlCore
import ServiceManagement
import SystemConfiguration

/// The screen host as the menu bar sees it (DESIGN 「구조」). Turning on and adding a device happen only here, at the
/// Mac, behind Touch ID or the password; turning off, disconnecting and revoking never ask (보안 원칙 5).
/// The listener binds to this Mac's Wi‑Fi or Ethernet address only on a network approved at the Mac (결정 4): moving to
/// another approved network rebinds, any other network stops listening until the Mac is back on an approved one.
/// A session keeps to the session limits, and however it ends (a limit, disconnecting, revoking, turning off, the app
/// quitting) what the phone held down is let go first and the phone hears why (VideoPump.end).
@MainActor @Observable
public final class ScreenService {
    public enum Power: Equatable {
        case off(reason: String?)
        case starting
        case on(address: String)
        /// On, but not listening: this Mac is not on an approved network (결정 4). It listens again by itself once it is.
        case waiting(Waiting)
    }

    /// Why screen control is on but not listening, as the menu says it.
    public enum Waiting: Equatable {
        /// No Wi‑Fi or Ethernet address.
        case noNetwork
        /// The router's hardware address is not known yet, so the network cannot be told apart. Checked again every few
        /// seconds.
        case unidentified(label: String)
        /// No router to tell this network apart (or one whose hardware address names no particular router): it can never
        /// be approved, so screen control cannot be used here.
        case noRouter(label: String)
        /// 「승인되지 않은 네트워크」: approving it at the Mac lets the Mac listen here.
        case unapproved(label: String)

        var needsSoonRecheck: Bool {
            switch self { case .unidentified, .noNetwork, .noRouter: true; default: false }
        }
    }

    public struct Session: Equatable {
        public let deviceID: String
        public let deviceName: String
        public let since: Date
        public let canControl: Bool
    }

    public enum Registration {
        case showing(RegistrationInvite, until: Date)
        case confirming(name: String, model: String, sas: String)
        case finished(String)
    }

    /// The screen listener's port: fixed, so a registered phone finds this Mac again after a restart.
    public static let screenPort: UInt16 = 52741

    public private(set) var power: Power = .off(reason: nil) { didSet { publishStatus() } }
    public private(set) var devices: [RegisteredDevice] = [] { didSet { publishStatus() } }
    public private(set) var session: Session? { didSet { publishStatus() } }
    public private(set) var registration: Registration?
    public private(set) var problem: String?
    /// Why the last session ended by itself (a session limit), until the next one starts.
    public private(set) var lastEnded: String?
    /// Networks approved at this Mac; the listener opens only on one of them (결정 4).
    public private(set) var networks: [ApprovedNetwork] = []
    /// Where the listener is bound now.
    private var binding: NetworkBinding?

    private struct Active {
        let session: MacSession
        let task: Task<Void, Never>
        /// Set once capture is ready; until then nothing was captured or injected.
        var streamer: HostStreamer?
    }

    private let store = ScreenStore()
    private let keys = RegisteredDeviceKeys()
    private var identity: SecureEnclaveTranscriptSigner?
    private var listener: ScreenListener?
    private var listening: Task<Void, Never>?
    private var monitor: NWPathMonitor?
    private var gate = PreAuthGate()
    private var active: Active?
    private var registrationListener: RegistrationListener?
    private var registrationTask: Task<Void, Never>?
    private var pending: PendingRegistration?
    public private(set) var internetRoute: ScreenRelayRoute?
    public private(set) var internetNotice: String?
    public enum InternetConnection: Int, Sendable {
        case off = 0, connecting, waiting, authenticating, connected, retrying
        public var label: String {
            switch self {
            case .off: "자체 중계: 꺼짐"
            case .connecting: "자체 중계: 접속 중"
            case .waiting: "자체 중계: 기기 접속 대기"
            case .authenticating: "자체 중계: 기기 인증 중"
            case .connected: "자체 중계: 기기 연결됨"
            case .retrying: "자체 중계: 연결할 수 없음 · 재시도 대기"
            }
        }
    }
    public private(set) var internetConnection = InternetConnection.off
    private var internetAttempt: UUID?
    private var internetTask: Task<Void, Never>?
    private var registrationInternetTask: Task<Void, Never>?
    private var registrationWindow: RegistrationWindow?
    private var registrationStarting = false
    private var registrationGeneration = 0
    private var registrationDecisionTask: Task<Void, Never>?
    /// 「로그인할 때 열기」 as the system last reported it; publishStatus reads it again, so the menu and window follow.
    public private(set) var loginItem: ScreenStatus.LoginItem = .off
    /// The last status the main app was given (ScreenStatusFile); nil after quitting removed it.
    @ObservationIgnored private var published: ScreenStatus?
    @ObservationIgnored private var quitting = false
    // Approved networks (결정 4): the one handshake of this turning on, the interface the system uses, the unapproved
    // network on screen as 「이 네트워크 승인…」 would add it, and the evaluations that bind, rebind or stop.
    @ObservationIgnored private var handshake: MacHandshake?
    @ObservationIgnored private var interface: (name: String, medium: NetworkSnapshot.Medium)?
    @ObservationIgnored private var candidate: ApprovedNetwork?
    @ObservationIgnored private var evaluation: Task<Void, Never>?
    @ObservationIgnored private var recheck: Task<Void, Never>?
    /// Since when the bound network's router has stayed unreadable (NetworkApproval.unreadableGrace); nil while readable.
    @ObservationIgnored private var unreadableSince: ContinuousClock.Instant?
    /// Bumped whenever listening stops, so an evaluation that was reading the network does not bind afterwards.
    @ObservationIgnored private var epoch = 0
    /// Notifications and remote stop (ScreenPush.swift): nil, and nothing sent or polled, unless built with an endpoint.
    @ObservationIgnored private var push: ScreenPush?

    public init() {
        do {
            devices = try store.devices()
            keys.set(devices)
        } catch {
            problem = "등록 목록을 읽지 못했습니다: \(error)"
        }
        do {
            networks = try store.networks { discarded in
                problem = [problem, "손상된 승인 네트워크 항목 \(discarded)개를 제외했습니다."].compactMap { $0 }.joined(separator: " ")
            }
        } catch {
            // Nothing is approved then: the Mac does not listen until a network is approved again.
            problem = [problem, "승인된 네트워크 목록을 읽지 못했습니다: \(error)"].compactMap { $0 }.joined(separator: " ")
        }
        // However the app quits, nothing stays pressed on this Mac (SR-16): turning off lets go before the process
        // exits. Posted on the main thread, and `queue: nil` runs this before termination goes on.
        _ = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.turnOff()
                // Last: the main app then shows the helper as not running instead of an old state.
                self?.quitting = true
                ScreenStatusFile.remove()
            }
        }
        push = ScreenPush.fromBundle() // push hook
        publishStatus()
    }

    public var isOn: Bool { if case .on = power { true } else { false } }
    /// On, but not listening on this network.
    public var isWaiting: Bool { if case .waiting = power { true } else { false } }
    /// The approved network the listener is on now.
    public var listeningNetwork: ApprovedNetwork? { binding.flatMap { bound in networks.first { $0.identity == bound.identity } } }

    // MARK: The main app's view

    /// Tells the main app what its work-mode panel shows (ScreenStatusFile). Written only when something it shows
    /// changed, so calling it often (a timer, the menu opening) costs a few permission checks and no disk write.
    public func publishStatus() {
        guard !quitting else { return }
        let login = Self.systemLoginItem
        if login != loginItem { loginItem = login }
        let state: ScreenStatus.Power = switch power { case .off: .off; case .starting: .starting; case .on: .on; case .waiting: .waiting }
        let status = ScreenStatus(
            pid: getpid(), power: state,
            viewing: session != nil, devices: devices.filter { !$0.isExpired() }.count,
            capture: ScreenRecordingPermission.current == .granted, control: InputInjector.isAllowed,
            loginItem: loginItem, updatedAt: Int64(Date().timeIntervalSince1970 * 1000))
        // A file removed by someone else (a quitting second copy, a cleanup) is written again on the next tick.
        guard !status.sameState(as: published) || !FileManager.default.fileExists(atPath: ScreenStatusFile.url.path) else { return }
        do {
            try ScreenStatusFile.write(status)
            published = status
        } catch {
            // The panel then shows the helper as running with an unknown state; nothing here depends on the file.
            published = nil
        }
    }

    /// Opening AgentsToZ Screen when this Mac's user logs in, so a phone can find it after a restart. The system keeps
    /// this setting and the person may approve it in System Settings at any time.
    private static var systemLoginItem: ScreenStatus.LoginItem {
        switch SMAppService.mainApp.status {
        case .enabled: .on
        case .requiresApproval: .approval
        default: .off
        }
    }

    public func setLoginItem(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            problem = "로그인 항목을 바꾸지 못했습니다: \(error.localizedDescription)"
        }
        publishStatus()
    }

    // MARK: Power

    /// Touch ID or the password, then it listens wherever this Mac is on an approved network. On a network that is not
    /// approved yet, the same prompt approves it too: the person approves the network the prompt names.
    public func turnOn() async {
        guard case .off = power else { return }
        power = .starting
        let powerEpoch = epoch
        problem = nil
        do {
            guard try await Self.authenticate("근거리에서 등록한 기기로 Mac 화면 제어를 켭니다") else { return power = .off(reason: nil) }
            guard epoch == powerEpoch, case .starting = power else { return }
            let identity = try self.identity ?? store.identity()
            self.identity = identity
            gate = PreAuthGate()
            let keys = keys
            let handshake = MacHandshake(signer: identity, replay: NonceReplayCache()) { keys.key(for: $0) }
            self.handshake = handshake
            let nearby = try ScreenListener(handshake: handshake, gate: gate, port: NWEndpoint.Port(rawValue: Self.screenPort)!,
                                            nearbyServiceName: ScreenNearby.screenService(fingerprint: ScreenControlIdentity.fingerprint(of: identity.publicKey)))
            _ = try await nearby.start()
            guard case .starting = power else { nearby.stop(); return }
            listener = nearby
            power = .on(address: "근거리 직접 연결")
            listening = Task { [weak self] in
                for await incoming in nearby.sessions {
                    guard let self, self.listener === nearby else { incoming.connection.close(); continue }
                    self.accept(incoming)
                }
            }
            // Internet access remains separately enabled at this Mac; starting the app alone never opens it.
            do {
                if let data = try store.read("internet-route") {
                    internetRoute = try JSONDecoder().decode(ScreenRelayRoute?.self, from: data)
                }
            } catch {
                internetRoute = nil
                internetNotice = "저장된 자체 중계 설정을 읽지 못했습니다. 근거리 연결은 켜져 있습니다. 「고급 · 자체 중계 서버」에서 다시 설정해 주세요."
            }
            startInternetListener()
            push?.started(service: self, identity: identity, keys: keys)
        } catch {
            stopListening()
            power = .off(reason: "켜지 못했습니다: \(Self.describe(error))")
        }
    }

    public func turnOff(reason: String? = nil) { stop(reason: reason) }

    /// For the quit button: turns off and waits, about a second at most, until the phone has heard why.
    public func quit() async { await stop(reason: nil)?.value }

    @discardableResult
    private func stop(reason: String?) -> Task<Void, Never>? {
        cancelRegistration()
        let ending = endSession(.turnedOff)
        stopListening()
        power = .off(reason: reason)
        push?.stopped() // push hook
        return ending
    }

    private func stopListening() {
        internetTask?.cancel(); internetTask = nil
        internetAttempt = nil; internetConnection = .off
        epoch += 1
        evaluation?.cancel()
        evaluation = nil
        recheck?.cancel()
        recheck = nil
        monitor?.cancel()
        monitor = nil
        listening?.cancel()
        listening = nil
        listener?.stop()
        listener = nil
        binding = nil
        candidate = nil
        interface = nil
        handshake = nil
    }

    /// Follows the network while on: a path change binds, rebinds or stops at once, and a re-check catches what a path
    /// change does not announce (the router's hardware address becoming known, another router behind the same address).
    private func watchNetwork() {
        let monitor = NWPathMonitor(), epoch = epoch
        monitor.pathUpdateHandler = { [weak self] path in
            let now = Self.interface(on: path)
            Task { @MainActor in
                guard let self, self.epoch == epoch else { return }
                self.interface = now
                self.reevaluate()
            }
        }
        monitor.start(queue: DispatchQueue(label: "agentstoz.screen-control.path"))
        self.monitor = monitor
        // Ticks every 3 seconds and decides on each tick what is due, so entering a state that is re-checked often takes
        // effect at the next tick rather than after a 15-second sleep chosen earlier.
        recheck = Task { [weak self] in
            var since = Duration.zero
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled else { return }
                since += .seconds(3)
                let soon = if case .waiting(let waiting) = self?.power { waiting.needsSoonRecheck } else { false }
                guard soon || self?.unreadableSince != nil || since >= .seconds(15) else { continue }
                since = .zero
                self?.reevaluate()
            }
        }
    }

    // MARK: Approved networks

    /// Evaluations run one at a time, in order: each reads the network, then binds, rebinds or stops listening.
    @discardableResult
    private func reevaluate() -> Task<Void, Never> {
        // Legacy network approvals never replace an active nearby listener.
        if isOn { return Task {} }
        let previous = evaluation
        let next = Task { [weak self] in
            await previous?.value
            await self?.evaluate()
        }
        evaluation = next
        return next
    }

    private var isActive: Bool { if case .off = power { false } else { true } }

    /// The network on the interface the system uses, read away from the main thread.
    private func readSnapshot() async -> NetworkSnapshot? {
        let interface = interface
        return await Task.detached { interface.flatMap { NetworkProbe.snapshot(interface: $0.name, medium: $0.medium) } }.value
    }

    private func evaluate() async {
        guard isActive else { return }
        let epoch = epoch
        let snapshot = await readSnapshot()
        guard epoch == self.epoch, isActive else { return }
        let now = ContinuousClock.now
        let decision = NetworkApproval.decide(snapshot, approved: networks, bound: binding,
                                              unreadableFor: unreadableSince.map { now - $0 } ?? .zero)
        unreadableSince = decision == .stay && snapshot?.identity == nil ? unreadableSince ?? now : nil
        switch decision {
        case .stay:
            return
        case .bind(let next):
            unbind()
            do {
                try await bind(next, epoch: epoch)
            } catch {
                guard epoch == self.epoch else { return }
                // The address went away while binding (the network moved on again): decide again rather than turn off.
                // An address that is still there and cannot be listened on turns off with the reason, as before.
                let now = await readSnapshot()
                guard epoch == self.epoch else { return }
                if now?.interface == next.snapshot.interface, now?.address == next.snapshot.address {
                    stop(reason: "켜지 못했습니다: \(Self.describe(error))")
                } else {
                    reevaluate()
                }
            }
        case .wait(let why):
            unbind()
            await wait(why, epoch: epoch)
        }
    }

    private func bind(_ next: NetworkBinding, epoch: Int) async throws {
        guard let handshake else { return }
        let address = next.snapshot.addressText
        let listener = try await Self.listen(handshake: handshake, gate: gate, address: address)
        guard epoch == self.epoch, isActive else { return listener.stop() }
        self.listener = listener
        binding = next
        candidate = nil
        power = .on(address: address)
        listening = Task { [weak self] in
            for await session in listener.sessions {
                // A key exchange that finished on a listener just replaced belongs to the network the Mac left.
                guard let self, self.listener === listener else { session.connection.close(); continue }
                self.accept(session)
            }
        }
    }

    /// Stops listening where it was: the QR closes saying why, and the session ends (its phone was on that network).
    /// Until the next state is read it is `.starting`, never `.on` with the address it left, so 「기기 등록…」 cannot
    /// open a QR there across the awaits that follow (binding again, naming an unapproved network).
    private func unbind() {
        guard listener != nil || binding != nil else { return }
        switch registration {
        case .showing, .confirming: finishRegistration(Self.networkChangedQR)
        case .finished, nil: break
        }
        endSession(.endedAtMac)
        listening?.cancel()
        listening = nil
        listener?.stop()
        listener = nil
        binding = nil
        power = .starting
    }

    private func wait(_ why: NetworkWait, epoch: Int) async {
        let waiting: Waiting
        switch why {
        case .noNetwork:
            candidate = nil
            waiting = .noNetwork
        case .unidentified(let snapshot):
            candidate = nil
            let label = Self.neutralLabel(for: snapshot)
            waiting = snapshot.canBeIdentified ? .unidentified(label: label) : .noRouter(label: label)
        case .unapproved(let snapshot, let identity):
            if case .waiting(.unapproved) = power, candidate?.identity == identity { return }
            let label = await Task.detached { Self.label(for: snapshot) }.value
            guard epoch == self.epoch, isActive else { return }
            candidate = ApprovedNetwork(identity: identity, label: label)
            waiting = .unapproved(label: label)
        }
        if power != .waiting(waiting) { power = .waiting(waiting) }
    }

    /// 「이 네트워크 승인…」: the person at the Mac approves the network named on screen, behind Touch ID or the login
    /// password as for turning on. The Mac then listens here.
    public func approveCurrentNetwork() async {
        guard case .waiting(.unapproved(let label)) = power, let candidate else { return }
        // Refused before the prompt: a full list would refuse it after Touch ID anyway.
        guard networks.count < NetworkApproval.limit else { return problem = Self.fullListMessage }
        problem = nil
        do {
            guard try await Self.authenticate("이 네트워크(\(label))에서 Mac 화면 제어를 허용합니다") else { return }
            // The network the prompt named, even if the Mac moved meanwhile; the next evaluation decides where to listen.
            if addNetwork(ApprovedNetwork(identity: candidate.identity, label: candidate.label)) { reevaluate() }
        } catch {
            problem = "네트워크를 승인하지 못했습니다: \(Self.describe(error))"
        }
    }

    /// Never asks: removing only narrows where the Mac listens (보안 원칙 5). Removing the network it listens on stops
    /// listening and ends the session.
    public func removeNetwork(_ network: ApprovedNetwork) {
        networks = NetworkApproval.remove(network.id, from: networks)
        do { try store.saveNetworks(networks) } catch { problem = "승인된 네트워크 목록을 저장하지 못했습니다: \(Self.describe(error))" }
        reevaluate()
    }

    /// Saved first: the Mac never listens on a network it could not remember approving.
    @discardableResult
    private func addNetwork(_ network: ApprovedNetwork) -> Bool {
        do {
            let next = try NetworkApproval.approve(network, in: networks)
            try store.saveNetworks(next)
            networks = next
            return true
        } catch ApprovedNetworkError.full {
            problem = Self.fullListMessage
        } catch {
            problem = "승인한 네트워크를 저장하지 못했습니다: \(Self.describe(error))"
        }
        return false
    }

    private static let fullListMessage = "승인된 네트워크는 \(NetworkApproval.limit)개까지입니다. 목록에서 하나를 지운 뒤 다시 승인해 주세요."

    // MARK: Sessions

    private func accept(_ incoming: MacSession) {
        let id = Self.hex(incoming.deviceID)
        // The key exchange already refused an expired registration (RegisteredDeviceKeys); this is a second look.
        guard let device = devices.first(where: { $0.id == id }), !device.isExpired() else { return incoming.connection.close() }
        // One viewer at a time. The same device reconnecting replaces its old session, which may not have noticed
        // that the phone left; another device waits until this one is done.
        if let current = active {
            guard current.session.deviceID == incoming.deviceID else { return incoming.connection.close() }
            endSession(.replaced)
        }
        // A QR must never travel in the stream (SR-18).
        cancelRegistration()
        let localMonitor = InputInjector.isAllowed ? LocalInputMonitor() : nil
        let canControl = localMonitor?.isRunning == true
        let physicalInput: PhysicalInputProbe?
        if let localMonitor { physicalInput = { localMonitor.snapshot() } } else { physicalInput = nil }
        if canControl { problem = nil }
        else {
            problem = "Mac 입력 우선 보호가 준비되지 않아 화면만 보여줍니다. 손쉬운 사용·입력 모니터링 권한을 확인한 뒤 다시 연결하세요."
        }
        let deviceName = device.displayName
        session = Session(deviceID: id, deviceName: device.displayName, since: Date(), canControl: canControl)
        lastEnded = nil
        let task = Task<Void, Never> { [weak self] in
            var reason: SessionEndReason?
            do {
                // The main display first; a version-2 phone may choose another, and input follows it (HostCapture).
                let injector = InputInjector(displayID: CGMainDisplayID())
                let input = canControl ? InputReceiver(physicalInput: physicalInput,
                    release: { injector.releaseHeld($0) },
                    compound: { text, probe in injector.injectTextAndReturn(text, physicalInput: probe) }, inject: { injector.inject($0) }) : nil
                let desktop = DesktopController(input: input, injector: injector)
                let streamer = HostStreamer(connection: incoming.connection, input: input, onDisplay: { input?.releaseHeld(); injector.setDisplay($0.id) },
                                            desktop: desktop, pointerPosition: { injector.currentPointerPosition() })
                // Ended while starting: nothing was captured or injected, and the connection is closed.
                guard await MainActor.run(body: { self?.attach(streamer, to: incoming) ?? false }) else { return }
                try await streamer.run(lockStates: ScreenLock.states, turnOff: { [weak self] in
                    Task { @MainActor [weak self] in self?.turnOffFromDevice(named: deviceName) }
                })
                reason = streamer.endReason
            } catch TransportError.closed, ChannelError.closed {
                // The phone left or the Mac disconnected it.
            } catch {
                await MainActor.run { self?.problem = "연결이 끝났습니다: \(Self.describe(error))" }
            }
            await MainActor.run { [reason] in self?.sessionEnded(incoming, reason: reason) }
        }
        active = Active(session: incoming, task: task)
        touch(id)
        push?.notify(.connected, by: device, among: devices) // push hook: tells the Mac's other devices
    }

    private func attach(_ streamer: HostStreamer, to incoming: MacSession) -> Bool {
        guard active?.session.connection === incoming.connection else { return false }
        active?.streamer = streamer
        return true
    }

    /// Only a session that ended by itself is still active here; one the Mac ended was let go in `endSession`.
    private func sessionEnded(_ ended: MacSession, reason: SessionEndReason?) {
        guard let active, active.session.connection === ended.connection else { return }
        self.active = nil
        session = nil
        if let reason { lastEnded = Self.describe(reason) }
    }

    /// Ends the current session from the Mac. Held keys and buttons are let go before this returns (SR-16); the phone
    /// hears `reason` in the returned task.
    @discardableResult
    private func endSession(_ reason: SessionEndReason) -> Task<Void, Never>? {
        guard let current = active else { return nil }
        active = nil
        session = nil
        if let streamer = current.streamer { return streamer.end(reason) }
        // Still starting: nothing captured or injected yet.
        current.session.connection.close()
        current.task.cancel()
        return nil
    }

    /// Ends the current session from the Mac.
    public func disconnect() { endSession(.endedAtMac) }

    /// The phone of the current session turned screen control off over the session (version 2), after Face ID on it.
    /// The session already ended with `turnedOffFromDevice`; this does what the menu's 끄기 does and says who did it.
    private func turnOffFromDevice(named name: String) {
        turnOff(reason: "‘\(name)’에서 화면 제어를 껐습니다. 다시 켜려면 이 Mac에서 켜세요.")
    }

    /// A completed connection is a use: it starts the 90 days over (SR-13).
    private func touch(_ id: String) {
        do {
            let next = try persistRegistrationMutation(read: { try store.devices() }, write: { try store.save($0) }) { rows in
                if let index = rows.firstIndex(where: { $0.id == id }) { rows[index].lastConnectedAt = Date() }
            }
            devices = next
            keys.set(next)
        } catch { problem = "기기 사용 시각을 저장하지 못했습니다. 기존 등록은 유지했습니다." }
    }

    /// Renames a device at this Mac only. Nil when saved; otherwise what to tell the person, with the old name kept.
    public func rename(_ device: RegisteredDevice, to text: String) -> String? {
        let alias: String?
        switch device.alias(from: text) {
        case .clear: alias = nil
        case .name(let typed): alias = typed
        case .invalid: return "이름은 32자 이내의 글자·숫자·기호로 입력하세요."
        }
        do {
            let next = try persistRegistrationMutation(read: { try store.devices() }, write: { try store.save($0) }) { rows in
                if let index = rows.firstIndex(where: { $0.id == device.id }) { rows[index].alias = alias }
            }
            devices = next
            keys.set(next)
            if let current = session, current.deviceID == device.id, let renamed = next.first(where: { $0.id == device.id }) {
                session = Session(deviceID: current.deviceID, deviceName: renamed.displayName, since: current.since,
                                  canControl: current.canControl)
            }
            return nil
        } catch {
            return "이름을 저장하지 못했습니다. 이 Mac을 잠금 해제한 뒤 다시 시도하세요."
        }
    }

    public func revoke(_ device: RegisteredDevice) {
        do {
            let next = try persistRegistrationMutation(read: { try store.devices() }, write: { try store.save($0) }) { rows in
                rows.removeAll { $0.id == device.id }
            }
            devices = next
            keys.set(next)
            if session?.deviceID == device.id { endSession(.revoked) }
        } catch {
            // Do not report an in-memory deletion as durable revocation. Stop listening as well so the
            // still-registered key cannot reconnect while the person resolves the Keychain error.
            turnOff(reason: "등록 해지를 저장하지 못해 화면 제어를 중지했습니다. 기기는 아직 등록되어 있습니다. 이 Mac을 잠금 해제한 뒤 다시 해지하세요.")
        }
    }

    // MARK: Registration

    /// Opens a QR for one device. Only while listening on an approved network, and never during a session: the QR would
    /// be in the stream (SR-18).
    public func startRegistration() async {
        guard case .on = power, active == nil, let identity else { return }
        guard !registrationStarting else { return }
        switch registration { case .showing, .confirming: return; case .finished, nil: break }
        registrationStarting = true
        defer { registrationStarting = false }
        let registrationEpoch = epoch
        cancelRegistration()
        let generation = registrationGeneration
        let code = RegistrationCode.generate()
        let window = RegistrationWindow(code: code, signer: identity, openedAt: .now,
                                        attestationVerifier: AnyAppAttestVerifier(Self.attestationVerifiers))
        do {
            let nearbyRegistration = ScreenNearby.registrationService(codeID: code.id)
            let listener = try RegistrationListener(window: window, signer: identity, gate: gate,
                                                    nearbyServiceName: nearbyRegistration, privacyCode: code)
            _ = try await listener.start()
            guard epoch == registrationEpoch, registrationGeneration == generation, case .on = power, active == nil else { listener.stop(); return }
            registrationListener = listener
            registrationWindow = window
            let fingerprint = ScreenControlIdentity.fingerprint(of: identity.publicKey)
            let registrationRelay = try internetRoute.map { try ScreenRelayRoute(endpoint: $0.endpoint,
                                                                                 room: ScreenRelayRoute.newRoom(fingerprint: fingerprint)) }
            let invite = try RegistrationInvite(
                macFingerprint: fingerprint, code: code, macName: Self.macName, hostName: Self.hostName ?? "mac.local",
                nearbyRegistrationService: nearbyRegistration, nearbyScreenService: ScreenNearby.screenService(fingerprint: fingerprint),
                registrationRelay: registrationRelay, screenRelay: internetRoute)
            if let registrationRelay { startInternetRegistration(route: registrationRelay, window: window, identity: identity, code: code) }
            let until = Date().addingTimeInterval(Double(RegistrationCode.lifetime.components.seconds))
            registration = .showing(invite, until: until)
            registrationTask = Task { [weak self] in
                let expiry = Task { [weak self] in
                    guard (try? await Task.sleep(for: RegistrationCode.lifetime)) != nil else { return }
                    await MainActor.run {
                        guard let self, self.registrationGeneration == generation, case .showing = self.registration else { return }
                        self.finishRegistration("QR 시간이 지났습니다. 다시 시작해 주세요.")
                    }
                }
                defer { expiry.cancel() }
                for await outcome in listener.outcomes {
                    guard self?.registrationGeneration == generation, self?.registrationWindow === window else {
                        if case .pending(let request) = outcome { await request.refuse() }
                        return
                    }
                    switch outcome {
                    case .pending(let request):
                        expiry.cancel()
                        await MainActor.run {
                            self?.presentPending(request)
                        }
                        return
                    case .failed(_, let error):
                        await MainActor.run { self?.finishRegistration("등록하지 못했습니다(\(error)). QR을 닫았습니다.") }
                        return
                    }
                }
            }
        } catch {
            guard epoch == registrationEpoch, registrationGeneration == generation else { return }
            registration = .finished("등록을 시작하지 못했습니다: \(Self.describe(error))")
        }
    }

    /// The person compared the numbers: Touch ID or the password, then the device joins the registry.
    public func approvePending() async {
        guard let pending, case .confirming(let name, _, _) = registration else { return }
        do {
            guard try await Self.authenticate("‘\(name)’을 화면 제어 기기로 등록합니다") else { return }
            guard self.pending === pending, case .confirming = registration else { return }
            let registered = RegisteredDevice(record: pending.acceptance.record, attestationKeyID: pending.acceptance.attestation.keyID)
            // The same key approved again renews its registration (SR-13) instead of adding a second row.
            let next = try persistRegistrationMutation(read: { try store.devices() }, write: { try store.save($0) }) { rows in
                var renewed = registered
                renewed.alias = rows.first { $0.id == registered.id }?.alias   // the person's name for it outlives renewal
                rows.removeAll { $0.id == registered.id }
                rows.append(renewed)
            }
            devices = next
            keys.set(next)
            try await pending.approve()
            // push hook: tells the Mac's other devices
            push?.notify(.registered, by: next.first { $0.id == registered.id } ?? registered, among: devices)
            finishRegistration("‘\(name)’을 등록했습니다. 그 기기에서 「화면 보기」를 누르세요.")
        } catch {
            finishRegistration("등록하지 못했습니다: \(Self.describe(error))")
        }
    }

    public func refusePending() async {
        await pending?.refuse()
        finishRegistration("등록을 거절했습니다.")
    }

    /// Closes the QR and refuses any request still waiting.
    public func cancelRegistration() {
        registrationGeneration += 1
        registrationDecisionTask?.cancel(); registrationDecisionTask = nil
        if let window = registrationWindow { Task { await window.close() } }
        registrationWindow = nil
        registrationInternetTask?.cancel(); registrationInternetTask = nil
        if let pending { Task { await pending.refuse() } }
        pending = nil
        registrationTask?.cancel()
        registrationTask = nil
        registrationListener?.stop()
        registrationListener = nil
        registration = nil
    }

    private func finishRegistration(_ message: String) {
        cancelRegistration()
        registration = .finished(message)
    }

    private static let networkChangedQR = "네트워크가 바뀌어 QR을 닫았습니다. 승인된 네트워크에서 다시 시작해 주세요."

    private func presentPending(_ request: PendingRegistration) {
        guard case .showing = registration, pending == nil else { Task { await request.refuse() }; return }
        pending = request
        registrationDecisionTask = Task { [weak self, weak request] in
            guard (try? await Task.sleep(for: .seconds(180))) != nil else { return }
            guard let self, let request, self.pending === request else { return }
            self.finishRegistration("승인 시간이 지났습니다. 새 QR로 다시 시작해 주세요.")
        }
        let record = request.acceptance.record
        registration = .confirming(name: record.deviceName, model: record.deviceModel, sas: request.acceptance.sas)
        registrationListener?.stop()
    }

    /// This is a local Mac approval, distinct from QR registration and screen permissions.
    public func enableInternet(endpointText: String) async {
        do {
            guard case .on = power, let identity, let endpoint = URL(string: endpointText), ScreenRelayRoute.validEndpoint(endpoint) else {
                internetNotice = "화면 제어를 켠 뒤 wss://서버/screen-relay 주소를 입력하세요."; return
            }
            let enablingEpoch = epoch
            guard try await Self.authenticate("등록한 기기가 자체 중계 서버로 이 Mac의 화면에 연결하도록 허용합니다") else { return }
            guard enablingEpoch == epoch, case .on = power else { return }
            cancelRegistration()
            let route = try ScreenRelayRoute(endpoint: endpoint, room: ScreenRelayRoute.newRoom(fingerprint: ScreenControlIdentity.fingerprint(of: identity.publicKey)))
            try store.write("internet-route", JSONEncoder().encode(route))
            internetRoute = route
            internetTask?.cancel(); internetTask = nil
            startInternetListener()
            internetNotice = "자체 중계를 저장했습니다. 기기마다 새 QR로 다시 등록해야 이 경로를 씁니다. 실제 접속 상태는 위에 표시됩니다."
        } catch { internetNotice = "자체 중계를 켜지 못했습니다: \(Self.describe(error))" }
    }

    public func disableInternet() {
        // Close access before persisting the disabled state. Nearby registrations remain usable.
        internetTask?.cancel(); internetTask = nil
        internetAttempt = nil; internetConnection = .off
        cancelRegistration()
        endSession(.endedAtMac)
        internetRoute = nil
        do { try store.write("internet-route", Data("null".utf8)) }
        catch { stop(reason: "자체 중계 해제를 저장하지 못했습니다. 화면 제어를 껐습니다."); return }
        internetNotice = "자체 중계를 껐습니다. 근거리·Cloudflare로는 계속 연결할 수 있습니다."
    }

    private func startInternetListener() {
        guard let route = internetRoute, let identity, let handshake, internetTask == nil else { return }
        let epoch = epoch, gate = gate
        internetTask = Task { [weak self] in
            var retry = ScreenRelayRetry()
            while !Task.isCancelled {
                var transport: ScreenRelayTransport?
                let attempt = UUID()
                guard let self, self.epoch == epoch, self.internetRoute == route else { return }
                self.internetAttempt = attempt; self.internetConnection = .connecting
                do {
                    let opened = try await ScreenRelayTransport.open(route: route, purpose: .screen, hostSigner: identity,
                                                                    progress: { [weak self] progress in
                        Task { @MainActor [weak self] in
                            guard let self, self.epoch == epoch, self.internetRoute == route, self.internetAttempt == attempt else { return }
                            let state: InternetConnection = switch progress {
                            case .connecting: .connecting
                            case .waiting: .waiting
                            case .paired: .authenticating
                            }
                            // Delayed callbacks from the same attempt must not overwrite connected/retrying.
                            if state.rawValue >= self.internetConnection.rawValue { self.internetConnection = state }
                        }
                    })
                    transport = opened
                    guard !Task.isCancelled, self.epoch == epoch, self.internetRoute == route else { opened.cancel(); return }
                    let incoming = try await ScreenTransportHandshake.accept(over: opened, peer: PeerKey(relayEndpoint: route.endpoint), handshake: handshake, gate: gate)
                    try await opened.authenticated()
                    guard !Task.isCancelled, self.epoch == epoch, self.internetRoute == route else { incoming.connection.close(); return }
                    self.accept(incoming)
                    retry.reset()
                    if self.active?.session.connection === incoming.connection { self.internetConnection = .connected }
                    while !Task.isCancelled, self.active?.session.connection === incoming.connection {
                        try await Task.sleep(for: .seconds(1))
                    }
                } catch ScreenRelayError.peerWaitExpired {
                    // A normal bounded peer wait is not a failed connection. Rejoin promptly, including v1 relays
                    // which never acknowledged admission and therefore never entered the verified waiting state.
                    retry.reset()
                } catch { /* The relay cannot grant access. Rejoin with a fresh challenge while locally enabled. */ }
                transport?.cancel()
                guard !Task.isCancelled, self.epoch == epoch, self.internetRoute == route else { return }
                if self.internetConnection == .waiting { retry.reset() }
                self.internetConnection = .retrying
                do { try await Task.sleep(for: retry.delay(randomUnit: Double.random(in: 0...1))) }
                catch { return }
            }
        }
    }

    private func startInternetRegistration(route: ScreenRelayRoute, window: RegistrationWindow, identity: SecureEnclaveTranscriptSigner, code: RegistrationCode) {
        let epoch = epoch, gate = gate
        registrationInternetTask = Task { [weak self] in
            while !Task.isCancelled, await window.isOpen(at: .now) {
                var transport: ScreenRelayTransport?
                do {
                    let opened = try await ScreenRelayTransport.open(route: route, purpose: .registration, hostSigner: identity)
                    transport = opened
                    guard !Task.isCancelled, let self, self.epoch == epoch, self.registrationWindow === window else { opened.cancel(); return }
                    let request = try await RegistrationHost.accept(over: opened, peer: PeerKey(relayEndpoint: route.endpoint), window: window, signer: identity, gate: gate, privacyCode: code)
                    guard !Task.isCancelled, self.epoch == epoch, self.registrationWindow === window else { await request.refuse(); return }
                    self.presentPending(request)
                    return // PendingRegistration owns the connection until Mac approval/refusal.
                } catch {
                    transport?.cancel()
                    if !(await window.isOpen(at: .now)) {
                        if let self, self.registrationWindow === window { self.finishRegistration("등록하지 못했습니다. 새 QR로 다시 시작해 주세요.") }
                        return
                    }
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    // MARK: Helpers

    /// Our two iOS app IDs (TestFlight and development installs) in either App Attest environment. Both environments
    /// chain to Apple's App Attestation root; which one a build uses depends on how it was signed and distributed.
    static let attestationVerifiers: [any AppAttestationVerifying] =
        ["com.intenet.agentstoz.mobile.testflight", "com.intenet.agentstoz.mobile"].flatMap { bundleID in
            [AppAttestEnvironment.production, .development].map {
                AppAttestVerifier(teamID: "DA8QKAQ2C9", bundleID: bundleID, environment: $0) as any AppAttestationVerifying
            }
        }

    /// Touch ID, or the login password when there is none. False when the person cancels.
    static func authenticate(_ reason: String) async throws -> Bool {
        do {
            return try await LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch let error as LAError where [.userCancel, .appCancel, .systemCancel].contains(error.code) {
            return false
        }
    }

    /// The interface the system uses now, when it is Wi‑Fi or Ethernet.
    nonisolated static func interface(on path: NWPath) -> (name: String, medium: NetworkSnapshot.Medium)? {
        guard path.status == .satisfied,
              let interface = path.availableInterfaces.first(where: { $0.type == .wifi || $0.type == .wiredEthernet }) else {
            return nil
        }
        return (interface.name, interface.type == .wifi ? .wifi : .ethernet)
    }

    struct NetworkReading: Sendable {
        let interface: (name: String, medium: NetworkSnapshot.Medium)?
        /// Nil when the network cannot be told apart (no router, or its hardware address not known yet).
        let network: (identity: NetworkIdentity, label: String)?
    }

    /// The interface and its network now, read once away from the main thread.
    nonisolated static func readNetwork() async -> NetworkReading {
        await Task.detached {
            let interface = pathSnapshot().flatMap(interface(on:))
            let snapshot = interface.flatMap { NetworkProbe.snapshot(interface: $0.name, medium: $0.medium) }
            return NetworkReading(interface: interface,
                                  network: snapshot.flatMap { snapshot in snapshot.identity.map { ($0, label(for: snapshot)) } })
        }.value
    }

    /// The listener on the fixed port at `address`. Moving to another approved network can give back the address the
    /// old listener is still letting go of, so a failed start is tried again briefly.
    private static func listen(handshake: MacHandshake, gate: PreAuthGate, address: String) async throws -> ScreenListener {
        var attempt = 1
        while true {
            let listener = try ScreenListener(handshake: handshake, gate: gate, host: .init(address),
                                              port: NWEndpoint.Port(rawValue: screenPort)!)
            do {
                _ = try await listener.start()
                return listener
            } catch {
                listener.stop()
                guard attempt < 4 else { throw error }
                attempt += 1
                try await Task.sleep(for: .milliseconds(300))
            }
        }
    }

    /// What the menu calls a network: the Wi‑Fi name when macOS gives it without asking, otherwise a neutral
    /// 「Wi‑Fi · 192.168.0.x」. The name needs Location permission since macOS 14; this app never asks for it (no usage
    /// description, so no prompt can appear) and usually shows the neutral label. Either ends with the router's last two
    /// bytes when it is known (「· 공유기 …44:55」): many homes and cafés share 192.168.0.x and a default Wi‑Fi name, and
    /// two rows must not look the same when one is to be removed. Only a label: never the identity.
    nonisolated static func label(for snapshot: NetworkSnapshot) -> String {
        if snapshot.medium == .wifi, let name = CWWiFiClient.shared().interface(withName: snapshot.interface)?.ssid(),
           RegistrationInvite.isShowableName(name) {
            return "\(name) · \(snapshot.subnetText)" + routerText(snapshot)
        }
        return neutralLabel(for: snapshot)
    }

    nonisolated static func neutralLabel(for snapshot: NetworkSnapshot) -> String {
        "\(snapshot.medium == .wifi ? "Wi‑Fi" : "유선") · \(snapshot.subnetText)" + routerText(snapshot)
    }

    private nonisolated static func routerText(_ snapshot: NetworkSnapshot) -> String {
        snapshot.identity.map { " · 공유기 …\($0.routerTail)" } ?? ""
    }

    /// The current path, read once.
    private nonisolated static func pathSnapshot() -> NWPath? {
        let monitor = NWPathMonitor()
        let semaphore = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: NWPath?
        monitor.pathUpdateHandler = { path in
            result = path
            semaphore.signal()
        }
        monitor.start(queue: DispatchQueue(label: "agentstoz.screen-control.path-snapshot"))
        _ = semaphore.wait(timeout: .now() + 2)
        monitor.cancel()
        return result
    }

    nonisolated static var hostName: String? {
        (SCDynamicStoreCopyLocalHostName(nil) as String?).map { $0 + ".local" }
    }

    /// The computer name, when the phone's list can show it as it is.
    nonisolated static var macName: String {
        let name = (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? "Mac"
        return RegistrationInvite.isShowableName(name) ? name : "Mac"
    }

    nonisolated static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    nonisolated static func describe(_ reason: SessionEndReason) -> String {
        let limits = SessionLimits.standard
        return switch reason {
        case .idle: "\(limits.idle.components.seconds / 60)분 동안 조작이 없어 연결을 끝냈습니다."
        case .timeLimit: "연결 시간 제한에 도달해 끝냈습니다."
        case .endedAtMac, .turnedOff, .revoked, .replaced: "이 Mac에서 연결을 끝냈습니다."
        case .turnedOffFromDevice: "등록한 기기에서 화면 제어를 껐습니다. 다시 켜려면 이 Mac에서 켜세요."
        }
    }

    nonisolated static func describe(_ error: Error) -> String {
        switch error {
        case TransportError.closed: "연결이 닫혔습니다"
        case TransportError.timedOut: "시간이 초과되었습니다"
        case let TransportError.failed(reason): reason
        case CaptureError.noDisplay, HostCaptureError.noDisplay: "화면을 찾지 못했습니다"
        case let ScreenStoreError.keychain(status): "키체인 오류 \(status)"
        default: "\(error)"
        }
    }
}
#endif
