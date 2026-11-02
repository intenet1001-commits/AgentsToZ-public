#if os(macOS)
import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import os
import ScreenControlCore

// The screen host's rules for who may hold this Mac's screen and what a session may do (docs/design/mac-to-mac-2026-11-01
// 6.4, 6.5, 9절): the two key sets, which listener serves which kind of peer, the arbitration of one session at a time,
// the release gate, the plan a session starts with, and input to a locked Mac (D-3). Pure, or behind a lock, so checks
// run them without a listener, a screen or a keychain; ScreenService wires them to the system.

/// What this build may open, as `scripts/build-screen-app.ts` writes it into Info.plist (DESIGN 9절 「빌드」). Every flag is
/// off unless the build says otherwise, so a build that never heard of them opens nothing new.
public struct ScreenBuildFlags: Sendable, Equatable {
    /// S-M3 calibration passed: a Mac controller may be granted control at all. Off, the 「조작」 choice is hidden and a
    /// controller granted control watches (D-10 is still the person's to decide).
    public var macControl: Bool
    /// The Apple change report for keeping Screen on was sent (D-2): 「이 네트워크에서 켜 두기」 may be offered.
    public var keepOn: Bool
    /// S0-2 passed: a Mac controller granted control may type into this Mac while it is locked (D-3).
    public var lockedInput: Bool

    public init(macControl: Bool = false, keepOn: Bool = false, lockedInput: Bool = false) {
        self.macControl = macControl
        self.keepOn = keepOn
        self.lockedInput = lockedInput
    }

    static let macControlKey = "AgentsToZScreenMacControl"
    static let keepOnKey = "AgentsToZScreenKeepOn"
    static let lockedInputKey = "AgentsToZScreenLockedInput"

    /// Exactly a boolean true under each key; anything else is off. 「조작」 also needs the S-M3 rule this build ships
    /// (`ScreenInputCalibration.current`): the one place the two meet, so Screen reads S-M3 from `macControl` alone (its
    /// list, the pairing window, the session plan) and a key set without a passed calibration opens nothing.
    public static func fromBundle(_ bundle: Bundle = .main) -> ScreenBuildFlags {
        func on(_ key: String) -> Bool { (bundle.object(forInfoDictionaryKey: key) as? Bool) == true }
        return ScreenBuildFlags(macControl: on(macControlKey) && ScreenInputCalibration.current.allowsControl, keepOn: on(keepOnKey),
                                lockedInput: on(lockedInputKey))
    }
}

/// The release gate (DESIGN 9절): decided at this Mac, at run time, from the build and whether notifications and remote
/// stop are reaching the person's phones (`pushLive`).
public enum ReleaseGate {
    /// Whether a controller may open a session at all: one bound to the genuine Viewer's own key always may; any other
    /// (a direct enrollment without the Viewer's attestation, a phone-brokered one) only once the push gate is open, so
    /// the owner hears each connection and can stop it from the phone. Refused at the key lookup, as `notAccepted`.
    public static func admitsController(bindsGenuineViewer: Bool, pushLive: Bool) -> Bool {
        bindsGenuineViewer || pushLive
    }

    /// Whether a controller granted control may control now: the build's calibration and the push gate. Otherwise the
    /// session starts view-only and the Viewer hears why from `viewOnly`.
    public static func controlOpen(flags: ScreenBuildFlags, pushLive: Bool) -> Bool { flags.macControl && pushLive }

    /// Whether the person at this Mac is offered 「이 네트워크에서 켜 두기」 (SR-27). Hidden otherwise.
    public static func keepOnOffered(flags: ScreenBuildFlags, pushLive: Bool) -> Bool { flags.keepOn && pushLive }

    /// Whether a controller session that may control (so the control gate is open) may also type into a locked Mac (D-3).
    public static func lockedInputOpen(canControl: Bool, flags: ScreenBuildFlags) -> Bool { canControl && flags.lockedInput }
}

