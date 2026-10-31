import CoreMedia
import CoreVideo
import Foundation
import os

#if os(macOS)

/// What the pump needs from an encoder: `VideoEncoder`, or a stand-in in checks.
protocol PictureEncoding: Sendable {
    func encode(_ image: CVPixelBuffer, at time: CMTime)
    func requestKeyframe()
}

extension VideoEncoder: PictureEncoding {}

public protocol DesktopControlling: Sendable {
    func keyboardState() async -> ScreenKeyboardState
    func keyboard(_ action: ScreenKeyboardAction) async -> (ScreenKeyboardState, ScreenControlResult)
    func navigate(_ action: ScreenSpaceAction) async -> ScreenControlResult
    func spaceChanges() async -> AsyncStream<Bool>
}

/// Where an encoder's frames go.
typealias EncoderOutput = @Sendable (Result<VideoFrame, VideoError>) -> Void

/// What a version-2 session offers beside the picture and input (DESIGN 「버전 협상」). `VideoPump.run` leaves all of it
/// out of a version-1 session: that phone hears none of it, and asking for any of it is a malformed message there.
public struct SessionFeatures: Sendable {
    /// Makes a stream of whether the Mac's screen is locked: the state now, then each change. Called only for a
    /// version-2 session, which tells the phone outside the picture; the stream ends with the session.
    public var lockStates: (@Sendable () -> AsyncStream<Bool>)?
    /// The displays the phone may choose between, and the cursor in the picture.
    public var capture: (any CaptureControl)?
    /// Turns screen control off at the Mac, as its menu's 끄기 does. The pump has already ended the session with
    /// `turnedOffFromDevice` when it calls this. Without it, the phone's request changes nothing, and so does a request
    /// read after the Mac ended the session for another reason.
    public var turnOff: (@Sendable () -> Void)?
    public var desktop: (any DesktopControlling)?
    public var reportsInputAvailability: Bool
    public var pointerPosition: (@Sendable () -> ScreenPointerPosition?)?

    public init(lockStates: (@Sendable () -> AsyncStream<Bool>)? = nil, capture: (any CaptureControl)? = nil,
                turnOff: (@Sendable () -> Void)? = nil, desktop: (any DesktopControlling)? = nil,
                reportsInputAvailability: Bool = false, pointerPosition: (@Sendable () -> ScreenPointerPosition?)? = nil) {
        self.lockStates = lockStates
        self.capture = capture
        self.turnOff = turnOff
        self.desktop = desktop
        self.reportsInputAvailability = reportsInputAvailability
        self.pointerPosition = pointerPosition
    }
}

/// The Mac's half of a session after the key exchange: captured pictures in, `.video` records out, the phone's
/// control and input records answered. When the network falls behind, a picture is skipped *before* encoding; an encoded frame
/// is never dropped, because later delta frames depend on it.
///
/// The pump also holds the session to its limits (`SessionLimits`), pauses remote input while someone at the Mac uses
/// it (`LocalPriority`), and ends the session on the Mac's word (`end`). However the session ends, everything the
/// phone held down is let go (SR-16).
///
/// A display change replaces the encoder (`restartEncoder`). Each encoder is a generation: pictures offered for an
/// older one are skipped and frames an older one still emits are dropped, so after a change the next frame on the wire is
/// the new encoder's first, a keyframe carrying the new size's parameter sets.
public final class VideoPump: @unchecked Sendable {
    public struct Statistics: Sendable {
        public var offered = 0
        public var skipped = 0
        public var sent = 0
        public var bytes = 0
    }

    /// Encoded frames not yet on the wire before new pictures are skipped. Pictures handed to the encoder do not
    /// count: a real-time encoder drops some without ever emitting them (measured: 1 in 12 at 3440×1440) and holds a
    /// few at large sizes, so counting them leaked the backlog until the feed stopped for good.
    static let maxBacklog = 3
    /// How long the Mac waits for its `.close` to leave before closing anyway.
    static let goodbyeTimeout: Duration = .seconds(1)

