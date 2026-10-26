import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import os
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// During a session (DESIGN 「3) 세션 동안」): the limits, the Mac's goodbye with a reason, local input winning, letting
// go of held input however a session ends (SR-16), and registrations expiring after 90 days without use (SR-13).
// Time is a clock the checks move by hand; nothing waits ten real minutes and nothing touches the real HID system.

/// A clock a check moves by hand. Sleepers wake when `advance` passes their deadline, or throw when cancelled.
final class ManualClock: Sendable {
    private struct Sleeper {
        let deadline: ContinuousClock.Instant
        let continuation: CheckedContinuation<Void, Error>
    }

    private struct State {
        var now: ContinuousClock.Instant
        var sleepers: [UUID: Sleeper] = [:]
        var cancelled = Set<UUID>()
    }

    let start: ContinuousClock.Instant
    private let state: OSAllocatedUnfairLock<State>

    init() {
        start = .now
        state = OSAllocatedUnfairLock(initialState: State(now: start))
    }

    var now: ContinuousClock.Instant { state.withLock { $0.now } }

    /// Tasks sleeping now. A task that sleeps for a while from "now" must be asleep before the clock moves.
    var sleeperCount: Int { state.withLock { $0.sleepers.count } }

    func advance(by duration: Duration) {
        let due = state.withLock { state -> [CheckedContinuation<Void, Error>] in
            state.now += duration
            let due = state.sleepers.filter { $0.value.deadline <= state.now }
            for id in due.keys { state.sleepers[id] = nil }
            return due.values.map(\.continuation)
        }
        for continuation in due { continuation.resume() }
    }

    func sleep(until deadline: ContinuousClock.Instant) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let ready: Result<Void, Error>? = state.withLock { state in
                    if state.cancelled.remove(id) != nil { return .failure(CancellationError()) }
                    if deadline <= state.now { return .success(()) }
                    state.sleepers[id] = Sleeper(deadline: deadline, continuation: continuation)
                    return nil
                }
                if let ready { continuation.resume(with: ready) }
            }
        } onCancel: {
            let waiting = state.withLock { state -> CheckedContinuation<Void, Error>? in
                if let sleeper = state.sleepers.removeValue(forKey: id) { return sleeper.continuation }
                state.cancelled.insert(id)
                return nil
            }
            waiting?.resume(throwing: CancellationError())
        }
    }

    var session: SessionClock { SessionClock(now: { [self] in now }, sleep: { [self] in try await sleep(until: $0) }) }
}

/// The HID system's clock of recent input, as the Mac reads it: the last event of each kind, local or injected
/// (the case where injected events are counted, which is the harder one for telling them apart).
final class FakeHID: Sendable {
    private let clock: ManualClock
    private let last = OSAllocatedUnfairLock(initialState: [LocalInputKind: ContinuousClock.Instant]())
    private let reads = OSAllocatedUnfairLock(initialState: 0)

    init(clock: ManualClock) { self.clock = clock }

    /// Someone at the Mac used it now.
    func local(_ kind: LocalInputKind) { last.withLock { $0[kind] = clock.now } }
    /// The session injected an event now.
    func injected(_ event: InputEvent) { last.withLock { $0[event.localKind] = clock.now } }

    var readCount: Int { reads.withLock { $0 } }

    var probe: LocalInputProbe {
        { [self] kind in
            reads.withLock { $0 += 1 }
            return last.withLock { $0[kind] }.map { seconds(clock.now - $0) }
        }
    }
}

/// Emits no frame and counts the phone's keyframe requests: the Mac handles records in order, so a request seen means
/// every record sent before it was handled.
final class KeyframeCounter: PictureEncoding {
    private let count = OSAllocatedUnfairLock(initialState: 0)
    func encode(_ image: CVPixelBuffer, at time: CMTime) {}
    func requestKeyframe() { count.withLock { $0 += 1 } }
    var requests: Int { count.withLock { $0 } }
}

/// One session over TCP on 127.0.0.1: the phone's viewer and the Mac's pump, the pump on a hand-moved clock.
struct LoopbackSession {
    let listener: ScreenListener
    let viewer: ScreenViewer
    let pump: VideoPump
    let input: InputReceiver
    let running: Task<Void, Error>
    let pictures: Task<Void, Error>
    let injected: Collector<InputEvent>
    let keyframes: KeyframeCounter

