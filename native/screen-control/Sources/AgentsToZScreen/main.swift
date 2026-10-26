import AppKit
import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import Network
import os
import ScreenControlCore
import ScreenHost

// AgentsToZ Screen (DESIGN 「screen-host」): the separate app that alone holds screen recording and Accessibility
// permission. Opened normally, it lives in the menu bar (ScreenApp.swift). Two command-line modes remain for checks:
// `--permission` reports screen recording permission without prompting. `--identity` prints this Mac's screen-control
// fingerprint, making the identity key in the app's keychain group the first time. `--selftest [seconds] [scale]` runs the real capture → H.264 → encrypt → TCP → decrypt → decode loop inside this
// process on 127.0.0.1, with throw-away keys. It prints timings and image fidelity; it writes no frame anywhere. With
// more than one display it switches to the next halfway, as a phone would, and reports the keyframe that follows.

/// Keys that live only for one self-test.
struct EphemeralSigner: TranscriptSigner, @unchecked Sendable {
    let key = P256.Signing.PrivateKey()
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for: data) }
}

let timebase: mach_timebase_info_data_t = { var info = mach_timebase_info_data_t(); mach_timebase_info(&info); return info }()
func milliseconds(since start: UInt64) -> Double {
    Double(mach_absolute_time() &- start) * Double(timebase.numer) / Double(timebase.denom) / 1e6
}
func microseconds(_ time: CMTime) -> UInt64 { UInt64(max(0, CMTimeConvertScale(time, timescale: 1_000_000, method: .default).value)) }
func percentile(_ values: [Double], _ p: Double) -> Double {
    guard !values.isEmpty else { return .nan }
    let sorted = values.sorted()
    return sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * p))]
}