    typealias EncoderFactory = @Sendable (VideoEncoder.Settings, @escaping EncoderOutput) throws -> any PictureEncoding

    private struct Ending {
        var timer: SessionTimer
        var reason: SessionEndReason?
        var task: Task<Void, Never>?
    }

    private struct Coding {
        var statistics = Statistics()
        var backlog = 0
        var error: VideoError?
        /// The encoder in use and its generation; 0 until the first.
        var generation: UInt64 = 0
        /// The newest generation handed out, in use or still being made.
        var reserved: UInt64 = 0
        var encoder: (any PictureEncoding)?
    }

    private let connection: SecureConnection
    private let makeEncoder: EncoderFactory?
    private let input: InputReceiver?
    private let clock: SessionClock
    private let localInput: LocalInputProbe?
    private let frames: AsyncStream<VideoFrame>
    private let sink: AsyncStream<VideoFrame>.Continuation
    private let coding = OSAllocatedUnfairLock(initialState: Coding())
    private let ending: OSAllocatedUnfairLock<Ending>
    private let qualityLimiter = OSAllocatedUnfairLock(initialState: TokenBucket(perSecond: 1, burst: 2))

    /// Without `input`, the phone's input records are read and dropped: a view-only session. `localInput` lets
    /// local input win; without it the phone's input is never paused.
    public convenience init(connection: SecureConnection, settings: VideoEncoder.Settings, input: InputReceiver? = nil,
                            limits: SessionLimits = .standard, localInput: LocalInputProbe? = nil) throws {
        self.init(connection: connection, input: input, limits: limits, localInput: localInput,
                  encoderFactory: { try VideoEncoder($0, output: $1) })
        try restartEncoder(settings)
    }

    /// For a capture that picks its display after the key exchange (`HostCapture`): pictures are skipped until the
    /// first `restartEncoder`.
    public convenience init(connection: SecureConnection, input: InputReceiver? = nil, limits: SessionLimits = .standard,
                            localInput: LocalInputProbe? = nil) {
        self.init(connection: connection, input: input, limits: limits, localInput: localInput,
                  encoderFactory: { try VideoEncoder($0, output: $1) })
    }

    /// Checks pass an encoder that drops pictures on purpose, and a clock they move by hand.
    convenience init(connection: SecureConnection, input: InputReceiver? = nil, limits: SessionLimits = .standard,
                     clock: SessionClock = .continuous, localInput: LocalInputProbe? = nil,
                     makeEncoder: (@escaping EncoderOutput) throws -> any PictureEncoding) throws {
        self.init(connection: connection, input: input, limits: limits, clock: clock, localInput: localInput, encoderFactory: nil)
        try install(makeEncoder)
    }

    /// Checks pass a factory too, to watch a display change replace the encoder.
    init(connection: SecureConnection, input: InputReceiver? = nil, limits: SessionLimits = .standard,
         clock: SessionClock = .continuous, localInput: LocalInputProbe? = nil, encoderFactory: EncoderFactory?) {
        (frames, sink) = AsyncStream.makeStream(of: VideoFrame.self)
        self.connection = connection
        makeEncoder = encoderFactory
        self.input = input
        self.clock = clock
        self.localInput = localInput
        ending = OSAllocatedUnfairLock(initialState: Ending(timer: SessionTimer(limits: limits, started: clock.now())))
    }

    public var statistics: Statistics { coding.withLock { $0.statistics } }

    /// Why the Mac ended the session, once it has.
    public var endReason: SessionEndReason? { ending.withLock { $0.reason } }

    /// Replaces the encoder, for a new display or size, and returns its generation for `offer`. The new encoder's first
    /// frame is a keyframe with its own parameter sets; nothing the old one still emits reaches the phone.
    @discardableResult
    public func restartEncoder(_ settings: VideoEncoder.Settings) throws -> UInt64 {
        guard let makeEncoder else { throw VideoError.codec(-12902) }   // kVTParameterErr: this pump has a fixed encoder
        return try install { try makeEncoder(settings, $0) }
    }