    static func open(clock: ManualClock, limits: SessionLimits = .standard, hid: FakeHID? = nil) async throws -> LoopbackSession {
        let fixture = Fixture()
        let (listener, endpoint) = try await loopbackListener(fixture.mac)
        let viewer = try await within(5) {
            try await ScreenViewer.connect(to: endpoint, mac: pinned(fixture.macSigner.publicKey), signer: fixture.deviceSigner)
        }
        let mac = try await nextSession(listener)
        let injected = Collector<InputEvent>()
        let input = InputReceiver { event in
            injected.add(event)
            hid?.injected(event)
        }
        let keyframes = KeyframeCounter()
        let pump = try VideoPump(connection: mac.connection, input: input, limits: limits, clock: clock.session,
                                 localInput: hid?.probe) { _ in keyframes }
        let running = Task { try await pump.run() }
        let pictures = Task { for try await _ in viewer.pictures() {} }
        return LoopbackSession(listener: listener, viewer: viewer, pump: pump, input: input, running: running,
                               pictures: pictures, injected: injected, keyframes: keyframes)
    }

    /// Waits until the Mac has handled every record the phone sent before.
    func handled(line: Int = #line) async throws {
        let before = keyframes.requests
        try await viewer.requestKeyframe()
        try await waitUntil(line: line) { keyframes.requests > before }
    }

    /// Sends from the phone and waits until the Mac has injected `count` events in all.
    func send(_ events: [InputEvent], untilInjected count: Int, line: Int = #line) async throws {
        for event in events { viewer.input(event) }
        try await waitUntil(line: line) { injected.all.count >= count }
    }

    /// Holds the left button and Command, as in the middle of a drag with a modifier.
    func hold() async throws {
        try await send([.button(.left, isDown: true), .key(code: 0x37, isDown: true, modifiers: [.command])], untilInjected: 2)
    }

    var releasedEverything: Bool {
        Array(injected.all.suffix(2)) == [.button(.left, isDown: false), .key(code: 0x37, isDown: false, modifiers: [])]
    }

    func close() async {
        await viewer.close()
        running.cancel()
        _ = await running.result
        _ = await pictures.result
        listener.stop()
    }
}

/// Waits, in real time, until `condition` holds; fails the check after `seconds`.
func waitUntil(_ seconds: Double = 3, line: Int = #line, _ condition: @escaping @Sendable () -> Bool) async throws {
    _ = try await within(seconds, line: line) {
        while !condition() { try await Task.sleep(for: .milliseconds(5)) }
        return true
    }
}

extension ScreenControlChecks {
    func testSessionTimerReasonsAndControlDirections() async throws {
        try check(SessionLimits.standard == SessionLimits(idle: .seconds(600), maximum: .seconds(3600)), "결정 3: ten and sixty minutes")
        let start = ContinuousClock.now
        func at(_ seconds: Int) -> ContinuousClock.Instant { start + .seconds(seconds) }
        var timer = SessionTimer(limits: .standard, started: start)
        try check(timer.expired(at: at(599)) == nil && timer.expired(at: at(600)) == .idle, "ten minutes without input")
        timer.noteInput(at: at(500))
        timer.noteInput(at: at(100))   // an older instant never moves it back
        try check(timer.expired(at: at(1099)) == nil && timer.expired(at: at(1100)) == .idle, "input starts the ten minutes over")
        for second in stride(from: 1000, through: 3500, by: 500) { timer.noteInput(at: at(second)) }
        try check(timer.deadline.reason == .timeLimit && timer.expired(at: at(3599)) == nil
                  && timer.expired(at: at(3600)) == .timeLimit, "sixty minutes however busy")

        for reason in SessionEndReason.allCases {
            try check(SessionEndReason(closePayload: reason.encoded) == reason, "close reason \(reason) round trip")
        }
        for payload in [Data(), Data([0]), Data([99]), Data([1, 0])] {
            try check(SessionEndReason(closePayload: payload) == nil, "no reason in \([UInt8](payload))")
        }

        try check(ControlMessage.requestKeyframe.sender == .device && ControlMessage.remoteInputPaused.sender == .mac
                  && ControlMessage.remoteInputResumed.sender == .mac, "each control message has one sender")
        for message in [ControlMessage.remoteInputPaused, .remoteInputResumed] {
            try check(try ControlMessage(decoding: message.encoded) == message, "control \(message) round trip")
        }
    }

