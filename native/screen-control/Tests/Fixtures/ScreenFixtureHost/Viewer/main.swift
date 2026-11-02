// Emulator e2e fixture only: a macOS stand-in for the phone, on ScreenControlCore's public viewer API, that
// `bun scripts/emulator-e2e/screenFixtureHost.ts selfcheck` connects to the fixture host with. It signs with a software
// key from a pins file: no Secure Enclave, Face ID, keychain or window. It decodes the pictures it receives with
// VideoToolbox only to read the synthetic frame counter back.
//
//   screen-fixture-viewer session --pins FILE [--frames N] [--inputs scripted|none] [--leave true] [--timeout SECONDS]
//   screen-fixture-viewer expect-refused --pins FILE [--key device|impostor] [--timeout SECONDS]
//   screen-fixture-viewer parse-invites --invites FILE
//
// stdout carries one JSON object per line. `session` waits for `--frames` pictures, sends the scripted input, waits for
// the Mac's answer to its text-and-Return, then (unless `--leave true`) waits for the Mac to end the session.
#if os(macOS)
import CoreMedia
import CoreVideo
import CryptoKit
import Darwin
import Foundation
import Network
import os
import ScreenControlCore
import VideoToolbox

struct Pins {
    let port: UInt16
    let mac: PinnedMac
    let device: P256.Signing.PrivateKey?
    let impostor: P256.Signing.PrivateKey?

    init(path: String) throws {
        let object = try FixtureJSON.read(path)
        guard let port = object["port"] as? Int, let macText = object["macPublicKey"] as? String,
              let macData = Data(base64Encoded: macText), let fingerprintText = object["macFingerprint"] as? String,
              let fingerprint = FixtureEncoding.data(hex: fingerprintText) else { throw FixtureFailure("pins file is incomplete") }
        self.port = UInt16(port)
        mac = try PinnedMac(publicKey: try P256.Signing.PublicKey(x963Representation: macData), fingerprint: fingerprint)
        device = try (object["devicePrivateKey"] as? String).map(Self.key)
        impostor = try (object["impostorPrivateKey"] as? String).map(Self.key)
    }

    static func key(_ base64: String) throws -> P256.Signing.PrivateKey {
        guard let data = Data(base64Encoded: base64) else { throw FixtureFailure("a private key is base64") }
        return try P256.Signing.PrivateKey(rawRepresentation: data)
    }

    var endpoint: NWEndpoint { .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!) }
}

/// Decodes each picture to read the synthetic frame number. Used from the pictures task only.
final class PictureReader: @unchecked Sendable {
    private var session: VTDecompressionSession?
    private var format: CMFormatDescription?
    private let decoded = OSAllocatedUnfairLock(initialState: [Int?]())

    deinit { if let session { VTDecompressionSessionInvalidate(session) } }

    /// The frame number the picture shows; nil when it could not be decoded or read.
    func read(_ sample: CMSampleBuffer) -> Int? {
        guard let description = CMSampleBufferGetFormatDescription(sample) else { return nil }
        if session == nil || format.map({ !CMFormatDescriptionEqual($0, otherFormatDescription: description) }) ?? true {
            if let session { VTDecompressionSessionInvalidate(session) }
            session = nil
            let attributes: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
            var created: VTDecompressionSession?
            guard VTDecompressionSessionCreate(allocator: nil, formatDescription: description, decoderSpecification: nil,
                                               imageBufferAttributes: attributes as CFDictionary, outputCallback: nil,
                                               decompressionSessionOut: &created) == noErr, let created else { return nil }
            session = created
            format = description
        }
        guard let session else { return nil }
        decoded.withLock { $0.removeAll() }
        let status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [], infoFlagsOut: nil) {
            [decoded] status, _, image, _, _ in
            let value = status == noErr ? image.flatMap(FixturePattern.read) : nil
            decoded.withLock { $0.append(value) }
        }
        guard status == noErr else { return nil }
        VTDecompressionSessionWaitForAsynchronousFrames(session)
        return decoded.withLock { $0.last ?? nil }
    }
}

/// What the session saw, shared between its tasks.
struct Observed: Sendable {
    var pictures = 0
    var decoded = 0
    var unreadable = 0
    var firstCounter: Int?
    var lastCounter: Int?
    var inOrder = true
    var notices: [String] = []
    var inputReady = false
    var textReturn: String?

    var json: [String: Any] {
        ["pictures": pictures, "decoded": decoded, "unreadable": unreadable,
         "firstCounter": firstCounter.map { $0 as Any } ?? NSNull(), "lastCounter": lastCounter.map { $0 as Any } ?? NSNull(),
         "countersInOrder": inOrder, "notices": notices]
    }
}