    @discardableResult
    private func install(_ make: (@escaping EncoderOutput) throws -> any PictureEncoding) throws -> UInt64 {
        let generation = coding.withLock { state -> UInt64 in
            state.reserved += 1
            return state.reserved
        }
        let encoder = try make { [coding, sink] result in
            coding.withLock { state in
                // A frame a replaced encoder still emitted: the phone gets the new encoder's keyframe instead.
                guard state.generation == generation else { return }
                switch result {
                case .success(let frame):
                    state.backlog += 1
                    sink.yield(frame)
                case .failure(let error):
                    state.error = error
                }
            }
        }
        let replaced = coding.withLock { state -> (any PictureEncoding)? in
            // A later restart already took over; this encoder never runs.
            guard generation > state.generation else { return encoder }
            defer {
                state.generation = generation
                state.encoder = encoder
            }
            return state.encoder
        }
        // Let go here, outside the lock: a VideoToolbox session may emit its last frames while it is torn down, and those
        // take the lock to be dropped.
        withExtendedLifetime(replaced) {}
        return generation
    }

    /// Offers one captured picture. Returns false when it was skipped: the network is behind, there is no encoder yet,
    /// or the picture belongs to an older `generation` (a display the session has left).
    @discardableResult
    public func offer(_ image: CVPixelBuffer, at time: CMTime, generation: UInt64? = nil) -> Bool {
        let encoder = coding.withLock { state -> (any PictureEncoding)? in
            state.statistics.offered += 1
            guard let encoder = state.encoder, generation.map({ $0 == state.generation }) ?? true,
                  state.backlog < Self.maxBacklog else {
                state.statistics.skipped += 1
                return nil
            }
            return encoder
        }
        encoder?.encode(image, at: time)
        return encoder != nil
    }

    private func requestKeyframe() { coding.withLock { $0.encoder }?.requestKeyframe() }

    /// Ends the session from the Mac. Before returning it lets go of everything the phone holds and refuses its later
    /// input (SR-16), so it also serves when the app is about to quit. Then, in the returned task, it tells the phone
    /// why in a sealed `.close` record and closes, waiting at most `goodbyeTimeout`. Only the first reason counts;
    /// later calls return the same task. A version-1 phone hears the nearest reason its version knows.
    @discardableResult
    public func end(_ reason: SessionEndReason) -> Task<Void, Never> { begin(reason).goodbye }

    /// `end`, and whether `reason` is the one the session ended for: false when another reason came first.
    private func begin(_ reason: SessionEndReason) -> (goodbye: Task<Void, Never>, first: Bool) {
        input?.finish(at: clock.now())
        return ending.withLock { [connection] ending in
            if let task = ending.task { return (task, false) }
            ending.reason = reason
            let task = Task {
                await withTaskGroup(of: Void.self) { group in
                    group.addTask { _ = try? await connection.send(.close, reason.closePayload(version: connection.version)) }
                    group.addTask { _ = try? await Task.sleep(for: VideoPump.goodbyeTimeout) }
                    await group.next()
                    // Also fails a send the network never took, so the group can finish.
                    connection.close()
                    group.cancelAll()
                }
            }
            ending.task = task
            return (task, true)
        }
    }