    func testLocalPriorityTellsLocalInputFromInjected() async throws {
        let start = ContinuousClock.now
        func at(_ seconds: Double) -> ContinuousClock.Instant { start + .seconds(seconds) }
        var seen: [LocalInputKind: ContinuousClock.Instant] = [:]
        var now = start
        func probe() -> LocalInputProbe {
            let snapshot = seen, current = now
            return { kind in snapshot[kind].map { seconds(current - $0) } }
        }
        var priority = LocalPriority()
        try check(priority.update(probe(), at: now) == nil && !priority.isPaused, "nothing seen, nothing paused")

        // The session's own events, as the HID system may count them, never pause it: at the same moment or within the
        // tolerance after.
        priority.noteInjected(.pointer, at: at(10))
        priority.noteInjected(.key, at: at(10))
        seen = [.pointer: at(10), .key: at(10.2)]
        now = at(10.3)
        try check(priority.update(probe(), at: now) == nil, "injected events are not local")

        // A key the session did not type, while it only moves the pointer, is local at once.
        priority.noteInjected(.pointer, at: at(11))
        seen = [.pointer: at(11), .key: at(11)]
        now = at(11.1)
        try check(priority.update(probe(), at: now) == .paused && priority.isPaused, "a local key pauses remote input")
        now = at(13)
        try check(priority.update(probe(), at: now) == nil && priority.isPaused, "still paused inside the window")
        now = at(14)
        try check(priority.update(probe(), at: now) == .resumed && !priority.isPaused, "resumes three seconds after the last local event")

        // When injected events are not counted, the latest event is local even if the session injected after it.
        var uncounted = LocalPriority()
        uncounted.noteInjected(.pointer, at: at(21))
        seen = [.pointer: at(20)]
        now = at(21.1)
        try check(uncounted.update(probe(), at: now) == .paused, "a local move a second before an injected one is still local")

        // Old, missing and nonsense readings change nothing.
        var quiet = LocalPriority()
        seen = [.scroll: at(25)]
        now = at(28.5)
        try check(quiet.update(probe(), at: now) == nil, "older than the window")
        for reading in [Double.nan, -1, .infinity] {
            try check(quiet.update({ _ in reading }, at: now) == nil, "reading \(reading) ignored")
        }
    }

    func testInputReceiverPausesForLocalInputAndLetsGo() async throws {
        let start = ContinuousClock.now
        let injected = Collector<InputEvent>()
        let receiver = InputReceiver { injected.add($0) }
        try receiver.receive(InputCodec.encode(.button(.left, isDown: true)), at: start)
        try receiver.receive(InputCodec.encode(.key(code: 0x37, isDown: true, modifiers: [.command])), at: start)
        let localKey: LocalInputProbe = { $0 == .key ? 0 : nil }
        try check(receiver.checkLocalInput(localKey, at: start + .seconds(1)) == .paused, "someone types at the Mac")
        try check(injected.all.suffix(2) == [.button(.left, isDown: false), .key(code: 0x37, isDown: false, modifiers: [])],
                  "pausing lets go of what the phone held: \(injected.all)")
        try receiver.receive(InputCodec.encode(.pointerMove(x: 0.5, y: 0.5)), at: start + .seconds(2))
        try check(injected.all.count == 4, "the phone's input is dropped while paused")
        try await expectError(InputError.malformed) { try receiver.receive(Data([0xFF]), at: start + .seconds(2)) }
        try check(receiver.checkLocalInput({ _ in nil }, at: start + .seconds(4)) == .resumed, "resumes once the Mac is still")
        try receiver.receive(InputCodec.encode(.pointerMove(x: 0.25, y: 0.5)), at: start + .seconds(4))
        try check(injected.all.last == .pointerMove(x: 0.25, y: 0.5), "the phone's input flows again")

        try receiver.receive(InputCodec.encode(.button(.right, isDown: true)), at: start + .seconds(5))
        receiver.finish(at: start + .seconds(5))
        try check(injected.all.last == .button(.right, isDown: false), "finishing lets go")
        try receiver.receive(InputCodec.encode(.button(.right, isDown: true)), at: start + .seconds(6))
        try check(injected.all.last == .button(.right, isDown: false), "nothing is injected after the session ended")
        try check(receiver.checkLocalInput(localKey, at: start + .seconds(7)) == nil, "an ended session never pauses or resumes")
    }

