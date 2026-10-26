import CoreMedia
import CoreVideo
import Foundation
import os
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// The video loop without screen capture: synthetic pictures through the real encoder, channel, TCP and decoder.

/// Top-left red, top-right green, bottom-left blue, bottom-right light grey, plus a small moving bar at the bottom
/// edge so consecutive frames differ.
let quadrantColors: [(r: Int, g: Int, b: Int)] = [(220, 30, 30), (30, 200, 30), (30, 30, 220), (230, 230, 230)]

func patternFrame(width: Int, height: Int, bar: Int) throws -> CVPixelBuffer {
    var created: CVPixelBuffer?
    let status = CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA,
                                     [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary, &created)
    guard status == kCVReturnSuccess, let buffer = created else { throw CheckFailure(description: "pixel buffer \(status)") }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    for y in 0..<height {
        for x in 0..<width {
            var color = quadrantColors[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]
            if y >= height - 16, (bar..<bar + 16).contains(x) { color = (255, 255, 255) }
            let pixel = base + y * rowBytes + x * 4
            pixel[0] = UInt8(color.b); pixel[1] = UInt8(color.g); pixel[2] = UInt8(color.r); pixel[3] = 255
        }
    }
    return buffer
}

/// BGRA at (x, y) as (r, g, b).
func pixel(_ buffer: CVPixelBuffer, _ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let pixel = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self) + y * CVPixelBufferGetBytesPerRow(buffer) + x * 4
    return (Int(pixel[2]), Int(pixel[1]), Int(pixel[0]))
}

/// Emits every second picture at once and drops the rest without a word, as a real-time encoder may.
final class DroppingEncoder: PictureEncoding, @unchecked Sendable {
    private let output: @Sendable (Result<VideoFrame, VideoError>) -> Void
    private let count = OSAllocatedUnfairLock(initialState: 0)
    init(output: @escaping @Sendable (Result<VideoFrame, VideoError>) -> Void) { self.output = output }
    func encode(_ image: CVPixelBuffer, at time: CMTime) {
        guard count.withLock({ $0 += 1; return $0 % 2 == 1 }) else { return }
        output(.success(try! VideoFrame(isKeyframe: false, timestamp: UInt64(time.value), parameterSets: [],
                                        data: Data([0, 0, 0, 2, 0x41, 0x9A]))))
    }
    func requestKeyframe() {}
}

final class Collector<T: Sendable>: Sendable {
    private let items = OSAllocatedUnfairLock<[T]>(initialState: [])
    func add(_ item: T) { items.withLock { $0.append(item) } }
    var all: [T] { items.withLock { $0 } }
}

extension ScreenControlChecks {
    func testVideoPumpKeepsFeedingTheEncoder() async throws {
        let fixture = Fixture()
        let (listener, endpoint) = try await loopbackListener(fixture.mac)
        defer { listener.stop() }
        let phone = try await within(5) {
            try await ScreenClient.connect(to: endpoint, handshake: fixture.device(), signer: fixture.deviceSigner)
        }
        let mac = try await nextSession(listener)
        let pump = try VideoPump(connection: mac.connection, settings: .init(width: 640, height: 360))
        let running = Task { try await pump.run() }
        let received = Collector<VideoFrame>()
        let watching = Task {
            while true {
                let record = try await phone.receive()
                if record.type == .video { received.add(try VideoFrame(decoding: record.payload)) }
            }
        }

        let offered = 45
        for index in 0..<offered {
            pump.offer(try patternFrame(width: 640, height: 360, bar: index * 8), at: CMTime(value: Int64(index), timescale: 30))
            try await Task.sleep(for: .milliseconds(8))
        }
        _ = try await within(3) {
            while received.all.count < pump.statistics.offered - pump.statistics.skipped - 4 { try await Task.sleep(for: .milliseconds(10)) }
            return true
        }
        let statistics = pump.statistics
        try check(statistics.offered == offered && statistics.skipped < offered / 3 && statistics.sent >= offered / 2,
                  "the pump keeps feeding: \(statistics)")

        // A keyframe request from the phone is answered by the next picture.
        try await phone.send(.control, ControlMessage.requestKeyframe.encoded)
        try await Task.sleep(for: .milliseconds(100))
        let before = received.all.count
        pump.offer(try patternFrame(width: 640, height: 360, bar: 0), at: CMTime(value: Int64(offered), timescale: 30))
        pump.offer(try patternFrame(width: 640, height: 360, bar: 8), at: CMTime(value: Int64(offered + 1), timescale: 30))
        _ = try await within(3) {
            while !received.all.dropFirst(before).contains(where: \.isKeyframe) { try await Task.sleep(for: .milliseconds(10)) }
            return true
        }

        // The phone's goodbye ends the pump, which closes the session.
        try await phone.send(.close, Data())
        try await within(3) { try await running.value }
        _ = await watching.result

        // A real-time encoder drops pictures and never emits them. Counting pictures handed to the encoder leaked the
        // backlog and stopped the feed after three drops; the self-test on a real screen caught it.
        let phone2 = try await within(5) {
            try await ScreenClient.connect(to: endpoint, handshake: fixture.device(), signer: fixture.deviceSigner)
        }
        let mac2 = try await nextSession(listener)
        let dropping = try VideoPump(connection: mac2.connection) { DroppingEncoder(output: $0) }
        let running2 = Task { try await dropping.run() }
        let delivered = Collector<Int>()
        let watching2 = Task { while true { if try await phone2.receive().type == .video { delivered.add(1) } } }
        let tiny = try patternFrame(width: 16, height: 16, bar: 0)
        for index in 0..<30 {
            dropping.offer(tiny, at: CMTime(value: Int64(index), timescale: 30))
            try await Task.sleep(for: .milliseconds(5))
        }
        _ = try await within(3) {
            while delivered.all.count < 13 { try await Task.sleep(for: .milliseconds(10)) }
            return true
        }
        try check(dropping.statistics.sent >= 13, "the feed survives dropped pictures: \(dropping.statistics)")
        try await phone2.send(.close, Data())
        try await within(3) { try await running2.value }
        _ = await watching2.result
    }