/// What this Mac does with a session that completed its key exchange while another may hold the screen (DESIGN 6.5,
/// M-4): one session at a time, the person's registered phone before a Mac controller.
public enum SessionArbitration: Equatable, Sendable {
    /// Nobody holds the screen.
    case accept
    /// The same device again: its old session ends `.replaced` (a controller hears it so too) and the new one starts.
    case replace
    /// A registered phone while a Mac controller watches: the controller's session ends `.takenOver` (an older peer hears
    /// `.replaced`) and the phone's starts.
    case takeOver
    /// Another phone while a phone watches: closed without a word, as before Mac controllers.
    case refuseQuietly
    /// A Mac controller while anyone else holds the screen: told `.busy` after the key exchange, then closed.
    case refuseBusy
}

public enum SessionArbiter {
    public struct Holder: Equatable, Sendable {
        public let peerClass: ScreenPeerClass
        public let deviceID: Data
        public init(_ peerClass: ScreenPeerClass, _ deviceID: Data) {
            self.peerClass = peerClass
            self.deviceID = deviceID
        }
    }

    public static func decide(current: Holder?, incoming: Holder) -> SessionArbitration {
        guard let current else { return .accept }
        if current == incoming { return .replace }
        switch (current.peerClass, incoming.peerClass) {
        case (.phone, .phone): return .refuseQuietly
        case (.controller, .phone): return .takeOver
        case (_, .controller): return .refuseBusy
        }
    }
}

/// Which peers each listener serves (SR-33): the screen port serves phones and Mac controllers, the self-hosted relay
/// phones only (a controller never comes through it), and the enrollment window enrolment only (its own listener).
public enum ScreenListenerClasses {
    public static let screenPort: Set<ScreenPeerClass> = [.phone, .controller]
    public static let relay: Set<ScreenPeerClass> = [.phone]
}

/// The two registries as the key exchange sees them (SR-22, DESIGN 6.4 5-2): phones first, then Mac controllers while the
/// switch is on, each unexpired. A key both registries hold answers from neither: only a store written some other way
/// holds one, and answering for it would let a controller open a phone session with every right. A controller the release
/// gate does not admit yet is unknown here, so a version-5 Viewer hears `notAccepted` and nothing else (7.7).
public final class ScreenPeerKeys: Sendable {
    private struct State {
        var bound: Set<Data> = []
        var excluded: Set<Data> = []
        /// When each phone of the set was last used, for whether one is still in use.
        var phoneUse: [(registeredAt: Date, lastConnectedAt: Date?)] = []
    }

    /// The phones' keys: also what remote stop trusts (ScreenPush), and never a controller's.
    public let community = ScreenCommunityLeaseCache()
    public let phones: RegisteredDeviceKeys
    private let controllers: RegisteredDeviceKeys
    private let state = OSAllocatedUnfairLock(initialState: State())
    private let pushLive: @Sendable () -> Bool
    private let now: @Sendable () -> Date

    /// `pushLive` says whether the remote-stop rounds reach the relay (`PushLiveness`); the gate also needs a phone in use.
    public init(phones: RegisteredDeviceKeys = RegisteredDeviceKeys(), controllers: RegisteredDeviceKeys = RegisteredDeviceKeys(),
                pushLive: @escaping @Sendable () -> Bool, now: @escaping @Sendable () -> Date = { Date() }) {
        self.phones = phones
        self.controllers = controllers
        self.pushLive = pushLive
        self.now = now
    }