    func testSessionLimitsEndTheSessionAndTellThePhone() async throws {
        // Ten minutes without input. The phone's held button is let go and the phone hears why.
        let clock = ManualClock()
        let idle = try await LoopbackSession.open(clock: clock)
        try await idle.send([.button(.left, isDown: true)], untilInjected: 1)
        // Only input counts. A phone that just watches still asks for keyframes; that is no one at the phone (DESIGN 3).
        clock.advance(by: .seconds(300))
        try await idle.handled()
        clock.advance(by: .seconds(299))
        try await idle.handled()
        try await Task.sleep(for: .milliseconds(100))
        try check(idle.pump.endReason == nil && idle.viewer.endReason == nil, "alive after 9:59")
        clock.advance(by: .seconds(1))
        // Awaiting the session itself cannot be cut short; this fails instead of hanging if the session lives on.
        try await waitUntil { idle.pump.endReason != nil }
        try await within(3) { try await idle.running.value }
        try await within(3) { try await idle.pictures.value }
        try check(idle.pump.endReason == .idle && idle.viewer.endReason == .idle, "ended for being idle, and the phone knows")
        try check(idle.injected.all.last == .button(.left, isDown: false), "the held button is let go")
        await idle.close()

        // Sixty minutes, however busy. Input every 500 s keeps the idle limit away.
        let busyClock = ManualClock()
        let busy = try await LoopbackSession.open(clock: busyClock)
        for round in 1...7 {
            try await busy.send([.pointerMove(x: 0.5, y: Double(round) / 10)], untilInjected: round)
            busyClock.advance(by: .seconds(500))
        }
        try await busy.send([.key(code: 0x37, isDown: true, modifiers: [.command])], untilInjected: 8)
        busyClock.advance(by: .seconds(99))
        try await Task.sleep(for: .milliseconds(100))
        try check(busy.pump.endReason == nil, "alive at 59:59")
        busyClock.advance(by: .seconds(1))
        try await within(3) { try await busy.running.value }
        try await within(3) { try await busy.pictures.value }
        try check(busy.pump.endReason == .timeLimit && busy.viewer.endReason == .timeLimit, "ended at sixty minutes")
        try check(busy.injected.all.last == .key(code: 0x37, isDown: false, modifiers: []), "Command is let go")

        // Reconnecting is a new key exchange; the old session's input goes nowhere.
        busy.viewer.input(.button(.left, isDown: true))
        try await Task.sleep(for: .milliseconds(100))
        try check(busy.injected.all.count == 9, "nothing injected after the end")
        await busy.close()
    }

    func testEveryWayASessionEndsLetsGo() async throws {
        // The Mac ends it (disconnect, revoke, turning off, replacing, quitting): let go before `end` returns, so it
        // holds even when the process exits right after; then the phone hears why.
        let clock = ManualClock()
        let revoked = try await LoopbackSession.open(clock: clock)
        try await revoked.hold()
        let goodbye = revoked.pump.end(.revoked)
        try check(revoked.releasedEverything, "let go before end returned: \(revoked.injected.all)")
        try check(revoked.pump.end(.idle) == goodbye && revoked.pump.endReason == .revoked, "only the first reason counts")
        await goodbye.value
        try await within(3) { try await revoked.running.value }
        try await within(3) { try await revoked.pictures.value }
        try check(revoked.viewer.endReason == .revoked, "the phone hears it was revoked")
        try check(revoked.injected.all.count == 4, "nothing pressed twice or released twice")
        await revoked.close()

        // The phone says goodbye.
        let left = try await LoopbackSession.open(clock: clock)
        try await left.hold()
        await left.viewer.close()
        try await within(3) { try await left.running.value }
        try check(left.releasedEverything && left.pump.endReason == nil, "the phone left: \(left.injected.all)")
        await left.close()

        // The phone vanishes without a word (out of range, killed).
        let vanished = try await LoopbackSession.open(clock: clock)
        try await vanished.hold()
        vanished.viewer.connection.close()
        _ = try await within(3) { await vanished.running.result }
        try check(vanished.releasedEverything, "the connection dropped: \(vanished.injected.all)")
        await vanished.close()

        // The task running the session is cancelled.
        let cancelled = try await LoopbackSession.open(clock: clock)
        try await cancelled.hold()
        cancelled.running.cancel()
        _ = try await within(3) { await cancelled.running.result }
        try check(cancelled.releasedEverything, "cancelled: \(cancelled.injected.all)")
        await cancelled.close()

        // Local input pausing the phone lets go too (testLocalInputPausesRemoteInputOverTheSession).
    }