/// The luma plane, copied so the capture buffer goes straight back to ScreenCaptureKit.
func lumaPlane(_ image: CVPixelBuffer) -> (width: Int, height: Int, bytes: [UInt8]) {
    CVPixelBufferLockBaseAddress(image, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    let width = CVPixelBufferGetWidthOfPlane(image, 0), height = CVPixelBufferGetHeightOfPlane(image, 0)
    let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(image, 0)
    let base = CVPixelBufferGetBaseAddressOfPlane(image, 0)!.assumingMemoryBound(to: UInt8.self)
    var bytes = [UInt8](repeating: 0, count: width * height)
    for row in 0..<height { bytes.withUnsafeMutableBufferPointer { _ = memcpy($0.baseAddress! + row * width, base + row * rowBytes, width) } }
    return (width, height, bytes)
}

func psnr(_ a: [UInt8], _ b: [UInt8]) -> Double {
    guard a.count == b.count, !a.isEmpty else { return .nan }
    let squared = zip(a, b).reduce(0.0) { $0 + pow(Double(Int($1.0) - Int($1.1)), 2) }
    return squared == 0 ? .infinity : 10 * log10(255 * 255 / (squared / Double(a.count)))
}

final class Measurements: @unchecked Sendable {
    private struct State {
        var displayTimes: [UInt64: UInt64] = [:]
        var latencies: [Double] = []
        var reference: (timestamp: UInt64, luma: [UInt8])?
        var fidelity: Double?
        var decoded = 0
        var errors: [String] = []
    }
    private let state = OSAllocatedUnfairLock(uncheckedState: State())
    static let referenceFrame = 45

    func captured(_ frame: CapturedPicture, index: Int) {
        let timestamp = microseconds(frame.time)
        let luma = index == Self.referenceFrame ? lumaPlane(frame.image).bytes : nil
        state.withLockUnchecked {
            $0.displayTimes[timestamp] = frame.displayTime
            if let luma { $0.reference = (timestamp, luma) }
        }
    }

    func decoded(_ frame: DecodedFrame) {
        let luma = state.withLockUnchecked { $0.reference?.timestamp == frame.timestamp } ? lumaPlane(frame.image).bytes : nil
        state.withLockUnchecked {
            $0.decoded += 1
            if let shown = $0.displayTimes.removeValue(forKey: frame.timestamp) { $0.latencies.append(milliseconds(since: shown)) }
            if let luma, let reference = $0.reference { $0.fidelity = psnr(reference.luma, luma) }
        }
    }

    func failed(_ error: Error) { state.withLockUnchecked { $0.errors.append("\(error)") } }

    var summary: (latencies: [Double], fidelity: Double?, decoded: Int, errors: [String]) {
        state.withLockUnchecked { ($0.latencies, $0.fidelity, $0.decoded, $0.errors) }
    }
}

func selfTest(seconds: Double, scale: Double) async -> Int32 {
    guard ScreenRecordingPermission.current == .granted else {
        ScreenRecordingPermission.request()
        print("""
        Screen recording is not allowed for AgentsToZ Screen yet.
        System Settings → Privacy & Security → Screen & System Audio Recording → turn on AgentsToZ Screen, then run again.
        """)
        return 2
    }
    do {
        let displays = try await ScreenCaptureBackend().displays()
        for display in displays {
            let size = CaptureSizing.scale(scale).size(of: display)
            let settings = CaptureSettings(width: size.width, height: size.height)
            print("display \(display.id): \(display.width)x\(display.height) pt → stream \(settings.width)x\(settings.height) @\(settings.framesPerSecond)fps")
        }

        // Throw-away identities, registered with each other the way a QR registration would.
        let macSigner = EphemeralSigner(), deviceSigner = EphemeralSigner()
        let deviceID = ScreenControlIdentity.fingerprint(of: deviceSigner.publicKey)
        let handshake = MacHandshake(signer: macSigner, replay: NonceReplayCache()) { [deviceSigner] id in
            id == deviceID ? deviceSigner.publicKey : nil
        }
        let listener = try ScreenListener(handshake: handshake, gate: PreAuthGate(), host: .ipv4(.loopback))
        defer { listener.stop() }
        let port = try await listener.start()
        let mac = try PinnedMac(publicKey: macSigner.publicKey, fingerprint: ScreenControlIdentity.fingerprint(of: macSigner.publicKey))

        let started = mach_absolute_time()
        let phone = try await ScreenClient.connect(to: .hostPort(host: .ipv4(.loopback), port: port),
                                                   handshake: DeviceHandshake(mac: mac, devicePublicKey: deviceSigner.publicKey),
                                                   signer: deviceSigner)
        var sessions = listener.sessions.makeAsyncIterator()
        guard let session = await sessions.next() else { throw TransportError.closed }
        print(String(format: "key exchange over TCP: %.1f ms", milliseconds(since: started)))

        let measurements = Measurements()
        let index = OSAllocatedUnfairLock(initialState: 0)
        let streamer = HostStreamer(connection: session.connection, sizing: .scale(scale), observe: { frame in
            measurements.captured(frame, index: index.withLock { $0 += 1; return $0 })
        })
        let host = Task { try await streamer.run() }
        print("protocol version \(phone.version)")

        // The phone: open, parse, decode.
        let decoder = VideoDecoder(pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange) { result in
            switch result {
            case .success(let frame): measurements.decoded(frame)
            case .failure(let error): measurements.failed(error)
            }
        }
        // What a phone hears beside the picture, and the first keyframe after it asked for another display.
        let switching = OSAllocatedUnfairLock(initialState: (choices: [String](), asked: UInt64?.none, keyframe: String?.none))
        let viewer = Task {
            var sets: [Data] = []
            while true {
                let record = try await phone.receive()
                switch record.type {
                case .video:
                    let frame = try VideoFrame(decoding: record.payload)
                    if frame.isKeyframe, frame.parameterSets != sets {
                        if !sets.isEmpty, let asked = switching.withLock({ $0.asked }) {
                            let size = CMVideoFormatDescriptionGetDimensions(try VideoFrame.format(frame.parameterSets))
                            let note = String(format: "%dx%d keyframe %.0f ms after asking", size.width, size.height, milliseconds(since: asked))
                            switching.withLock { if $0.keyframe == nil { $0.keyframe = note } }
                        }
                        sets = frame.parameterSets
                    }
                    try decoder.decode(frame)
                case .control:
                    if case let .displays(count, current) = try ControlMessage(decoding: record.payload, version: phone.version) {
                        switching.withLock { $0.choices.append("\(current + 1)/\(count)") }
                    }
                default:
                    continue
                }
            }
        }
        try await Task.sleep(for: .milliseconds(Int(seconds * 500)))
        if displays.count > 1, phone.version >= 2 {
            switching.withLock { $0.asked = mach_absolute_time() }
            try await phone.send(ControlMessage.nextDisplay)
        }
        try await Task.sleep(for: .milliseconds(Int(seconds * 500)))
        try await phone.send(.close, Data())
        try await host.value
        _ = await viewer.result
        decoder.flush()

        let statistics = streamer.statistics
        let summary = measurements.summary
        print(String(format: """
        %.0f s: captured %d, skipped %d, sent %d, decoded %d (%.1f fps)
        bitrate %.2f Mbps
        capture → decoded on the phone side: p50 %.1f ms, p95 %.1f ms
        luma PSNR of frame %d: %.1f dB
        """, seconds, statistics.offered, statistics.skipped, statistics.sent, summary.decoded,
                     Double(summary.decoded) / seconds, Double(statistics.bytes) * 8 / seconds / 1e6,
                     percentile(summary.latencies, 0.5), percentile(summary.latencies, 0.95),
                     Measurements.referenceFrame, summary.fidelity ?? .nan))
        let switched = switching.withLock { $0 }
        print("displays the phone heard: \(switched.choices.joined(separator: " → "))")
        if switched.asked != nil { print("display switch: \(switched.keyframe ?? "no keyframe with new parameter sets")") }
        if !summary.errors.isEmpty { print("decode errors: \(summary.errors.prefix(5))") }
        return summary.errors.isEmpty && summary.decoded > 0 && (switched.asked == nil || switched.keyframe != nil) ? 0 : 1
    } catch {
        print("self-test failed: \(error)")
        return 1
    }
}

let arguments = CommandLine.arguments.dropFirst()
switch arguments.first {
case "--selftest":
    // Half the display by default: the phone's default stream size (DESIGN S0-4).
    let numbers = arguments.dropFirst().compactMap(Double.init)
    exit(await selfTest(seconds: numbers.first ?? 6, scale: numbers.dropFirst().first ?? 0.5))
case "--permission":
    // Reports without prompting.
    print(ScreenRecordingPermission.current == .granted ? "granted" : "not granted")
    exit(0)
case "--identity":
    do {
        let fingerprint = ScreenControlIdentity.fingerprint(of: try ScreenStore().identity().publicKey)
        print("identity \(fingerprint.prefix(8).map { String(format: "%02x", $0) }.joined()) · devices \(try ScreenStore().devices().count)")
        exit(0)
    } catch {
        print("identity failed: \(error)")
        exit(1)
    }
case "--help", "-h":
    print("usage: AgentsToZScreen [--show | --selftest [seconds] [scale] | --permission | --identity]")
    exit(0)
default:
    // Any other argument opens the menu app: an older or newer AgentsToZ that passes something else still gets it.
    ScreenLaunch.showWindow = arguments.first == "--show"
    // A polite kill or Ctrl-C quits like the menu does, so ScreenService lets go of held input on the way (SR-16).
    let quitSignals = [SIGTERM, SIGINT].map { number in
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { NSApplication.shared.terminate(nil) } }
        source.resume()
        return source
    }
    withExtendedLifetime(quitSignals) { ScreenMenuApp.main() }
}