    /// Replaces both sets at once.
    public func set(phones devices: [RegisteredDevice], controllers registry: ScreenControllers) {
        let excluded = registry.doublyRegistered(with: devices)
        // Remote stop reads the phones' set directly, so a doubly held key leaves it too.
        let trusted = devices.filter { device in
            let keyID = (try? P256.Signing.PublicKey(x963Representation: device.publicKey)).map(ScreenControlIdentity.fingerprint(of:))
            return !excluded.contains { RegisteredController.hex($0) == device.id || $0 == keyID }
        }
        state.withLock {
            $0.excluded = excluded
            $0.bound = Set(registry.controllers.filter(\.bindsGenuineViewer).compactMap { Self.fingerprint(of: $0) })
            $0.phoneUse = trusted.map { ($0.registeredAt, $0.lastConnectedAt) }
        }
        phones.set(trusted)
        controllers.set(registry.keyEntries.filter { !excluded.contains($0.id) })
    }

    /// The push gate (DESIGN 9절): the remote-stop rounds reach the relay, and some phone is still in use to hear each
    /// connection and to stop it from afar. A Mac nobody's phone watches never opens it, however well the relay answers.
    public var pushGateOpen: Bool {
        let date = now()
        let phoneInUse = state.withLock { state in
            state.phoneUse.contains { !RegistrationLifetime.isExpired(registeredAt: $0.registeredAt, lastConnectedAt: $0.lastConnectedAt, at: date) }
        }
        return phoneInUse && pushLive()
    }

    /// The registered key with this ID and the registry it is in; nil for anything the key exchange must refuse.
    public func peer(for id: Data) -> RegisteredPeerKey? {
        let (excluded, bound) = state.withLock { ($0.excluded.contains(id), $0.bound.contains(id)) }
        guard !excluded else { return nil }
        if let key = phones.key(for: id) { return RegisteredPeerKey(key: key, peerClass: .phone) }
        if let key = controllers.key(for: id), ReleaseGate.admitsController(bindsGenuineViewer: bound, pushLive: pushGateOpen) {
            return RegisteredPeerKey(key: key, peerClass: .controller)
        }
        // An issuer-signed community membership is its own admission source, never a fake SAS/App Attest row.
        // It still needs the existing owner-phone notifications/remote-stop gate.
        guard let peer = community.peer(for: id, at: now()), ReleaseGate.admitsController(bindsGenuineViewer: false, pushLive: pushGateOpen) else { return nil }
        return RegisteredPeerKey(key: peer.key, peerClass: peer.member.platform == "ios" ? .phone : .controller)
    }

    static func fingerprint(of controller: RegisteredController) -> Data? {
        (try? P256.Signing.PublicKey(x963Representation: controller.publicKey)).map(ScreenControlIdentity.fingerprint(of:))
    }
}

/// Why a Mac controller granted control only watches (DESIGN 6.5 「권한」, 9절, 12절): the menu says it, and a version-5
/// Viewer hears it as the session's first input availability, so neither blames the push gate for what the build or the
/// input protection decided. Most lasting first: a build that never opens control, then the push gate, then this Mac's
/// permissions.
public enum ControllerViewOnlyCause: Equatable, Sendable {
    /// This build has not passed the S-M3 calibration: control is not opened to another Mac at all (D-10).
    case build
    /// Notifications and remote stop are not confirmed to reach the owner's phones yet (the push gate, `pushLive`).
    case notifications
    /// The person's own input protection could not start here (Accessibility or Input Monitoring, SR-7).
    case inputProtection

    /// What the Viewer hears.
    public var availability: ScreenInputAvailability {
        switch self {
        case .build: .controlNotInThisBuild
        case .notifications: .notificationsUnconfirmed
        case .inputProtection: .permissionsRequired
        }
    }

    /// The cause for `grant`, or nil when the grant is view (the grant says it) or the session may control.
    public static func of(grant: ScreenControllerGrant, inputMonitorAvailable: Bool, pushLive: Bool,
                          flags: ScreenBuildFlags) -> ControllerViewOnlyCause? {
        guard grant == .control else { return nil }
        if !flags.macControl { return .build }
        if !pushLive { return .notifications }
        if !inputMonitorAvailable { return .inputProtection }
        return nil
    }
}