    func testLocalInputPausesRemoteInputOverTheSession() async throws {
        let clock = ManualClock()
        let hid = FakeHID(clock: clock)
        let session = try await LoopbackSession.open(clock: clock, hid: hid)
        let notices = Collector<ScreenNotice>()
        let listening = Task { for await notice in session.viewer.notices { notices.add(notice) } }
        defer { listening.cancel() }
        /// One look at the HID system. The Mac's poll sleeps a while from when it last looked, so the clock moves only
        /// once it sleeps again, beside the session limits.
        func poll() async throws {
            try await waitUntil { clock.sleeperCount == 2 }
            let before = hid.readCount
            clock.advance(by: .milliseconds(250))
            try await waitUntil { hid.readCount >= before + LocalInputKind.allCases.count }
        }

        // The phone's own moves and clicks reach the HID system too; they never pause it.
        try await session.send([.pointerMove(x: 0.1, y: 0.1), .button(.left, isDown: true), .pointerMove(x: 0.2, y: 0.2)],
                               untilInjected: 3)
        for _ in 0..<4 { try await poll() }
        try check(!session.input.isPaused && notices.all.isEmpty, "injected input is not local input")

        // Someone at the Mac types: the phone's drag is let go and the phone is told.
        hid.local(.key)
        try await poll()
        try await waitUntil { notices.all == [.remoteInputPaused] }
        try check(session.injected.all.last == .button(.left, isDown: false), "the phone's drag is let go")
        // Dropped while paused, and seen to be handled before the clock moves on.
        try await session.viewer.connection.send(.input, InputCodec.encode(.pointerMove(x: 0.9, y: 0.9)))
        try await session.handled()

        // Still for three seconds: the phone has the Mac back.
        for _ in 0..<12 { try await poll() }
        try await waitUntil { notices.all == [.remoteInputPaused, .remoteInputResumed] }
        try await session.send([.pointerMove(x: 0.3, y: 0.3)], untilInjected: 5)
        try check(session.injected.all == [.pointerMove(x: 0.1, y: 0.1), .button(.left, isDown: true), .pointerMove(x: 0.2, y: 0.2),
                                           .button(.left, isDown: false), .pointerMove(x: 0.3, y: 0.3)],
                  "the move made while paused never arrived: \(session.injected.all)")

        // Only the Mac may say who has the input: a phone that sends it ends its session.
        try await session.viewer.connection.send(.control, ControlMessage.remoteInputResumed.encoded)
        try await expectError(ScreenControlWireError.malformed) { try await within(3) { try await session.running.value } }
        await session.close()
    }

