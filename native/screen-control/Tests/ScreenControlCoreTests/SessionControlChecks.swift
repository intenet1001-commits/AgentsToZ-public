import CoreMedia
import CoreVideo
import Foundation
import os
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// Version 2's control messages (DESIGN 「버전 협상」, 「3) 세션 동안」): the Mac's lock state, choosing its display, the
// cursor in the picture and turning screen control off from the phone. Each message parses strictly and has one sender;
// a version-1 session never carries one, in either direction. Sessions run over real TCP on 127.0.0.1; the displays
// and the lock state are stand-ins, the encoder in the display check is the real one.

/// A phone and a Mac connected over 127.0.0.1 with the versions given, before anything runs on either side.
struct ConnectedPair {
    let listener: ScreenListener
    let phone: SecureConnection
    let mac: SecureConnection

    static func open(phone: VersionPolicy = .current, mac: VersionPolicy = .current) async throws -> ConnectedPair {
        let fixture = Fixture(macVersions: mac)
        let (listener, endpoint) = try await loopbackListener(fixture.mac)
        let client = try await within(5) {
            try await ScreenClient.connect(to: endpoint, handshake: fixture.device(versions: phone), signer: fixture.deviceSigner)
        }
        let session = try await nextSession(listener)
        return ConnectedPair(listener: listener, phone: client, mac: session.connection)
    }
}

/// Everything a raw phone connection receives, in order, until it closes.
final class Inbox: Sendable {
    let records: Collector<(type: RecordType, payload: Data)>
    private let task: Task<Void, Never>

    init(_ connection: SecureConnection) {
        let records = Collector<(type: RecordType, payload: Data)>()
        self.records = records
        task = Task { while let record = try? await connection.receive() { records.add(record) } }
    }

    var controls: [ControlMessage] {
        records.all.filter { $0.type == .control }.compactMap { try? ControlMessage(decoding: $0.payload, version: 2) }
    }
    var frames: [VideoFrame] { records.all.filter { $0.type == .video }.compactMap { try? VideoFrame(decoding: $0.payload) } }
}

/// An encoder a check drives by hand: it counts pictures and keyframe requests and emits frames when told.
final class ManualEncoder: PictureEncoding, @unchecked Sendable {
    let settings: VideoEncoder.Settings
    private let output: @Sendable (Result<VideoFrame, VideoError>) -> Void
    private let counts = OSAllocatedUnfairLock(initialState: (pictures: 0, keyframes: 0))

    init(_ settings: VideoEncoder.Settings, output: @escaping @Sendable (Result<VideoFrame, VideoError>) -> Void) {
        self.settings = settings
        self.output = output
    }

    func encode(_ image: CVPixelBuffer, at time: CMTime) { counts.withLock { $0.pictures += 1 } }
    func requestKeyframe() { counts.withLock { $0.keyframes += 1 } }
    var pictures: Int { counts.withLock { $0.pictures } }
    var keyframeRequests: Int { counts.withLock { $0.keyframes } }

    func emit(keyframe: Bool, timestamp: UInt64) {
        output(.success(try! VideoFrame(isKeyframe: keyframe, timestamp: timestamp,
                                        parameterSets: keyframe ? [Data([0x67, 0x42, UInt8(settings.width & 0xFF)]), Data([0x68, 0xCE])] : [],
                                        data: Data([0, 0, 0, 2, keyframe ? 0x65 : 0x41, 0x9A]))))
    }
}

/// Makes `ManualEncoder`s for a pump and keeps them, oldest first.
final class EncoderShop: Sendable {
    let made = Collector<ManualEncoder>()
    var factory: VideoPump.EncoderFactory {
        { [made] settings, output in
            let encoder = ManualEncoder(settings, output: output)
            made.add(encoder)
            return encoder
        }
    }
    var keyframeRequests: Int { made.all.reduce(0) { $0 + $1.keyframeRequests } }
}

/// Displays a check controls: it records every start, update and stop and hands pictures to the running capture.
final class FakeDisplays: DisplayCapturing, Sendable {
    struct Started: Equatable {
        let display: CaptureDisplay
        let settings: CaptureSettings
    }

    private struct State {
        var list: [CaptureDisplay]
        var started: [Started] = []
        var updates: [CaptureSettings] = []
        var stops = 0
        var deliver: (@Sendable (CapturedPicture) -> Void)?
        var unavailable = Set<UInt32>()
    }

    private let state: OSAllocatedUnfairLock<State>