    func testVideoFrameWireFormatIsStrict() async throws {
        let sps = Data([0x67, 0x64, 0x00, 0x1F]), pps = Data([0x68, 0xEE, 0x3C, 0x80])
        let nal = Data([0, 0, 0, 3, 0x65, 0x88, 0x84])
        let key = try VideoFrame(isKeyframe: true, timestamp: 1_234_567, parameterSets: [sps, pps], data: nal)
        try check(try VideoFrame(decoding: key.encoded()) == key, "keyframe round trip")
        let delta = try VideoFrame(isKeyframe: false, timestamp: 1_267_900, parameterSets: [], data: nal + Data([0, 0, 0, 1, 0x41]))
        try check(try VideoFrame(decoding: delta.encoded()) == delta, "delta round trip, two NAL units")
        try check(try VideoFrame(decoding: (Data([9, 9, 9]) + key.encoded())[3...]) == key, "a slice that does not start at 0")
        let longPPS = try VideoFrame(isKeyframe: true, timestamp: 0, parameterSets: [sps, Data([0x68]) + Data(count: 299)], data: nal)
        try check(try VideoFrame(decoding: longPPS.encoded()) == longPPS, "two-byte parameter-set lengths")

        for (name, isKeyframe, sets, data) in [
            ("keyframe without parameter sets", true, [Data](), nal),
            ("keyframe with only an SPS", true, [sps], nal),
            ("PPS where the SPS belongs", true, [pps, pps], nal),
            ("SPS where a PPS belongs", true, [sps, sps], nal),
            ("five parameter sets", true, [sps, pps, pps, pps, pps], nal),
            ("empty parameter set", true, [sps, Data()], nal),
            ("oversized parameter set", true, [sps, Data([0x68]) + Data(count: 1024)], nal),
            ("delta frame with parameter sets", false, [sps, pps], nal),
            ("no NAL units", false, [Data](), Data()),
            ("zero-length NAL unit", false, [Data](), Data([0, 0, 0, 0])),
            ("NAL unit running past the end", false, [Data](), Data([0, 0, 0, 9, 0x41])),
            ("trailing bytes after the last NAL unit", false, [Data](), nal + Data([0, 0, 1])),
        ] {
            do {
                _ = try VideoFrame(isKeyframe: isKeyframe, timestamp: 0, parameterSets: sets, data: data)
                throw CheckFailure(description: "accepted: \(name)")
            } catch VideoError.malformed {}
        }
        let wire = key.encoded()
        var badFlags = delta.encoded(); badFlags[0] = 2
        var shortSet = wire; shortSet[1] = 3                     // claims a third parameter set that is not there
        for (name, payload) in [("unknown flags", badFlags), ("missing parameter set", shortSet),
                                ("short header", wire.prefix(9)), ("cut inside a parameter set", wire.prefix(13))] {
            do {
                _ = try VideoFrame(decoding: payload)
                throw CheckFailure(description: "accepted: \(name)")
            } catch VideoError.malformed {}
        }

        try check(try ControlMessage(decoding: ControlMessage.requestKeyframe.encoded) == .requestKeyframe, "control round trip")
        for payload in [Data(), Data([0]), Data([4]), Data([0xFF]), Data([1, 0])] {
            try await expectError(ScreenControlWireError.malformed) { _ = try ControlMessage(decoding: payload) }
        }

        // Nothing decodes before a keyframe.
        let decoder = VideoDecoder { _ in }
        try await expectError(VideoError.needKeyframe) { try decoder.decode(delta) }
    }