    func testRegistrationsExpireAfterNinetyDaysWithoutUse() async throws {
        let day: TimeInterval = 24 * 60 * 60
        try check(RegistrationLifetime.unused == 90 * day, "SR-13: ninety days")
        let registered = Date(timeIntervalSince1970: 1_800_000_000)
        @Sendable func days(_ n: Double) -> Date { registered.addingTimeInterval(n * day) }
        try check(!RegistrationLifetime.isExpired(registeredAt: registered, lastConnectedAt: nil, at: days(89.99)), "alive at day 89")
        try check(RegistrationLifetime.isExpired(registeredAt: registered, lastConnectedAt: nil, at: days(90)), "expired at day 90")
        try check(!RegistrationLifetime.isExpired(registeredAt: registered, lastConnectedAt: days(60), at: days(149)),
                  "a connection starts the ninety days over")
        try check(RegistrationLifetime.isExpired(registeredAt: registered, lastConnectedAt: days(60), at: days(150)), "until it runs out")
        try check(!RegistrationLifetime.isExpired(registeredAt: registered, lastConnectedAt: nil, at: days(-30)),
                  "a clock set back never expires anything early")

        // At the key exchange, an expired device is refused like an unknown one, before the Mac signs anything.
        let now = OSAllocatedUnfairLock(initialState: days(89))
        let keys = RegisteredDeviceKeys(now: { now.withLock { $0 } })
        let macSigner = CountingSigner(), deviceSigner = SoftwareSigner()
        keys.set([.init(publicKey: deviceSigner.publicKey, registeredAt: registered, lastConnectedAt: nil)])
        let mac = MacHandshake(signer: macSigner, replay: NonceReplayCache()) { keys.key(for: $0) }
        func attempt() -> DeviceHandshake { DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: deviceSigner.publicKey) }
        _ = try await mac.respond(to: attempt().hello)
        now.withLock { $0 = days(90) }
        let signed = await macSigner.counter.count
        try await expectError(HandshakeError.unknownDevice) { _ = try await mac.respond(to: attempt().hello) }
        try check(await macSigner.counter.count == signed, "refused before the Mac signs")

        // Registering again at the Mac renews it; so does a connection while it lived.
        keys.set([.init(publicKey: deviceSigner.publicKey, registeredAt: days(90), lastConnectedAt: nil)])
        _ = try await mac.respond(to: attempt().hello)
        keys.set([.init(publicKey: deviceSigner.publicKey, registeredAt: registered, lastConnectedAt: days(80))])
        now.withLock { $0 = days(169) }
        _ = try await mac.respond(to: attempt().hello)
        now.withLock { $0 = days(170) }
        try await expectError(HandshakeError.unknownDevice) { _ = try await mac.respond(to: attempt().hello) }

        // A store written before re-registering replaced the row can hold two rows for one key: the first approval, which
        // connections kept renewing, and a later one. They are one registration, alive from the last use of either,
        // whatever their order.
        let renewed = RegisteredDeviceKeys.Entry(publicKey: deviceSigner.publicKey, registeredAt: registered, lastConnectedAt: days(150))
        let approvedAgain = RegisteredDeviceKeys.Entry(publicKey: deviceSigner.publicKey, registeredAt: days(50), lastConnectedAt: nil)
        now.withLock { $0 = days(239) }
        for rows in [[renewed, approvedAgain], [approvedAgain, renewed]] {
            keys.set(rows)
            _ = try await mac.respond(to: attempt().hello)
        }
        now.withLock { $0 = days(240) }
        try await expectError(HandshakeError.unknownDevice) { _ = try await mac.respond(to: attempt().hello) }
        // The Mac's list merges such rows the same way when it reads them, so the menu, each connection and the key
        // exchange see one row: the latest approval, with the latest connection any of them saw.
        struct Row: ExpiringRegistration, Equatable {
            let id: String, name: String, registeredAt: Date
            var lastConnectedAt: Date?
        }
        let stored = [Row(id: "a", name: "first", registeredAt: registered, lastConnectedAt: days(150)),
                      Row(id: "b", name: "other", registeredAt: days(10), lastConnectedAt: nil),
                      Row(id: "a", name: "again", registeredAt: days(50), lastConnectedAt: days(20)),
                      Row(id: "b", name: "older", registeredAt: days(5), lastConnectedAt: nil)]
        try check(stored.oneRowPerDevice() == [Row(id: "b", name: "other", registeredAt: days(10), lastConnectedAt: nil),
                                               Row(id: "a", name: "again", registeredAt: days(50), lastConnectedAt: days(150))],
                  "one row per device: \(stored.oneRowPerDevice())")
        try check(Array(stored.prefix(2)).oneRowPerDevice() == Array(stored.prefix(2)), "rows already one per device stay as they are")

        // Keyed by each key's own fingerprint, so a row can never lend its dates or key to another device.
        try check(keys.key(for: ScreenControlIdentity.fingerprint(of: SoftwareSigner().publicKey)) == nil, "unknown stays unknown")
    }
}
