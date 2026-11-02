#if os(macOS)
import CryptoKit
import Foundation
import LocalAuthentication
import os
@testable import ScreenControlCore
@testable import ScreenHost
import XCTest

// Mac controllers at the screen host (docs/design/mac-to-mac-2026-11-01 6.4-6.6, 9절, SR-21·SR-33·SR-37): the
// arbitration table, the release gate, what a view grant may do, the listener classes, and narrowing at this Mac. Every
// session here is a real key exchange over an in-memory frame pipe into the service's own `accept`, with a capture that
// shows nothing and an injector that only records: nothing captures the screen, posts an event, opens a port, reads the
// keychain or asks for a permission.

// MARK: - Rig shared by the host checks

/// Store items in memory. An account in `failing` refuses writes, one in `failingReads` reads, as a locked keychain would.
final class HostTestItems: ScreenStoreItems, Sendable {
    let items = OSAllocatedUnfairLock(initialState: [String: Data]())
    let failing = OSAllocatedUnfairLock(initialState: Set<String>())
    let failingReads = OSAllocatedUnfairLock(initialState: Set<String>())
    func read(_ account: String) throws -> Data? {
        if failingReads.withLock({ $0.contains(account) }) { throw ScreenStoreError.keychain(errSecInteractionNotAllowed) }
        return items.withLock { $0[account] }
    }
    func write(_ account: String, _ data: Data) throws {
        if failing.withLock({ $0.contains(account) }) { throw ScreenStoreError.keychain(errSecInteractionNotAllowed) }
        items.withLock { $0[account] = data }
    }
    func fail(_ accounts: Set<String>) { failing.withLock { $0 = accounts } }
    func failReads(_ accounts: Set<String>) { failingReads.withLock { $0 = accounts } }
}

struct HostTestSigner: TranscriptSigner, @unchecked Sendable {
    let key = P256.Signing.PrivateKey()
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    var fingerprint: Data { ScreenControlIdentity.fingerprint(of: publicKey) }
    var id: String { RegisteredController.hex(fingerprint) }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for: data) }
}

/// Two ends of an in-memory frame stream.
final class HostPipeEnd: ScreenFrameTransport, Sendable {
    private let inbox: AsyncStream<Data>
    private let inboxSink: AsyncStream<Data>.Continuation
    private let outbox: AsyncStream<Data>.Continuation

    init(inbox: AsyncStream<Data>, inboxSink: AsyncStream<Data>.Continuation, outbox: AsyncStream<Data>.Continuation) {
        self.inbox = inbox; self.inboxSink = inboxSink; self.outbox = outbox
    }

    func setMaxFrame(_ value: Int) {}
    func send(_ payload: Data) async throws { outbox.yield(payload) }
    func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void) {
        outbox.yield(payload)
        completion(nil)
    }
    func receive() async throws -> Data {
        var iterator = inbox.makeAsyncIterator()
        guard let data = await iterator.next() else { throw TransportError.closed }
        return data
    }
    func cancel() { inboxSink.finish(); outbox.finish() }

    static func pair() -> (HostPipeEnd, HostPipeEnd) {
        let (a, aSink) = AsyncStream.makeStream(of: Data.self)
        let (b, bSink) = AsyncStream.makeStream(of: Data.self)
        return (HostPipeEnd(inbox: a, inboxSink: aSink, outbox: bSink), HostPipeEnd(inbox: b, inboxSink: bSink, outbox: aSink))
    }
}

/// One display that never delivers a picture; `failing` makes starting it fail, as a capture without permission does.
final class QuietDisplays: DisplayCapturing, Sendable {
    let failing: Bool
    init(failing: Bool = false) { self.failing = failing }
    func displays() async throws -> [CaptureDisplay] { [CaptureDisplay(id: 1, width: 1280, height: 800)] }
    func start(_ display: CaptureDisplay, settings: CaptureSettings, deliver: @escaping @Sendable (CapturedPicture) -> Void) async throws {
        if failing { throw HostCaptureError.noDisplay }
    }
    func update(_ settings: CaptureSettings) async throws {}
    func stop() async {}
}

/// Records what would have reached this Mac.
final class Recorded<Element: Sendable>: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: [Element]())
    func add(_ element: Element) { state.withLock { $0.append(element) } }
    var all: [Element] { state.withLock { $0 } }
}

/// Keyboard and Spaces that answer without touching the Mac.
final class QuietDesktop: DesktopControlling, Sendable {
    let calls = Recorded<ScreenKeyboardAction>()
    private static let state = ScreenKeyboardState(language: .latin, capsLock: false, canSelectLatin: true, canSelectKorean: true)
    func keyboardState() async -> ScreenKeyboardState { Self.state }
    func keyboard(_ action: ScreenKeyboardAction) async -> (ScreenKeyboardState, ScreenControlResult) {
        calls.add(action)
        return (Self.state, .applied)
    }
    func navigate(_ action: ScreenSpaceAction) async -> ScreenControlResult { .applied }
    func spaceChanges() async -> AsyncStream<Bool> { AsyncStream { $0.finish() } }
}

/// The screen port as a stream the check feeds.
final class QuietSource: ScreenSessionSource, Sendable {
    let sessions: AsyncStream<MacSession>
    private let sink: AsyncStream<MacSession>.Continuation
    private let stopped = OSAllocatedUnfairLock(initialState: false)
    init() { (sessions, sink) = AsyncStream.makeStream() }
    func stop() {
        stopped.withLock { $0 = true }
        sink.finish()
    }
    var isStopped: Bool { stopped.withLock { $0 } }
}

/// What the person's network is, as a check sets it.
final class NetworkBox: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: (identity: NetworkIdentity, label: String)?.none)
    func set(_ value: (identity: NetworkIdentity, label: String)?) { state.withLock { $0 = value } }
    var value: (identity: NetworkIdentity, label: String)? { state.withLock { $0 } }
}

/// Whether the Mac is locked, as a check sets it: nil when the system could not tell.
final class LockBox: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: Bool?.some(false))
    func set(_ value: Bool?) { state.withLock { $0 = value } }
    var value: Bool? { state.withLock { $0 } }
}

/// The relay as a recorder of what the Mac asked it to push. Nothing leaves the process.
final class RecordingPushTransport: PushTransport {
    let events = Recorded<ScreenEvent>()
    func post(_ body: Data, to url: URL) async throws -> (status: Int, body: Data) {
        if let fields = try? JSONSerialization.jsonObject(with: body) as? [String: String], fields["type"] == "notify",
           let message = fields["message"].flatMap({ Data(base64Encoded: $0) }), let event = try? ScreenEvent.decode(message) {
            events.add(event)
        }
        return (200, Data("{}".utf8))
    }
}

final class TestClock: Sendable {
    private let state: OSAllocatedUnfairLock<Date>
    init(_ date: Date = Date(timeIntervalSince1970: 1_793_000_000)) { state = OSAllocatedUnfairLock(initialState: date) }
    var now: Date { state.withLock { $0 } }
    func advance(_ seconds: TimeInterval) { state.withLock { $0 = $0.addingTimeInterval(seconds) } }
}

func sampleNetwork(_ last: UInt8, label: String) -> (identity: NetworkIdentity, label: String) {
    (NetworkIdentity(router: Data([0x10, 0x20, 0x30, 0x40, 0x50, last]), address: Data([192, 168, last, 10]), prefixLength: 24)!, label)
}

/// How a session ended at the peer.
enum Ending: Equatable {
    /// A sealed `.close` naming this reason.
    case reason(SessionEndReason)
    /// A sealed `.close` naming none.
    case silent
    /// Closed without a goodbye.
    case dropped
    /// Nothing within the wait.
    case stillOpen
}

