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
///
/// Mac controllers (docs/design/mac-to-mac-2026-11-01 5.2, 6.4-6.7, 9절): a second registry beside the phones', looked up
/// after them (`ScreenPeerKeys`); the screen port serves both, the self-hosted relay phones only (SR-33). One session at
/// a time (`SessionArbiter`), a phone before a controller; a controller's grant, limits and address hint go to the
/// streamer, and it can never turn this Mac's screen control off. Raising what another Mac may do takes Touch ID or a
/// paired Watch (`ScreenAuthentication.raising`); narrowing never asks and ends its session at once. Each controller event
/// is logged (`ControllerLog`) and told to the phones (kinds 3·4). 「켜 두기」 (SR-27) turns screen control on by itself
/// after a restart, on saved networks only.
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
        /// Turned on by itself after a restart (켜 두기, SR-27) on a network keeping on did not save: it listens again by
        /// itself once the Mac is back on a saved one.
        case notKept(label: String)

        var needsSoonRecheck: Bool {
            switch self { case .unidentified, .noNetwork, .noRouter: true; default: false }
        }
    }

    public struct Session: Equatable {
        public let deviceID: String
        public let deviceName: String
        public let since: Date
        public let canControl: Bool
        /// A registered phone, or a Mac controller.
        public var peerClass: ScreenPeerClass = .phone
        /// What a controller's registration grants; nil for a phone.
        public var grant: ScreenControllerGrant? = nil
        /// Why a controller granted control only watches: this build, the push gate or this Mac's input protection
        /// (DESIGN 6.5, 9절, 12절); nil for a phone, a view grant and a controller that may control.
        public var viewOnlyCause: ControllerViewOnlyCause? = nil
        /// The model it registered with ("iPhone16,2", "Mac16,7"; a controller's only when this Mac may show it): the
        /// session bar shows a phone's kind from it, and a Mac controller always as a Mac (ScreenDeviceKind).
        public var deviceModel = ""
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
        /// Ending it before it ran sends the goodbye and captures nothing.
        let streamer: HostStreamer
        /// The name this Mac showed for the peer when it connected.
        let name: String
        let route: ControllerLogEntry.Route
        /// Remote input on this Mac, for the main app's sidecar (DESIGN 6.7); removed when the session ends.
        let marker: RemoteInputMarker
        /// The session bar's hold on this session's remote input, from `macHold` for a phone and a Mac controller alike.
        let hold: ScreenSessionInputHold
        var peerClass: ScreenPeerClass { session.peerClass }
    }

    // MARK: Mac controllers and keeping on (DESIGN 5.2)

    /// The 「다른 Mac 연결 허용」 switch and the approved Mac controllers.
    public private(set) var macControllers = ScreenControllers()
    public var controllers: [RegisteredController] { macControllers.controllers }
    /// The controllers' recent history at this Mac, oldest first (SR-30).
    public private(set) var controllerHistory: [ControllerLogEntry] = []
    /// Whether the last history entry could not be saved (it stays in memory; nothing waits on it).
    public private(set) var controllerHistoryUnsaved = false
    /// Whether the stored history could not be read yet (DESIGN 12절 「키체인 읽기 실패」): the menu says so instead of
    /// showing an empty list, and nothing overwrites the stored entries until a read goes through.
    public private(set) var controllerHistoryUnread = false
    /// Whether notifications and remote stop reach the phones now (DESIGN 9절): the release gate. Needs a round that
    /// reached the relay with a phone in it within 30 minutes and a phone still in use (`ScreenPeerKeys.pushGateOpen`).
    public private(set) var pushLive = false
    public private(set) var unifiedSafetyNotice = "공통 수신 안전 연결 준비 전"
    /// Negative presentation only. Actual ON still checks the broker's current signed consent and private hold.
    public private(set) var trustedCommunityTurnOnNotice: String?
    static let receivingHoldRecoveryNotice = "이 Mac의 커뮤니티 화면 수신이 보류되어 있습니다. ‘고급 · 이전 직접 등록 관리’에서 ‘다른 Mac 연결 허용’을 이 Mac에서 다시 켜고 Touch ID 또는 Apple Watch로 확인해 주세요. 등록 승인이나 입력 보류 해제 위임으로는 이 수신 보류가 해제되지 않습니다."
    @ObservationIgnored private var safetyPoller: ScreenCommunitySafetyPoller?
    @ObservationIgnored private var safetyActivation: ScreenCommunityBroker.SafetyActivation?
    @ObservationIgnored private var unifiedSafetyOwn: CommunityAuthorization?
    @ObservationIgnored private var unifiedReceivingHeld = false
    @ObservationIgnored private var safetySequence: Int64 = 0
    @ObservationIgnored private let communityRenewalScope=ScreenCommunityRenewalScope()
    /// What this build may open (S-M3, D-2, D-3).
    public let flags: ScreenBuildFlags
    /// Whether 「조작」 may be offered for a controller at all: hidden while the build has not passed S-M3 (D-10). The
    /// pairing window offers it from this too (`controllerPairingDependencies`).
    public var controlChoiceOffered: Bool { flags.macControl }
    /// 「재시작·업데이트 뒤에도 켜 두기」 while on; nil while off.
    public private(set) var keepOn: KeepOnSetting?
    /// The network this Mac is on, as last read: when screen control turns on (by the person or by itself), when keeping on
    /// is turned on or follows the network, and when the menu or the status window opens (`refreshPresentNetwork`). Nil
    /// when it could not be told apart or was not read yet. 「이 네트워크도 켜 두기」 reads it: the nearby listener serves
    /// every network, so `listeningNetwork` (an approved network's binding) says nothing while it is on.
    public private(set) var presentNetwork: NetworkIdentity?
    @ObservationIgnored private var presentNetworkReads = 0
    /// 「다른 Mac 연결 허용」 closed here while the store may still say on (the registry could not be read again after the
    /// pairing window saved a row): every change saves it off until the person turns it on again at this Mac.
    @ObservationIgnored private var controllersHeldClosed = false
    /// Whether 「이 네트워크에서 켜 두기」 may be offered now (SR-27); hidden otherwise.
    public var keepOnOffered: Bool { ReleaseGate.keepOnOffered(flags: flags, pushLive: pushLive) }
    /// What went wrong letting keeping on go, for the menu.
    public private(set) var keepOnNotice: String?
    /// What 「켜 둔 채 끝내기」 says.
    public static let keepOnQuitNotice = "다음 로그인 때 이 네트워크에서 다시 켜집니다."
    /// Closes the 「다른 Mac 추가…」 window and refuses its pending decision (SR-37). Set by the controller enrollment
    /// window; every session that starts calls it before anything is captured, so its codes never travel in a stream.
    @ObservationIgnored public var closeControllerPairing: (@MainActor () -> Void)?

    @ObservationIgnored private let environment: ScreenServiceEnvironment
    @ObservationIgnored private let liveness: PushLiveness
    @ObservationIgnored private let peerKeys: ScreenPeerKeys
    @ObservationIgnored private let logBook: ControllerLogBook
    /// On by itself after a restart: it follows the saved networks until the person turns it off.
    @ObservationIgnored private var keptOnBySelf = false
    /// The stored keep-on item may still say on while it is off here (a release that could not be saved, or an item that
    /// could not be read): the next release writes it again, and the hold file stays until it is written.
    @ObservationIgnored private var keepOnStale = false
    @ObservationIgnored private var keepOnMonitor: NWPathMonitor?
    @ObservationIgnored private var keepOnWatch: Task<Void, Never>?
    @ObservationIgnored private var keepOnFollowing: Task<Void, Never>?

    private let store: ScreenStore
    private var identity: (any TranscriptSigner)?
    private var listener: (any ScreenSessionSource)?
    private var listening: Task<Void, Never>?
    private var monitor: NWPathMonitor?
    private var gate = PreAuthGate()
    private var active: Active?
    /// 「직접 하기」·「보기만」 across sessions: every session's hold comes from here (ScreenSessionInputHold.swift).
    @ObservationIgnored private var macHold = ScreenMacHold()
    @ObservationIgnored private var handBackInProgress=false
    @ObservationIgnored private var persistentInputHold:ScreenPersistentInputHold?
    public private(set) var inputProtectionNotice:String?
    public private(set) var ownerDelegationNotice="다른 Mac의 입력 보류 해제 위임 · 상태 확인 전"
    public private(set) var ownerDelegationEnabled:Bool?
    @ObservationIgnored private var ownerLifecycleGeneration=UUID().uuidString.lowercased()
    @ObservationIgnored private var ownerRecoveryTask:Task<Void,Never>?
    @ObservationIgnored private var ownerLockTask:Task<Void,Never>?
    public struct CommunityDesktopDestination:Identifiable,Sendable {
        public let id:String,name:String,deviceId:String,ready:Bool
    }
    public private(set) var communityDesktops:[CommunityDesktopDestination]=[]
    public private(set) var communityDesktopNotice="목록 준비 전 · 커뮤니티 등록 뒤 Viewer에서 현재 기기 목록을 불러옵니다."
    @ObservationIgnored private var desktopSelections:[String:CommunityDesktopScreenTrust]=[:]
    @ObservationIgnored private var desktopListExpiry:Task<Void,Never>?
    public var needsTrustedInputOwnerConfirmation:Bool { persistentInputHold?.held == true && offersTrustedCommunityTurnOn && !quitting }
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
    @ObservationIgnored private var communityBroker: ScreenCommunityBroker?
    @ObservationIgnored private var communityServer: ScreenCommunitySocketServer?
    @ObservationIgnored private var communityTask: Task<Void, Never>?
    @ObservationIgnored private var communityExpiry: Task<Void, Never>?
    @ObservationIgnored private var activeCommunityPeer = false
    public private(set) var unifiedReceivingRegistered = false
    @ObservationIgnored private var unifiedMux: CommunityRelayMultiplexer?
    @ObservationIgnored private var unifiedOpening: Task<Void, Never>?
    @ObservationIgnored private var unifiedGeneration = UUID()
    @ObservationIgnored private var unifiedAdmission: CommunityScreenAdmission?
    @ObservationIgnored private var unifiedRenewal: Task<Void, Never>?
    @ObservationIgnored private var unifiedDeadline: Task<Void, Never>?
    @ObservationIgnored private var unifiedReplay = NonceReplayCache()
    @ObservationIgnored private var push: ScreenPush?

    public convenience init() { self.init(environment: .system()) }

    init(environment: ScreenServiceEnvironment) {
        self.environment = environment
        store = environment.store
        flags = environment.flags
        liveness = environment.liveness
        let liveness = environment.liveness
        peerKeys = ScreenPeerKeys(pushLive: { liveness.isLive }, now: environment.now)
        logBook = ControllerLogBook(store: environment.store, now: environment.now)
        controllerHistory = logBook.log.entries
        controllerHistoryUnread = logBook.unread
        do {
            devices = try store.devices()
        } catch {
            problem = "등록 목록을 읽지 못했습니다: \(error)"
        }
        do {
            macControllers = try store.controllers { discarded in
                problem = [problem, "손상된 다른 Mac 항목 \(discarded)개를 제외했습니다."].compactMap { $0 }.joined(separator: " ")
            }
        } catch {
            // No controller can connect then; the phones are untouched.
            problem = [problem, "다른 Mac 목록을 읽지 못했습니다: \(error)"].compactMap { $0 }.joined(separator: " ")
        }
        refreshKeys()
        // Kept on only as the store says and nothing holds it (SR-27); a held or unreadable setting is off here.
        let kept = store.keepOn()
        let held = PowerHold.isHeld(at: environment.powerHoldURL)
        keepOn = held ? nil : kept.setting
        keepOnStale = kept.unreadable || (held && kept.setting != nil)
        do {
            networks = try store.networks { discarded in
                problem = [problem, "손상된 승인 네트워크 항목 \(discarded)개를 제외했습니다."].compactMap { $0 }.joined(separator: " ")
            }
        } catch {
            // Nothing is approved then: the Mac does not listen until a network is approved again.
            problem = [problem, "승인된 네트워크 목록을 읽지 못했습니다: \(error)"].compactMap { $0 }.joined(separator: " ")
        }
        // However the app quits, nothing stays pressed on this Mac (SR-16): turning off lets go before the process
        // exits. Posted on the main thread, and `queue: nil` runs this before termination goes on. Quit from outside
        // (an update, a restart) keeps 「켜 두기」: only the person's own 끄기 and 「끄고 끝내기」 let it go (SR-27).
        if environment.observesTermination {
            _ = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.stop(reason: nil, releasingKeepOn: false)
                    self?.closeInputAndSeal()
                    // Last: the main app then shows the helper as not running instead of an old state.
                    self?.quitting = true
                    ScreenStatusFile.remove()
                }
            }
        }
        // A prior opted-in instance's negative remains effective even before its community lease is refreshed.
        // Missing legacy storage alone does not opt a device into the new policy.
        do { if try store.inputHoldData() != nil { preparePersistentInputHold() } }
        catch { preparePersistentInputHold() }
        push = environment.push(liveness) // push hook
        publishStatus()
        if environment.resumesKeptOn { Task { await resumeKeptOn() } }
    }

    /// Production app lifecycle only, never the test environment initializer. Registration IPC cannot start a session.
    public func startCommunityRegistration() {
        guard communityBroker == nil, ScreenCommunityAuthority.configured != nil else { return }
        do {
            let broker = try ScreenCommunityBroker(didAccessChange: { [weak self] own, peers, held in
                Task { @MainActor [weak self] in self?.unifiedAccessChanged(own, peers: peers, held: held) }
            }, didChange: { [weak self] directory, held in
                Task { @MainActor [weak self] in self?.communityChanged(directory, held: held) }
            })
            let server = try ScreenCommunitySocketServer { await broker.handle($0) }
            communityBroker = broker; communityServer = server
            startOwnerRecovery(broker)
            safetyPoller = ScreenCommunitySafetyPoller { [weak self] ready,notice in
                guard let self else { return }
                self.unifiedSafetyNotice=notice
                if !ready,self.unifiedAdmission != nil { self.endSession(.revoked) }
            }
            Task { await server.run() }
            communityTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await broker.refresh()
                    try? await broker.refreshAccess()
                    try? await Task.sleep(for: .seconds(30))
                    guard self != nil else { return }
                }
            }
        } catch { problem = "커뮤니티 기기 등록 서비스를 준비하지 못했습니다. Screen을 다시 열어 주세요." }
    }
    private func communityChanged(_ directory: ScreenCommunityDirectory?, held: Bool) {
        let ownHost = directory?.members.first(where: { $0.enrollmentID == directory?.selfEnrollmentID })?.hostKey
        peerKeys.community.update(directory, ownHostKey: ownHost, held: held)
        communityExpiry?.cancel()
        if session != nil, activeCommunityPeer, peerKeys.community.peer(for: active?.session.deviceID ?? Data()) == nil { endSession(.revoked) }
        if let directory {
            let delay = max(0, directory.expiresAt.timeIntervalSinceNow)
            communityExpiry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, let self else { return }
                self.peerKeys.community.update(nil, ownHostKey: nil, held: held)
                if self.activeCommunityPeer { self.endSession(.revoked) }
            }
        }
    }

    /// Both registries as the key exchange sees them.
    private func refreshKeys() {
        peerKeys.set(phones: devices, controllers: macControllers)
    }

    /// The Mac's half of the key exchange for this service's registries (DESIGN 6.4): phones first, then the Mac
    /// controllers the switch and the release gate admit.
    func macHandshake(signer: any TranscriptSigner) -> MacHandshake {
        let peerKeys = peerKeys
        return MacHandshake(signer: signer, replay: NonceReplayCache(), registeredPeer: { peerKeys.peer(for: $0) })
    }

    private var canReceiveUnified: Bool {
        switch power { case .on, .waiting: true; case .off, .starting: false }
    }
    private func stopUnifiedListener() {
        unifiedGeneration = UUID(); unifiedOpening?.cancel(); unifiedOpening = nil
        unifiedMux?.cancel(); unifiedMux = nil
    }
    /// Native broker callback; internal so software checks can deliver a policy change through the real lifecycle.
    /// No public command or IPC accepts these values.
    func unifiedAccessChanged(_ own: CommunityAuthorization?, peers: [CommunityAuthorization], held: Bool) {
        let previousPolicy=unifiedSafetyOwn.flatMap{try? CommunityMobileControlPolicy.authorizationDigest($0)},nextPolicy=own.flatMap{try? CommunityMobileControlPolicy.authorizationDigest($0)}
        if held || previousPolicy != nextPolicy {ownerLifecycleGeneration=UUID().uuidString.lowercased()}
        updateCommunityDesktops(own,peers:peers)
        unifiedSafetyOwn=own;unifiedReceivingHeld=held
        trustedCommunityTurnOnNotice=held ? Self.receivingHoldRecoveryNotice:nil
        if own?.isCurrent() == true,own?.body.capabilities.contains(.desktopTrust) == true { preparePersistentInputHold() }
        unifiedReceivingRegistered = own?.isCurrent() == true && own?.body.capabilities.contains(.receiveView) == true
        guard let own, unifiedReceivingRegistered, !held, canReceiveUnified, let broker = communityBroker,
              let authority = ScreenCommunityAuthority.configured else {
            stopUnifiedListener()
            safetyPoller?.stop()
            if unifiedAdmission != nil { endSession(.revoked) }
            return
        }
        if let activation=safetyActivation,let safetyPoller {
            let binding=activation.id + ":" + ((try? CommunityMobileControlPolicy.authorizationDigest(own)) ?? "invalid")
            safetyPoller.start(binding:binding,poll:{ [weak self] in
                guard let self,self.canReceiveUnified,!self.unifiedReceivingHeld,self.safetyActivation==activation else { throw ScreenCommunityError.service("SAFETY_INACTIVE") }
                let round=try await broker.safetyPoll(activation:activation,afterSequence:self.safetySequence,snapshot:self.safetySnapshot())
                guard self.canReceiveUnified,!self.unifiedReceivingHeld,self.safetyActivation==activation else { throw ScreenCommunityError.service("SAFETY_INACTIVE") }
                self.safetySequence=round.nextSequence;return round // Paging may wrap; the durable observation counter orders polls.
            },apply:{ [weak self] command in
                guard let self else { throw ScreenCommunityError.service("SAFETY_INACTIVE") }
                try await broker.performSafetyCommand(command,activation:activation) { [weak self] in
                    guard let self else { return .superseded }
                    return try await self.applySafetyCommand(command,activation:activation,broker:broker)
                }
            })
        }
        // Restoring an outbound receiver socket is not restoring a person session. Every new stream still needs
        // current issuer admission and the protocol6 key exchange; an interrupted screen session is never replayed.
        guard unifiedOpening == nil else { return }
        let generation = unifiedGeneration
        unifiedOpening = Task { [weak self] in
            guard let self else { return }
            if let mux = self.unifiedMux, !(await mux.isClosed) { self.unifiedOpening = nil; return }
            self.unifiedMux = nil
            do {
                let context = try CommunityRelayContext(communityID: own.body.communityId, enrollmentID: own.body.enrollmentId,
                    deviceID: own.body.deviceId, publicKey: own.body.hostPublicKey, role: .host)
                let mux = try await CommunityRelayMultiplexer.open(authority: authority, context: context,
                    ticketProvider: { try await broker.receiverTicket(connectionId: $0) },
                    proofSigner: { try await broker.relayProof($0) }, incoming: { [weak self] stream in
                        guard let self else { stream.cancel(); return }
                        await self.receiveUnified(stream, broker: broker, generation: generation)
                    })
                guard self.unifiedGeneration == generation, self.canReceiveUnified, !Task.isCancelled else { mux.cancel(); return }
                self.unifiedMux = mux
            } catch { if self.unifiedGeneration == generation { self.problem = "커뮤니티 인터넷 연결을 준비하지 못했습니다. 등록 상태를 유지하고 다시 연결합니다." } }
            if self.unifiedGeneration == generation { self.unifiedOpening = nil }
        }
    }
    private func receiveUnified(_ stream: CommunityRelayFrameTransport, broker: ScreenCommunityBroker, generation: UUID) async {
        guard unifiedGeneration == generation, canReceiveUnified, safetyPoller?.isReady == true, let authority = ScreenCommunityAuthority.configured else { return stream.cancel() }
        do {
            let handshake = try await broker.receiverHandshake(replay: unifiedReplay)
            let incoming = try await CommunityScreenConnector.accept(over: stream, handshake: handshake,
                peer: PeerKey(relayEndpoint: authority.origin.appending(path: "relay")), gate: gate)
            guard unifiedGeneration == generation, canReceiveUnified else { return incoming.session.connection.close() }
            accept(incoming.session, access: incoming.admission)
        } catch { stream.cancel() }
    }
    @ObservationIgnored private var unifiedDesktopTrust:CommunityDesktopTrustLease?
    private func clearUnifiedSession() {
        unifiedDesktopTrust?.invalidate();unifiedDesktopTrust=nil
        communityRenewalScope.cancel()
        unifiedAdmission = nil; unifiedRenewal?.cancel(); unifiedRenewal = nil; unifiedDeadline?.cancel(); unifiedDeadline = nil
    }
    private func safetySnapshot() -> CommunitySafetyHostState {
        let power:CommunitySafetyHostState.Power = isOn ? .on : (isWaiting ? .waiting : .off)
        var current:CommunitySafetyHostState.Session?
        if let admission=unifiedAdmission,let session {
            current=try? .init(channelId:admission.binding.channelId,controllerEnrollmentId:admission.controller.body.enrollmentId,since:Int64(session.since.timeIntervalSince1970*1000))
        }
        return .init(power:power,held:unifiedReceivingHeld,session:power == .off ? nil : current)
    }
    private func applySafetyCommand(_ command:CommunitySafetyCommand,activation:ScreenCommunityBroker.SafetyActivation,broker:ScreenCommunityBroker) async throws -> CommunitySafetyOutcome {
        guard canReceiveUnified,!unifiedReceivingHeld,safetyActivation==activation,command.acceptedAt>=activation.since,command.expiresAt>Int64(environment.now().timeIntervalSince1970*1000),
              safetyPoller?.isReady == true,let own=unifiedSafetyOwn,own.isCurrent(),
              (try? CommunityMobileControlPolicy.authorizationDigest(own))==command.receiverPolicyDigest else { return .superseded }
        switch command.command.action {
        case .end:
            guard let admission=unifiedAdmission,admission.binding.channelId==command.command.expectedSessionId else { return .superseded }
            _ = endSession(.turnedOff);return .ended
        case .turnOff:
            turnOff(reason:"관리 모바일에서 공통 화면 수신을 껐습니다. 다시 켜려면 이 Mac에서 켜 주세요.");return .turnedOff
        case .revoke:
            guard let target=command.command.targetEnrollmentId else { return .refused }
            try await broker.denySafetyPeer(target,activationId:activation.id)
            if unifiedAdmission?.controller.body.enrollmentId==target { _ = endSession(.revoked) }
            return .revoked
        }
    }
    private func scheduleUnifiedDeadline(_ date: Date, connection: SecureConnection) {
        unifiedDeadline?.cancel()
        unifiedDeadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, date.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self, self.active?.session.connection === connection else { return }
            self.endSession(.revoked)
        }
    }
    private func watchUnifiedSession(_ admission: CommunityScreenAdmission, connection: SecureConnection,desktopTrust:CommunityDesktopTrustLease?) {
        clearUnifiedSession(); unifiedAdmission = admission;unifiedDesktopTrust=desktopTrust
        let renewalToken=communityRenewalScope.begin()
        scheduleUnifiedDeadline(admission.expiresAt, connection: connection)
        unifiedRenewal = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard !Task.isCancelled, let self, self.active?.session.connection === connection, let broker = self.communityBroker else { return }
                do {
                    try await broker.refreshAccess()
                    guard self.communityRenewalScope.permits(renewalToken),self.active?.session.connection === connection else { return }
                    let (own, controller, session) = try await broker.admitted(admission.controller, session: admission.useSession)
                    guard self.communityRenewalScope.permits(renewalToken),self.active?.session.connection === connection else { return }
                    guard self.safetyPoller?.isReady == true,own.body.enrollmentId == admission.receiver.body.enrollmentId, own.body.revision == admission.receiver.body.revision,
                          own.body.hostPublicKey == admission.receiver.body.hostPublicKey, controller.body.revision == admission.controller.body.revision,
                          session?.body.sessionId == admission.useSession?.body.sessionId,
                          session?.body.publicKey == admission.useSession?.body.publicKey else { throw ScreenCommunityError.wrongCommunity }
                    try desktopTrust?.renew(controller:controller,receiver:own,now:self.environment.now())
                    let expiry = min(own.body.expiresAt, controller.body.expiresAt, session?.body.expiresAt ?? Int64.max)
                    self.communityRenewalScope.perform(renewalToken) { self.scheduleUnifiedDeadline(Date(timeIntervalSince1970:Double(expiry)/1000),connection:connection) }
                } catch {
                    guard self.communityRenewalScope.permits(renewalToken),self.active?.session.connection === connection else { return }
                    self.communityRenewalScope.perform(renewalToken) {
                        self.safetyPoller?.invalidate("등록 유지 · 공통 화면의 현재 수신 권한을 확인하지 못해 연결을 종료했습니다.")
                        if self.active?.session.connection === connection { self.endSession(.revoked) }
                    };return
                }
            }
        }
    }

    /// The push gate may have opened or closed (ScreenPush, after each round that reached the relay; the status timer).
    func pushLivenessChanged() {
        let live = peerKeys.pushGateOpen
        if live != pushLive { pushLive = live }
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
        // A timer calls this: the release gate also closes by itself after a long silence.
        pushLivenessChanged()
        guard !quitting, environment.publishesStatus else { return }
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
        guard !quitting,case .off = power else { return }
        power = .starting
        let powerEpoch = epoch
        let protectedGeneration=persistentInputHold?.record?.generation,holdGeneration=macHold.generation
        problem = nil
        do {
            guard try await authenticate("근거리에서 등록한 기기로 Mac 화면 제어를 켭니다", policy: ScreenAuthentication.turningOn)
            else { return power = .off(reason: nil) }
            guard epoch == powerEpoch, case .starting = power else { return }
            // Proven at this Mac: input a person here took back from the session bar is not held into the next turning on.
            if let value=persistentInputHold {
                // Preserve the old explicit authenticated-ON recovery, using that same fresh OS-owner check.
                // A newer negative/migration while the OS sheet was open cannot be cleared by the older result.
                if let protectedGeneration,value.record?.generation==protectedGeneration,macHold.generation==holdGeneration {
                    do { try value.clearAfterOwnerConfirmation(expectedGeneration:protectedGeneration);macHold.reset() }
                    catch { macHold.restoreHeld();inputProtectionNotice=value.issue }
                }
            } else { macHold.reset() }
            let identity = try self.identity ?? environment.identity(store)
            self.identity = identity
            // The person turned it on here: what keeping on held back may go (SR-27), once the store says it is off.
            keptOnBySelf = false
            settleHold()
            try await startListening(identity: identity)
            guard listener != nil else { return }
            push?.started(service: self, identity: identity, keys: peerKeys.phones)
            await readPresentNetwork()
        } catch {
            stopListening()
            power = .off(reason: "켜지 못했습니다: \(Self.describe(error))")
        }
    }
    /// One-time community consent replaces repeat application BIO, but never the person's explicit hardware action
    /// at Screen, the OS recording/input grants, local stop, push gate or calibrated Mac input gate.
    public func turnOnFromCommunity(click: ScreenInputRefusal?) async {
        guard !quitting else { return }
        guard click == nil else { problem = ScreenInputOriginText.notInFront; return }
        guard case .off = power else { return }
        guard unifiedReceivingRegistered, let broker = communityBroker else { await turnOn(); return }
        let powerEpoch = epoch
        do {
            _ = try await broker.consentForTurningOn()
            guard epoch == powerEpoch, case .off = power else { return }
            power = .starting; problem = nil;if persistentInputHold == nil { macHold.reset() }; try await broker.hold(false)
            let identity = try self.identity ?? environment.identity(store); self.identity = identity
            keptOnBySelf = false; settleHold(); try await startListening(identity: identity)
            guard listener != nil else { return }
            push?.started(service: self, identity: identity, keys: peerKeys.phones)
            try await broker.refreshAccess(); await readPresentNetwork()
        } catch { stopListening(); power = .off(reason: "커뮤니티 수신 권한을 확인하지 못했습니다. \(Self.describe(error))") }
    }

    public var offersTrustedCommunityTurnOn:Bool { unifiedReceivingRegistered && unifiedSafetyOwn?.isCurrent() == true && unifiedSafetyOwn?.body.capabilities.contains(.desktopTrust) == true }
    public var canTurnOnFromTrustedCommunity:Bool { offersTrustedCommunityTurnOn && !unifiedReceivingHeld && !quitting }
    /// Explicit device-trust ON only. Neither persistent receive hold nor the person's input hold is cleared.
    public func turnOnFromTrustedCommunity() async {
        guard let broker=communityBroker else {
            problem="기기 신뢰 수신 권한을 아직 확인할 수 없습니다. 커뮤니티 기기 등록·승인에서 이 Mac의 등록 상태를 새로 고침해 주세요."
            return
        }
        await turnOnFromTrustedCommunity(consent:{ try await broker.trustedConsentForTurningOn() },refresh:{ try await broker.refreshAccess() })
    }
    /// The actual startup lifecycle, with typed native authority. Software checks replace only the network awaits.
    func turnOnFromTrustedCommunity(consent: @MainActor () async throws -> CommunityDesktopReceiveTrust,
                                   refresh: @MainActor () async throws -> Void) async {
        guard !quitting,case .off=power else { return }
        guard !unifiedReceivingHeld else { problem=Self.receivingHoldRecoveryNotice;return }
        let powerEpoch=epoch
        // Claim before the first await: another ON cannot share this epoch. OFF invalidates this entire attempt.
        power = .starting;problem=nil
        do {
            let consent=try await consent()
            guard !quitting,epoch==powerEpoch,case .starting=power else { return }
            guard consent.isCurrent(),!unifiedReceivingHeld else { throw ScreenCommunityError.expired }
            preparePersistentInputHold()
            let identity=try self.identity ?? environment.identity(store);self.identity=identity
            keptOnBySelf=false;settleHold();try await startListening(identity:identity)
            guard !quitting,epoch==powerEpoch else { return }
            guard !unifiedReceivingHeld,listener != nil else { throw ScreenCommunityError.expired }
            push?.started(service:self,identity:identity,keys:peerKeys.phones)
            try await refresh()
            guard !quitting,epoch==powerEpoch else { return }
            guard !unifiedReceivingHeld,listener != nil else { throw ScreenCommunityError.expired }
            await readPresentNetwork()
        } catch {
            guard !quitting,epoch==powerEpoch else { return }
            stopListening();power = .off(reason:"기기 신뢰 수신 권한을 확인하지 못했습니다. 보류·OS 권한은 유지됩니다. \(Self.describe(error))")
        }
    }
    /// Reads the network this Mac is on into `presentNetwork`. The app calls it when a menu or the status window opens,
    /// and now and then while kept on, so 「이 네트워크도 켜 두기」 follows a move to another network.
    public func refreshPresentNetwork() async { await readPresentNetwork() }

    /// The network this Mac is on now; `presentNetwork` follows the newest read that finished.
    @discardableResult
    private func readPresentNetwork() async -> (identity: NetworkIdentity, label: String)? {
        presentNetworkReads += 1
        let ticket = presentNetworkReads
        let network = await environment.currentNetwork()
        if ticket == presentNetworkReads, presentNetwork != network?.identity { presentNetwork = network?.identity }
        return network
    }

    /// The nearby listener on the screen port, serving phones and Mac controllers (SR-33), and the self-hosted relay when
    /// it was enabled at this Mac.
    private func startListening(identity: any TranscriptSigner) async throws {
        let startEpoch = epoch
        gate = PreAuthGate()
        let handshake = macHandshake(signer: identity)
        self.handshake = handshake
        let nearby = try await environment.openNearby(handshake, gate,
                                                      ScreenNearby.screenService(fingerprint: ScreenControlIdentity.fingerprint(of: identity.publicKey)))
        guard epoch == startEpoch, case .starting = power, listener == nil else { nearby.stop(); return }
        listener = nearby
        power = .on(address: Self.nearbyAddress)
        if let broker=communityBroker {
            if safetyActivation==nil {
                let activation=try await broker.beginSafetyActivation(resuming:keptOnBySelf)
                guard epoch==startEpoch,listener===nearby,isOn else { try? await broker.endSafetyActivation(activation.id);return }
                safetyActivation=activation;safetySequence=0
            }
            try? await broker.refreshAccess()
            guard epoch==startEpoch,listener===nearby,isOn else { return }
        }
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
    }

    private static let nearbyAddress = "근거리 직접 연결"

    /// Every way of turning off lets 「켜 두기」 go (SR-27): the menu's 끄기, a phone's 끄기, a remote turnOff and a stop
    /// because something could not be saved.
    public func turnOff(reason: String? = nil) { stop(reason: reason) }

    /// For the quit button: turns off and waits, about a second at most, until the phone has heard why. 「끄고 끝내기」
    /// (the default) lets keeping on go; 「켜 둔 채 끝내기」 (`keepingOn`) keeps it, and screen control turns on by
    /// itself at the next login on a saved network (`keepOnQuitNotice`).
    public func quit(keepingOn: Bool = false) async {
        let ending=stop(reason:nil,releasingKeepOn:!keepingOn)
        closeInputAndSeal()
        await ending?.value
    }

    /// Terminal barrier first; a queued connection, hold or owner-auth result cannot run after the clean seal.
    private func closeInputAndSeal() {
        guard !quitting else { return };quitting=true
        ownerLifecycleGeneration=UUID().uuidString.lowercased();ownerRecoveryTask?.cancel();ownerLockTask?.cancel();desktopListExpiry?.cancel()
        active?.hold.lowerToView();endSession(.turnedOff)
        persistentInputHold?.sealAfterClosingInput();inputProtectionNotice=persistentInputHold?.issue
    }

    @discardableResult
    private func stop(reason: String?, releasingKeepOn: Bool = true) -> Task<Void, Never>? {
        ownerLifecycleGeneration=UUID().uuidString.lowercased()
        // First, so a stop because something could not be saved never leaves keeping on behind it.
        if releasingKeepOn { releaseKeepOn() } else { stopFollowingKeptOnNetwork() }
        if releasingKeepOn,let activation=safetyActivation,let broker=communityBroker { Task { try? await broker.endSafetyActivation(activation.id) } }
        safetyActivation=nil;safetySequence=0
        cancelRegistration()
        let ending = endSession(.turnedOff)
        stopListening()
        power = .off(reason: reason)
        push?.stopped() // push hook
        return ending
    }

    // MARK: Keeping on (D-2, SR-27)

    /// 「이 네트워크에서 켜 두기」: only while on, while the push gate is open and the build allows it, behind Touch ID or a
    /// paired Watch at this Mac (never the password). Names the network the Mac is on now; on another network the same
    /// proof adds it.
    public func enableKeepOn() async {
        pushLivenessChanged()
        guard keepOnOffered, isOn else { return }
        guard let network = await readPresentNetwork() else {
            return problem = "이 네트워크를 구별할 수 없어 켜 두지 못합니다. 공유기가 있는 Wi‑Fi나 유선 네트워크에서 다시 시도하세요."
        }
        do {
            guard try await authenticate("재시작·업데이트 뒤에도 이 네트워크(\(network.label))에서 화면 제어를 켜 둡니다",
                                         policy: ScreenAuthentication.raising) else { return }
            pushLivenessChanged()
            guard isOn, keepOnOffered else { return }
            let next = KeepOnSetting.turningOn(keepOn, network: network.identity, at: environment.now())
            try store.saveKeepOn(next)
            keepOn = next
            keepOnStale = false
            keepOnNotice = nil
            PowerHold.release(at: environment.powerHoldURL)
        } catch {
            problem = "켜 두기를 켜지 못했습니다: \(Self.describe(error))"
        }
    }

    /// Never asks: it only stops screen control from turning on by itself.
    public func disableKeepOn() { releaseKeepOn() }

    /// Saves keeping on off; when that fails, writes the hold file so nothing turns on by itself (the closed side).
    private func releaseKeepOn() {
        stopFollowingKeptOnNetwork()
        guard keepOn != nil || keepOnStale else { return }
        keepOn = nil
        let holdURL = environment.powerHoldURL, store = store
        switch KeepOn.release(clear: { try store.saveKeepOn(nil) }, hold: { try PowerHold.hold(at: holdURL) }) {
        case .cleared:
            keepOnStale = false
        case .held:
            keepOnStale = true
            keepOnNotice = "켜 두기 해제를 저장하지 못했습니다. 이 Mac에서 다시 켤 때까지 스스로 켜지지 않습니다."
        case .failed:
            keepOnStale = true
            keepOnNotice = "켜 두기 해제를 저장하지 못했습니다. 다음 로그인 때 다시 켜질 수 있습니다. 이 Mac을 잠금 해제한 뒤 「켜 두기」를 다시 꺼 주세요."
        }
    }

    /// After the person turned on at this Mac behind its proof: a hold file goes once the store says keeping on is off.
    private func settleHold() {
        let holdURL = environment.powerHoldURL
        guard PowerHold.isHeld(at: holdURL) else { return }
        if keepOnStale {
            guard (try? store.saveKeepOn(keepOn)) != nil else { return }
            keepOnStale = false
        }
        PowerHold.release(at: holdURL)
        keepOnNotice = nil
    }

    /// What keeping on decides at launch: nothing unless kept on, not held, and the build allows it.
    func keepOnLaunchDecision() async -> (decision: KeepOnDecision, network: (identity: NetworkIdentity, label: String)?) {
        guard flags.keepOn, let setting = keepOn else { return (.stayOff, nil) }
        let held = PowerHold.isHeld(at: environment.powerHoldURL)
        guard !held else { return (.stayOff, nil) }
        let network = await readPresentNetwork()
        return (KeepOn.atLaunch(setting, held: held, network: network?.identity), network)
    }

    /// At launch: on by itself, without Touch ID, only when kept on and on a saved network; waiting on any other.
    func resumeKeptOn() async {
        guard case .off = power else { return }
        let (decision, network) = await keepOnLaunchDecision()
        guard decision != .stayOff, case .off = power, let setting = keepOn else { return }
        power = .starting
        let powerEpoch = epoch
        do {
            let identity = try self.identity ?? environment.identity(store)
            self.identity = identity
            guard epoch == powerEpoch, case .starting = power else { return }
            keptOnBySelf = true
            if decision == .listen {
                try await startListening(identity: identity)
            } else {
                power = .waiting(.notKept(label: network?.label ?? Self.unknownNetwork))
            }
            guard keptOnBySelf else { return }
            // A remote 끄기 sent since keeping on was chosen still applies.
            push?.started(service: self, identity: identity, keys: peerKeys.phones, onSince: setting.since)
            watchKeptOnNetwork()
        } catch {
            // Not the person's 끄기: keeping on stays, and the next launch tries again.
            keptOnBySelf = false
            stopListening()
            power = .off(reason: "스스로 켜지 못했습니다: \(Self.describe(error))")
        }
    }

    private static let unknownNetwork = "확인할 수 없는 네트워크"

    /// While on by itself: listens on a saved network, waits on any other. One at a time, in order.
    @discardableResult
    func followKeptOnNetwork() -> Task<Void, Never> {
        let previous = keepOnFollowing
        let next = Task { [weak self] in
            await previous?.value
            await self?.followKeptOnNetworkNow()
        }
        keepOnFollowing = next
        return next
    }

    private func followKeptOnNetworkNow() async {
        guard keptOnBySelf, let setting = keepOn else { return }
        let network = await readPresentNetwork()
        guard keptOnBySelf, keepOn == setting, let identity else { return }
        switch KeepOn.follow(setting, network: network?.identity) {
        case .listen:
            guard listener == nil, case .waiting = power else { return }
            power = .starting
            do {
                try await startListening(identity: identity)
            } catch {
                guard keptOnBySelf, case .starting = power else { return }
                problem = "연결을 받지 못했습니다: \(Self.describe(error))"
                power = .waiting(.notKept(label: network?.label ?? Self.unknownNetwork))
            }
        case .wait, .stayOff:
            let label = network?.label ?? Self.unknownNetwork
            guard listener != nil || power != .waiting(.notKept(label: label)) else { return }
            stopListeningForNetwork()
            power = .waiting(.notKept(label: label))
        }
    }

    /// Stops listening where the Mac is now, as leaving an approved network does: the QR closes, the session ends.
    private func stopListeningForNetwork() {
        switch registration {
        case .showing, .confirming: finishRegistration(Self.networkChangedQR)
        case .finished, nil: break
        }
        endSession(.endedAtMac)
        internetTask?.cancel(); internetTask = nil
        internetAttempt = nil; internetConnection = .off
        epoch += 1
        listening?.cancel()
        listening = nil
        listener?.stop()
        listener = nil
    }

    private func watchKeptOnNetwork() {
        stopFollowingKeptOnNetwork(keepingFlag: true)
        guard environment.watchesKeptOnNetwork else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] _ in
            Task { @MainActor [weak self] in self?.followKeptOnNetwork() }
        }
        monitor.start(queue: DispatchQueue(label: "agentstoz.screen-control.keep-on-path"))
        keepOnMonitor = monitor
        // A path change does not announce everything (the router becoming known): look again now and then.
        keepOnWatch = Task { [weak self] in
            while !Task.isCancelled {
                guard (try? await Task.sleep(for: .seconds(15))) != nil else { return }
                await self?.followKeptOnNetwork().value
            }
        }
    }

    private func stopFollowingKeptOnNetwork(keepingFlag: Bool = false) {
        if !keepingFlag { keptOnBySelf = false }
        keepOnMonitor?.cancel()
        keepOnMonitor = nil
        keepOnWatch?.cancel()
        keepOnWatch = nil
    }

    private func stopListening() {
        stopUnifiedListener()
        safetyPoller?.stop()
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
        // Legacy network approvals never replace an active nearby listener, nor the saved networks of keeping on.
        if isOn || keptOnBySelf { return Task {} }
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
            guard try await authenticate("이 네트워크(\(label))에서 Mac 화면 제어를 허용합니다", policy: ScreenAuthentication.turningOn) else { return }
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

    /// A completed key exchange (DESIGN 6.4 5): the registries looked up again, then one session at a time (6.5), then
    /// what the session may do and for how long.
    func accept(_ incoming: MacSession, access: CommunityScreenAdmission? = nil) {
        guard !quitting else { return incoming.connection.close() }
        let id = Self.hex(incoming.deviceID)
        let now = environment.now()
        let route = ControllerLogEntry.route(of: incoming.peer)
        var controller: RegisteredController?
        var communityPeer: ScreenCommunityPeerAdmission?
        let name: String
        if let access {
            guard canReceiveUnified, unifiedReceivingRegistered, access.expiresAt > now,
                  access.peerClass == incoming.peerClass, safetyPoller?.isReady == true else { return incoming.connection.close() }
            name = access.controller.body.name
        } else { switch incoming.peerClass {
        case .phone:
            // The key exchange already refused an expired registration (RegisteredDeviceKeys); this is a second look.
            // A key a controller row holds too answers from neither registry (SR-22).
            if let device = devices.first(where: { $0.id == id }), !device.isExpired(at: now), !macControllers.holds(incoming.deviceID) {
                name = device.displayName
            } else if let peer = peerKeys.community.peer(for: incoming.deviceID, at: now), peer.member.platform == "ios",
                      !macControllers.holds(incoming.deviceID), peerKeys.pushGateOpen {
                communityPeer = peer; name = peer.member.name
            } else { return incoming.connection.close() }
        case .controller:
            if let row = macControllers.controller(for: incoming.deviceID), !row.isExpired(at: now), !devices.holds(incoming.deviceID),
               ReleaseGate.admitsController(bindsGenuineViewer: row.bindsGenuineViewer, pushLive: peerKeys.pushGateOpen) {
                controller = row; name = row.displayName
            } else if let peer = peerKeys.community.peer(for: incoming.deviceID, at: now), peer.member.platform == "mac",
                      !devices.holds(incoming.deviceID), peerKeys.pushGateOpen {
                communityPeer = peer; name = peer.member.name
            } else { return incoming.connection.close() }
        } }
        let controllerGrant: ScreenControllerGrant? = controller?.grant ?? (incoming.peerClass == .controller ? access.map { $0.canControl ? .control : .view } ?? communityPeer.map { $0.receivingGrant == .control ? .control : .view } : nil)
        // One session at a time. The same device reconnecting replaces its old session, which may not have noticed that
        // it left; a registered phone takes the screen from a Mac controller; anything else waits until it is free.
        let holding = active.map { SessionArbiter.Holder($0.peerClass, $0.session.deviceID) }
        switch SessionArbiter.decide(current: holding, incoming: SessionArbiter.Holder(incoming.peerClass, incoming.deviceID)) {
        case .accept: break
        case .replace: endSession(.replaced)
        case .takeOver: endSession(.takenOver)
        case .refuseQuietly: return incoming.connection.close()
        case .refuseBusy:
            if let controller { record(.refused, controller, reason: ControllerLogEntry.reason(.busy), route: route) }
            else if communityPeer?.member.platform == "mac" { record(.refused, id: id, name: name, reason: ControllerLogEntry.reason(.busy), route: route) }
            return Self.refuse(incoming.connection, .busy)
        }
        // A QR must never travel in the stream (SR-18), nor a controller enrollment's codes and approval (SR-37).
        cancelRegistration()
        closeControllerPairing?()
        ownerLifecycleGeneration=UUID().uuidString.lowercased()
        let desktopTrust:CommunityDesktopTrustLease?
        do { desktopTrust=try access?.desktopTrust.map { try CommunityDesktopTrustLease($0,now:now) } } catch { return incoming.connection.close() }
        if desktopTrust != nil { preparePersistentInputHold() }
        let pushLive = access != nil ? safetyPoller?.isReady == true : peerKeys.pushGateOpen
        // Input protection is started only for a session that may control: a phone, or a controller granted control
        // while the control gate is open.
        let wantsInput = switch incoming.peerClass {
        case .phone: access?.canControl ?? (communityPeer == nil || communityPeer?.receivingGrant == .control)
        case .controller: controllerGrant == .control && ReleaseGate.controlOpen(flags: flags, pushLive: pushLive,desktopTrust:desktopTrust)
        }
        let probe = wantsInput ? environment.sessions.inputMonitor() : nil
        let plan: HostSessionPlan = if let controllerGrant {
            .controller(grant: controllerGrant, inputMonitorAvailable: probe != nil, pushLive: pushLive, flags: flags,desktopTrust:desktopTrust)
        } else {
            .phone(inputMonitorAvailable: probe != nil, controlGranted: access?.canControl ?? (communityPeer == nil || communityPeer?.receivingGrant == .control))
        }
        if wantsInput, !plan.canControl {
            problem = "Mac 입력 우선 보호가 준비되지 않아 화면만 보여줍니다. 손쉬운 사용·입력 모니터링 권한을 확인한 뒤 다시 연결하세요."
        } else {
            problem = nil
        }
        // Paused from the first event while a person at this Mac holds its input (「직접 하기」·「보기만」 earlier): reconnecting,
        // or connecting from another registered phone or Mac, never hands input back (SR-29). One hold for both kinds.
        let hold = macHold.begin()
        let physicalInput: PhysicalInputProbe?
        if plan.canControl, let probe {
            physicalInput = { @Sendable in hold.apply(probe()) }
        } else {
            physicalInput = nil
        }
        let marker = RemoteInputMarker(url: environment.remoteInputURL, session: incoming.peerClass, now: environment.now)
        let streamer = environment.sessions.streamer(incoming, plan, physicalInput, marker)
        hold.attach(streamer.input)
        let model = controller.map { $0.showableModel ?? "" } ?? devices.first(where: { $0.id == id })?.model ?? ""
        session = Session(deviceID: id, deviceName: name, since: now, canControl: plan.canControl, peerClass: incoming.peerClass,
                          grant: controllerGrant, viewOnlyCause: plan.viewOnlyCause, deviceModel: model)
        lastEnded = nil
        // Only the phone path may turn this Mac's screen control off; a controller may remove only its own row (6.5, 6.6).
        var turnOff: (@Sendable () -> Void)?
        var unenroll: (@Sendable () -> Void)?
        if access == nil, incoming.peerClass == .phone, communityPeer == nil || communityPeer?.member.admin == true {
            turnOff = { [weak self] in Task { @MainActor [weak self] in self?.turnOffFromDevice(named: name) } }
        } else if access == nil, communityPeer == nil {
            unenroll = { [weak self] in Task { @MainActor [weak self] in self?.controllerUnenrolledItself(id) } }
        }
        let features = (turnOff: turnOff, unenroll: unenroll)
        let hints = incoming.peerClass == .phone ? [] : ScreenAddressHints.routes(from: environment.addresses())
        let lockStates = environment.sessions.lockStates
        let task = Task<Void, Never> { [weak self] in
            var reason: SessionEndReason?
            do {
                // Ended while starting: the goodbye went out (endSession) and nothing was captured or injected.
                guard self?.active?.session.connection === incoming.connection else { return }
                try await streamer.run(lockStates: lockStates, turnOff: features.turnOff, grant: plan.grant, addressHint: hints,
                                       unenrollSelf: features.unenroll, viewOnlyReason: plan.viewOnlyCause?.availability)
                reason = streamer.endReason
            } catch TransportError.closed, ChannelError.closed {
                // The peer left or the Mac disconnected it.
            } catch {
                self?.problem = "연결이 끝났습니다: \(Self.describe(error))"
            }
            self?.sessionEnded(incoming, reason: reason)
        }
        activeCommunityPeer = communityPeer != nil
        active = Active(session: incoming, task: task, streamer: streamer, name: name, route: route, marker: marker, hold: hold)
        if let access { watchUnifiedSession(access, connection: incoming.connection,desktopTrust:desktopTrust) }
        if let access {
            if let broker=communityBroker,let activation=safetyActivation {
                Task { try? await broker.safetyEvent(activationId:activation.id,kind:"connection",actor:access.controller.body.enrollmentId) }
            }
        } else if let controller {
            touchController(id)
            record(.connected, controller, route: route)
            push?.notify(.controllerConnected, controller: controller, among: devices) // push hook: kind 3
        } else if let communityPeer {
            if communityPeer.member.platform == "mac" { record(.connected, id: id, name: name, route: route) }
            push?.notify(communityPeer, among: devices)
        } else if let device = devices.first(where: { $0.id == id }) {
            touch(id)
            push?.notify(.connected, by: device, among: devices) // push hook: tells the Mac's other devices
        }
    }

    /// Tells an authenticated peer why it was refused, then closes: within the goodbye's second, as a session's end.
    private static func refuse(_ connection: SecureConnection, _ reason: SessionEndReason) {
        Task {
            await withTaskGroup(of: Void.self) { group in
                group.addTask { _ = try? await connection.send(.close, reason.closePayload(version: connection.version)) }
                group.addTask { _ = try? await Task.sleep(for: .seconds(1)) }
                await group.next()
                connection.close()
                group.cancelAll()
            }
        }
    }

    /// Only a session that ended by itself is still active here; one the Mac ended was let go in `endSession`.
    private func sessionEnded(_ ended: MacSession, reason: SessionEndReason?) {
        guard let active, active.session.connection === ended.connection else { return }
        ownerLifecycleGeneration=UUID().uuidString.lowercased()
        clearUnifiedSession()
        self.active = nil
        session = nil
        finished(active, reason: reason)
        if let reason { lastEnded = Self.describe(reason) }
    }

    /// Ends the current session from the Mac. Held keys and buttons are let go before this returns (SR-16); the peer
    /// hears `reason` in the returned task. A session ended before it ran captures nothing.
    @discardableResult
    private func endSession(_ reason: SessionEndReason) -> Task<Void, Never>? {
        guard let current = active else { return nil }
        ownerLifecycleGeneration=UUID().uuidString.lowercased()
        clearUnifiedSession()
        active = nil
        session = nil
        let goodbye = current.streamer.end(reason)
        finished(current, reason: reason)
        return goodbye
    }

    /// However a session ended: the remote-input hint goes, and a controller's ending is logged.
    private func finished(_ ended: Active, reason: SessionEndReason?) {
        ended.marker.remove()
        guard ended.peerClass == .controller else { return }
        record(.ended, id: Self.hex(ended.session.deviceID), name: ended.name, reason: ControllerLogEntry.reason(reason), route: ended.route)
    }

    /// Ends the current session from the Mac.
    public func disconnect() { endSession(.endedAtMac) }

    // MARK: The session bar (AgentsToZScreen/ScreenSessionBar.swift, DESIGN mac-to-mac 「부록 A」)

    /// The bar's hold on the current session's remote input.
    public var sessionInput: ScreenSessionInputHold? { active?.hold }
    public var usesTrustedInputOwnerConfirmation:Bool { unifiedDesktopTrust?.current() != nil }
    /// When a session limit ends the current session, and which; nil until its stream runs.
    public var sessionDeadline: (at: ContinuousClock.Instant, reason: SessionEndReason)? { active?.streamer.deadline }

    /// 「직접 하기」: remote input waits until a person at this Mac hands it back, in this session or a later one from any
    /// device (ScreenMacHold). Any click may take input away.
    public func pauseRemoteInput() {
        guard !quitting,let active else { return }
        macHold.pause(active.hold)
        ownerLifecycleGeneration=UUID().uuidString.lowercased()
        persistInputHold()
    }

    /// 「다시 넘기기」: only with no `refusal` (ScreenSessionBarClick: a hardware click at this Mac). False when refused
    /// or when there was nothing to hand back.
    @discardableResult
    public func resumeRemoteInput(refusal: ScreenSessionBarClick.Refusal?) async -> Bool {
        if usesTrustedInputOwnerConfirmation {
            guard refusal != .screenInjected else { return false }
            return await confirmTrustedInputOwner()
        }
        guard refusal == nil,!handBackInProgress,let original=active,macHold.held,original.hold.mode == .paused else { return false }
        // Never-opted-in legacy behavior remains its original accepted-hardware action, without a new BIO prompt.
        if persistentInputHold == nil { return macHold.resume(original.hold) }
        handBackInProgress=true;defer { handBackInProgress=false }
        let generation=macHold.generation
        let protectedGeneration=persistentInputHold?.record?.generation
        do {
            guard try await authenticate("이 Mac에서 보류한 원격 입력을 다시 허용할 계정 소유자를 확인합니다. 연결할 때마다 요구하는 인증이 아닙니다.",policy:ScreenAuthentication.trustedHoldRecovery),
                  let current=active,current.session.connection === original.session.connection,current.hold === original.hold,
                  macHold.generation==generation,current.hold.mode == .paused,isOn else { return false }
            // A prior opted-in negative uses fresh OS-owner confirmation, without silently clearing a newer hold.
            guard !quitting else { return false }
            if let value=persistentInputHold {
                guard let protectedGeneration,value.record?.generation==protectedGeneration else { return false }
                try value.clearAfterOwnerConfirmation(expectedGeneration:protectedGeneration);inputProtectionNotice=value.issue
            }
            return macHold.resume(current.hold)
        } catch { problem="보류 해제 확인을 완료하지 못했습니다. 입력 보류를 유지합니다.";return false }
    }

    /// 「보기만」: the rest of this session only shows the picture, and the next session starts paused until a person at
    /// this Mac hands input back (ScreenMacHold).
    public func lowerSessionToView() {
        guard !quitting,let active, let current = session else { return }
        macHold.lowerToView(active.hold)
        ownerLifecycleGeneration=UUID().uuidString.lowercased()
        persistInputHold()
        guard current.canControl else { return }
        session = Session(deviceID: current.deviceID, deviceName: current.deviceName, since: current.since,
                          canControl: false, peerClass: current.peerClass, grant: current.grant,
                          viewOnlyCause: current.viewOnlyCause, deviceModel: current.deviceModel)
    }

    /// Negative-only preparation: observing an opted-in grant cannot clear a prior hold or grant input authority.
    private func preparePersistentInputHold() {
        guard !quitting else { return }
        if persistentInputHold == nil {
            let value=ScreenPersistentInputHold(store:store);persistentInputHold=value;value.arm()
        }
        guard let value=persistentInputHold else { return }
        if value.held { if !macHold.held { macHold.restoreHeld() };active?.hold.pause() }
        inputProtectionNotice=value.issue
    }
    private func persistInputHold() {
        persistentInputHold?.engage();inputProtectionNotice=persistentInputHold?.issue
    }

    /// A normal explicit UI action. No CG-event-origin heuristic is a prerequisite in device-trust mode;
    /// the final authority is a fresh OS-owned authentication sheet, never an application password field.
    @discardableResult public func confirmTrustedInputOwner() async -> Bool {
        guard !quitting,!handBackInProgress,!unifiedReceivingHeld,let broker=communityBroker else { return false }
        do {
            let original=active?.session.connection,epoch=epoch
            let consent=try await broker.trustedConsentForTurningOn()
            guard !quitting,self.epoch==epoch,active?.session.connection === original else { return false }
            return await confirmTrustedInputOwner(consent:consent,refreshConsent:{ try await broker.trustedConsentForTurningOn() })
        } catch { problem="기기 신뢰 권한을 새로 확인하지 못해 입력 보류를 유지합니다.";return false }
    }

    /// Internal typed seam shared by production and software lifecycle checks. No raw claims/Boolean consent.
    @discardableResult func confirmTrustedInputOwner(consent:CommunityDesktopReceiveTrust,refreshConsent:(@MainActor () async throws -> CommunityDesktopReceiveTrust)?=nil) async -> Bool {
        guard !quitting,!handBackInProgress,!unifiedReceivingHeld,consent.isCurrent(at:environment.now()) else { return false }
        preparePersistentInputHold()
        guard let value=persistentInputHold else { return false }
        if !value.armed { value.arm() }
        guard value.held,let record=value.record else { inputProtectionNotice=value.issue;return false }
        let original=active,holdGeneration=macHold.generation,powerEpoch=epoch
        handBackInProgress=true;defer { handBackInProgress=false }
        do {
            guard try await authenticate("이 Mac의 입력 보류를 해제할 계정 소유자를 확인합니다. 가능한 생체·Apple Watch 또는 macOS 암호를 OS 창에 직접 입력해 주세요.",policy:ScreenAuthentication.trustedHoldRecovery) else { return false }
            let fresh=try await refreshConsent?() ?? consent
            guard !quitting,consent.hasSamePolicy(as:fresh),fresh.isCurrent(at:environment.now()),!unifiedReceivingHeld,self.epoch==powerEpoch,
                  active?.session.connection === original?.session.connection,active?.hold === original?.hold,
                  macHold.generation==holdGeneration,value.record?.generation==record.generation else { return false }
            try value.clearAfterOwnerConfirmation(expectedGeneration:record.generation)
            // There is no await between CAS and the live state change. View-only sessions remain view-only.
            if let hold=active?.hold,hold.mode == .paused { _=macHold.resume(hold) } else { macHold.reset() }
            inputProtectionNotice=value.issue;return true
        } catch { inputProtectionNotice=value.issue;problem="계정 소유자 확인 또는 보류 저장을 완료하지 못했습니다. 입력 보류를 유지합니다.";return false }
    }

    private func startOwnerRecovery(_ broker:ScreenCommunityBroker) {
        ownerRecoveryTask=Task { [weak self] in
            let target:ScreenOwnerRecoveryTarget
            do {target=try await broker.ownerRecoveryTarget()}
            catch {self?.ownerDelegationNotice="위임 보호 상태를 읽지 못했습니다. 자동으로 초기화하거나 승인하지 않습니다.";return}
            while !Task.isCancelled {
                guard let self,!self.quitting else {return}
                if self.communityBroker != nil {
                    do {
                        let result=try await target.tick(snapshot:{ [weak self] in await self?.ownerRecoverySnapshot() },apply:{ [weak self] permit in
                            guard let self else {return false};return try await self.applyDelegatedInput(permit)
                        })
                        guard !self.quitting,!Task.isCancelled else {return}
                        self.ownerDelegationEnabled=result.enabled;self.ownerDelegationNotice=result.notice
                    } catch {self.ownerDelegationEnabled=nil;self.ownerDelegationNotice="위임 상태·원래 처리 결과 확인이 필요합니다. 입력 보류는 자동으로 해제하지 않습니다."}
                }
                try? await Task.sleep(for:.seconds(15))
            }
        }
        if let lockStates=environment.sessions.lockStates {
            ownerLockTask=Task { [weak self] in
                for await locked in lockStates() {
                    guard !Task.isCancelled,let self,!self.quitting else {return}
                    if locked {self.ownerLifecycleGeneration=UUID().uuidString.lowercased()}
                }
            }
        }
    }
    private func ownerRecoverySnapshot()->ScreenOwnerRecoveryTarget.Snapshot? {
        guard !quitting,isOn,!unifiedReceivingHeld,environment.sessions.isUnlocked(),let value=persistentInputHold,value.armed,value.held,let record=value.record else {return nil}
        if active != nil,unifiedAdmission==nil {return nil} // Legacy sessions retain their original local-owner path.
        return .init(instance:ownerLifecycleGeneration,holdGeneration:record.generation,connectionId:unifiedAdmission?.binding.channelId)
    }
    private func applyDelegatedInput(_ permit:ScreenDelegatedInputPermit)throws->Bool {
        let p=permit.publication
        return try permit.perform {
            guard let snapshot=ownerRecoverySnapshot(),snapshot.instance==p.instance,snapshot.holdGeneration==p.holdGeneration,snapshot.connectionId==p.connectionId,let value=persistentInputHold else {return false}
            do {try value.clearAfterDelegatedConfirmation(permit.proof,expectedGeneration:p.holdGeneration)}
            catch {inputProtectionNotice=value.issue;return false}
            if let hold=active?.hold,hold.mode == .paused {_=macHold.resume(hold)} else {macHold.reset()}
            ownerLifecycleGeneration=UUID().uuidString.lowercased();inputProtectionNotice=value.issue
            return true
        }
    }
    public func disableOwnerDelegation()async {
        ownerLifecycleGeneration=UUID().uuidString.lowercased()
        guard let broker=communityBroker else {ownerDelegationNotice="등록 서비스가 준비되지 않아 위임 해제 상태를 확인하지 못했습니다.";return}
        do {try await broker.ownerRecoveryTarget().disable();ownerDelegationEnabled=false;ownerDelegationNotice="이 Mac의 입력 보류 해제 위임을 껐습니다."}
        catch {ownerDelegationEnabled=nil;ownerDelegationNotice="이 실행에서는 위임 승인을 차단했습니다. 지속 저장·서버 해제 결과는 확인이 필요합니다."}
    }
    private func updateCommunityDesktops(_ own:CommunityAuthorization?,peers:[CommunityAuthorization]) {
        desktopListExpiry?.cancel();desktopSelections=[:];communityDesktops=[]
        guard let own,own.isCurrent(at:environment.now()),let authority=environment.communityDirectoryAuthority else {communityDesktopNotice="현재 기기 목록 준비 전 · 목록 불러오기로 Viewer를 열어 주세요.";return}
        for peer in peers where peer.isCurrent(at:environment.now()) && peer.body.deviceKind == .desktop && peer.body.deviceId != own.body.deviceId && peer.body.capabilities.contains(.receiveView) {
            let selection=try? CommunityDesktopScreenTrust.verified(authority:authority,controller:own,receiver:peer,now:environment.now())
            if let selection {desktopSelections[peer.body.enrollmentId]=selection}
            communityDesktops.append(.init(id:peer.body.enrollmentId,name:peer.body.name,deviceId:peer.body.deviceId,ready:selection != nil))
        }
        communityDesktopNotice=communityDesktops.isEmpty ? "현재 등록된 다른 Mac이 없습니다. 커뮤니티에서 한 번 등록·기능 승인하면 여기에 표시됩니다.":"현재 서명된 커뮤니티 기기 목록 · 기기 신뢰를 함께 승인한 Mac에 연결합니다."
        let until=min(own.body.expiresAt,peers.map{$0.body.expiresAt}.min() ?? own.body.expiresAt)
        desktopListExpiry=Task { [weak self] in
            try? await Task.sleep(for:.milliseconds(max(0,until-Int64(Date().timeIntervalSince1970*1000))))
            guard !Task.isCancelled,let self else {return};self.desktopSelections=[:];self.communityDesktops=[];self.communityDesktopNotice="기기 목록 확인이 만료됐습니다. 목록 불러오기로 갱신해 주세요."
        }
    }
    public func prepareCommunityDesktopList()async {
        do {try await environment.openViewer(false);communityDesktopNotice="Viewer에 현재 커뮤니티 목록 준비를 요청했습니다. 연결은 시작하지 않았습니다."}
        catch {communityDesktopNotice="정식 Viewer를 준비하지 못했습니다. 메인 앱의 ‘다른 Mac 화면 보기’를 확인해 주세요."}
    }
    public func openCommunityApprovals()async {
        if let broker=communityBroker {await broker.cancelViewerTargetHint()}
        do {try await environment.openViewer(true);communityDesktopNotice="Viewer의 ‘커뮤니티 기기 등록·승인…’에서 기능 선택·입력 보류 위임을 관리하세요."}
        catch {communityDesktopNotice="정식 Viewer를 열지 못했습니다. 메인 앱에서 Viewer 설치 상태를 확인해 주세요."}
    }
    public func openCommunityDesktop(_ id:String)async {
        guard let selection=desktopSelections[id],selection.isCurrent(),let broker=communityBroker else {communityDesktopNotice="현재 기기 신뢰·목록을 다시 확인해 주세요.";return}
        do {
            let nonce=try await broker.chooseViewerTarget(selection)
            do {try await environment.openViewer(true);communityDesktopNotice="선택한 Mac을 Viewer에서 여는 중입니다. 실제 연결 결과는 Viewer에서 확인합니다."}
            catch {await broker.cancelViewerTarget(nonce);throw error}
        } catch {communityDesktopNotice="선택한 Mac을 열지 못했습니다. 현재 권한과 정식 Viewer 상태를 확인해 주세요."}
    }

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
            refreshKeys()
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
            refreshKeys()
            if let current = session, current.deviceID == device.id, current.peerClass == .phone,
               let renamed = next.first(where: { $0.id == device.id }) {
                session = Session(deviceID: current.deviceID, deviceName: renamed.displayName, since: current.since,
                                  canControl: current.canControl, deviceModel: current.deviceModel)
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
            refreshKeys()
            if session?.deviceID == device.id { endSession(.revoked) }
        } catch {
            // Do not report an in-memory deletion as durable revocation. Stop listening as well so the
            // still-registered key cannot reconnect while the person resolves the Keychain error.
            turnOff(reason: "등록 해지를 저장하지 못해 화면 제어를 중지했습니다. 기기는 아직 등록되어 있습니다. 이 Mac을 잠금 해제한 뒤 다시 해지하세요.")
        }
    }

    // MARK: Mac controllers (DESIGN 5.2, 6.5, 6.6)

    /// 「다른 Mac 연결 허용」. Turning on asks for Touch ID or a paired Watch (never the password); turning off never asks,
    /// keeps the rows and ends a controller's session at once (`.endedAtMac`).
    public func setAllowMacControllers(_ on: Bool) async {
        guard on != macControllers.allowMacControllers || !on else { return }
        if on {
            do {
                guard try await authenticate("다른 Mac이 이 Mac 화면에 연결하도록 허용합니다", policy: ScreenAuthentication.raising),
                      !macControllers.allowMacControllers else { return }
            } catch {
                return problem = "다른 Mac 연결 허용을 켜지 못했습니다: \(Self.describe(error))"
            }
        }
        do {
            // Turning on here, behind the proof, is what reopens a switch held closed.
            try mutateControllers(reopening: on) { $0.allowMacControllers = on }
        } catch {
            guard !on else { return problem = "다른 Mac 연결 허용을 저장하지 못했습니다: \(Self.describe(error))" }
            var narrowed = macControllers
            narrowed.allowMacControllers = false
            failClosed(narrowed, "다른 Mac 연결 허용 끄기를 저장하지 못해 화면 제어를 중지했습니다. 이 Mac을 잠금 해제한 뒤 다시 꺼 주세요.")
        }
        peerKeys.community.setHeld(!on)
        if let communityBroker { try? await communityBroker.hold(!on) }
        if !on, session?.peerClass == .controller || activeCommunityPeer { endSession(.endedAtMac) }
    }

    /// A controller's grant. View → control asks for Touch ID or a paired Watch and only where this build offers control;
    /// control → view never asks. Either way its session ends at once (`.endedAtMac`): the next one starts with the new
    /// grant.
    public func setControllerGrant(_ id: String, to grant: ScreenControllerGrant) async {
        guard let row = controllers.first(where: { $0.id == id }), row.grant != grant else { return }
        if grant == .control {
            guard controlChoiceOffered else { return }
            do {
                guard try await authenticate("‘\(row.displayName)’이 이 Mac을 조작하도록 허용합니다", policy: ScreenAuthentication.raising),
                      controllers.contains(where: { $0.id == id && $0.grant != grant }) else { return }
            } catch {
                return problem = "권한을 바꾸지 못했습니다: \(Self.describe(error))"
            }
        }
        do {
            try mutateControllers { registry in
                if let index = registry.controllers.firstIndex(where: { $0.id == id }) { registry.controllers[index].grant = grant }
            }
        } catch {
            guard grant == .view else { return problem = "권한을 저장하지 못했습니다: \(Self.describe(error))" }
            var narrowed = macControllers
            if let index = narrowed.controllers.firstIndex(where: { $0.id == id }) { narrowed.controllers[index].grant = .view }
            failClosed(narrowed, "권한 변경을 저장하지 못해 화면 제어를 중지했습니다. 이 Mac을 잠금 해제한 뒤 다시 바꿔 주세요.")
        }
        record(.grantChanged, row, reason: grant.rawValue)
        if session?.deviceID == id { endSession(.endedAtMac) }
    }

    /// 「이 Mac에서 삭제」: never asks; its session ends at once (`.revoked`).
    public func removeController(_ id: String) {
        guard let row = controllers.first(where: { $0.id == id }) else { return }
        do {
            try mutateControllers { $0.controllers.removeAll { $0.id == id } }
        } catch {
            var narrowed = macControllers
            narrowed.controllers.removeAll { $0.id == id }
            failClosed(narrowed, "다른 Mac 삭제를 저장하지 못해 화면 제어를 중지했습니다. 그 Mac은 아직 등록되어 있습니다. 이 Mac을 잠금 해제한 뒤 다시 삭제하세요.")
        }
        record(.removed, row)
        if session?.deviceID == id { endSession(.revoked) }
    }

    /// Renames a controller at this Mac only. Nil when saved; otherwise what to tell the person.
    public func renameController(_ id: String, to text: String) -> String? {
        guard let row = controllers.first(where: { $0.id == id }) else { return nil }
        let alias: String?
        switch row.alias(from: text) {
        case .clear: alias = nil
        case .name(let typed): alias = typed
        case .invalid: return "이름은 32자 이내의 글자·숫자·기호로 입력하세요."
        }
        do {
            try mutateControllers { registry in
                if let index = registry.controllers.firstIndex(where: { $0.id == id }) { registry.controllers[index].alias = alias }
            }
            return nil
        } catch {
            return "이름을 저장하지 못했습니다. 이 Mac을 잠금 해제한 뒤 다시 시도하세요."
        }
    }

    /// A controller the person approved at this Mac (DESIGN 6.3, after its key's own signature checked out): the switch
    /// on and its row stored in one change, logged and told to the phones (kind 4). Throws, changing nothing, when it
    /// cannot be saved, the phones cannot be read or a phone holds the key (SR-22). The phones are read again from the
    /// store, never taken from memory, which stays empty when they could not be read at launch.
    ///
    /// Not public: it asks for nothing itself. Only the enrollment window in this module calls it, after the hardware
    /// click and Touch ID or the Watch at this Mac (SR-20, SR-29).
    func enrollController(_ controller: RegisteredController, replacing replacedID: String? = nil) throws {
        let next = try store.controllers().enrolling(controller, replacing: replacedID, phones: try store.devices())
        try store.saveControllers(next)
        macControllers = next
        controllersHeldClosed = false  // the person's approval here turned the switch on
        refreshKeys()
        announceEnrolled(controller)
    }

    /// The 「다른 Mac 추가」 window ended (`ScreenControllerPairing.onEvent`; the app wires it). That window saves an approved
    /// row itself, so the registry is read again here: the new row can connect at once, a row it replaced no longer can,
    /// and the menu lists it. Then it is logged and told to the phones (kind 4), as `enrollController` does.
    ///
    /// A registry that cannot be read again closes 「다른 Mac 연결 허용」 until the person turns it on again at this Mac:
    /// saved off (every later change saves it off too, `controllersHeldClosed`), and when even that cannot be saved, held
    /// closed in memory and screen control stops (`failClosed`), as any narrowing that cannot be saved does, so nothing
    /// listens or turns on by itself while the store still says on. A refusal stored nothing: it is only logged (SR-30).
    public func controllerPairingEnded(_ event: ScreenControllerPairingEvent) {
        switch event {
        case .refused(let name, let reason, let controllerID):
            // An empty ID: the key was never learned (a Viewer that could not prove itself).
            record(.refused, id: controllerID ?? "", name: name, reason: reason.rawValue)
        case .enrolled(let controller):
            do {
                macControllers = try store.controllers()
                controllersHeldClosed = false  // the person's approval in the window turned the switch on
                refreshKeys()
            } catch {
                controllersHeldClosed = true
                if session?.peerClass == .controller { endSession(.endedAtMac) }
                do {
                    try mutateControllers { _ in }
                    problem = "추가한 Mac을 목록에 바로 읽지 못해 다른 Mac 연결 허용을 껐습니다. 「다른 Mac 연결 허용」을 다시 켜 주세요."
                } catch {
                    var closed = macControllers
                    closed.allowMacControllers = false
                    failClosed(closed, "추가한 Mac을 목록에 다시 읽지 못해 화면 제어를 중지했습니다. 이 Mac을 잠금 해제한 뒤 화면 제어와 「다른 Mac 연결 허용」을 다시 켜 주세요.")
                }
            }
            announceEnrolled(controller)
        }
    }

    /// A controller approved at this Mac and stored: logged and told to the phones (kind 4).
    private func announceEnrolled(_ controller: RegisteredController) {
        record(.paired, controller, reason: controller.grant.rawValue)
        if push != nil, let identity = identity ?? (try? environment.identity(store)) {
            self.identity = identity
            push?.adopt(identity: identity)
        }
        push?.notify(.controllerRegistered, controller: controller, among: devices) // push hook: kind 4
    }

    /// The controller of the session asked to be removed (`unenrollSelf`); the pump already ended the session `.revoked`.
    private func controllerUnenrolledItself(_ id: String) {
        guard let row = controllers.first(where: { $0.id == id }) else { return }
        do {
            try mutateControllers { $0.controllers.removeAll { $0.id == id } }
        } catch {
            var narrowed = macControllers
            narrowed.controllers.removeAll { $0.id == id }
            failClosed(narrowed, "다른 Mac의 등록 해제를 저장하지 못해 화면 제어를 중지했습니다. 이 Mac을 잠금 해제한 뒤 그 Mac을 삭제하세요.")
        }
        record(.unenrolled, row)
        if session?.deviceID == id { endSession(.revoked) }
    }

    /// A completed connection is a use: it starts the 90 days over (SR-13).
    private func touchController(_ id: String) {
        let now = environment.now()
        do {
            try mutateControllers { registry in
                if let index = registry.controllers.firstIndex(where: { $0.id == id }) { registry.controllers[index].lastConnectedAt = now }
            }
        } catch { problem = "다른 Mac의 사용 시각을 저장하지 못했습니다. 기존 등록은 유지했습니다." }
    }

    /// Reads the controllers item again, changes it and saves it; memory follows only a save that went through. While the
    /// switch is held closed, the save says off unless the person is turning it on (`reopening`); once saved, the store
    /// says what memory does and nothing more needs holding.
    private func mutateControllers(reopening: Bool = false, _ update: (inout ScreenControllers) -> Void) throws {
        var next = try store.controllers()
        update(&next)
        if controllersHeldClosed, !reopening { next.allowMacControllers = false }
        try store.saveControllers(next)
        macControllers = next
        controllersHeldClosed = false
        refreshKeys()
    }

    /// A narrowing that could not be saved holds in memory, and screen control stops, as a phone's 해지 does, so nothing
    /// listens while the stored registry still says otherwise. Stopping lets keeping on go first (SR-27).
    private func failClosed(_ narrowed: ScreenControllers, _ reason: String) {
        macControllers = narrowed
        refreshKeys()
        turnOff(reason: reason)
    }

    private func record(_ event: ControllerLogEntry.Event, _ controller: RegisteredController, reason: String? = nil,
                        route: ControllerLogEntry.Route? = nil) {
        record(event, id: controller.id, name: controller.displayName, reason: reason, route: route)
    }

    /// Best effort: an entry that cannot be saved stays in memory, and nothing waits on it (SR-30).
    private func record(_ event: ControllerLogEntry.Event, id: String, name: String, reason: String? = nil,
                        route: ControllerLogEntry.Route? = nil) {
        controllerHistoryUnsaved = !logBook.record(event, id: id, name: name, reason: reason, route: route)
        controllerHistory = logBook.log.entries
        controllerHistoryUnread = logBook.unread
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
            guard try await authenticate("‘\(name)’을 화면 제어 기기로 등록합니다", policy: ScreenAuthentication.turningOn) else { return }
            guard self.pending === pending, case .confirming = registration else { return }
            // A key a Mac controller row holds is never a phone too (SR-22): read again, and refused when unreadable.
            guard !(try store.controllers()).holds(pending.acceptance.record.deviceID) else {
                // Closing refuses the waiting request too.
                return finishRegistration("이 기기의 키는 이미 다른 Mac으로 등록되어 있어 등록하지 않았습니다.")
            }
            let registered = RegisteredDevice(record: pending.acceptance.record, attestationKeyID: pending.acceptance.attestation.keyID)
            // The same key approved again renews its registration (SR-13) instead of adding a second row.
            let next = try persistRegistrationMutation(read: { try store.devices() }, write: { try store.save($0) }) { rows in
                var renewed = registered
                renewed.alias = rows.first { $0.id == registered.id }?.alias   // the person's name for it outlives renewal
                rows.removeAll { $0.id == registered.id }
                rows.append(renewed)
            }
            devices = next
            refreshKeys()
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
            guard try await authenticate("등록한 기기가 자체 중계 서버로 이 Mac의 화면에 연결하도록 허용합니다", policy: ScreenAuthentication.turningOn) else { return }
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
                    // Phones only: a Mac controller never comes through the self-hosted relay (SR-33).
                    let incoming = try await ScreenTransportHandshake.accept(over: opened, peer: PeerKey(relayEndpoint: route.endpoint), handshake: handshake,
                                                                             gate: gate, accepting: ScreenListenerClasses.relay)
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

    private func startInternetRegistration(route: ScreenRelayRoute, window: RegistrationWindow, identity: any TranscriptSigner, code: RegistrationCode) {
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

    /// The person's proof at this Mac (`ScreenAuthentication`): the phone path's turning on keeps Touch ID or the login
    /// password; raising what another Mac may do takes Touch ID or a paired Watch only. False when the person cancels.
    func authenticate(_ reason: String, policy: LAPolicy) async throws -> Bool {
        try await environment.authenticate(reason, policy)
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
                                              port: NWEndpoint.Port(rawValue: screenPort)!, accepting: ScreenListenerClasses.screenPort)
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
        case .takenOver: "등록한 폰이 연결해 Mac 컨트롤러 연결을 끝냈습니다."
        case .busy: "다른 연결이 이 Mac을 보고 있어 받지 않았습니다."
        case .captureUnavailable: "화면 기록 허용이 없어 연결을 끝냈습니다."
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