/// Everything a session is decided with before it starts (DESIGN 6.5 「권한」, 「한도」).
public struct HostSessionPlan: Sendable, Equatable {
    public let peerClass: ScreenPeerClass
    /// Input reaches this Mac: the person's own input can take it back, and for a controller its grant is control and
    /// the control gate is open.
    public let canControl: Bool
    public let limits: SessionLimits
    /// What a controller's registration grants, told to it at the start; nil for a phone, which hears no grant.
    public let grant: ScreenSessionGrant?
    /// Why a controller granted control only watches; nil for a phone, a view grant and a session that may control.
    public let viewOnlyCause: ControllerViewOnlyCause?
    /// A controller that may control may also type while this Mac is locked (D-3). Phones keep what they always did.
    public let lockedInputOpen: Bool

    /// A registered phone: as before Mac controllers.
    public static func phone(inputMonitorAvailable: Bool, controlGranted: Bool = true) -> HostSessionPlan {
        HostSessionPlan(peerClass: .phone, canControl: inputMonitorAvailable && controlGranted, limits: .standard, grant: nil,
                        viewOnlyCause: nil, lockedInputOpen: true)
    }

    /// A Mac controller with `grant`, the person's own input protection, the push gate and the build.
    public static func controller(grant: ScreenControllerGrant, inputMonitorAvailable: Bool, pushLive: Bool,
                                  flags: ScreenBuildFlags) -> HostSessionPlan {
        let open = ReleaseGate.controlOpen(flags: flags, pushLive: pushLive)
        let effective: ScreenControllerGrant = grant == .control && open ? .control : .view
        let canControl = ScreenControllerPolicy.canControl(inputMonitorAvailable: inputMonitorAvailable, grant: effective)
        return HostSessionPlan(peerClass: .controller, canControl: canControl,
                               limits: ScreenControllerPolicy.sessionLimits(canControl: canControl),
                               grant: grant == .control ? .control : .view,
                               viewOnlyCause: ControllerViewOnlyCause.of(grant: grant, inputMonitorAvailable: inputMonitorAvailable,
                                                                         pushLive: pushLive, flags: flags),
                               lockedInputOpen: ReleaseGate.lockedInputOpen(canControl: canControl, flags: flags))
    }
}

/// A Mac controller's input to this Mac while it is locked (D-3): only when the plan opens it. A state the system cannot
/// tell (no console session: the login window, FileVault before unlock) counts as locked, and those are out of reach
/// whatever the plan says (DESIGN 4절 비목표).
public enum ControllerLockedInput {
    public static func admits(locked: Bool?, lockedInputOpen: Bool) -> Bool {
        switch locked {
        case false?: true
        case true?: lockedInputOpen
        case nil: false
        }
    }

    /// One input event of a Mac controller's: letting go (a key or button up) always reaches this Mac, so nothing stays
    /// pressed when it locks in the middle of a press; anything else as `admits(locked:lockedInputOpen:)` says.
    public static func admits(_ event: InputEvent, locked: Bool?, lockedInputOpen: Bool) -> Bool {
        switch event {
        case .button(_, isDown: false), .key(_, isDown: false, _): true
        default: admits(locked: locked, lockedInputOpen: lockedInputOpen)
        }
    }
}

/// One session's input on its way to this Mac's injector, as the app's streamer wires it (`ScreenSessionSystem.live`):
/// a Mac controller's input reaches a locked Mac only as the plan opens it (D-3, `ControllerLockedInput`), and every input
/// that reached this Mac is marked for the sidecar (DESIGN 6.7). A phone's input goes as it always did. The injector is
/// passed in, so checks run the same path with one that only records.
struct HostInputPath: Sendable {
    let controller: Bool
    let lockedInputOpen: Bool
    /// Whether this Mac is locked now; nil when the system cannot tell.
    let locked: @Sendable () -> Bool?
    let marker: RemoteInputMarker