/// The screen host with everything outside it replaced.
@MainActor
final class HostRig {
    let items = HostTestItems()
    var store: ScreenStore { ScreenStore(items: items) }
    let folder: URL
    let mac = HostTestSigner()
    let clock = TestClock()
    let liveness = PushLiveness()
    let net = NetworkBox()
    var flags = ScreenBuildFlags()
    let injected = Recorded<InputEvent>()
    /// Text and Return that reached the Mac.
    let typed = Recorded<String>()
    let locked = LockBox()
    let desktop = QuietDesktop()
    /// The owner's phone `seed` registers unless told otherwise: the push gate needs a phone in use (DESIGN 9절).
    let ownerPhone = HostTestSigner()
    /// A push relay that only records. Only for checks that never turn screen control on: polling would also read the
    /// main app's weekly allowance outbox.
    var pushTransport: RecordingPushTransport?
    var monitorAvailable = true
    var captureFails = false
    var authenticates = true
    private(set) var policies: [LAPolicy] = []
    private(set) var opened: [QuietSource] = []
    private(set) var pairingClosed = 0

    init() throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "screen-host-checks-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: folder) }

    var remoteInputURL: URL { folder.appending(path: "remote-input.json") }
    var powerHoldURL: URL { folder.appending(path: "power-hold") }

    func makeService() -> ScreenService {
        let injected = injected, typed = typed, locked = locked, desktop = desktop, captureFails = captureFails, available = monitorAvailable
        let net = net, clock = clock, mac = mac
        let probe: PhysicalInputProbe = { PhysicalInputSnapshot(available: true) }
        let inputMonitor: @MainActor () -> PhysicalInputProbe? = { available ? probe : nil }
        // The app's own input path (lock rule and marker) in front of an injector that only records.
        let streamer: @MainActor (MacSession, HostSessionPlan, PhysicalInputProbe?, RemoteInputMarker) -> HostStreamer = { incoming, plan, physical, marker in
            let path = HostInputPath(plan: plan, marker: marker, locked: { locked.value })
            let input = physical.map { physical in
                path.receiver(physicalInput: physical, inject: { injected.add($0) }, release: { injected.add($0) },
                              type: { text, _ in typed.add(text); return .posted })
            }
            return HostStreamer(connection: incoming.connection, backend: QuietDisplays(failing: captureFails), input: input,
                                limits: plan.limits, desktop: MarkedDesktopControls(desktop, marker: marker),
                                captureAllowed: { !captureFails })
        }
        let authenticate: @MainActor (String, LAPolicy) async throws -> Bool = { [weak self] _, policy in
            guard let self else { return false }
            self.policies.append(policy)
            return self.authenticates
        }
        let openNearby: @MainActor (MacHandshake, PreAuthGate, String) async throws -> any ScreenSessionSource = { [weak self] _, _, _ in
            let source = QuietSource()
            self?.opened.append(source)
            return source
        }
        let identity: @MainActor (ScreenStore) throws -> any TranscriptSigner = { _ in mac }
        let transport = pushTransport
        let push: @MainActor (PushLiveness) -> ScreenPush? = { liveness in
            transport.map { ScreenPush(client: ScreenPushClient(endpoint: PushEndpoint("https://push.invalid/screen-push"), transport: $0),
                                       liveness: liveness) }
        }
        let environment = ScreenServiceEnvironment(
            store: store, publishesStatus: false, observesTermination: false, resumesKeptOn: false, watchesKeptOnNetwork: false,
            flags: flags, liveness: liveness, push: push, identity: identity, authenticate: authenticate,
            sessions: ScreenSessionSystem(inputMonitor: inputMonitor, streamer: streamer, lockStates: nil),
            openNearby: openNearby,
            currentNetwork: { net.value },
            addresses: { ["192.168.0.10", "10.0.0.7", "100.64.0.1", "127.0.0.1"] },
            remoteInputURL: remoteInputURL, powerHoldURL: powerHoldURL, now: { clock.now })
        let service = ScreenService(environment: environment)
        service.closeControllerPairing = { [weak self] in self?.pairingClosed += 1 }
        return service
    }

    // MARK: Registrations

    func phone(_ peer: HostTestSigner, name: String = "iPhone") throws -> RegisteredDevice {
        let record = try RegistrationRecord(macFingerprint: mac.fingerprint, codeID: Data(repeating: 9, count: RegistrationCode.idSize),
                                            devicePublicKey: peer.publicKey, deviceName: name, deviceModel: "iPhone16,1")
        return RegisteredDevice(record: record, attestationKeyID: Data(repeating: 1, count: 32), at: clock.now)
    }

    func controller(_ peer: HostTestSigner, grant: ScreenControllerGrant = .view, bound: Bool = false,
                    name: String = "1호 MacBook Pro") throws -> RegisteredController {
        let enrollment: ControllerEnrollment = bound
            ? try JSONDecoder().decode(ControllerEnrollment.self, from: JSONSerialization.data(withJSONObject: [
                "method": "direct-sas", "attested": true, "attestationKeyID": Data(repeating: 4, count: 32).base64EncodedString()]))
            : try .directSAS(attestation: nil)
        return RegisteredController(publicKey: peer.publicKey, name: name, model: "Mac16,7", grant: grant, enrollment: enrollment, at: clock.now)
    }

    /// Stores the registrations, with the owner's phone among the phones unless `ownerPhone` is false.
    func seed(phones: [RegisteredDevice] = [], controllers: [RegisteredController] = [], allow: Bool = true,
              ownerPhone: Bool = true) throws {
        try store.save(phones + (ownerPhone ? [try phone(self.ownerPhone, name: "주인 iPhone")] : []))
        try store.saveControllers(ScreenControllers(allowMacControllers: allow, controllers: controllers))
    }

    /// A remote-stop round reached the relay for a phone; the gate opens when a phone is still in use.
    func openPushGate(_ service: ScreenService) {
        liveness.noteRound(reaching: 1)
        service.pushLivenessChanged()
    }

    // MARK: Sessions

    /// A completed key exchange as `peer`, handed to the service the way a listener would, on a path serving `accepting`.
    func connect(_ service: ScreenService, _ peer: HostTestSigner, as peerClass: ScreenPeerClass,
                 accepting: Set<ScreenPeerClass> = ScreenListenerClasses.screenPort) async throws -> SecureConnection {
        let (deviceEnd, macEnd) = HostPipeEnd.pair()
        let handshake = service.macHandshake(signer: mac)
        let gate = PreAuthGate()
        let pinned = try PinnedMac(publicKey: mac.publicKey, fingerprint: mac.fingerprint)
        let device = DeviceHandshake(mac: pinned, devicePublicKey: peer.publicKey, peerClass: peerClass)
        async let macSide = ScreenTransportHandshake.accept(over: macEnd, peer: PeerKey(host: "192.168.0.20")!, handshake: handshake,
                                                            gate: gate, accepting: accepting)
        let connection: SecureConnection
        do {
            connection = try await ScreenTransportHandshake.connect(over: deviceEnd, handshake: device, signer: peer)
        } catch {
            _ = try? await macSide
            throw error
        }
        service.accept(try await macSide)
        return connection
    }

    /// Why the key exchange was refused, as the peer heard it.
    func refusal(_ service: ScreenService, _ peer: HostTestSigner, as peerClass: ScreenPeerClass,
                 accepting: Set<ScreenPeerClass> = ScreenListenerClasses.screenPort) async -> Error? {
        do {
            let connection = try await connect(service, peer, as: peerClass, accepting: accepting)
            connection.close()
            return nil
        } catch {
            return error
        }
    }
}