enum ViewerMain {
    /// The input the stand-in phone sends: a tap, a two-finger tap (secondary click), a press-and-drag, a scroll, a
    /// shifted key, composed text, and text with Return.
    static let script: [InputEvent] = [
        .pointerMove(x: 0.25, y: 0.25), .button(.left, isDown: true), .button(.left, isDown: false),
        .pointerMove(x: 0.5, y: 0.5), .button(.right, isDown: true), .button(.right, isDown: false),
        .pointerMove(x: 0.2, y: 0.6), .button(.left, isDown: true), .pointerMove(x: 0.4, y: 0.6), .pointerMove(x: 0.6, y: 0.6),
        .button(.left, isDown: false),
        .scroll(dx: 0, dy: -120),
        .key(code: 0, isDown: true, modifiers: [.shift]), .key(code: 0, isDown: false, modifiers: [.shift]),
        .text("hello"),
        .textAndReturn(id: 1, text: "hello"),
    ]

    static func notice(_ notice: ScreenNotice) -> String {
        switch notice {
        case .remoteInputPaused: "remoteInputPaused"
        case .remoteInputResumed: "remoteInputResumed"
        case .macLocked: "macLocked"
        case .macUnlocked: "macUnlocked"
        case let .displays(count, current): "displays:\(count):\(current)"
        case .keyboardState: "keyboardState"
        case .spaceResult: "spaceResult"
        case .spaceChanged: "spaceChanged"
        case .videoQuality(let quality): "videoQuality:\(quality.rawValue)"
        case .inputAvailability(let value): "inputAvailability:\(FixtureNames.availability(value))"
        case .pointerPosition: "pointerPosition"
        case let .textAndReturnResult(id, result): "textAndReturnResult:\(id):\(FixtureNames.textReturn(result))"
        case .sessionLimits: "sessionLimits"
        case .addressHint: "addressHint"
        case .inputHeldAtMac(let held): "inputHeldAtMac:\(held)"
        }
    }

    /// Polls `condition` every 20 ms until it holds or `deadline` passes.
    static func wait(until deadline: ContinuousClock.Instant, _ condition: () -> Bool) async -> Bool {
        while !condition() {
            guard ContinuousClock.now < deadline, (try? await Task.sleep(for: .milliseconds(20))) != nil else { return condition() }
        }
        return true
    }

    static func session(_ arguments: FixtureArguments) async throws -> Int32 {
        guard let pinsPath = arguments.value("pins") else { throw FixtureFailure("--pins is required") }
        let pins = try Pins(path: pinsPath)
        guard let key = pins.device else { throw FixtureFailure("the pins file has no device key") }
        let frames = try arguments.int("frames", default: 30)
        let deadline = ContinuousClock.now + .seconds(try arguments.int("timeout", default: 60))
        let scripted = (arguments.value("inputs") ?? "scripted") == "scripted"
        let peer: ScreenPeerClass = arguments.value("peer") == "controller" ? .controller : .phone
        let viewer = try await ScreenViewer.connect(to: pins.endpoint, mac: pins.mac, signer: SoftwareTranscriptSigner(key: key), peerClass: peer)
        FixtureJSON.emit(["event": "connected", "protocolVersion": Int(viewer.protocolVersion)])
        let observed = OSAllocatedUnfairLock(initialState: Observed())
        let notices = Task {
            for await notice in viewer.notices {
                observed.withLock { state in
                    state.notices.append(Self.notice(notice))
                    if case .inputAvailability(.ready) = notice { state.inputReady = true }
                    if case let .textAndReturnResult(1, result) = notice { state.textReturn = FixtureNames.textReturn(result) }
                }
            }
        }
        let pictures = Task { () -> String? in
            let reader = PictureReader()
            do {
                for try await picture in viewer.pictures() {
                    let counter = reader.read(picture.sample)
                    observed.withLock { state in
                        state.pictures += 1
                        guard let counter else { state.unreadable += 1; return }
                        state.decoded += 1
                        if let last = state.lastCounter, counter <= last { state.inOrder = false }
                        if state.firstCounter == nil { state.firstCounter = counter }
                        state.lastCounter = counter
                    }
                }
                return nil
            } catch {
                return "\(error)"
            }
        }
        guard await wait(until: deadline, { observed.withLock { $0.pictures >= frames } }) else {
            throw FixtureFailure("only \(observed.withLock { $0.pictures }) of \(frames) pictures before the deadline")
        }
        FixtureJSON.emit(["event": "frames", "pictures": observed.withLock { $0.pictures }])
        if scripted {
            guard await wait(until: deadline, { observed.withLock { $0.inputReady } }) else {
                throw FixtureFailure("the Mac never said its input is ready")
            }
            for event in script { viewer.input(event) }
            // One ordered sender: the Mac's answer to the last event means it has read every event before it.
            guard await wait(until: deadline, { observed.withLock { $0.textReturn != nil } }) else {
                throw FixtureFailure("no answer to text-and-Return")
            }
            FixtureJSON.emit(["event": "inputs-done", "sent": script.map(FixtureInputJSON.object),
                              "textAndReturnResult": observed.withLock { $0.textReturn ?? "" }])
        }
        if arguments.value("leave") == "true" {
            await viewer.close()
        }
        // Waits for the session to end: the Mac ends it (`end` on the host), or this phone left.
        let failure: String?
        let ended = Task { await pictures.value }
        let watchdog = Task {
            guard (try? await Task.sleep(until: deadline, clock: .continuous)) != nil else { return }
            pictures.cancel()
        }
        failure = await ended.value
        watchdog.cancel()
        notices.cancel()
        var result = observed.withLock { $0 }.json
        result["event"] = "session-ended"
        result["endReason"] = viewer.endReason.map { FixtureNames.endReason($0) as Any } ?? NSNull()
        result["error"] = failure.map { $0 as Any } ?? NSNull()
        FixtureJSON.emit(result)
        return 0
    }

