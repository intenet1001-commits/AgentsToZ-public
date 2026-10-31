import Foundation
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

private let koreanKeyboard = ScreenKeyboardState(language: .korean, capsLock: false, canSelectLatin: true, canSelectKorean: true)

private actor FixtureDesktop: DesktopControlling {
    var actions: [ScreenKeyboardAction] = []
    var spaces: [ScreenSpaceAction] = []
    let changes: AsyncStream<Bool>
    let sink: AsyncStream<Bool>.Continuation
    init() { (changes, sink) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1)) }
    func keyboardState() -> ScreenKeyboardState { koreanKeyboard }
    func keyboard(_ action: ScreenKeyboardAction) -> (ScreenKeyboardState, ScreenControlResult) {
        actions.append(action); return (koreanKeyboard, .applied)
    }
    func navigate(_ action: ScreenSpaceAction) -> ScreenControlResult { spaces.append(action); return .applied }
    func spaceChanges() -> AsyncStream<Bool> { changes }
    func changeSpace() { sink.yield(true) }
}

extension ScreenControlChecks {
    func testPrivateNetworkRouteIsExplicitAndBounded() async throws {
        for address in ["10.0.0.1", "172.16.0.2", "172.31.255.254", "192.168.1.10"] {
            let route = try ScreenPrivateNetworkRoute(address: address)
            try check(try JSONDecoder().decode(ScreenPrivateNetworkRoute.self, from: JSONEncoder().encode(route)) == route,
                      "private route survives device-only storage")
        }
        for address in ["", "127.0.0.1", "0.0.0.0", "8.8.8.8", "100.64.1.1", "169.254.1.1", "172.15.0.1", "172.32.0.1",
                        "192.169.0.1", "192.168.001.1", "10.0.0.256", "10.0.0.-1", "10.0.0.1:443", "mac.local", "::1",
                        " 10.0.0.1", "10.0.0.1\n", "１０.0.0.1", "https://10.0.0.1"] {
            try await expectError(RegistrationError.malformed) { _ = try ScreenPrivateNetworkRoute(address: address) }
            let encoded = try JSONSerialization.data(withJSONObject: ["address": address])
            try await expectError(RegistrationError.malformed) { _ = try JSONDecoder().decode(ScreenPrivateNetworkRoute.self, from: encoded) }
        }
        try check(ScreenPrivateNetworkRoute.port == 52741, "private VPN route never chooses another service port")
        try check(ScreenConnectionRoute(rawValue: "privateNetwork") == .privateNetwork && ScreenConnectionRoute.automatic != .privateNetwork,
                  "private VPN is an explicit mode, not automatic discovery or WSS")
    }