    init(_ list: [CaptureDisplay]) { state = OSAllocatedUnfairLock(initialState: State(list: list)) }

    func displays() async throws -> [CaptureDisplay] {
        let list = state.withLock { $0.list }
        guard !list.isEmpty else { throw HostCaptureError.noDisplay }
        return list
    }

    func start(_ display: CaptureDisplay, settings: CaptureSettings, deliver: @escaping @Sendable (CapturedPicture) -> Void) async throws {
        try state.withLock { state in
            guard !state.unavailable.contains(display.id) else { throw HostCaptureError.noDisplay }
            state.started.append(Started(display: display, settings: settings))
            state.deliver = deliver
        }
    }

    func update(_ settings: CaptureSettings) async throws { state.withLock { $0.updates.append(settings) } }

    func stop() async {
        state.withLock { state in
            state.stops += 1
            state.deliver = nil
        }
    }

    /// The running capture's way to the pump; a check may keep an old one to play a late picture.
    var deliver: (@Sendable (CapturedPicture) -> Void)? { state.withLock { $0.deliver } }
    var started: [Started] { state.withLock { $0.started } }
    var updates: [CaptureSettings] { state.withLock { $0.updates } }
    var stops: Int { state.withLock { $0.stops } }
    func makeUnavailable(_ id: UInt32) { state.withLock { _ = $0.unavailable.insert(id) } }
}

func picture(width: Int, height: Int, at index: Int) throws -> CapturedPicture {
    CapturedPicture(image: try patternFrame(width: width, height: height, bar: (index * 8) % width),
                    time: CMTime(value: Int64(index), timescale: 30), displayTime: 0)
}

func dimensions(_ frame: VideoFrame) throws -> (width: Int32, height: Int32) {
    let size = CMVideoFormatDescriptionGetDimensions(try VideoFrame.format(frame.parameterSets))
    return (size.width, size.height)
}

/// Waits for `task` at most `seconds`. On timeout the check fails at once, even when the task waits on a network read
/// that cancellation does not end (`within` would wait for it).
func finished<T: Sendable>(_ task: Task<T, Error>, within seconds: Double = 3, line: Int = #line) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
        let once = Once()
        Task {
            let result = await task.result
            if once.claim() { continuation.resume(with: result) }
        }
        Task {
            try? await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
            if once.claim() { continuation.resume(throwing: CheckFailure(description: "line \(line): timed out after \(seconds)s")) }
        }
    }
}

/// Waits until the Mac has handled every record the phone sent before: a keyframe request reaches the encoder in order.
func handled(_ phone: SecureConnection, _ shop: EncoderShop, line: Int = #line) async throws {
    let before = shop.keyframeRequests
    try await phone.send(ControlMessage.requestKeyframe)
    try await waitUntil(line: line) { shop.keyframeRequests > before }
}