    static func expectRefused(_ arguments: FixtureArguments) async throws -> Int32 {
        guard let pinsPath = arguments.value("pins") else { throw FixtureFailure("--pins is required") }
        let pins = try Pins(path: pinsPath)
        let which = arguments.value("key") ?? "impostor"
        guard let key = which == "device" ? pins.device : pins.impostor else { throw FixtureFailure("no \(which) key in the pins file") }
        let timeout = try arguments.int("timeout", default: 10)
        let attempt = Task { try await ScreenViewer.connect(to: pins.endpoint, mac: pins.mac, signer: SoftwareTranscriptSigner(key: key)) }
        let watchdog = Task {
            guard (try? await Task.sleep(for: .seconds(timeout))) != nil else { return }
            attempt.cancel()
        }
        defer { watchdog.cancel() }
        do {
            let viewer = try await attempt.value
            await viewer.close()
            FixtureJSON.emit(["event": "unexpectedly-connected", "key": which])
            return 1
        } catch {
            FixtureJSON.emit(["event": "refused", "key": which, "error": "\(error)"])
            return 0
        }
    }

    static func parseInvites(_ arguments: FixtureArguments) throws -> Int32 {
        guard let path = arguments.value("invites") else { throw FixtureFailure("--invites is required") }
        let invites = try FixtureJSON.read(path)
        var result: [String: Any] = ["event": "invites"]
        for name in ["device", "deviceLegacy", "controller"] {
            guard let text = invites[name] as? String else { throw FixtureFailure("no \(name) invitation") }
            do {
                let invite = try RegistrationInvite(text: text)
                var entry: [String: Any] = ["purpose": invite.purpose == .device ? "device" : "macController",
                                            "scheme": RegistrationInvite.scheme, "nearby": invite.nearbyRegistrationService != nil]
                if invite.nearbyRegistrationService == nil {
                    entry["address"] = invite.address
                    entry["registrationPort"] = Int(invite.registrationPort)
                }
                do {
                    _ = try RegistrationInvite(deviceRegistrationText: text)
                    entry["deviceRegistration"] = "accepted"
                } catch RegistrationError.wrongPurpose {
                    entry["deviceRegistration"] = "wrongPurpose"
                }
                result[name] = entry
            } catch {
                result[name] = ["error": "\(error)"]
            }
        }
        FixtureJSON.emit(result)
        return 0
    }

    static func run() async -> Int32 {
        do {
            let all = Array(CommandLine.arguments.dropFirst())
            guard let command = all.first else { throw FixtureFailure("usage: session | expect-refused | parse-invites") }
            let arguments = try FixtureArguments(Array(all.dropFirst()))
            switch command {
            case "session": return try await session(arguments)
            case "expect-refused": return try await expectRefused(arguments)
            case "parse-invites": return try parseInvites(arguments)
            default: throw FixtureFailure("unknown command \(command)")
            }
        } catch {
            FixtureJSON.emit(["event": "error", "message": "\(error)"])
            return 1
        }
    }
}

exit(await ViewerMain.run())
#else
#error("The stand-in viewer is macOS only.")
#endif