    /// Sends encoded frames and answers the phone until it says goodbye, the session fails, the Mac ends it or the
    /// task is cancelled. Closes the session and releases held keys and buttons on the way out. Returns normally when
    /// the phone left or the Mac ended the session with a reason. `features` reach a version-2 phone only.
    public func run(features: SessionFeatures = SessionFeatures()) async throws {
        defer {
            sink.finish()
            connection.close()
            input?.finish(at: clock.now())
        }
        guard endReason == nil else {
            // Ended before it ran: closing now would cut off the goodbye that names the reason.
            await ending.withLock { $0.task }?.value
            return
        }
        let reportsInputAvailability = features.reportsInputAvailability
        let features = connection.version >= 2 ? features : SessionFeatures()
        if input?.observesPhysicalInput == true { _ = input?.checkLocalInput(at: clock.now()) }
        let initialAvailability = input?.availability ?? .permissionsRequired
        do {
            if reportsInputAvailability, connection.version >= 3 { try await connection.send(ControlMessage.inputAvailability(initialAvailability)) }
            if connection.version >= 3, let position = features.pointerPosition?() { try await connection.send(ControlMessage.pointerPosition(position)) }
            if reportsInputAvailability, initialAvailability != .ready { try await connection.send(ControlMessage.remoteInputPaused) }
            // Each task returns true when the session is over, false when only its own part is done.
            try await withThrowingTaskGroup(of: Bool.self) { [connection, frames, coding, input, clock, localInput, ending] group in
                group.addTask {
                    for await frame in frames {
                        // Nothing after the goodbye. Draining rather than returning keeps the group, and with it the
                        // connection, open until the goodbye has left.
                        guard ending.withLock({ $0.reason == nil }) else { continue }
                        let payload = frame.encoded()
                        try await connection.send(.video, payload)
                        coding.withLock {
                            $0.backlog -= 1
                            $0.statistics.sent += 1
                            $0.statistics.bytes += payload.count
                        }
                    }
                    return true
                }
                group.addTask {
                    // Displays are announced from this task alone, so the phone hears them in the order they changed.
                    if let capture = features.capture {
                        let choice = await capture.choice()
                        try await connection.send(ControlMessage.displays(count: choice.count, current: choice.current))
                    }
                    while true {
                        let record = try await connection.receive()
                        switch record.type {
                        case .close: return true
                        case .control:
                            let message = try ControlMessage(decoding: record.payload, version: connection.version)
                            guard message.sender == .device else { throw ScreenControlWireError.malformed }
                            if try await self.answer(message, features) { return true }
                        case .input:
                            // Input keeps the session alive even while it is paused or view-only: someone is there.
                            let now = clock.now()
                            ending.withLock { $0.timer.noteInput(at: now) }
                            if let input {
                                if let (id, result) = try input.receive(record.payload, version: connection.version, at: now) {
                                    try await connection.send(ControlMessage.textAndReturnResult(id: id, result))
                                }
                            } else if case let .textAndReturn(id, _) = try InputCodec.decode(record.payload, version: connection.version) {
                                try await connection.send(ControlMessage.textAndReturnResult(id: id, .blocked))
                            }
                        case .video: continue
                        }
                    }
                }
                group.addTask {
                    // The session limits. Returns once the Mac's goodbye is out and the session closed.
                    while true {
                        try await clock.sleep(ending.withLock { $0.timer.deadline.at })
                        let now = clock.now()
                        if let reason = ending.withLock({ $0.timer.expired(at: now) }) {
                            await self.end(reason).value
                            return true
                        }
                    }
                }
                if let input, localInput != nil || input.observesPhysicalInput {
                    group.addTask {
                        var previousAvailability = initialAvailability
                        while true {
                            try await clock.sleep(clock.now() + input.localPriority.pollInterval)
                            let change = input.checkLocalInput(localInput, at: clock.now())
                            let availability = input.availability
                            if reportsInputAvailability, connection.version >= 3, availability != previousAvailability {
                                try await connection.send(ControlMessage.inputAvailability(availability))
                                previousAvailability = availability
                            }
                            if change == .resumed, connection.version >= 3, let position = features.pointerPosition?() {
                                // The client receives the real position before it is allowed to resume relative input.
                                try await connection.send(ControlMessage.pointerPosition(position))
                            }
                            switch change {
                            case .paused?: try await connection.send(ControlMessage.remoteInputPaused)
                            case .resumed?: try await connection.send(ControlMessage.remoteInputResumed)
                            case nil: break
                            }
                        }
                    }
                }
                if let makeStates = features.lockStates {
                    group.addTask {
                        // Told when it changes, not each time the system repeats itself. Ends quietly with the session.
                        var told: Bool?
                        for await locked in makeStates() where locked != told {
                            told = locked
                            try await connection.send(locked ? ControlMessage.macLocked : .macUnlocked)
                        }
                        return false
                    }
                }
                if connection.version >= 3, let desktop = features.desktop {
                    group.addTask {
                        var previous: ScreenKeyboardState?
                        while true {
                            let state = await desktop.keyboardState()
                            if state != previous {
                                try await connection.send(ControlMessage.keyboardState(id: 0, state, .observed))
                                previous = state
                            }
                            try await clock.sleep(clock.now() + .milliseconds(500))
                        }
                    }
                    group.addTask {
                        for await _ in await desktop.spaceChanges() {
                            self.requestKeyframe()
                            try await connection.send(ControlMessage.spaceChanged)
                        }
                        return false
                    }
                }
                while let over = try await group.next(), !over {}
                group.cancelAll()
            }
        } catch {
            // Ending closes the connection, which the other tasks see as an error; the session ended as the Mac meant.
            guard endReason == nil else { return }
            throw coding.withLock({ $0.error }) ?? error
        }
    }

