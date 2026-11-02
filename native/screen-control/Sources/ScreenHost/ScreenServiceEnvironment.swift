#if os(macOS)
import CoreGraphics
import Foundation
import LocalAuthentication
import Network
import ScreenControlCore

/// The parts of one session that reach the system: the person's own input protection, the injector, the capture and the
/// lock state. The app's are real (`live`); checks pass fakes, so nothing captures the screen, posts an event or asks
/// for a permission.
struct ScreenSessionSystem {
    /// Starts the person's own input protection for one session; nil when it cannot run (no permission, the tap did not
    /// start). Without it nothing is injected (SR-7).
    var inputMonitor: @MainActor () -> PhysicalInputProbe?
    /// The streamer for one session. `physicalInput` is nil for a session that only watches; every input that reaches
    /// this Mac is noted on `marker` (DESIGN 6.7).
    var streamer: @MainActor (_ incoming: MacSession, _ plan: HostSessionPlan, _ physicalInput: PhysicalInputProbe?,
                              _ marker: RemoteInputMarker) -> HostStreamer
    var lockStates: (@Sendable () -> AsyncStream<Bool>)?

    static var live: ScreenSessionSystem {
        ScreenSessionSystem(
            inputMonitor: {
                guard InputInjector.isAllowed, let monitor = LocalInputMonitor(), monitor.isRunning else { return nil }
                return { monitor.snapshot() }
            },
            streamer: { incoming, plan, physicalInput, marker in
                // The main display first; a version-2 phone may choose another, and input follows it (HostCapture).
                let injector = InputInjector(displayID: CGMainDisplayID())
                // A Mac controller reaches a locked Mac only when the plan opens it (D-3); every input is marked (6.7).
                let path = HostInputPath(plan: plan, marker: marker, locked: { ScreenLock.isLocked })
                let input = physicalInput.map { probe in
                    path.receiver(physicalInput: probe, inject: { injector.inject($0) }, release: { injector.releaseHeld($0) },
                                  type: { injector.injectTextAndReturn($0, physicalInput: $1) })
                }
                let desktop = MarkedDesktopControls(DesktopController(input: input, injector: injector), marker: marker)
                return HostStreamer(connection: incoming.connection, input: input, onDisplay: { input?.releaseHeld(); injector.setDisplay($0.id) },
                                    limits: plan.limits, desktop: desktop, pointerPosition: { injector.currentPointerPosition() })
            },
            lockStates: ScreenLock.states)
    }
}

/// The screen port's listener as the service uses it: `ScreenListener` in the app, a plain stream in checks.
protocol ScreenSessionSource: AnyObject, Sendable {
    var sessions: AsyncStream<MacSession> { get }
    func stop()
}

extension ScreenListener: ScreenSessionSource {}

/// What `ScreenService` reaches outside itself. The app uses `system()`; checks pass memory, temporary folders and fakes,
/// so they never read the keychain, write the main app's status file, open port 52741, capture the screen or post an
/// event.
struct ScreenServiceEnvironment {
    var store: ScreenStore
    /// Writes the status file the main app reads (ScreenStatusFile) and reads the system's settings for it.
    var publishesStatus: Bool
    /// Turns off on the app's termination (SR-16).
    var observesTermination: Bool
    /// Turns screen control on by itself at launch when it was kept on (SR-27).
    var resumesKeptOn: Bool
    /// Follows the network while kept on by itself.
    var watchesKeptOnNetwork: Bool
    var flags: ScreenBuildFlags
    var liveness: PushLiveness
    var push: @MainActor (PushLiveness) -> ScreenPush?
    var identity: @MainActor (ScreenStore) throws -> any TranscriptSigner
    /// The person's proof at this Mac with `policy`; false when they cancel.
    var authenticate: @MainActor (_ reason: String, _ policy: LAPolicy) async throws -> Bool
    var sessions: ScreenSessionSystem
    /// The screen port's nearby listener, started.
    var openNearby: @MainActor (_ handshake: MacHandshake, _ gate: PreAuthGate, _ serviceName: String) async throws -> any ScreenSessionSource
    /// The network this Mac is on now, when it can be told apart.
    var currentNetwork: @Sendable () async -> (identity: NetworkIdentity, label: String)?
    /// This Mac's addresses, for a controller's `addressHint`.
    var addresses: @Sendable () -> [String]
    var remoteInputURL: URL
    var powerHoldURL: URL
    var now: @Sendable () -> Date

    @MainActor
    static func system() -> ScreenServiceEnvironment {
        ScreenServiceEnvironment(
            store: ScreenStore(), publishesStatus: true, observesTermination: true, resumesKeptOn: true, watchesKeptOnNetwork: true,
            flags: .fromBundle(), liveness: PushLiveness(),
            push: { ScreenPush.fromBundle(liveness: $0) },
            identity: { try $0.identity() },
            authenticate: { reason, policy in
                do {
                    return try await LAContext().evaluatePolicy(policy, localizedReason: reason)
                } catch let error as LAError where [.userCancel, .appCancel, .systemCancel].contains(error.code) {
                    return false
                }
            },
            sessions: .live,
            openNearby: { handshake, gate, serviceName in
                let listener = try ScreenListener(handshake: handshake, gate: gate, port: NWEndpoint.Port(rawValue: ScreenService.screenPort)!,
                                                  nearbyServiceName: serviceName, accepting: ScreenListenerClasses.screenPort,
                                                  nearbyTXT: ScreenNearbyAdvert.txt)
                do {
                    _ = try await listener.start()
                } catch {
                    listener.stop()
                    throw error
                }
                return listener
            },
            currentNetwork: {
                let reading = await ScreenService.readNetwork()
                return reading.network
            },
            addresses: { ScreenAddressHints.interfaceAddresses() },
            remoteInputURL: RemoteInputMarker.url, powerHoldURL: PowerHold.url, now: { Date() })
    }
}

/// What the screen port's nearby advertisement says before any authentication (DESIGN 7.7): the newest session version
/// this Screen speaks, so a Viewer can tell an older Screen apart. Phones ignore it.
public enum ScreenNearbyAdvert {
    public static let txt = ["pv": String(ScreenControlProtocol.version)]
}
#endif