    init(plan: HostSessionPlan, marker: RemoteInputMarker, locked: @escaping @Sendable () -> Bool?) {
        controller = plan.peerClass == .controller
        lockedInputOpen = plan.lockedInputOpen
        self.locked = locked
        self.marker = marker
    }

    /// One event: posted and marked, unless a controller's would reach a locked Mac the plan keeps closed.
    func inject(_ event: InputEvent, post: (InputEvent) -> Void) {
        guard !controller || ControllerLockedInput.admits(event, locked: locked(), lockedInputOpen: lockedInputOpen) else { return }
        post(event)
        marker.note()
    }

    /// Text and Return: typed and marked when it was posted, `blocked` for a controller the plan keeps off a locked Mac.
    func type(_ text: String, physicalInput: PhysicalInputProbe,
              post: @escaping (String, PhysicalInputProbe) -> ScreenTextReturnResult) -> ScreenTextReturnResult {
        guard !controller || ControllerLockedInput.admits(locked: locked(), lockedInputOpen: lockedInputOpen) else { return .blocked }
        let result = post(text, physicalInput)
        if result == .posted { marker.note() }
        return result
    }

    /// The session's receiver: `inject` and `type` behind the path, `release` (letting go at the end) always.
    func receiver(physicalInput: @escaping PhysicalInputProbe, inject: @escaping @Sendable (InputEvent) -> Void,
                  release: @escaping @Sendable (InputEvent) -> Void,
                  type: @escaping @Sendable (String, PhysicalInputProbe) -> ScreenTextReturnResult) -> InputReceiver {
        InputReceiver(physicalInput: physicalInput, release: release,
                      compound: { text, probe in self.type(text, physicalInput: probe, post: type) },
                      inject: { event in self.inject(event, post: inject) })
    }
}

/// The private IPv4 addresses this Mac answers on, told once to a controller as `addressHint` (DESIGN 8절): RFC 1918
/// only (`ScreenPrivateNetworkRoute`), never loopback, link-local, a VPN's carrier-grade range or a public address; each
/// once, in the order the system lists them, at most `ControlMessage.maxAddressHints`.
public enum ScreenAddressHints {
    public static func routes(from addresses: [String]) -> [ScreenPrivateNetworkRoute] {
        var routes: [ScreenPrivateNetworkRoute] = []
        for address in addresses where routes.count < ControlMessage.maxAddressHints {
            guard let route = try? ScreenPrivateNetworkRoute(address: address), !routes.contains(route) else { continue }
            routes.append(route)
        }
        return routes
    }

    /// The IPv4 addresses of this Mac's Wi‑Fi and Ethernet interfaces that are up (`en*`; never `utun`, `awdl`, `lo`).
    public static func interfaceAddresses() -> [String] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var addresses: [String] = []
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let entry = pointer.pointee
            guard let address = entry.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  (entry.ifa_flags & UInt32(IFF_UP)) != 0, (entry.ifa_flags & UInt32(IFF_LOOPBACK)) == 0,
                  String(cString: entry.ifa_name).hasPrefix("en") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
            else { continue }
            let length = host.firstIndex(of: 0) ?? host.count
            addresses.append(String(decoding: host[..<length].map { UInt8(bitPattern: $0) }, as: UTF8.self))
        }
        return addresses
    }
}

/// How the person at this Mac proves themselves (DESIGN 5.2 「권한을 늘리는 인증」, SR-19, F7). Raising what another Mac
/// may do (the switch on, view → control, keeping Screen on) takes Touch ID or a paired Apple Watch and never the
/// password, which a remote-desktop visitor could type; the phone path's turning on keeps the password fallback.
public enum ScreenAuthentication {
    public static let raising: LAPolicy = .deviceOwnerAuthenticationWithBiometricsOrWatch
    public static let turningOn: LAPolicy = .deviceOwnerAuthentication
}
#endif