    func testVideoLoopEncodesEncryptsAndDecodes() async throws {
        let width = 640, height = 360, count = 30
        let (frames, sink) = AsyncStream.makeStream(of: VideoFrame.self)
        let encodeErrors = Collector<VideoError>()
        let encoder = try VideoEncoder(.init(width: width, height: height)) { result in
            switch result {
            case .success(let frame): sink.yield(frame)
            case .failure(let error): encodeErrors.add(error)
            }
        }

        let fixture = Fixture()
        let (listener, endpoint) = try await loopbackListener(fixture.mac)
        defer { listener.stop() }
        let phone = try await within(5) {
            try await ScreenClient.connect(to: endpoint, handshake: fixture.device(), signer: fixture.deviceSigner)
        }
        let mac = try await nextSession(listener)

        // Mac: encode, seal, send. A keyframe is requested halfway, as when a phone asks after losing state.
        let sender = Task {
            var sent = 0
            for await frame in frames {
                try await mac.connection.send(.video, frame.encoded())
                sent += 1
            }
            return sent
        }
        for index in 0..<count {
            if index == count / 2 { encoder.requestKeyframe() }
            encoder.encode(try patternFrame(width: width, height: height, bar: index * 8), at: CMTime(value: Int64(index), timescale: 30))
        }
        encoder.flush()
        sink.finish()
        let sent = try await within(10) { try await sender.value }
        try check(encodeErrors.all.isEmpty && sent == count, "encoded and sent every frame: \(sent), errors \(encodeErrors.all)")

        // Phone: open, parse, decode.
        let decoded = Collector<DecodedFrame>()
        let decodeErrors = Collector<VideoError>()
        let decoder = VideoDecoder { result in
            switch result {
            case .success(let frame): decoded.add(frame)
            case .failure(let error): decodeErrors.add(error)
            }
        }
        var keyframes: [UInt64] = []
        for _ in 0..<sent {
            let record = try await within(3) { try await phone.receive() }
            try check(record.type == .video, "video record")
            let frame = try VideoFrame(decoding: record.payload)
            if frame.isKeyframe { keyframes.append(frame.timestamp) }
            try decoder.decode(frame)
        }
        decoder.flush()
        try check(keyframes == [0, 500_000], "keyframes at the start and where requested: \(keyframes)")
        let pictures = decoded.all
        try check(decodeErrors.all.isEmpty && pictures.count == count, "decoded every frame: \(pictures.count), errors \(decodeErrors.all)")
        try check(zip(pictures, pictures.dropFirst()).allSatisfy { $0.timestamp < $1.timestamp }, "in order")
        guard let last = pictures.last else { return }
        try check(CVPixelBufferGetWidth(last.image) == width && CVPixelBufferGetHeight(last.image) == height, "size kept")
        for (index, expected) in quadrantColors.enumerated() {
            let got = pixel(last.image, (index % 2 == 0 ? 1 : 3) * width / 4, (index < 2 ? 1 : 3) * height / 4)
            try check(abs(got.r - expected.r) < 40 && abs(got.g - expected.g) < 40 && abs(got.b - expected.b) < 40,
                      "quadrant \(index): expected \(expected), got \(got)")
        }

        // The Mac switches resolution (the phone rotated, or zoomed in): the next keyframe restarts the decoder.
        let resized = Collector<VideoFrame>()
        let small = try VideoEncoder(.init(width: 320, height: 180)) { if case .success(let frame) = $0 { resized.add(frame) } }
        small.encode(try patternFrame(width: 320, height: 180, bar: 0), at: CMTime(value: Int64(count), timescale: 30))
        small.flush()
        guard let switched = resized.all.first, switched.isKeyframe else { throw CheckFailure(description: "no keyframe at the new size") }
        try decoder.decode(try VideoFrame(decoding: switched.encoded()))
        decoder.flush()
        guard let after = decoded.all.last else { return }
        try check(CVPixelBufferGetWidth(after.image) == 320 && CVPixelBufferGetHeight(after.image) == 180, "decoder follows the new size")
    }
}