    /// Answers one of the phone's control messages; true when that ended the session. Internal so checks can hand it a
    /// message at a chosen moment, as the receive loop does with each one it decodes.
    func answer(_ message: ControlMessage, _ features: SessionFeatures) async throws -> Bool {
        // Once the Mac's goodbye has started (it revoked the device, a limit ran out, a new connection took over), the
        // phone's requests change nothing, as its input does not (SR-16). Reading on until the goodbye closes the
        // connection keeps that goodbye from being cut off.
        guard endReason == nil else { return false }
        switch message {
        case .requestKeyframe:
            requestKeyframe()
        case .nextDisplay, .selectDisplay:
            guard let capture = features.capture else { return false }
            ending.withLock { $0.timer.noteInput(at: clock.now()) }
            let choice: DisplayChoice
            do {
                if case .selectDisplay(let index) = message {
                    choice = try await capture.select(index)
                } else {
                    choice = try await capture.selectNext()
                }
            } catch {
                // Neither the display asked for nor the one before could be captured: nothing left to show.
                await end(.endedAtMac).value
                return true
            }
            try await connection.send(ControlMessage.displays(count: choice.count, current: choice.current))
            if connection.version >= 3, let position = features.pointerPosition?() {
                try await connection.send(ControlMessage.pointerPosition(position))
            }
        case .hideCursor, .showCursor:
            // A cursor the capture could not change stays as it was; nothing else does.
            if let capture = features.capture {
                ending.withLock { $0.timer.noteInput(at: clock.now()) }
                try? await capture.setCursorVisible(message == .showCursor)
            }
        case .turnOff:
            guard let turnOff = features.turnOff else { return false }
            // The Mac may end the session for its own reason at the same moment; then that reason stands and nothing is
            // turned off.
            let (goodbye, first) = begin(.turnedOffFromDevice)
            if first { turnOff() }
            await goodbye.value
            return true
        case let .keyboardAction(id, action):
            guard let desktop = features.desktop else { throw ScreenControlWireError.malformed }
            ending.withLock { $0.timer.noteInput(at: clock.now()) }
            let (state, result) = await desktop.keyboard(action)
            try await connection.send(ControlMessage.keyboardState(id: id, state, result))
        case .navigateSpace(let action):
            guard let desktop = features.desktop else { throw ScreenControlWireError.malformed }
            ending.withLock { $0.timer.noteInput(at: clock.now()) }
            let result = await desktop.navigate(action)
            requestKeyframe()
            try await connection.send(ControlMessage.spaceResult(action, result))
        case .setVideoQuality(let quality):
            guard let capture = features.capture, qualityLimiter.withLock({ $0.admit(at: clock.now()) }) else { return false }
            ending.withLock { $0.timer.noteInput(at: clock.now()) }
            try await capture.setVideoQuality(quality)
            try await connection.send(ControlMessage.videoQuality(quality))
        case .remoteInputPaused, .remoteInputResumed, .macLocked, .macUnlocked, .displays,
             .keyboardState, .spaceResult, .spaceChanged, .videoQuality, .inputAvailability, .pointerPosition, .textAndReturnResult:
            // The Mac's own messages, sent by the phone.
            throw ScreenControlWireError.malformed
        }
        return false
    }
}
#endif