/// The control messages the peer read until `until` matched, or nil when the session ended first or nothing came.
func read(_ connection: SecureConnection, until match: @escaping @Sendable (ControlMessage) -> Bool,
          seconds: Double = 5) async -> [ControlMessage]? {
    await withTaskGroup(of: [ControlMessage]?.self) { group in
        group.addTask {
            var seen: [ControlMessage] = []
            while true {
                guard let (type, payload) = try? await connection.receive() else { return nil }
                guard type == .control, let message = try? ControlMessage(decoding: payload, version: connection.version) else {
                    if type == .close { return nil }
                    continue
                }
                seen.append(message)
                if match(message) { return seen }
            }
        }
        group.addTask { try? await Task.sleep(for: .seconds(seconds)); return nil }
        let first = await group.next() ?? nil
        group.cancelAll()
        return first
    }
}

/// How the session ended at the peer, reading past anything else it was sent.
func ending(of connection: SecureConnection, seconds: Double = 5) async -> Ending {
    await withTaskGroup(of: Ending.self) { group in
        group.addTask {
            while true {
                guard let (type, payload) = try? await connection.receive() else { return .dropped }
                guard type == .close else { continue }
                guard let byte = payload.first else { return .silent }
                return SessionEndReason(rawValue: byte).map(Ending.reason) ?? .silent
            }
        }
        group.addTask {
            try? await Task.sleep(for: .seconds(seconds))
            return .stillOpen
        }
        let first = await group.next() ?? .stillOpen
        group.cancelAll()
        if first == .stillOpen { connection.close() }
        return first
    }
}