extension ScreenControlChecks {
    func testControlMessagesParseStrictlyByVersion() async throws {
        let versionOne: [ControlMessage] = [.requestKeyframe, .remoteInputPaused, .remoteInputResumed]
        let versionTwo: [ControlMessage] = [.macLocked, .macUnlocked, .displays(count: 1, current: 0),
                                            .displays(count: ControlMessage.maxDisplays, current: ControlMessage.maxDisplays - 1),
                                            .nextDisplay, .selectDisplay(0), .selectDisplay(ControlMessage.maxDisplays - 1),
                                            .hideCursor, .showCursor, .turnOff]
        for message in versionOne + versionTwo {
            try check(try ControlMessage(decoding: message.encoded, version: 2) == message, "\(message) round trip in version 2")
        }
        for message in versionOne {
            try check(message.minimumVersion == 1 && (try ControlMessage(decoding: message.encoded, version: 1)) == message,
                      "\(message) is version 1's")
        }
        for message in versionTwo {
            try check(message.minimumVersion == 2, "\(message) is version 2's")
            try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: message.encoded, version: 1) }
            try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: message.encoded) }
        }
        try check(ControlMessage.displays(count: 2, current: 1).encoded == Data([6, 2, 1])
                  && ControlMessage.selectDisplay(3).encoded == Data([8, 3]) && ControlMessage.turnOff.encoded == Data([11]),
                  "the wire form is a tag and exactly its values")

        // Exact lengths, ranges and known tags only.
        for payload in [Data(), Data([0]), Data([12]), Data([0xFF]), Data([4, 0]), Data([5, 5]), Data([6]), Data([6, 1]),
                        Data([6, 1, 0, 0]), Data([6, 0, 0]), Data([6, 17, 0]), Data([6, 2, 2]), Data([6, 0xFF, 0]),
                        Data([7, 0]), Data([8]), Data([8, 0, 0]), Data([8, 16]), Data([8, 0xFF]), Data([9, 0]), Data([10, 1]),
                        Data([11, 0]), Data([1, 0])] {
            try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: payload, version: 2) }
        }

        let fromPhone: [ControlMessage] = [.requestKeyframe, .nextDisplay, .selectDisplay(2), .hideCursor, .showCursor, .turnOff]
        let fromMac: [ControlMessage] = [.remoteInputPaused, .remoteInputResumed, .macLocked, .macUnlocked, .displays(count: 2, current: 0)]
        try check(fromPhone.allSatisfy { $0.sender == .device } && fromMac.allSatisfy { $0.sender == .mac }, "each message has one sender")

        // The Mac's own reason for a turn-off from the phone, and what a version-1 phone hears instead.
        try check(SessionEndReason.turnedOffFromDevice.minimumVersion == 2
                  && SessionEndReason.turnedOffFromDevice.closePayload(version: 2) == Data([7])
                  && SessionEndReason.turnedOffFromDevice.closePayload(version: 1) == SessionEndReason.turnedOff.encoded,
                  "a version-1 phone hears 「turned off」")
        for reason in SessionEndReason.allCases where reason != .turnedOffFromDevice {
            try check(reason.minimumVersion == 1 && reason.closePayload(version: 1) == reason.encoded, "\(reason) is version 1's")
        }
    }

    func testControlMessagesGoOnlyFromTheirSenderAndVersion() async throws {
        // Version 2: the wrong end, or values no receiver accepts, are refused before sealing, and the session stays.
        let two = try await ConnectedPair.open()
        defer { two.listener.stop() }
        try await expectError(ChannelError.wrongDirection) { try await two.mac.send(ControlMessage.turnOff) }
        try await expectError(ChannelError.wrongDirection) { try await two.mac.send(ControlMessage.requestKeyframe) }
        try await expectError(ChannelError.wrongDirection) { try await two.phone.send(ControlMessage.macLocked) }
        try await expectError(ChannelError.wrongDirection) { try await two.phone.send(ControlMessage.displays(count: 1, current: 0)) }
        try await expectError(ChannelError.malformed) { try await two.mac.send(ControlMessage.displays(count: 17, current: 0)) }
        try await expectError(ChannelError.malformed) { try await two.mac.send(ControlMessage.displays(count: 2, current: 2)) }
        try await expectError(ChannelError.malformed) { try await two.phone.send(ControlMessage.selectDisplay(-1)) }
        try await expectError(ChannelError.malformed) { try await two.phone.send(ControlMessage.selectDisplay(16)) }
        try await two.mac.send(ControlMessage.macLocked)
        let first = try await within(3) { try await two.phone.receive() }
        try check(first.type == .control && first.payload == ControlMessage.macLocked.encoded, "nothing refused was sent: \(first)")
        try await two.phone.send(ControlMessage.hideCursor)
        let echo = try await within(3) { try await two.mac.receive() }
        try check(echo.type == .control && echo.payload == ControlMessage.hideCursor.encoded, "nothing refused was sent: \(echo)")

        // Version 1, either way round: no version-2 message is ever sealed, and the session goes on.
        for (phone, mac) in [(VersionPolicy.only(1), VersionPolicy.current), (.current, .only(1))] {
            let one = try await ConnectedPair.open(phone: phone, mac: mac)
            defer { one.listener.stop() }
            try check(one.phone.version == 1 && one.mac.version == 1, "settled on version 1")
            for message in [ControlMessage.macLocked, .macUnlocked, .displays(count: 1, current: 0)] {
                try await expectError(ChannelError.notNegotiated) { try await one.mac.send(message) }
            }
            for message in [ControlMessage.nextDisplay, .selectDisplay(0), .hideCursor, .showCursor, .turnOff] {
                try await expectError(ChannelError.notNegotiated) { try await one.phone.send(message) }
            }
            try await one.mac.send(ControlMessage.remoteInputPaused)
            let paused = try await within(3) { try await one.phone.receive() }
            try check(paused.payload == ControlMessage.remoteInputPaused.encoded, "the first record is version 1's: \(paused)")
            try await one.phone.send(ControlMessage.requestKeyframe)
            let request = try await within(3) { try await one.mac.receive() }
            try check(request.payload == ControlMessage.requestKeyframe.encoded, "the first record is version 1's: \(request)")
            one.phone.close()
            one.mac.close()
        }
        two.phone.close()
        two.mac.close()
    }

    func testEachEndRefusesWhatItMayNotReceive() async throws {
        // The Mac ends a version-2 session on its own message coming from the phone.
        let two = try await ConnectedPair.open()
        defer { two.listener.stop() }
        let turnedOff = Collector<Int>()
        let pump = VideoPump(connection: two.mac, encoderFactory: EncoderShop().factory)
        let running = Task { try await pump.run(features: SessionFeatures(turnOff: { turnedOff.add(1) })) }
        try await two.phone.send(.control, ControlMessage.macLocked.encoded)
        try await expectError(ScreenControlWireError.malformed) { try await finished(running) }

        // A version-1 session ends on a version-2 message, before acting on it.
        let one = try await ConnectedPair.open(phone: .only(1))
        defer { one.listener.stop() }
        let pumpOne = VideoPump(connection: one.mac, encoderFactory: EncoderShop().factory)
        let runningOne = Task { try await pumpOne.run(features: SessionFeatures(turnOff: { turnedOff.add(1) })) }
        try await one.phone.send(.control, ControlMessage.turnOff.encoded)
        try await expectError(ScreenControlWireError.malformed) { try await finished(runningOne) }
        try check(turnedOff.all.isEmpty && pumpOne.endReason == nil, "a version-1 phone cannot turn screen control off")

        // The phone ends a session on the phone's own message from the Mac, and on a version-2 one in version 1, and
        // closes the connection then.
        for (policy, payload) in [(VersionPolicy.current, ControlMessage.selectDisplay(0).encoded),
                                  (.current, ControlMessage.turnOff.encoded), (.only(1), ControlMessage.macLocked.encoded),
                                  (.only(1), ControlMessage.displays(count: 2, current: 0).encoded)] {
            let pair = try await ConnectedPair.open(phone: policy)
            defer { pair.listener.stop() }
            let viewer = ScreenViewer(connection: pair.phone)
            let watching = Task { for try await _ in viewer.pictures() {} }
            try await pair.mac.send(.control, payload)
            try await expectError(ScreenControlWireError.malformed) { try await finished(watching) }
            try await waitForEnd(pair.mac.framed)
        }
    }

    func testLockStateReachesVersionTwoPhonesOnly() async throws {
        let (states, feed) = AsyncStream.makeStream(of: Bool.self)
        let asked = Collector<Int>()
        let features = SessionFeatures(lockStates: {
            asked.add(1)
            return states
        })
        let pair = try await ConnectedPair.open()
        defer { pair.listener.stop() }
        let pump = VideoPump(connection: pair.mac, encoderFactory: EncoderShop().factory)
        let running = Task { try await pump.run(features: features) }
        let viewer = ScreenViewer(connection: pair.phone)
        let watching = Task { for try await _ in viewer.pictures() {} }
        let notices = Collector<ScreenNotice>()
        let listening = Task { for await notice in viewer.notices { notices.add(notice) } }
        for locked in [true, true, false, false, true] { feed.yield(locked) }
        try await waitUntil { notices.all.count == 3 }
        try check(notices.all == [.macLocked, .macUnlocked, .macLocked], "each change once, outside the picture: \(notices.all)")
        try check(asked.all.count == 1, "one stream for the session")
        await viewer.close()
        try await finished(running)
        _ = await watching.result
        _ = await listening.result

        // With a version-1 end the Mac never asks for its lock state, and the phone hears nothing of it.
        for (phone, mac) in [(VersionPolicy.only(1), VersionPolicy.current), (.current, .only(1))] {
            let one = try await ConnectedPair.open(phone: phone, mac: mac)
            defer { one.listener.stop() }
            let shop = EncoderShop()
            let pumpOne = VideoPump(connection: one.mac, encoderFactory: shop.factory)
            try pumpOne.restartEncoder(.init(width: 64, height: 64))
            let neverAsked = Collector<Int>()
            let runningOne = Task {
                try await pumpOne.run(features: SessionFeatures(lockStates: {
                    neverAsked.add(1)
                    return AsyncStream { $0.yield(true) }
                }))
            }
            let viewerOne = ScreenViewer(connection: one.phone)
            let watchingOne = Task { for try await _ in viewerOne.pictures() {} }
            let heard = Collector<ScreenNotice>()
            let listeningOne = Task { for await notice in viewerOne.notices { heard.add(notice) } }
            try await handled(one.phone, shop)
            // A version-1 record after: the phone only hears it if nothing it refuses came first.
            try await one.mac.send(ControlMessage.remoteInputPaused)
            try await waitUntil { heard.all == [.remoteInputPaused] }
            try check(neverAsked.all.isEmpty, "a version-1 session never reads the lock state")
            await viewerOne.close()
            try await finished(runningOne)
            _ = await watchingOne.result
            _ = await listeningOne.result
        }
    }

    func testDisplayChangeSendsAKeyframeWithNewParameterSets() async throws {
        let main = CaptureDisplay(id: 1, width: 1280, height: 720), side = CaptureDisplay(id: 2, width: 800, height: 600)
        let backend = FakeDisplays([main, side])
        let pair = try await ConnectedPair.open()
        defer { pair.listener.stop() }
        let pump = VideoPump(connection: pair.mac)
        let inputOn = Collector<CaptureDisplay>()
        let capture = HostCapture(backend: backend, pump: pump, onDisplay: { inputOn.add($0) })
        try await capture.start()
        let running = Task { try await pump.run(features: SessionFeatures(capture: capture)) }
        let inbox = Inbox(pair.phone)
        try await waitUntil { inbox.controls == [.displays(count: 2, current: 0)] }
        try check(backend.started == [.init(display: main, settings: CaptureSettings(width: 1280, height: 720))]
                  && inputOn.all == [main], "the session starts on the main display: \(backend.started)")

        /// Feeds pictures of one size until the phone has `count` frames.
        func feed(_ deliver: (@Sendable (CapturedPicture) -> Void)?, _ display: CaptureDisplay, untilFrames count: Int) async throws {
            guard let deliver else { throw CheckFailure(description: "no capture running") }
            _ = try await within(5) { [inbox] in
                var index = 0
                while inbox.frames.count < count {
                    deliver(try picture(width: display.width, height: display.height, at: index))
                    index += 1
                    try await Task.sleep(for: .milliseconds(30))
                }
                return true
            }
        }
        let mainDeliver = backend.deliver
        try await feed(mainDeliver, main, untilFrames: 1)
        let opening = inbox.frames[0]
        try check(opening.isKeyframe && (try dimensions(opening)) == (1280, 720), "the first frame is the main display's keyframe")

        try await pair.phone.send(ControlMessage.nextDisplay)
        try await waitUntil { inbox.controls.last == .displays(count: 2, current: 1) }
        try check(backend.started.map(\.display) == [main, side] && backend.stops == 1
                  && backend.started[1].settings == CaptureSettings(width: 800, height: 600), "captures the next display")
        try check(inputOn.all == [main, side], "input follows the display")
        // A late picture from the display left behind never reaches the new encoder.
        let skipped = pump.statistics.skipped
        mainDeliver?(try picture(width: 1280, height: 720, at: 999))
        try check(pump.statistics.skipped == skipped + 1, "a picture of the old display is skipped")
        let before = inbox.frames.count
        try await feed(backend.deliver, side, untilFrames: before + 1)
        let switched = inbox.frames[before]
        try check(switched.isKeyframe && switched.parameterSets != opening.parameterSets && (try dimensions(switched)) == (800, 600),
                  "the next frame is a keyframe with the new display's parameter sets")

        // An index past the end and the display shown change nothing; the phone hears the choice again.
        for message in [ControlMessage.selectDisplay(2), .selectDisplay(1)] {
            let heard = inbox.controls.count
            try await pair.phone.send(message)
            try await waitUntil { inbox.controls.count == heard + 1 }
            try check(inbox.controls.last == .displays(count: 2, current: 1) && backend.started.count == 2, "\(message) changes nothing")
        }
        try await pair.phone.send(ControlMessage.selectDisplay(0))
        try await waitUntil { inbox.controls.last == .displays(count: 2, current: 0) }
        let back = inbox.frames.count
        try await feed(backend.deliver, main, untilFrames: back + 1)
        try check(inbox.frames[back].isKeyframe && (try dimensions(inbox.frames[back])) == (1280, 720), "back on the main display")

        // A display that cannot be captured: back to the one shown before, and the phone hears it.
        backend.makeUnavailable(side.id)
        let heard = inbox.controls.count
        try await pair.phone.send(ControlMessage.nextDisplay)
        try await waitUntil { inbox.controls.count == heard + 1 }
        try check(inbox.controls.last == .displays(count: 2, current: 0) && backend.started.last?.display == main
                  && inputOn.all.last == main, "a failed change goes back: \(backend.started.map(\.display.id))")
        try check(pump.endReason == nil, "and the session goes on")

        try await pair.phone.send(.close, Data())
        try await finished(running)
        await capture.stop()
    }

    func testAReplacedEncoderNeverReachesThePhone() async throws {
        let pair = try await ConnectedPair.open()
        defer { pair.listener.stop() }
        let shop = EncoderShop()
        let pump = VideoPump(connection: pair.mac, encoderFactory: shop.factory)
        let running = Task { try await pump.run() }
        let inbox = Inbox(pair.phone)
        let image = try patternFrame(width: 64, height: 64, bar: 0)
        try check(!pump.offer(image, at: .zero), "no encoder before the first display: skipped")

        let first = try pump.restartEncoder(.init(width: 640, height: 360))
        shop.made.all[0].emit(keyframe: true, timestamp: 1)
        try await waitUntil { inbox.frames.count == 1 }
        let second = try pump.restartEncoder(.init(width: 320, height: 240))
        try check(second > first && shop.made.all.map(\.settings.width) == [640, 320], "a new encoder for the new size")
        shop.made.all[0].emit(keyframe: false, timestamp: 2)     // late, from the encoder replaced
        try check(!pump.offer(image, at: .zero, generation: first) && shop.made.all[1].pictures == 0, "an old picture is skipped")
        try check(pump.offer(image, at: .zero, generation: second) && shop.made.all[1].pictures == 1, "a new picture is encoded")
        shop.made.all[1].emit(keyframe: true, timestamp: 3)
        try await waitUntil { inbox.frames.count == 2 }
        try check(inbox.frames.map(\.timestamp) == [1, 3], "only the new encoder's frames follow: \(inbox.frames.map(\.timestamp))")
        try await handled(pair.phone, shop)
        try check(shop.made.all[0].keyframeRequests == 0 && shop.made.all[1].keyframeRequests == 1, "keyframe requests reach the new encoder")

        try await pair.phone.send(.close, Data())
        try await finished(running)
    }

    func testCursorRequestsReachTheCaptureAndOutlastADisplayChange() async throws {
        let main = CaptureDisplay(id: 7, width: 1920, height: 1080), side = CaptureDisplay(id: 9, width: 2560, height: 1440)
        let backend = FakeDisplays([main, side])
        let pair = try await ConnectedPair.open()
        defer { pair.listener.stop() }
        let shop = EncoderShop()
        let pump = VideoPump(connection: pair.mac, encoderFactory: shop.factory)
        let capture = HostCapture(backend: backend, pump: pump)
        try await capture.start()
        let running = Task { try await pump.run(features: SessionFeatures(capture: capture)) }
        let viewer = ScreenViewer(connection: pair.phone)
        let watching = Task { for try await _ in viewer.pictures() {} }
        let notices = Collector<ScreenNotice>()
        let listening = Task { for await notice in viewer.notices { notices.add(notice) } }
        try await waitUntil { notices.all == [.displays(count: 2, current: 0)] }
        try check(viewer.macHasSessionControls && backend.started[0].settings.showsCursor, "the cursor starts in the picture")

        try await viewer.setMacCursorHidden(true)
        try await waitUntil { backend.updates.count == 1 }
        try check(backend.updates[0] == CaptureSettings(width: 1920, height: 1080, showsCursor: false), "hidden in the running capture")
        try await viewer.nextDisplay()
        try await waitUntil { notices.all.last == .displays(count: 2, current: 1) }
        try check(backend.started[1].settings == CaptureSettings(width: 1920, height: 1080, showsCursor: false),
                  "the next display starts without the cursor too: \(backend.started[1].settings)")
        try await viewer.setMacCursorHidden(false)
        try await waitUntil { backend.updates.count == 2 }
        try check(backend.updates[1].showsCursor, "back in the picture")
        try await viewer.setMacCursorHidden(false)
        try await handled(pair.phone, shop)
        try check(backend.updates.count == 2, "asking for what it already is changes nothing")
        await viewer.close()
        try await finished(running)
        await capture.stop()
        _ = await watching.result
        _ = await listening.result

        // A version-1 phone hears no display list, and its cursor request sends nothing.
        let one = try await ConnectedPair.open(phone: .only(1))
        defer { one.listener.stop() }
        let backendOne = FakeDisplays([main, side])
        let shopOne = EncoderShop()
        let pumpOne = VideoPump(connection: one.mac, encoderFactory: shopOne.factory)
        let captureOne = HostCapture(backend: backendOne, pump: pumpOne)
        try await captureOne.start()
        let runningOne = Task { try await pumpOne.run(features: SessionFeatures(capture: captureOne)) }
        let viewerOne = ScreenViewer(connection: one.phone)
        let watchingOne = Task { for try await _ in viewerOne.pictures() {} }
        let heard = Collector<ScreenNotice>()
        let listeningOne = Task { for await notice in viewerOne.notices { heard.add(notice) } }
        try check(!viewerOne.macHasSessionControls, "a version-1 session")
        try await viewerOne.setMacCursorHidden(true)
        try await expectError(ChannelError.notNegotiated) { try await viewerOne.nextDisplay() }
        try await handled(one.phone, shopOne)
        try await one.mac.send(ControlMessage.remoteInputPaused)
        try await waitUntil { heard.all == [.remoteInputPaused] }
        try check(backendOne.updates.isEmpty && backendOne.started.count == 1, "nothing changed at the Mac")
        await viewerOne.close()
        try await finished(runningOne)
        await captureOne.stop()
        _ = await watchingOne.result
        _ = await listeningOne.result
    }

    func testTurningOffFromThePhoneEndsWithItsOwnReason() async throws {
        let pair = try await ConnectedPair.open()
        defer { pair.listener.stop() }
        let turnedOff = Collector<SessionEndReason?>()
        let pump = VideoPump(connection: pair.mac, encoderFactory: EncoderShop().factory)
        let running = Task { try await pump.run(features: SessionFeatures(turnOff: { turnedOff.add(pump.endReason) })) }
        let viewer = ScreenViewer(connection: pair.phone)
        let watching = Task { for try await _ in viewer.pictures() {} }
        try await viewer.turnOffScreenControl(approval: BiometricApproval())
        try await finished(running)
        try await finished(watching)
        try check(turnedOff.all == [.turnedOffFromDevice], "the Mac turned off, after naming its reason: \(turnedOff.all)")
        try check(pump.endReason == .turnedOffFromDevice && viewer.endReason == .turnedOffFromDevice,
                  "both ends know why: \(String(describing: pump.endReason)) / \(String(describing: viewer.endReason))")
        let used = BiometricApproval()
        _ = used.claim()
        try await expectError(HandshakeError.alreadyUsed) { try await viewer.turnOffScreenControl(approval: used) }

        // A Mac that offers no turn-off ignores the request; the session goes on.
        let plain = try await ConnectedPair.open()
        defer { plain.listener.stop() }
        let shop = EncoderShop()
        let pumpPlain = VideoPump(connection: plain.mac, encoderFactory: shop.factory)
        try pumpPlain.restartEncoder(.init(width: 64, height: 64))
        let runningPlain = Task { try await pumpPlain.run() }
        try await plain.phone.send(ControlMessage.turnOff)
        try await handled(plain.phone, shop)
        try check(pumpPlain.endReason == nil, "nothing to turn off")
        try await plain.phone.send(.close, Data())
        try await finished(runningPlain)

        // A version-1 Mac: refused before the approval is used, and that phone hears 「turned off」 for this reason.
        let one = try await ConnectedPair.open(mac: .only(1))
        defer { one.listener.stop() }
        let pumpOne = VideoPump(connection: one.mac, encoderFactory: EncoderShop().factory)
        let runningOne = Task { try await pumpOne.run() }
        let viewerOne = ScreenViewer(connection: one.phone)
        let watchingOne = Task { for try await _ in viewerOne.pictures() {} }
        let unused = BiometricApproval()
        try await expectError(ChannelError.notNegotiated) { try await viewerOne.turnOffScreenControl(approval: unused) }
        try check(unused.claim(), "the approval was not used")
        await pumpOne.end(.turnedOffFromDevice).value
        try await finished(runningOne)
        try await finished(watchingOne)
        try check(viewerOne.endReason == .turnedOff, "a version-1 phone hears 「turned off」: \(String(describing: viewerOne.endReason))")
    }

    /// The Mac ended the session for its own reason (here it revoked the device) and its goodbye is still on the way:
    /// whatever the phone asks in that window changes nothing, as its input does not (SR-16). Before, a `.turnOff`
    /// read then still turned the whole service off and replaced 「revoked」 with 「turned off from the device」 at the Mac.
    /// The records are handed to `answer` exactly as the receive loop hands each decoded one, after `end`.
    func testAfterTheMacsGoodbyeThePhoneChangesNothing() async throws {
        let main = CaptureDisplay(id: 7, width: 1920, height: 1080), side = CaptureDisplay(id: 9, width: 2560, height: 1440)
        let backend = FakeDisplays([main, side])
        let pair = try await ConnectedPair.open()
        defer { pair.listener.stop() }
        let shop = EncoderShop()
        let pump = VideoPump(connection: pair.mac, encoderFactory: shop.factory)
        let capture = HostCapture(backend: backend, pump: pump)
        try await capture.start()
        let turnedOff = Collector<SessionEndReason?>()
        let features = SessionFeatures(capture: capture, turnOff: { turnedOff.add(pump.endReason) })
        let inbox = Inbox(pair.phone)

        let goodbye = pump.end(.revoked)
        _ = try await pump.answer(.turnOff, features)
        try check(turnedOff.all.isEmpty, "a turn-off read after the Mac's goodbye turns nothing off: \(turnedOff.all)")
        try check(pump.endReason == .revoked, "the Mac's reason stays: \(String(describing: pump.endReason))")
        for message: ControlMessage in [.nextDisplay, .selectDisplay(1), .hideCursor, .requestKeyframe] {
            _ = try await pump.answer(message, features)
        }
        try check(backend.started.count == 1 && backend.updates.isEmpty && shop.made.all.count == 1 && shop.keyframeRequests == 0,
                  "no display, cursor or keyframe change after the goodbye: started \(backend.started.count), updates \(backend.updates.count)")
        await goodbye.value
        try await waitUntil { inbox.records.all.contains { $0.type == .close } }
        try check(inbox.records.all.last { $0.type == .close }?.payload == SessionEndReason.revoked.encoded, "the phone hears 「revoked」")
        try check(turnedOff.all.isEmpty && pump.endReason == .revoked, "still nothing turned off")
        await capture.stop()
    }

    /// The phone's banners and display button read `ScreenMacState`; each notice may change only its own part.
    func testThePhoneKeepsEachMacSignalApart() async throws {
        var state = ScreenMacState()
        try check(!state.inputPaused && state.locked == nil && !state.choosesDisplay, "nothing known before the Mac says")
        state.hear(.remoteInputPaused)
        for notice: ScreenNotice in [.macLocked, .displays(count: 2, current: 0), .macUnlocked] {
            state.hear(notice)
            try check(state.inputPaused, "\(notice) leaves the pause: the Mac still drops this phone's input")
        }
        try check(state.locked == false && state.choosesDisplay && state.currentDisplay == 0, "lock state and displays kept")
        state.hear(.remoteInputResumed)
        try check(!state.inputPaused && state.locked == false && state.displayCount == 2, "resuming changes only the pause")
        state.hear(.displays(count: 3, current: 2))
        state.hear(.macLocked)
        try check(state.displayCount == 3 && state.currentDisplay == 2 && state.locked == true, "the newest of each")
        state.hear(.displays(count: 1, current: 0))
        try check(!state.choosesDisplay && state.locked == true, "one display left: no choice, still locked")

        // A version-1 Mac tells only the pauses, over a real session: unknown lock state, no display choice.
        let one = try await ConnectedPair.open(mac: .only(1))
        defer { one.listener.stop() }
        let shop = EncoderShop()
        let pumpOne = VideoPump(connection: one.mac, encoderFactory: shop.factory)
        try pumpOne.restartEncoder(.init(width: 64, height: 64))
        let runningOne = Task { try await pumpOne.run(features: SessionFeatures(lockStates: { AsyncStream { $0.yield(true) } })) }
        let viewerOne = ScreenViewer(connection: one.phone)
        let watchingOne = Task { for try await _ in viewerOne.pictures() {} }
        let heard = Collector<ScreenMacState>()
        let listeningOne = Task {
            var seen = ScreenMacState()
            for await notice in viewerOne.notices {
                seen.hear(notice)
                heard.add(seen)
            }
        }
        try await handled(one.phone, shop)
        try await one.mac.send(ControlMessage.remoteInputPaused)
        try await waitUntil { heard.all.count == 1 }
        let seen = heard.all[0]
        try check(seen.inputPaused && seen.locked == nil && !seen.choosesDisplay && !viewerOne.macHasSessionControls,
                  "a version-1 Mac: pause only, lock state unknown, one display: \(seen)")
        await viewerOne.close()
        try await finished(runningOne)
        _ = await watchingOne.result
        _ = await listeningOne.result
    }
}