    func testDesktopControlsAreStrictAndVersioned() async throws {
        for (action, code) in [(ScreenSpaceAction.previous, UInt16(0x7B)), (.next, 0x7C), (.missionControl, 0x7E)] {
            try check(action.shortcut.code == code && action.shortcut.modifiers == [.control, .function],
                      "Space arrow shortcut includes macOS's function-key modifier")
        }
        let messages: [ControlMessage] = [
            .keyboardAction(id: 1, .korean), .keyboardAction(id: UInt32.max, .capsOff),
            .keyboardState(id: 0, koreanKeyboard, .observed), .keyboardState(id: 41, koreanKeyboard, .applied),
            .keyboardState(id: 42, koreanKeyboard, .blocked), .navigateSpace(.previous), .navigateSpace(.next),
            .navigateSpace(.missionControl), .spaceResult(.previous, .applied), .spaceChanged,
            .setVideoQuality(.saver), .videoQuality(.balanced), .setVideoQuality(.sharp),
            .pointerPosition(.init(x: 0, y: .max)), .pointerPosition(.init(x: .max, y: 0))
        ] + ScreenInputAvailability.allCases.map { .inputAvailability($0) }
        for message in messages {
            try check(message.minimumVersion == 3 && (try ControlMessage(decoding: message.encoded, version: 3)) == message, "v3 round trip")
            for version: UInt16 in [1, 2] {
                try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: message.encoded, version: version) }
            }
            try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: message.encoded + Data([0]), version: 3) }
            try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: message.encoded.dropLast(), version: 3) }
        }
        for bad in [Data([12, 0, 0, 0, 0, 1]), Data([12, 0, 0, 0, 1, 0]),
                    Data([13, 0, 0, 0, 0, 2, 7, 1]), Data([13, 0, 0, 0, 1, 2, 7, 0]),
                    Data([13, 0, 0, 0, 0, 3, 7, 0]), Data([13, 0, 0, 0, 0, 2, 8, 0]),
                    Data([14, 0]), Data([15, 1, 0]), Data([15, 4, 1]), Data([17, 0]), Data([18, 4]), Data([19, 5])] {
            try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: bad, version: 3) }
        }
        let pair = try await ConnectedPair.open()
        defer { pair.phone.close(); pair.mac.close(); pair.listener.stop() }
        try await expectError(ChannelError.wrongDirection) { try await pair.mac.send(ControlMessage.navigateSpace(.next)) }
        try await expectError(ChannelError.wrongDirection) { try await pair.phone.send(ControlMessage.keyboardState(id: 0, koreanKeyboard, .observed)) }
        let old = try await ConnectedPair.open(phone: .upTo(2))
        defer { old.phone.close(); old.mac.close(); old.listener.stop() }
        let viewer = ScreenViewer(connection: old.phone)
        try await expectError(ChannelError.notNegotiated) { try viewer.desktopControl(.navigateSpace(.next)) }
    }

    func testTextAndReturnIsVersionedAndSingleAdmission() async throws {
        let event = InputEvent.textAndReturn(id: 1, text: "한글 keyboard-ok")
        let payload = InputCodec.encode(event)
        try check(try InputCodec.decode(payload, version: 4) == event, "compound UTF-8 round trip")
        for old: UInt16 in [1, 2, 3] {
            try await expectError(InputError.malformed) { _ = try InputCodec.decode(payload, version: old) }
        }
        for malformed in [InputCodec.encode(.textAndReturn(id: 0, text: "x")),
                          InputCodec.encode(.textAndReturn(id: 2, text: "")),
                          InputCodec.encode(.textAndReturn(id: 2, text: "a\nb")),
                          InputCodec.encode(.textAndReturn(id: 2, text: String(repeating: "x", count: 257)))] {
            try await expectError(InputError.malformed) { _ = try InputCodec.decode(malformed, version: 4) }
        }
        for result: ScreenTextReturnResult in [.posted, .blocked, .unknown] {
            let reply = ControlMessage.textAndReturnResult(id: 1, result)
            try check(try ControlMessage(decoding: reply.encoded, version: 4) == reply, "v4 result round trip")
            try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: reply.encoded, version: 3) }
        }
        let attempts = Collector<String>()
        let receiver = InputReceiver(physicalInput: { .init(available: true) }, compound: { text, _ in
            attempts.add(text); return .posted
        }, inject: { _ in })
        let now = ContinuousClock.now
        try check(try receiver.receive(payload, version: 4, at: now)?.1 == .posted, "one admitted request")
        try check(try receiver.receive(payload, version: 4, at: now)?.1 == .unknown, "replayed request refused without claiming non-execution")
        try check(attempts.all == ["한글 keyboard-ok"], "duplicate injected only once")
        _ = receiver.checkLocalInput({ $0 == .key ? 0 : nil }, at: now) // physical probe owns the decision
        receiver.finish()
        try check(try receiver.receive(InputCodec.encode(.textAndReturn(id: 2, text: "x")), version: 4, at: now)?.1 == .blocked,
                  "finished session cannot post")
        let secure = InputReceiver(physicalInput: { .init(available: true, secureInput: true) }, compound: { text, _ in
            attempts.add(text); return .posted
        }, inject: { _ in })
        try check(try secure.receive(payload, version: 4, at: now)?.1 == .blocked && attempts.all.count == 1,
                  "secure input blocks the entire request")
        let saturated = InputReceiver(physicalInput: { .init(available: true) }, compound: { _, _ in .posted }, inject: { _ in })
        for _ in 0..<480 { try saturated.receive(InputCodec.encode(.pointerMove(x: 0.5, y: 0.5)), at: now) }
        try check(try saturated.receive(payload, version: 4, at: now)?.1 == .blocked, "rate limit blocks text and Return together")
    }

    func testTextAndReturnCrossesAuthenticatedTransportOnce() async throws {
        let pair = try await ConnectedPair.open()
        defer { pair.phone.close(); pair.mac.close(); pair.listener.stop() }
        let attempts = Collector<String>()
        let input = InputReceiver(physicalInput: { .init(available: true) }, compound: { text, _ in
            attempts.add(text); return .posted
        }, inject: { _ in })
        let pump = try VideoPump(connection: pair.mac, input: input) { _ in SilentEncoder() }
        let running = Task { try await pump.run() }
        let request = InputCodec.encode(.textAndReturn(id: 1, text: "한글"))
        try await pair.phone.send(.input, request)
        let first = try await within(3) { try await pair.phone.receive() }
        try check(first.type == .control && (try ControlMessage(decoding: first.payload, version: 4)) == .textAndReturnResult(id: 1, .posted),
                  "authenticated posted reply")
        try await pair.phone.send(.input, request)
        let duplicate = try await within(3) { try await pair.phone.receive() }
        try check(duplicate.type == .control && (try ControlMessage(decoding: duplicate.payload, version: 4)) == .textAndReturnResult(id: 1, .unknown),
                  "duplicate unknown, never reinjected")
        try check(attempts.all == ["한글"], "one injection")
        pair.phone.close()
        _ = try? await within(3) { try await running.value }
    }

    func testCapsLockTapHoldAndCancellation() async throws {
        var press = ScreenCapsLockPress()
        press.down(at: 1); press.down(at: 1.1)
        try check(press.resolve(at: 1.2, state: koreanKeyboard) == .latin, "tap Korean to Latin, repeat down ignored")
        try check(press.resolve(at: 1.3, state: koreanKeyboard) == nil, "release resolved only once")
        let latin = ScreenKeyboardState(language: .latin, capsLock: false, canSelectLatin: true, canSelectKorean: true)
        press.down(at: 2)
        try check(press.resolve(at: 2.2, state: latin) == .korean, "tap Latin to Korean")
        press.down(at: 3)
        try check(press.resolve(at: 4, state: latin) == .capsOn, "hold changes caps, not input source")
        let caps = ScreenKeyboardState(language: .latin, capsLock: true, canSelectLatin: true, canSelectKorean: true)
        press.down(at: 5)
        try check(press.resolve(at: 6, state: caps) == .capsOff, "hold clears remote caps")
        press.down(at: 7); press.cancel()
        try check(press.resolve(at: 8, state: latin) == nil, "cancel does not switch source")
        let unavailable = ScreenKeyboardState(language: .latin, capsLock: false, canSelectLatin: true, canSelectKorean: false)
        press.down(at: 9)
        try check(press.resolve(at: 9.1, state: unavailable) == nil, "never invent a missing Korean input source")
    }

    func testKeyboardFenceOrdersFirstCharacterAndBoundsMemory() async throws {
        var fence = ScreenKeyboardInputFence()
        let first = InputEvent.key(code: 0x00, isDown: true, modifiers: [])
        let up = InputEvent.key(code: 0x00, isDown: false, modifiers: [])
        let id = fence.begin()!
        try check(fence.begin() == nil, "one outstanding keyboard change")
        try check(fence.submit(first) == [] && fence.submit(up) == [], "first key waits")
        try check(fence.reply(id: id + 1, result: .applied) == [] && fence.pending == id, "wrong reply cannot release input")
        try check(fence.reply(id: 0, result: .observed) == [] && fence.pending == id, "polling state is not an acknowledgement")
        try check(fence.reply(id: id, result: .applied) == [first, up] && fence.pending == nil, "correct reply releases in order")
        let failed = fence.begin()!
        _ = fence.submit(.text("한글 첫 글자"))
        try check(fence.reply(id: failed, result: .unavailable) == [] && fence.pending == nil, "failed switch discards uncertain text")
        _ = fence.begin()
        for _ in 0..<ScreenKeyboardInputFence.maximumEvents { try check(fence.submit(first) == [], "bounded waiting input") }
        try check(fence.submit(up) == nil, "overflow is explicit, never silently drops a release")
        fence.cancel()
        try check(fence.pending == nil && fence.submit(up) == [up], "ending discards all pending input")
    }

    func testDesktopInputUsesLocalPriorityAndSessionLifetime() async throws {
        let injected = Collector<InputEvent>(), operations = Collector<Int>()
        let receiver = InputReceiver { injected.add($0) }
        let start = ContinuousClock.now
        try receiver.receive(InputCodec.encode(.key(code: 0x37, isDown: true, modifiers: .command)), at: start)
        try check(receiver.performControlInput(at: start) { operations.add(1) }, "authenticated operation admitted")
        try check(injected.all.last == .key(code: 0x37, isDown: false, modifiers: []), "held modifier released before navigation")
        _ = receiver.checkLocalInput({ $0 == .key ? 0 : nil }, at: start + .seconds(1))
        try check(!receiver.performControlInput(at: start + .seconds(1)) { operations.add(2) }, "local Mac input wins")
        receiver.finish()
        try check(!receiver.performControlInput { operations.add(3) } && operations.all == [1], "revocation/end prevents control input")
    }

    func testKeyboardFenceCoalescesPointerPositionsWithoutCrossingButtonBoundaries() async throws {
        var fence = ScreenKeyboardInputFence()
        let id = fence.begin() ?? 0
        try check(id != 0, "IME fence starts")
        for i in 0..<240 {
            try check(fence.submit(.pointerMove(x: Double(i) / 240, y: 0.5)) == [], "continuous pointer input stays bounded during IME change")
        }
        let down = InputEvent.button(.left, isDown: true)
        try check(fence.submit(down) == [], "button boundary retained")
        for i in 0..<240 { _ = fence.submit(.pointerMove(x: Double(i) / 240, y: 0.6)) }
        let last = Double(239) / 240
        try check(fence.reply(id: id, result: .applied) == [.pointerMove(x: last, y: 0.5), down, .pointerMove(x: last, y: 0.6)],
                  "newest position on each side of the press preserves drag order")
    }

    func testDesktopCommandsAndInputShareWireOrder() async throws {
        let pair = try await ConnectedPair.open()
        defer { pair.phone.close(); pair.mac.close(); pair.listener.stop() }
        let viewer = ScreenViewer(connection: pair.phone)
        viewer.input(.key(code: 0x00, isDown: false, modifiers: []))
        try viewer.desktopControl(.keyboardAction(id: 1, .korean))
        viewer.input(.key(code: 0x00, isDown: true, modifiers: []))
        let first = try await pair.mac.receive(), command = try await pair.mac.receive(), next = try await pair.mac.receive()
        try check(first.type == .input && command.type == .control && next.type == .input, "release, source change, next character in wire order")
        try check(try ControlMessage(decoding: command.payload, version: 3) == .keyboardAction(id: 1, .korean), "exact command preserved")
        await viewer.close()
    }

    func testQualityChangeRestartsEncoderAndKeepsDisplay() async throws {
        let pair = try await ConnectedPair.open()
        defer { pair.phone.close(); pair.mac.close(); pair.listener.stop() }
        let shop = EncoderShop(), backend = FakeDisplays([CaptureDisplay(id: 1, width: 2560, height: 1440)])
        let pump = VideoPump(connection: pair.mac, encoderFactory: shop.factory)
        let capture = HostCapture(backend: backend, pump: pump)
        try await capture.start()
        let old = backend.deliver!
        try await capture.setVideoQuality(.balanced)
        try check(backend.started.last?.settings.width == 1600 && backend.started.last?.settings.height == 900
                  && backend.started.last?.settings.framesPerSecond == 20, "LTE profile preserves aspect and bounds")
        try check(shop.made.all.last?.settings.averageBitRate == 2_000_000 && shop.made.all.count == 2, "new bitrate and encoder generation")
        let frame = try picture(width: 100, height: 100, at: 1)
        old(frame)
        try check(shop.made.all.last?.pictures == 0, "stale capture cannot feed new encoder")
        backend.deliver?(frame)
        try check(shop.made.all.last?.pictures == 1, "new capture feeds encoder")
        try await capture.setVideoQuality(.balanced)
        try check(shop.made.all.count == 2, "unchanged quality avoids restart")
        await capture.stop()
    }

    func testRelayRetryIsBoundedAndResettable() async throws {
        var retry = ScreenRelayRetry()
        try check(retry.delay(randomUnit: 0) == .milliseconds(800), "initial jittered delay")
        try check(retry.delay(randomUnit: 1) == .milliseconds(2400), "exponential retry")
        for _ in 0..<100 { try check(retry.delay(randomUnit: 1) <= .seconds(30), "bounded indefinitely") }
        retry.reset()
        try check(retry.delay(randomUnit: 0.5) == .seconds(1), "successful connection resets failures")
    }

    func testDesktopControlsReachAuthenticatedHostAndReturnNotices() async throws {
        let pair = try await ConnectedPair.open()
        defer { pair.phone.close(); pair.mac.close(); pair.listener.stop() }
        let desktop = FixtureDesktop(), shop = EncoderShop()
        let pump = VideoPump(connection: pair.mac, encoderFactory: shop.factory)
        var settings = VideoEncoder.Settings(width: 100, height: 100)
        settings.averageBitRate = 1_000_000
        try pump.restartEncoder(settings)
        let viewer = ScreenViewer(connection: pair.phone), notices = Collector<ScreenNotice>()
        let hearing = Task { for await notice in viewer.notices { notices.add(notice) } }
        let pictures = Task { for try await _ in viewer.pictures() {} }
        let running = Task { try await pump.run(features: SessionFeatures(desktop: desktop)) }
        defer { hearing.cancel(); pictures.cancel(); running.cancel() }
        try await waitUntil { notices.all.contains(.keyboardState(id: 0, koreanKeyboard, .observed)) }
        try viewer.desktopControl(.keyboardAction(id: 17, .korean))
        try await waitUntil { notices.all.contains(.keyboardState(id: 17, koreanKeyboard, .applied)) }
        try check(await desktop.actions == [.korean], "one keyboard operation after authentication")
        try viewer.desktopControl(.navigateSpace(.next))
        try await waitUntil { notices.all.contains(.spaceResult(.next, .applied)) }
        try check(await desktop.spaces == [.next], "one Spaces shortcut")
        await desktop.changeSpace()
        try await waitUntil { notices.all.contains(.spaceChanged) && shop.keyframeRequests > 0 }
        await viewer.close()
        _ = try await finished(running)
    }
}