/// Waits on the main actor until `condition` holds, or about two seconds.
@MainActor
func eventually(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<200 {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

func isStarted(_ message: ControlMessage) -> Bool { if case .inputAvailability = message { true } else { false } }

func keyboardAnswer(_ id: UInt32) -> @Sendable (ControlMessage) -> Bool {
    { message in if case .keyboardState(id, _, _) = message { true } else { false } }
}

// MARK: - Checks

final class ControllerSessionTests: XCTestCase {
    // MARK: 6.5 arbitration

    @MainActor
    func testArbitrationTable() async throws {
        let rig = try HostRig()
        let phoneX = HostTestSigner(), phoneY = HostTestSigner(), macC = HostTestSigner(), macD = HostTestSigner()
        try rig.seed(phones: [try rig.phone(phoneX), try rig.phone(phoneY, name: "iPad")],
                     controllers: [try rig.controller(macC), try rig.controller(macD, name: "2호 Mac")])
        let service = rig.makeService()
        rig.openPushGate(service)

        // Nobody: a phone is taken.
        let x1 = try await rig.connect(service, phoneX, as: .phone)
        let awaited1 = await read(x1, until: isStarted)
        XCTAssertNotNil(awaited1)
        XCTAssertEqual(service.session?.deviceID, phoneX.id)
        XCTAssertEqual(service.session?.peerClass, .phone)

        // Phone X, then phone X again: replaced.
        let x2 = try await rig.connect(service, phoneX, as: .phone)
        let replaced = await ending(of: x1)
        XCTAssertEqual(replaced, .reason(.replaced))
        let awaited2 = await read(x2, until: isStarted)
        XCTAssertNotNil(awaited2)

        // Phone X, then another phone: closed without a word; X keeps the screen.
        let y = try await rig.connect(service, phoneY, as: .phone)
        let quietly = await ending(of: y)
        XCTAssertEqual(quietly, .dropped)
        XCTAssertEqual(service.session?.deviceID, phoneX.id)

        // Phone X, then a controller: told busy after the key exchange; X keeps the screen.
        let c0 = try await rig.connect(service, macC, as: .controller)
        let busyWhilePhone = await ending(of: c0)
        XCTAssertEqual(busyWhilePhone, .reason(.busy))
        XCTAssertEqual(service.session?.deviceID, phoneX.id)
        XCTAssertEqual(service.controllerHistory.last?.event, .refused)
        XCTAssertEqual(service.controllerHistory.last?.reason, "busy")

        // Nobody, then a controller: taken.
        service.disconnect()
        _ = await ending(of: x2)
        let c1 = try await rig.connect(service, macC, as: .controller)
        let awaited3 = await read(c1, until: isStarted)
        XCTAssertNotNil(awaited3)
        XCTAssertEqual(service.session?.peerClass, .controller)

        // Controller C, then C again: replaced.
        let c2 = try await rig.connect(service, macC, as: .controller)
        let cReplaced = await ending(of: c1)
        XCTAssertEqual(cReplaced, .reason(.replaced))
        let awaited4 = await read(c2, until: isStarted)
        XCTAssertNotNil(awaited4)

        // Controller C, then another controller: busy; C keeps the screen.
        let d = try await rig.connect(service, macD, as: .controller)
        let busyWhileController = await ending(of: d)
        XCTAssertEqual(busyWhileController, .reason(.busy))
        XCTAssertEqual(service.session?.deviceID, macC.id)

        // Controller C, then a registered phone: C ends taken over, the phone has the screen.
        let x3 = try await rig.connect(service, phoneX, as: .phone)
        let takenOver = await ending(of: c2)
        XCTAssertEqual(takenOver, .reason(.takenOver))
        let awaited5 = await read(x3, until: isStarted)
        XCTAssertNotNil(awaited5)
        XCTAssertEqual(service.session?.deviceID, phoneX.id)
        XCTAssertEqual(service.controllerHistory.filter { $0.event == .ended }.map(\.reason), ["replaced", "takenOver"])
        x3.close()
    }

    // MARK: 9절 release gate

    @MainActor
    func testReleaseGateRefusesUnboundBeforePushLowersControlAndHidesKeepingOn() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(macControl: true, keepOn: true)
        let unbound = HostTestSigner(), bound = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(unbound, grant: .control), try rig.controller(bound, grant: .control, bound: true)])
        let service = rig.makeService()
        XCTAssertFalse(service.pushLive)

        // An unbound registration before the push gate: refused at the lookup, the Viewer told only notAccepted.
        guard case HandshakeError.preAuthNotice(.notAccepted)? = await rig.refusal(service, unbound, as: .controller) else {
            return XCTFail("an unbound controller must hear notAccepted before the push gate opens")
        }
        XCTAssertNil(service.session)
        // Keeping on is not offered yet.
        XCTAssertFalse(service.keepOnOffered)

        // The genuine Viewer's own key connects, but control is lowered to watching until the gate opens.
        let lowered = try await rig.connect(service, bound, as: .controller)
        let start = await read(lowered, until: isStarted)
        XCTAssertEqual(start?.first, .sessionLimits(grant: .control, limits: ControlMessage.wireLimits(ScreenControllerPolicy.sessionLimits(canControl: false))))
        XCTAssertEqual(start?.last, .inputAvailability(.notificationsUnconfirmed), "the Viewer hears it is the push gate")
        XCTAssertEqual(service.session?.viewOnlyCause, .notifications)
        XCTAssertEqual(service.session?.canControl, false)
        service.disconnect()
        _ = await ending(of: lowered)

        // The gate opens: the unbound registration connects, control opens, keeping on is offered.
        rig.openPushGate(service)
        XCTAssertTrue(service.pushLive)
        XCTAssertTrue(service.keepOnOffered)
        let open = try await rig.connect(service, unbound, as: .controller)
        let opened = await read(open, until: isStarted)
        XCTAssertEqual(opened?.first, .sessionLimits(grant: .control, limits: ControlMessage.wireLimits(ScreenControllerPolicy.sessionLimits(canControl: true))))
        XCTAssertEqual(opened?.last, .inputAvailability(.ready))
        XCTAssertEqual(service.session?.canControl, true)
        XCTAssertNil(service.session?.viewOnlyCause)
        open.close()
    }

    @MainActor
    func testControlStaysClosedInABuildWithoutTheCalibration() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(macControl: false, keepOn: false)
        let peer = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(peer, grant: .control, bound: true)])
        let service = rig.makeService()
        rig.openPushGate(service)
        XCTAssertFalse(service.keepOnOffered, "a build without the Apple report never offers keeping on")
        XCTAssertFalse(service.controlChoiceOffered)

        let connection = try await rig.connect(service, peer, as: .controller)
        let awaited6 = await read(connection, until: isStarted)
        XCTAssertEqual(awaited6?.last, .inputAvailability(.controlNotInThisBuild), "the build, not the push gate, which is open")
        XCTAssertEqual(service.session?.canControl, false)
        XCTAssertEqual(service.session?.viewOnlyCause, .build)
        // Raising to control is not even asked for.
        await service.setControllerGrant(peer.id, to: .control)
        XCTAssertTrue(rig.policies.isEmpty)
        connection.close()
    }

    // MARK: 6.5 what a session may do

    @MainActor
    func testViewGrantDropsInputAndTellsViewOnly() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(macControl: true)
        let watcher = HostTestSigner(), operatorMac = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(watcher, grant: .view), try rig.controller(operatorMac, grant: .control, name: "2호 Mac")])
        let service = rig.makeService()
        rig.openPushGate(service)

        let view = try await rig.connect(service, watcher, as: .controller)
        let started = await read(view, until: isStarted)
        XCTAssertEqual(started?.first, .sessionLimits(grant: .view, limits: ControlMessage.wireLimits(SessionLimits(idle: .seconds(3600), maximum: .seconds(3600)))))
        XCTAssertEqual(started?.last, .inputAvailability(.viewOnly))
        try await view.send(.input, InputCodec.encode(.pointerMove(x: 0.5, y: 0.5)))
        try await view.send(.input, InputCodec.encode(.key(code: 0, isDown: true, modifiers: [])))
        try await view.send(ControlMessage.keyboardAction(id: 1, .korean))
        let answer = await read(view, until: keyboardAnswer(1))
        XCTAssertEqual(answer?.last, .keyboardState(id: 1, ScreenKeyboardState(language: .latin, capsLock: false, canSelectLatin: true, canSelectKorean: true), .blocked))
        XCTAssertTrue(rig.injected.all.isEmpty, "a view grant injects nothing")
        XCTAssertTrue(rig.desktop.calls.all.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.remoteInputURL.path), "watching never stops the AI")
        XCTAssertEqual(service.session?.canControl, false)
        XCTAssertNil(service.session?.viewOnlyCause, "the grant says it")
        view.close()
        _ = await eventually { service.session == nil }

        // A controller granted control: input reaches the Mac, inside its limits.
        let control = try await rig.connect(service, operatorMac, as: .controller)
        let awaited7 = await read(control, until: isStarted)
        XCTAssertEqual(awaited7?.first,
                       .sessionLimits(grant: .control, limits: ControlMessage.wireLimits(SessionLimits(idle: .seconds(3600), maximum: .seconds(8 * 3600)))))
        try await control.send(.input, InputCodec.encode(.pointerMove(x: 0.25, y: 0.75)))
        try await control.send(ControlMessage.keyboardAction(id: 2, .korean))
        let awaited8 = await read(control, until: keyboardAnswer(2))
        XCTAssertEqual(awaited8?.last?.isKeyboardApplied, true)
        XCTAssertEqual(rig.injected.all, [.pointerMove(x: 0.25, y: 0.75)])
        control.close()
    }

    @MainActor
    func testSessionBarKeepsMacHoldAcrossControllerAndPhoneSessions() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(macControl: true)
        let mac = HostTestSigner(), phone = HostTestSigner()
        try rig.seed(phones: [try rig.phone(phone)], controllers: [try rig.controller(mac, grant: .control)])
        let service = rig.makeService()
        rig.openPushGate(service)

        let controller = try await rig.connect(service, mac, as: .controller)
        _ = await read(controller, until: isStarted)
        XCTAssertEqual(service.session?.peerClass, .controller)
        XCTAssertEqual(service.session?.grant, .control)
        XCTAssertEqual(service.session?.deviceModel, "Mac16,7")
        XCTAssertEqual(service.session?.canControl, true)
        XCTAssertNotNil(service.sessionDeadline)
        service.pauseRemoteInput()
        XCTAssertEqual(service.sessionInput?.mode, .paused)
        service.disconnect()
        _ = await ending(of: controller)

        let phoneSession = try await rig.connect(service, phone, as: .phone)
        _ = await read(phoneSession, until: isStarted)
        XCTAssertEqual(service.sessionInput?.mode, .paused, "a different device cannot clear the Mac-wide hold")
        XCTAssertFalse(service.resumeRemoteInput(refusal: .otherProcess))
        XCTAssertEqual(service.sessionInput?.mode, .paused)
        XCTAssertTrue(service.resumeRemoteInput(refusal: nil))
        service.disconnect()
        _ = await ending(of: phoneSession)

        let again = try await rig.connect(service, mac, as: .controller)
        _ = await read(again, until: isStarted)
        XCTAssertEqual(service.sessionInput?.mode, .remote)
        service.lowerSessionToView()
        XCTAssertEqual(service.session?.peerClass, .controller, "lowering must preserve the controller identity")
        XCTAssertEqual(service.session?.grant, .control)
        XCTAssertEqual(service.session?.canControl, false)
        XCTAssertEqual(service.sessionInput?.mode, .viewOnly)
        service.disconnect()
        _ = await ending(of: again)

        let afterLowering = try await rig.connect(service, phone, as: .phone)
        _ = await read(afterLowering, until: isStarted)
        XCTAssertEqual(service.sessionInput?.mode, .paused, "view-only still holds later sessions")
        service.disconnect()
        _ = await ending(of: afterLowering)
    }

    @MainActor
    func testControllerCannotTurnTheMacOffAndHearsItsAddresses() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(macControl: true)
        let peer = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(peer, grant: .control)])
        let service = rig.makeService()
        rig.openPushGate(service)

        let connection = try await rig.connect(service, peer, as: .controller)
        let start = await read(connection, until: isStarted)
        // Private IPv4 only (never a VPN's carrier-grade range or loopback), told once at the start.
        XCTAssertTrue(start?.contains(.addressHint(ScreenAddressHints.routes(from: ["192.168.0.10", "10.0.0.7"]))) == true)
        XCTAssertEqual(ScreenAddressHints.routes(from: ["192.168.0.10", "10.0.0.7", "100.64.0.1", "127.0.0.1"]).count, 2)

        try await connection.send(ControlMessage.turnOff)
        try await connection.send(ControlMessage.keyboardAction(id: 3, .latin))
        let awaited9 = await read(connection, until: keyboardAnswer(3))
        XCTAssertNotNil(awaited9, "the session goes on")
        XCTAssertEqual(service.power, .off(reason: nil), "a controller's turnOff changes nothing")
        XCTAssertEqual(service.session?.deviceID, peer.id)
        connection.close()
    }

    @MainActor
    func testCaptureWithoutPermissionTellsAViewerWhyAndAPhoneAsBefore() async throws {
        let rig = try HostRig()
        rig.captureFails = true
        let phone = HostTestSigner(), viewer = HostTestSigner()
        try rig.seed(phones: [try rig.phone(phone)], controllers: [try rig.controller(viewer)])
        let service = rig.makeService()
        rig.openPushGate(service)

        let phoneEnding = await ending(of: try await rig.connect(service, phone, as: .phone))
        XCTAssertEqual(phoneEnding, .reason(.endedAtMac))
        _ = await eventually { service.session == nil }
        let viewerEnding = await ending(of: try await rig.connect(service, viewer, as: .controller))
        XCTAssertEqual(viewerEnding, .reason(.captureUnavailable))
    }

    // MARK: SR-33, SR-37

    @MainActor
    func testRelayServesPhonesOnlyAndSessionsCloseTheEnrollmentWindow() async throws {
        XCTAssertEqual(ScreenListenerClasses.screenPort, [.phone, .controller])
        XCTAssertEqual(ScreenListenerClasses.relay, [.phone])
        let rig = try HostRig()
        let phone = HostTestSigner(), viewer = HostTestSigner(), other = HostTestSigner()
        try rig.seed(phones: [try rig.phone(phone)], controllers: [try rig.controller(viewer, bound: true), try rig.controller(other, bound: true, name: "2호 Mac")])
        let service = rig.makeService()

        guard case HandshakeError.preAuthNotice(.notAccepted)? = await rig.refusal(service, viewer, as: .controller, accepting: ScreenListenerClasses.relay) else {
            return XCTFail("the self-hosted relay must refuse a Mac controller")
        }
        XCTAssertEqual(rig.pairingClosed, 0)

        let viaRelay = try await rig.connect(service, phone, as: .phone, accepting: ScreenListenerClasses.relay)
        let awaited10 = await read(viaRelay, until: isStarted)
        XCTAssertNotNil(awaited10)
        XCTAssertEqual(rig.pairingClosed, 1, "a phone session closes the controller enrollment window")
        // A refused controller starts no session and closes nothing.
        let busy = await ending(of: try await rig.connect(service, viewer, as: .controller))
        XCTAssertEqual(busy, .reason(.busy))
        XCTAssertEqual(rig.pairingClosed, 1)
        service.disconnect()
        _ = await ending(of: viaRelay)

        let controller = try await rig.connect(service, viewer, as: .controller)
        let awaited11 = await read(controller, until: isStarted)
        XCTAssertNotNil(awaited11)
        XCTAssertEqual(rig.pairingClosed, 2, "a controller session closes it too")
        controller.close()
    }

    // MARK: 6.6 narrowing at this Mac

    @MainActor
    func testGrantChangeEndsTheSessionAndRaisingTakesBiometricsOrWatch() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(macControl: true)
        let peer = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(peer, grant: .control)])
        let service = rig.makeService()
        rig.openPushGate(service)

        let first = try await rig.connect(service, peer, as: .controller)
        let awaited12 = await read(first, until: isStarted)
        XCTAssertNotNil(awaited12)
        await service.setControllerGrant(peer.id, to: .view)
        XCTAssertTrue(rig.policies.isEmpty, "lowering never asks")
        let lowered = await ending(of: first)
        XCTAssertEqual(lowered, .reason(.endedAtMac))
        XCTAssertEqual(try rig.store.controllers().controllers.first?.grant, .view)

        let second = try await rig.connect(service, peer, as: .controller)
        let awaited13 = await read(second, until: isStarted)
        XCTAssertNotNil(awaited13)
        rig.authenticates = false
        await service.setControllerGrant(peer.id, to: .control)
        XCTAssertEqual(rig.policies, [.deviceOwnerAuthenticationWithBiometricsOrWatch])
        XCTAssertEqual(service.controllers.first?.grant, .view, "cancelled: nothing changes")
        XCTAssertEqual(service.session?.deviceID, peer.id)
        rig.authenticates = true
        await service.setControllerGrant(peer.id, to: .control)
        XCTAssertEqual(rig.policies, [.deviceOwnerAuthenticationWithBiometricsOrWatch, .deviceOwnerAuthenticationWithBiometricsOrWatch])
        let raised = await ending(of: second)
        XCTAssertEqual(raised, .reason(.endedAtMac))
        XCTAssertEqual(try rig.store.controllers().controllers.first?.grant, .control)
        XCTAssertEqual(service.controllerHistory.filter { $0.event == .grantChanged }.map(\.reason), ["view", "control"])
    }

    @MainActor
    func testRemovalAndTheSwitchEndTheSessionAtOnce() async throws {
        let rig = try HostRig()
        let removed = HostTestSigner(), kept = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(removed), try rig.controller(kept, name: "2호 Mac")])
        let service = rig.makeService()
        rig.openPushGate(service)

        let first = try await rig.connect(service, removed, as: .controller)
        let awaited14 = await read(first, until: isStarted)
        XCTAssertNotNil(awaited14)
        service.removeController(removed.id)
        let revoked = await ending(of: first)
        XCTAssertEqual(revoked, .reason(.revoked))
        XCTAssertEqual(try rig.store.controllers().controllers.map(\.id), [kept.id])
        guard case HandshakeError.preAuthNotice(.notAccepted)? = await rig.refusal(service, removed, as: .controller) else {
            return XCTFail("a removed controller must not connect again")
        }

        let second = try await rig.connect(service, kept, as: .controller)
        let awaited15 = await read(second, until: isStarted)
        XCTAssertNotNil(awaited15)
        await service.setAllowMacControllers(false)
        XCTAssertTrue(rig.policies.isEmpty, "turning off never asks")
        let switchedOff = await ending(of: second)
        XCTAssertEqual(switchedOff, .reason(.endedAtMac))
        XCTAssertEqual(try rig.store.controllers().allowMacControllers, false)
        XCTAssertEqual(try rig.store.controllers().controllers.map(\.id), [kept.id], "the rows stay")
        guard case HandshakeError.preAuthNotice(.notAccepted)? = await rig.refusal(service, kept, as: .controller) else {
            return XCTFail("no controller connects while the switch is off")
        }
        // Turning it on again asks.
        await service.setAllowMacControllers(true)
        XCTAssertEqual(rig.policies, [.deviceOwnerAuthenticationWithBiometricsOrWatch])
        XCTAssertTrue(service.macControllers.allowMacControllers)
        XCTAssertEqual(service.controllerHistory.map(\.event), [.connected, .removed, .ended, .connected, .ended])
    }

    @MainActor
    func testUnenrollSelfRemovesTheRowAndEndsRevoked() async throws {
        let rig = try HostRig()
        let peer = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(peer)])
        let service = rig.makeService()
        rig.openPushGate(service)

        let connection = try await rig.connect(service, peer, as: .controller)
        let awaited16 = await read(connection, until: isStarted)
        XCTAssertNotNil(awaited16)
        try await connection.send(ControlMessage.unenrollSelf)
        let revoked = await ending(of: connection)
        XCTAssertEqual(revoked, .reason(.revoked))
        let gone = await eventually { service.controllers.isEmpty }
        XCTAssertTrue(gone)
        XCTAssertEqual(try rig.store.controllers().controllers.count, 0)
        XCTAssertTrue(service.controllerHistory.contains { $0.event == .unenrolled && $0.controllerID == peer.id })
        XCTAssertNil(service.session)
    }

    @MainActor
    func testDoublyRegisteredKeyAnswersFromNeitherRegistry() async throws {
        let rig = try HostRig()
        let both = HostTestSigner()
        // Only a store written some other way can hold one key in both registries.
        try rig.seed(phones: [try rig.phone(both)], controllers: [try rig.controller(both, bound: true)])
        let service = rig.makeService()
        rig.openPushGate(service)
        let asPhone = await rig.refusal(service, both, as: .phone)
        XCTAssertNotNil(asPhone)
        let asController = await rig.refusal(service, both, as: .controller)
        XCTAssertNotNil(asController)
        XCTAssertNil(service.session)
    }

    @MainActor
    func testNearbyAdvertisementCarriesTheSessionVersion() throws {
        XCTAssertEqual(ScreenNearbyAdvert.txt, ["pv": "5"])
        let name = ScreenNearby.screenService(fingerprint: Data(repeating: 1, count: 32))
        let advertised = try ScreenListener.makeListener(host: nil, port: .any, nearbyServiceName: name, nearbyTXT: ScreenNearbyAdvert.txt)
        defer { advertised.cancel() }
        XCTAssertEqual(advertised.service?.txtRecordObject?.dictionary["pv"], "5")
        let plain = try ScreenListener.makeListener(host: nil, port: .any, nearbyServiceName: name)
        defer { plain.cancel() }
        XCTAssertNil(plain.service?.txtRecordObject?.dictionary["pv"], "a listener that was not given one advertises as before")
    }

    // MARK: 9절 the push gate needs a phone

    func testPushLivenessClosesAfterThirtyMinutesAndWhenTheClockGoesBack() {
        let clock = TestClock()
        let liveness = PushLiveness(now: { clock.now })
        XCTAssertFalse(liveness.isLive, "closed before the first round")
        liveness.noteRound(reaching: 1)
        XCTAssertTrue(liveness.isLive)
        clock.advance(PushLiveness.window - 1)
        XCTAssertTrue(liveness.isLive)
        clock.advance(1)
        XCTAssertFalse(liveness.isLive, "thirty minutes without a round")
        liveness.noteRound(reaching: 1)
        clock.advance(-1)
        XCTAssertFalse(liveness.isLive, "a clock that went back proves nothing")
        liveness.noteRound(reaching: 3)
        XCTAssertTrue(liveness.isLive)
        liveness.noteRound(reaching: 0)
        XCTAssertFalse(liveness.isLive, "a round with no phone in it closes the gate at once")
        liveness.noteRound(reaching: 0)
        XCTAssertFalse(liveness.isLive, "and never opens it")
    }

    @MainActor
    func testPushGateNeedsAPhoneInUse() async throws {
        let rig = try HostRig()
        let clock = rig.clock
        let liveness = PushLiveness(now: { clock.now })
        let keys = ScreenPeerKeys(pushLive: { liveness.isLive }, now: { clock.now })
        liveness.noteRound(reaching: 1)
        keys.set(phones: [], controllers: ScreenControllers())
        XCTAssertFalse(keys.pushGateOpen, "a relay that answers for nobody's phone opens nothing")
        keys.set(phones: [try rig.phone(HostTestSigner())], controllers: ScreenControllers())
        XCTAssertTrue(keys.pushGateOpen)
        clock.advance(RegistrationLifetime.unused + 60)
        liveness.noteRound(reaching: 1)
        XCTAssertTrue(liveness.isLive)
        XCTAssertFalse(keys.pushGateOpen, "the only phone expired")

        // A Mac only other Macs use: rounds reach the relay, but no phone hears a connection or can stop one.
        let lonely = try HostRig()
        lonely.flags = ScreenBuildFlags(macControl: true, keepOn: true)
        let unbound = HostTestSigner()
        try lonely.seed(controllers: [try lonely.controller(unbound, grant: .control)], ownerPhone: false)
        let service = lonely.makeService()
        lonely.openPushGate(service)
        XCTAssertTrue(lonely.liveness.isLive)
        XCTAssertFalse(service.pushLive)
        XCTAssertFalse(service.keepOnOffered)
        guard case HandshakeError.preAuthNotice(.notAccepted)? = await lonely.refusal(service, unbound, as: .controller) else {
            return XCTFail("an unbound controller must wait while no phone is in use")
        }
        XCTAssertNil(service.session)
    }

    // MARK: 6.5, 12절 why a session granted control only watches

    func testViewOnlyCauseNamesTheBuildThenThePushGateThenTheInputProtection() {
        let open = ScreenBuildFlags(macControl: true, keepOn: true, lockedInput: true)
        XCTAssertNil(ControllerViewOnlyCause.of(grant: .view, inputMonitorAvailable: false, pushLive: false, flags: ScreenBuildFlags()),
                     "a view grant says it itself")
        XCTAssertEqual(ControllerViewOnlyCause.of(grant: .control, inputMonitorAvailable: false, pushLive: false, flags: ScreenBuildFlags()), .build)
        XCTAssertEqual(ControllerViewOnlyCause.of(grant: .control, inputMonitorAvailable: true, pushLive: true, flags: ScreenBuildFlags()), .build,
                       "never the push gate's fault when the build keeps control closed")
        XCTAssertEqual(ControllerViewOnlyCause.of(grant: .control, inputMonitorAvailable: false, pushLive: false, flags: open), .notifications)
        XCTAssertEqual(ControllerViewOnlyCause.of(grant: .control, inputMonitorAvailable: false, pushLive: true, flags: open), .inputProtection)
        XCTAssertNil(ControllerViewOnlyCause.of(grant: .control, inputMonitorAvailable: true, pushLive: true, flags: open))
        XCTAssertEqual([ControllerViewOnlyCause.build, .notifications, .inputProtection].map(\.availability),
                       [.controlNotInThisBuild, .notificationsUnconfirmed, .permissionsRequired])
        for grant in [ScreenControllerGrant.view, .control] {
            for monitor in [false, true] {
                for push in [false, true] {
                    for flags in [ScreenBuildFlags(), open] {
                        let plan = HostSessionPlan.controller(grant: grant, inputMonitorAvailable: monitor, pushLive: push, flags: flags)
                        XCTAssertEqual(plan.canControl, grant == .control && plan.viewOnlyCause == nil, "\(grant) \(monitor) \(push) \(flags)")
                    }
                }
            }
        }
        XCTAssertNil(HostSessionPlan.phone(inputMonitorAvailable: false).viewOnlyCause, "a phone hears what it always heard")
    }

    @MainActor
    func testWithoutInputProtectionAControllerHearsThatAndNotTheGate() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(macControl: true)
        rig.monitorAvailable = false
        let peer = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(peer, grant: .control)])
        let service = rig.makeService()
        rig.openPushGate(service)

        let connection = try await rig.connect(service, peer, as: .controller)
        let start = await read(connection, until: isStarted)
        XCTAssertEqual(start?.first, .sessionLimits(grant: .control, limits: ControlMessage.wireLimits(ScreenControllerPolicy.sessionLimits(canControl: false))))
        XCTAssertEqual(start?.last, .inputAvailability(.permissionsRequired))
        XCTAssertEqual(service.session?.viewOnlyCause, .inputProtection)
        XCTAssertEqual(service.session?.canControl, false)
        try await connection.send(.input, InputCodec.encode(.pointerMove(x: 0.5, y: 0.5)))
        try await connection.send(ControlMessage.keyboardAction(id: 4, .latin))
        let answer = await read(connection, until: keyboardAnswer(4))
        XCTAssertNotNil(answer)
        XCTAssertTrue(rig.injected.all.isEmpty)
        connection.close()
    }

    // MARK: D-3 a locked Mac (SR-28)

    func testLockedInputRules() {
        XCTAssertTrue(ControllerLockedInput.admits(locked: false, lockedInputOpen: false))
        XCTAssertTrue(ControllerLockedInput.admits(locked: true, lockedInputOpen: true))
        XCTAssertFalse(ControllerLockedInput.admits(locked: true, lockedInputOpen: false))
        XCTAssertFalse(ControllerLockedInput.admits(locked: nil, lockedInputOpen: true), "a state the system cannot tell is out of reach")
        let keyDown = InputEvent.key(code: 0, isDown: true, modifiers: []), keyUp = InputEvent.key(code: 0, isDown: false, modifiers: [])
        for locked in [true, nil] as [Bool?] {
            XCTAssertFalse(ControllerLockedInput.admits(keyDown, locked: locked, lockedInputOpen: false))
            XCTAssertFalse(ControllerLockedInput.admits(.button(.left, isDown: true), locked: locked, lockedInputOpen: false))
            XCTAssertFalse(ControllerLockedInput.admits(.pointerMove(x: 0.5, y: 0.5), locked: locked, lockedInputOpen: false))
            XCTAssertTrue(ControllerLockedInput.admits(keyUp, locked: locked, lockedInputOpen: false), "letting go always reaches the Mac")
            XCTAssertTrue(ControllerLockedInput.admits(.button(.left, isDown: false), locked: locked, lockedInputOpen: false))
        }
        XCTAssertTrue(ControllerLockedInput.admits(keyDown, locked: true, lockedInputOpen: true))
        XCTAssertFalse(ControllerLockedInput.admits(keyDown, locked: nil, lockedInputOpen: true))

        // Open only for a controller that may control, in a build that passed S0-2.
        let lockedBuild = ScreenBuildFlags(macControl: true, lockedInput: true)
        XCTAssertTrue(HostSessionPlan.phone(inputMonitorAvailable: true).lockedInputOpen, "phones keep what they always did")
        XCTAssertTrue(HostSessionPlan.controller(grant: .control, inputMonitorAvailable: true, pushLive: true, flags: lockedBuild).lockedInputOpen)
        XCTAssertFalse(HostSessionPlan.controller(grant: .control, inputMonitorAvailable: true, pushLive: true,
                                                  flags: ScreenBuildFlags(macControl: true)).lockedInputOpen, "a build without S0-2")
        XCTAssertFalse(HostSessionPlan.controller(grant: .view, inputMonitorAvailable: true, pushLive: true, flags: lockedBuild).lockedInputOpen)
        XCTAssertFalse(HostSessionPlan.controller(grant: .control, inputMonitorAvailable: true, pushLive: false, flags: lockedBuild).lockedInputOpen,
                       "the push gate")
        XCTAssertFalse(HostSessionPlan.controller(grant: .control, inputMonitorAvailable: false, pushLive: true, flags: lockedBuild).lockedInputOpen)
    }

    func testTheInputPathKeepsAControllerOffALockedMac() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "input-path-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "remote-input.json")
        let lock = LockBox()
        let probe: PhysicalInputProbe = { PhysicalInputSnapshot(available: true) }
        let move = InputEvent.pointerMove(x: 0.5, y: 0.5), keyUp = InputEvent.key(code: 0, isDown: false, modifiers: [])
        func run(_ plan: HostSessionPlan, locked: Bool?) -> (posted: [InputEvent], typed: [String], result: ScreenTextReturnResult, marked: Bool) {
            try? FileManager.default.removeItem(at: url)
            lock.set(locked)
            let marker = RemoteInputMarker(url: url, session: plan.peerClass)
            let path = HostInputPath(plan: plan, marker: marker, locked: { lock.value })
            var posted: [InputEvent] = [], typed: [String] = []
            path.inject(move) { posted.append($0) }
            path.inject(keyUp) { posted.append($0) }
            let result = path.type("암호", physicalInput: probe) { text, _ in typed.append(text); return .posted }
            marker.settle()
            let marked = FileManager.default.fileExists(atPath: url.path)
            marker.remove()
            marker.settle()
            return (posted, typed, result, marked)
        }
        let closed = HostSessionPlan.controller(grant: .control, inputMonitorAvailable: true, pushLive: true, flags: ScreenBuildFlags(macControl: true))
        for locked in [true, nil] as [Bool?] {
            let held = run(closed, locked: locked)
            XCTAssertEqual(held.posted, [keyUp], "only letting go reaches a locked Mac")
            XCTAssertEqual(held.typed, [])
            XCTAssertEqual(held.result, .blocked)
        }
        let unlocked = run(closed, locked: false)
        XCTAssertEqual(unlocked.posted, [move, keyUp])
        XCTAssertEqual(unlocked.typed, ["암호"])
        XCTAssertEqual(unlocked.result, .posted)
        XCTAssertTrue(unlocked.marked, "input that reached the Mac is marked for the sidecar")

        let opened = HostSessionPlan.controller(grant: .control, inputMonitorAvailable: true, pushLive: true,
                                                flags: ScreenBuildFlags(macControl: true, lockedInput: true))
        let typedIntoLocked = run(opened, locked: true)
        XCTAssertEqual(typedIntoLocked.posted, [move, keyUp])
        XCTAssertEqual(typedIntoLocked.typed, ["암호"])
        XCTAssertEqual(run(opened, locked: nil).posted, [keyUp], "never where the system cannot tell")

        let phone = run(.phone(inputMonitorAvailable: true), locked: true)
        XCTAssertEqual(phone.posted, [move, keyUp], "a phone's input goes as it always did")
        XCTAssertEqual(phone.result, .posted)
    }

    @MainActor
    func testAControllerReachesALockedMacOnlyWhenThePlanOpensIt() async throws {
        for lockedInput in [false, true] {
            let rig = try HostRig()
            rig.flags = ScreenBuildFlags(macControl: true, lockedInput: lockedInput)
            rig.locked.set(true)
            let peer = HostTestSigner()
            try rig.seed(controllers: [try rig.controller(peer, grant: .control)])
            let service = rig.makeService()
            rig.openPushGate(service)

            let connection = try await rig.connect(service, peer, as: .controller)
            let start = await read(connection, until: isStarted)
            XCTAssertEqual(start?.last, .inputAvailability(.ready))
            try await connection.send(.input, InputCodec.encode(.pointerMove(x: 0.3, y: 0.3)))
            try await connection.send(.input, InputCodec.encode(.textAndReturn(id: 9, text: "암호")))
            let answer = await read(connection, until: { if case .textAndReturnResult(9, _) = $0 { true } else { false } })
            if lockedInput {
                XCTAssertEqual(answer?.last, .textAndReturnResult(id: 9, .posted))
                XCTAssertEqual(rig.injected.all, [.pointerMove(x: 0.3, y: 0.3)])
                XCTAssertEqual(rig.typed.all, ["암호"])
            } else {
                XCTAssertEqual(answer?.last, .textAndReturnResult(id: 9, .blocked))
                XCTAssertTrue(rig.injected.all.isEmpty, "\(rig.injected.all)")
                XCTAssertTrue(rig.typed.all.isEmpty)
                XCTAssertFalse(FileManager.default.fileExists(atPath: rig.remoteInputURL.path), "nothing reached the Mac, so nothing is marked")
            }
            connection.close()
        }
    }

    /// The app's streamer runs every input through the path the checks above run (the live closure itself posts real
    /// events, so it is never run here).
    func testTheAppsStreamerUsesTheCheckedInputPath() throws {
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: package.appending(path: "Sources/ScreenHost/ScreenServiceEnvironment.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("HostInputPath(plan: plan, marker: marker, locked: { ScreenLock.isLocked })"))
        XCTAssertTrue(source.contains("path.receiver(physicalInput: probe, inject: { injector.inject($0) }"))
        XCTAssertFalse(source.contains("InputReceiver("), "no input reaches the injector around the path")
        XCTAssertFalse(source.contains("ControllerLockedInput"), "the lock rule lives in the path only")
    }

    // MARK: 6.6, 7.6 remote stop and notifications reach Mac controllers

    @MainActor
    func testRemoteStopReachesAControllersSessionAndRow() async throws {
        let rig = try HostRig()
        rig.net.set(sampleNetwork(1, label: "집 Wi‑Fi"))
        let phone = HostTestSigner(), viewer = HostTestSigner(), other = HostTestSigner()
        try rig.seed(phones: [try rig.phone(phone)], controllers: [try rig.controller(viewer, bound: true), try rig.controller(other, bound: true, name: "2호 Mac")],
                     ownerPhone: false)
        let service = rig.makeService()
        await service.turnOn()
        XCTAssertTrue(service.isOn)

        let now = rig.clock.now
        let state = ScreenPush.remoteStopState(onSince: now, session: nil, devices: service.devices, controllers: service.controllers, at: now)
        XCTAssertEqual(Set(state.registeredAt.keys), [phone.fingerprint, viewer.fingerprint, other.fingerprint],
                       "a controller's row beside the phones'")
        let expired = ScreenPush.remoteStopState(onSince: now, session: nil, devices: service.devices, controllers: service.controllers,
                                                 at: now.addingTimeInterval(RegistrationLifetime.unused + 60))
        XCTAssertTrue(expired.registeredAt.isEmpty, "only registrations still in use")

        let mac = try PinnedMac(publicKey: rig.mac.publicKey, fingerprint: rig.mac.fingerprint)
        let later = now.addingTimeInterval(5)

        // 「이 기기 해지」 from a notification that named the controller: its row goes, its session ends revoked.
        let first = try await rig.connect(service, viewer, as: .controller)
        let started1 = await read(first, until: isStarted)
        XCTAssertNotNil(started1)
        let named = try RemoteCommand(mac: mac, deviceKey: phone.publicKey, action: .revokeDevice(viewer.fingerprint), issuedAt: later)
        XCTAssertEqual(ScreenPush.apply(named, to: service, onSince: now, at: later), .applied)
        let revoked = await ending(of: first)
        XCTAssertEqual(revoked, .reason(.revoked))
        XCTAssertEqual(try rig.store.controllers().controllers.map(\.id), [other.id])

        // A command sent before a controller was approved here does not reach it.
        let stale = try RemoteCommand(mac: mac, deviceKey: phone.publicKey, action: .revokeDevice(other.fingerprint),
                                      issuedAt: now.addingTimeInterval(-3600))
        XCTAssertEqual(ScreenPush.apply(stale, to: service, onSince: now, at: later), .superseded)
        XCTAssertEqual(try rig.store.controllers().controllers.map(\.id), [other.id])

        // 「이 기기 해지」 from the menu while another controller watches: the one connected now goes.
        let second = try await rig.connect(service, other, as: .controller)
        let started2 = await read(second, until: isStarted)
        XCTAssertNotNil(started2)
        let connected = try RemoteCommand(mac: mac, deviceKey: phone.publicKey, action: .revokeConnected, issuedAt: later)
        XCTAssertEqual(ScreenPush.apply(connected, to: service, onSince: now, at: later), .applied)
        let revokedToo = await ending(of: second)
        XCTAssertEqual(revokedToo, .reason(.revoked))
        XCTAssertTrue(try rig.store.controllers().controllers.isEmpty)
        XCTAssertEqual(service.controllerHistory.filter { $0.event == .removed }.map(\.controllerID), [viewer.id, other.id])
        let gone = try RemoteCommand(mac: mac, deviceKey: phone.publicKey, action: .revokeDevice(viewer.fingerprint), issuedAt: later)
        XCTAssertEqual(ScreenPush.apply(gone, to: service, onSince: now, at: later), .nothingToDo, "nothing left to revoke")
        service.turnOff()
        XCTAssertEqual(ScreenPush.apply(gone, to: service, onSince: now, at: later), .nothingToDo, "off: nothing to take away")
    }

    @MainActor
    func testControllerEventsAreKindsThreeAndFourToThePhonesInUse() throws {
        let clock = TestClock()
        func phone(_ signer: HostTestSigner, _ name: String) throws -> RegisteredDevice {
            let record = try RegistrationRecord(macFingerprint: Data(repeating: 7, count: 32), codeID: Data(repeating: 9, count: RegistrationCode.idSize),
                                                devicePublicKey: signer.publicKey, deviceName: name, deviceModel: "iPhone16,1")
            return RegisteredDevice(record: record, attestationKeyID: Data(repeating: 1, count: 32), at: clock.now)
        }
        let phoneA = HostTestSigner(), phoneB = HostTestSigner(), viewer = HostTestSigner(), mac = HostTestSigner()
        let phones = [try phone(phoneA, "iPhone"), try phone(phoneB, "iPad")]
        let controller = RegisteredController(publicKey: viewer.publicKey, name: "1호 MacBook Pro", model: "Mac16,7",
                                              enrollment: try .directSAS(attestation: nil), at: clock.now)
        for kind in [ScreenEventKind.controllerConnected, .controllerRegistered] {
            let event = try XCTUnwrap(ScreenPush.controllerEvent(kind, controller: controller, devices: phones, macKey: mac.publicKey,
                                                                  macName: "Mac", at: clock.now))
            XCTAssertEqual(event.kind, kind)
            XCTAssertEqual(event.actorID, viewer.fingerprint, "the controller's fingerprint is the actor")
            XCTAssertEqual(event.actorName, "1호 MacBook Pro")
            XCTAssertEqual(Set(event.recipients), [phoneA.fingerprint, phoneB.fingerprint])
        }
        for kind in [ScreenEventKind.connected, .registered] {
            XCTAssertNil(ScreenPush.controllerEvent(kind, controller: controller, devices: phones, macKey: mac.publicKey, macName: "Mac", at: clock.now),
                         "a phone's kind is never told for a controller")
        }
        XCTAssertNil(ScreenPush.controllerEvent(.controllerConnected, controller: controller, devices: [], macKey: mac.publicKey,
                                                macName: "Mac", at: clock.now), "no phone left to tell")
        XCTAssertNil(ScreenPush.controllerEvent(.controllerRegistered, controller: controller, devices: phones, macKey: mac.publicKey,
                                                macName: "Mac", at: clock.now.addingTimeInterval(RegistrationLifetime.unused + 60)),
                     "expired phones are not told")
    }

    // MARK: 6.3 enrolment (SR-19, SR-22, 7.6)

    @MainActor
    func testEnrollmentTurnsTheSwitchOnAndIsToldAsKindFourThenConnectionsAsKindThree() async throws {
        let rig = try HostRig()
        let transport = RecordingPushTransport()
        rig.pushTransport = transport
        let viewer = HostTestSigner()
        try rig.seed(allow: false)
        let service = rig.makeService()
        XCTAssertFalse(service.macControllers.allowMacControllers)

        try service.enrollController(try rig.controller(viewer, bound: true))
        XCTAssertTrue(service.macControllers.allowMacControllers, "approving the first enrolment turns the switch on")
        XCTAssertEqual(try rig.store.controllers().allowMacControllers, true)
        XCTAssertEqual(service.controllerHistory.last?.event, .paired)
        let toldEnrolment = await eventually { transport.events.all.count == 1 }
        XCTAssertTrue(toldEnrolment)
        XCTAssertEqual(transport.events.all.first?.kind, .controllerRegistered)
        XCTAssertEqual(transport.events.all.first?.actorID, viewer.fingerprint)
        XCTAssertEqual(transport.events.all.first?.recipients, [rig.ownerPhone.fingerprint])

        let connection = try await rig.connect(service, viewer, as: .controller)
        let started = await read(connection, until: isStarted)
        XCTAssertNotNil(started)
        let toldConnection = await eventually { transport.events.all.count == 2 }
        XCTAssertTrue(toldConnection)
        XCTAssertEqual(transport.events.all.last?.kind, .controllerConnected)
        XCTAssertEqual(transport.events.all.last?.actorID, viewer.fingerprint)
        connection.close()
    }

    @MainActor
    func testEnrollmentRefusesAPhonesKeyEvenWhenThePhonesDidNotLoad() async throws {
        let rig = try HostRig()
        let both = HostTestSigner()
        try rig.seed(phones: [try rig.phone(both)], allow: false)
        rig.items.failReads(["devices"])
        let service = rig.makeService()
        XCTAssertTrue(service.devices.isEmpty, "the phones could not be read at launch")
        rig.items.failReads([])

        XCTAssertThrowsError(try service.enrollController(try rig.controller(both))) { error in
            XCTAssertEqual(error as? ScreenControllerError, .registeredAsPhone)
        }
        // While the phones cannot be read, nothing is enrolled at all.
        rig.items.failReads(["devices"])
        XCTAssertThrowsError(try service.enrollController(try rig.controller(HostTestSigner())))
        rig.items.failReads([])
        XCTAssertTrue(try rig.store.controllers().controllers.isEmpty)
        XCTAssertFalse(try rig.store.controllers().allowMacControllers, "nothing changed")
        XCTAssertFalse(service.macControllers.allowMacControllers)
        XCTAssertTrue(service.controllerHistory.isEmpty)
    }
}

private extension ControlMessage {
    var isKeyboardApplied: Bool { if case .keyboardState(_, _, .applied) = self { true } else { false } }
}
#endif
