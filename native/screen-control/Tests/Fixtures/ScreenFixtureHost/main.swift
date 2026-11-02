// Emulator e2e fixture only: the AgentsToZ Screen host core with a synthetic display and recorded input, for the
// harness's phone-to-Mac-screen lanes (scripts/emulator-e2e/screenFixtureHost.ts builds and starts it inside
// sandbox-exec). It is built from ScreenControlCore, Sources/ScreenHost/HostStreamer.swift and the files in this folder,
// and from nothing else in ScreenHost: no Capture.swift (ScreenCaptureKit), InputInjector (CGEvent), LocalInputMonitor
// (event taps), DesktopController, ScreenService or the app. A build gate checks the linked binary for that.
//
//   screen-fixture-host --mode viewer|pinned-device|invite --state-dir DIR [--evidence-dir DIR]
//                       [--device-public-key BASE64-X963]... [--fps N] [--displays 1920x1080,1280x800] [--idle-seconds N]
//
// viewer         Listens on 127.0.0.1 (never Bonjour, never a LAN address) with a software Mac key, pins a fixture
//                device key it makes, and writes both private keys the stand-in phone needs (plus an unregistered
//                "impostor" key) to <state>/pins.json, owner-only.
// pinned-device  The same listener, but pins only the public keys it is given (arguments or `pin-device` commands), for
//                a phone whose device key lives in its own Secure Enclave.
// invite         Writes device and Mac-controller registration invitations to <state>/invites.json and counts the TCP
//                connections its loopback registration and screen ports receive, closing each at once. Only the
//                `deviceLegacy` invitation carries that address; the nearby-only `device` and `controller` ones can
//                never reach the counters, so a zero count is evidence about `deviceLegacy` alone.
//
// stdout carries one JSON object per line: `ready`, then one `reply` per command. stdin takes JSON commands:
// {"id","op":"end","reason"} · {"id","op":"pin-device","publicKey"} · {"id","op":"physical-input","available","held",
// "secureInput"} · {"id","op":"status"} · {"id","op":"stop"}. The host stops on `stop`, on stdin closing, on SIGTERM
// or SIGINT. Evidence: host-receipts.jsonl, input-events.jsonl and frames.json in --evidence-dir (or the state dir).
#if os(macOS)
import CryptoKit
import Darwin
import Dispatch
import Foundation
import Network
import os
import ScreenControlCore

enum FixtureMode: String, Sendable {
    case viewer, controller, pinnedDevice = "pinned-device", invite
}

struct HostOptions: Sendable {
    let mode: FixtureMode
    let stateDir: String
    let evidenceDir: String
    let devicePublicKeys: [P256.Signing.PublicKey]
    let framesPerSecond: Int
    let displays: [CaptureDisplay]
    let limits: SessionLimits

    init(_ arguments: FixtureArguments) throws {
        guard let modeName = arguments.value("mode"), let mode = FixtureMode(rawValue: modeName) else {
            throw FixtureFailure("--mode must be viewer, pinned-device or invite")
        }
        guard let stateDir = arguments.value("state-dir") else { throw FixtureFailure("--state-dir is required") }
        self.mode = mode
        self.stateDir = stateDir
        evidenceDir = arguments.value("evidence-dir") ?? stateDir
        devicePublicKeys = try arguments.all("device-public-key").map(Self.publicKey)
        framesPerSecond = try arguments.int("fps", default: 30)
        guard (1...60).contains(framesPerSecond) else { throw FixtureFailure("--fps must be 1...60") }
        displays = try (arguments.value("displays") ?? "1920x1080").split(separator: ",").enumerated().map { index, text in
            let parts = text.split(separator: "x").compactMap { Int($0) }
            guard parts.count == 2, (64...8192).contains(parts[0]), (64...8192).contains(parts[1]) else {
                throw FixtureFailure("--displays takes WIDTHxHEIGHT[,WIDTHxHEIGHT…]")
            }
            return CaptureDisplay(id: UInt32(index + 1), width: parts[0], height: parts[1])
        }
        if let idle = arguments.value("idle-seconds") {
            guard let seconds = Int(idle), seconds > 0 else { throw FixtureFailure("--idle-seconds must be positive") }
            limits = SessionLimits(idle: .seconds(seconds))
        } else {
            limits = .standard
        }
    }

    static func publicKey(_ base64: String) throws -> P256.Signing.PublicKey {
        guard let data = Data(base64Encoded: base64), data.count == 65, data.first == 0x04,
              let key = try? P256.Signing.PublicKey(x963Representation: data) else {
            throw FixtureFailure("a device public key is base64 of the 65-byte uncompressed point")
        }
        return key
    }
}

/// What the person at the Mac would be doing, as the session's physical-input probe reads it. Untouched it is "nobody":
/// remote input is ready. `physical-input` commands change it to play local activity or a missing monitor.
enum FixturePhysicalInput {
    static let state = OSAllocatedUnfairLock(initialState: PhysicalInputSnapshot(available: true))
    static let probe: PhysicalInputProbe = { state.withLock { $0 } }
}

final class Receipts: Sendable {
    let writer: JSONLWriter
    init(_ writer: JSONLWriter) { self.writer = writer }
    func log(_ event: String, _ fields: [String: Any] = [:]) {
        var object = fields
        object["event"] = event
        writer.append(object)
    }
}

/// Every event the session admitted, as the real host would have injected it. Nothing is injected anywhere.
final class InputRecorder: Sendable {
    private let writer: JSONLWriter
    private let pointer = OSAllocatedUnfairLock(initialState: [0.5, 0.5])

    init(_ writer: JSONLWriter) { self.writer = writer }

    func record(_ event: InputEvent, source: String, session: Int) {
        if case let .pointerMove(x, y) = event { pointer.withLock { $0 = [x, y] } }
        writer.append(["source": source, "session": session, "event": FixtureInputJSON.object(event)])
    }

    func recordTextAndReturn(_ text: String, session: Int) -> ScreenTextReturnResult {
        writer.append(["source": "phone", "session": session, "event": FixtureInputJSON.textAndReturn(text), "result": "posted"])
        return .posted
    }

    /// Where the fixture's pointer is: the last position the phone moved it to, the middle at first.
    var position: ScreenPointerPosition {
        pointer.withLock { point in
            ScreenPointerPosition(x: UInt16(clamping: Int((point[0] * 65535).rounded())), y: UInt16(clamping: Int((point[1] * 65535).rounded())))
        }
    }
}

struct SessionSummary: Sendable {
    let number: Int
    let deviceID: String
    let version: Int
    let outcome: String
    let statistics: VideoPump.Statistics

    var json: [String: Any] {
        ["session": number, "deviceID": deviceID, "version": version, "outcome": outcome,
         "offered": statistics.offered, "skipped": statistics.skipped, "sent": statistics.sent, "bytes": statistics.bytes]
    }
}

/// One viewer at a time, as ScreenService.accept: the same device reconnecting replaces its session, another device
/// is turned away. Sessions run HostStreamer exactly as the app does, with the stand-in backend its default argument
/// names and an InputReceiver whose every effect is a recorded line.
actor SessionDesk {
    private struct Active {
        let deviceID: Data
        let connection: SecureConnection
        let number: Int
        let hold: ScreenSessionInputHold
        let peerClass: ScreenPeerClass
        var streamer: HostStreamer?
    }

    private let registered: RegisteredDeviceKeys
    private let receipts: Receipts
    private let recorder: InputRecorder
    private let limits: SessionLimits
    private let framesPath: String
    private let options: HostOptions
    private var active: Active?
    private var macHold = ScreenMacHold()
    private var count = 0
    private var finished: [SessionSummary] = []
    private var running: [Task<Void, Never>] = []
    private var turnedOff = false
    private var onTurnOff: (@Sendable () -> Void)?

    init(registered: RegisteredDeviceKeys, receipts: Receipts, recorder: InputRecorder, options: HostOptions) {
        self.registered = registered
        self.receipts = receipts
        self.recorder = recorder
        self.options = options
        limits = options.limits
        framesPath = (options.evidenceDir as NSString).appendingPathComponent("frames.json")
    }

    func setTurnOff(_ action: @escaping @Sendable () -> Void) { onTurnOff = action }

    func accept(_ incoming: MacSession) {
        let id = FixtureEncoding.hex(incoming.deviceID)
        let version = Int(incoming.connection.version)
        guard !turnedOff, registered.key(for: incoming.deviceID) != nil else {
            receipts.log("session-refused", ["deviceID": id, "reason": turnedOff ? "turnedOff" : "notRegistered"])
            return incoming.connection.close()
        }
        if let current = active {
            guard current.deviceID == incoming.deviceID else {
                receipts.log("session-refused", ["deviceID": id, "reason": "anotherDeviceViewing"])
                return incoming.connection.close()
            }
            end(.replaced)
        }
        count += 1
        let number = count
        receipts.log("handshake", ["outcome": "accepted", "deviceID": id, "version": version, "session": number])
        let hold = macHold.begin()
        active = Active(deviceID: incoming.deviceID, connection: incoming.connection, number: number, hold: hold, peerClass: incoming.peerClass)
        running.append(Task { await self.serve(incoming, number: number, deviceID: id, version: version, hold: hold) })
    }

    private nonisolated func serve(_ incoming: MacSession, number: Int, deviceID: String, version: Int, hold: ScreenSessionInputHold) async {
        let recorder = recorder, receipts = receipts
        let input = InputReceiver(physicalInput: { hold.apply(FixturePhysicalInput.probe()) },
                                  release: { recorder.record($0, source: "release", session: number) },
                                  compound: { text, _ in recorder.recordTextAndReturn(text, session: number) },
                                  inject: { recorder.record($0, source: "phone", session: number) })
        hold.attach(input)
        // No `backend:` argument: the default, `ScreenCaptureBackend()`, is the fixture's synthetic display.
        let streamer = HostStreamer(connection: incoming.connection, input: input,
                                    onDisplay: { display in
                                        input.releaseHeld()
                                        receipts.log("display", ["session": number, "display": Int(display.id),
                                                                 "width": display.width, "height": display.height])
                                    },
                                    limits: limits, pointerPosition: { recorder.position })
        guard await attach(streamer, to: incoming.connection) else { return }
        let outcome: String
        do {
            try await streamer.run(lockStates: { AsyncStream { $0.yield(false); $0.finish() } },
                                   turnOff: { Task { await self.turnOffFromDevice(session: number) } })
            outcome = streamer.endReason.map(FixtureNames.endReason) ?? "phoneClosed"
        } catch TransportError.closed {
            outcome = "closed"
        } catch ChannelError.closed {
            outcome = "closed"
        } catch {
            outcome = "error: \(error)"
        }
        await sessionEnded(incoming.connection, summary: SessionSummary(number: number, deviceID: deviceID, version: version,
                                                                         outcome: outcome, statistics: streamer.statistics))
    }

    private func attach(_ streamer: HostStreamer, to connection: SecureConnection) -> Bool {
        guard active?.connection === connection else { return false }
        active?.streamer = streamer
        return true
    }

    private func sessionEnded(_ connection: SecureConnection, summary: SessionSummary) {
        if active?.connection === connection { active = nil }
        finished.append(summary)
        var fields = summary.json
        fields["reason"] = summary.outcome
        receipts.log("session-ended", fields)
        writeFrames()
    }

    private func turnOffFromDevice(session: Int) {
        guard !turnedOff else { return }
        turnedOff = true
        receipts.log("turned-off-from-device", ["session": session])
        onTurnOff?()
    }

    /// Ends the session from the Mac; the phone hears `reason`. Nil when no session is running.
    @discardableResult
    func end(_ reason: SessionEndReason) -> Task<Void, Never>? {
        guard let current = active else { return nil }
        active = nil
        if let streamer = current.streamer { return streamer.end(reason) }
        current.connection.close()
        return nil
    }

    /// Ends the session (if any) as the app does when it quits, then waits for its task to wind down.
    func shutDown() async {
        if let goodbye = end(.turnedOff) { await goodbye.value }
        for task in running { await task.value }
        writeFrames()
    }

    /// As JSON bytes: a dictionary of `Any` cannot leave the actor.
    func statusJSON() -> Data {
        FixtureJSON.line(["activeSession": active.map { $0.number as Any } ?? NSNull(), "sessions": count,
                          "finished": finished.map(\.json), "turnedOff": turnedOff])
    }

    /// Fixture-only scripted actions. No panel is created and no operating-system input is generated.
    func barJSON(_ action: String) -> Data {
        guard let current = active else { return FixtureJSON.line(["ok": false, "error": "no session"]) }
        switch action {
        case "status": break
        case "pause": macHold.pause(current.hold)
        case "view": macHold.lowerToView(current.hold)
        case "resume": _ = macHold.resume(current.hold)
        default: return FixtureJSON.line(["ok": false, "error": "unknown bar action"])
        }
        let isMac = current.peerClass == .controller
        let access = ScreenSessionAccess.of(canControl: true, hold: current.hold.mode, availability: current.hold.availability)
        let state = ScreenSessionBarState(kind: isMac ? .mac : .iPhone, name: isMac ? "Fixture Mac" : "Fixture Phone",
                                          access: access, elapsed: 0, limit: .init(kind: .idle, remaining: 3600), hotKey: "")
        let view = ScreenSessionBarText.present(state)
        receipts.log("bar", ["action": action, "title": view.title, "held": macHold.held, "scripted": true])
        return FixtureJSON.line(["ok": true, "title": view.title, "detail": view.detail,
                                 "actions": view.actions.map(\.rawValue), "held": macHold.held])
    }

    func writeFrames() {
        let capture = ScreenCaptureBackend.counters.withLock { $0 }
        let totals = finished.reduce(into: [0, 0, 0, 0]) { sum, summary in
            sum[0] += summary.statistics.offered; sum[1] += summary.statistics.skipped
            sum[2] += summary.statistics.sent; sum[3] += summary.statistics.bytes
        }
        let object: [String: Any] = [
            "mode": options.mode.rawValue, "framesPerSecondCeiling": options.framesPerSecond,
            "displays": options.displays.map { ["id": Int($0.id), "width": $0.width, "height": $0.height] },
            "capture": capture.json, "sessions": finished.map(\.json),
            "totals": ["offered": totals[0], "skipped": totals[1], "sent": totals[2], "bytes": totals[3]],
            "pattern": ["format": "420YpCbCr8BiPlanarVideoRange", "counterBits": FixturePattern.counterBits],
        ]
        try? FixtureJSON.writeFile(object, to: framesPath)
    }
}

/// Counts connections to a loopback port and closes each at once: the registration boundary only asks whether a phone
/// opened a transport at all.
final class CountingListener: Sendable {
    private let listener: NWListener
    private let queue: DispatchQueue
    private let connections = OSAllocatedUnfairLock(initialState: 0)

    init(label: String) throws {
        let parameters = NWParameters.tcp
        parameters.acceptLocalOnly = true
        parameters.includePeerToPeer = false
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: parameters)
        queue = DispatchQueue(label: "agentstoz.screen-fixture.\(label)")
    }

    var count: Int { connections.withLock { $0 } }

    func start(onConnection: @escaping @Sendable (Int) -> Void) async throws -> UInt16 {
        listener.newConnectionHandler = { [connections] connection in
            let number = connections.withLock { value -> Int in
                value += 1
                return value
            }
            connection.cancel()
            onConnection(number)
        }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
            let once = OSAllocatedUnfairLock(initialState: false)
            listener.stateUpdateHandler = { [listener] state in
                let resume: Result<UInt16, Error>?
                switch state {
                case .ready: resume = .success(listener.port?.rawValue ?? 0)
                case .failed(let error), .waiting(let error): resume = .failure(error)
                case .cancelled: resume = .failure(FixtureFailure("listener cancelled"))
                default: resume = nil
                }
                guard let resume, once.withLock({ claimed in defer { claimed = true }; return !claimed }) else { return }
                continuation.resume(with: resume)
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }
}

enum FixtureHostMain {
    static func run() async -> Int32 {
        let options: HostOptions
        do { options = try HostOptions(try FixtureArguments(Array(CommandLine.arguments.dropFirst()))) } catch {
            FixtureJSON.emit(["event": "error", "message": "\(error)"])
            return 64
        }
        do {
            try FixtureFile.makeDirectory(options.stateDir)
            try FixtureFile.makeDirectory(options.evidenceDir)
            ScreenCaptureBackend.configuration.withLock {
                $0.displays = options.displays
                $0.framesPerSecond = options.framesPerSecond
            }
            let receipts = Receipts(try JSONLWriter(path: (options.evidenceDir as NSString).appendingPathComponent("host-receipts.jsonl")))
            let (stops, stopSink) = AsyncStream.makeStream(of: String.self, bufferingPolicy: .bufferingOldest(8))
            let signals = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
                signal(number, SIG_IGN)
                let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
                source.setEventHandler { stopSink.yield(number == SIGTERM ? "SIGTERM" : "SIGINT") }
                source.resume()
                return source
            }
            defer { signals.forEach { $0.cancel() } }
            let mac = SoftwareTranscriptSigner()
            let shutDown: @Sendable () async -> Void
            let commands: @Sendable ([String: Any]) async -> [String: Any]
            var ready: [String: Any]
            switch options.mode {
            case .viewer, .controller, .pinnedDevice:
                (ready, commands, shutDown) = try await serveScreen(options: options, mac: mac, receipts: receipts)
            case .invite:
                (ready, commands, shutDown) = try await serveInvites(options: options, mac: mac, receipts: receipts)
            }
            ready["event"] = "ready"
            ready["mode"] = options.mode.rawValue
            ready["pid"] = Int(getpid())
            ready["protocolVersion"] = Int(options.mode == .controller ? ScreenControlProtocol.version : ScreenControlProtocol.phoneVersion)
            // What the process itself sees, so the harness can check its allowlisted environment from the inside.
            ready["home"] = ProcessInfo.processInfo.environment["HOME"].map { $0 as Any } ?? NSNull()
            ready["foundationHome"] = NSHomeDirectory()
            ready["environmentKeys"] = ProcessInfo.processInfo.environment.keys.sorted()
            ready["evidenceDir"] = options.evidenceDir
            receipts.log("ready", ["mode": options.mode.rawValue, "pid": Int(getpid())])
            FixtureJSON.emit(ready)

            let reader = Task {
                do {
                    for try await line in FileHandle.standardInput.bytes.lines {
                        guard let data = line.data(using: .utf8),
                              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                            FixtureJSON.emit(["event": "reply", "ok": false, "error": "not a JSON object"])
                            continue
                        }
                        let id = command["id"] ?? NSNull()
                        if command["op"] as? String == "stop" {
                            receipts.log("command", ["op": "stop", "scripted": true])
                            stopSink.yield("stop")
                            return
                        }
                        var reply = await commands(command)
                        reply["event"] = "reply"
                        reply["id"] = id
                        FixtureJSON.emit(reply)
                    }
                } catch {}
                // The harness went away without a word: never outlive it.
                stopSink.yield("stdin closed")
            }
            var iterator = stops.makeAsyncIterator()
            let why = await iterator.next() ?? "stopped"
            reader.cancel()
            await shutDown()
            receipts.log("stopped", ["why": why])
            receipts.writer.close()
            FixtureJSON.emit(["event": "stopped", "why": why])
            return 0
        } catch {
            FixtureJSON.emit(["event": "error", "message": "\(error)"])
            return 1
        }
    }

    static func serveScreen(options: HostOptions, mac: SoftwareTranscriptSigner, receipts: Receipts) async throws
        -> ([String: Any], @Sendable ([String: Any]) async -> [String: Any], @Sendable () async -> Void) {
        let registered = RegisteredDeviceKeys()
        let pinned = OSAllocatedUnfairLock(initialState: [RegisteredDeviceKeys.Entry]())
        @Sendable func pin(_ key: P256.Signing.PublicKey, how: String) -> String {
            let entries = pinned.withLock { list -> [RegisteredDeviceKeys.Entry] in
                list.append(.init(publicKey: key, registeredAt: Date(), lastConnectedAt: nil))
                return list
            }
            registered.set(entries)
            let id = FixtureEncoding.hex(FixtureEncoding.fingerprint(key))
            receipts.log("device-pinned", ["deviceID": id, "how": how, "scripted": true])
            return id
        }
        var pins: [String: Any] = [:]
        if options.mode == .viewer || options.mode == .controller {
            let device = P256.Signing.PrivateKey(), impostor = P256.Signing.PrivateKey()
            pins["devicePrivateKey"] = device.rawRepresentation.base64EncodedString()
            pins["devicePublicKey"] = device.publicKey.x963Representation.base64EncodedString()
            pins["deviceID"] = pin(device.publicKey, how: "generated")
            // Never pinned: a stand-in phone signing with it must be refused before any session starts.
            pins["impostorPrivateKey"] = impostor.rawRepresentation.base64EncodedString()
            pins["impostorDeviceID"] = FixtureEncoding.hex(FixtureEncoding.fingerprint(impostor.publicKey))
        }
        for key in options.devicePublicKeys { _ = pin(key, how: "argument") }

        let handshake = MacHandshake(signer: mac, replay: NonceReplayCache(), registeredPeer: { id in
            registered.key(for: id).map { RegisteredPeerKey(key: $0, peerClass: options.mode == .controller ? .controller : .phone) }
        })
        // Loopback only: no LAN address, no Bonjour service, the production pre-authentication policy.
        let listener = try ScreenListener(handshake: handshake, gate: PreAuthGate(), host: .ipv4(.loopback), port: .any,
                                          accepting: options.mode == .controller ? [.controller] : [.phone])
        let port = try await listener.start().rawValue
        let recorder = InputRecorder(try JSONLWriter(path: (options.evidenceDir as NSString).appendingPathComponent("input-events.jsonl")))
        let desk = SessionDesk(registered: registered, receipts: receipts, recorder: recorder, options: options)
        await desk.setTurnOff { listener.stop() }
        let sessions = Task { for await session in listener.sessions { await desk.accept(session) } }
        let events = Task {
            for await event in listener.events {
                switch event {
                case let .refused(peer, refusal): receipts.log("handshake", ["outcome": "refused", "peer": "\(peer)", "reason": "\(refusal)"])
                case let .failed(peer, reason): receipts.log("handshake", ["outcome": "failed", "peer": "\(peer)", "reason": reason])
                case let .blocked(peer, _): receipts.log("handshake", ["outcome": "blocked", "peer": "\(peer)"])
                }
            }
        }

        let fingerprint = FixtureEncoding.fingerprint(mac.publicKey)
        pins["mode"] = options.mode.rawValue
        pins["host"] = "127.0.0.1"
        pins["port"] = Int(port)
        pins["macPublicKey"] = mac.publicKey.x963Representation.base64EncodedString()
        pins["macFingerprint"] = FixtureEncoding.hex(fingerprint)
        pins["protocolVersion"] = Int(options.mode == .controller ? ScreenControlProtocol.version : ScreenControlProtocol.phoneVersion)
        let pinsPath = (options.stateDir as NSString).appendingPathComponent("pins.json")
        try FixtureJSON.writeFile(pins, to: pinsPath)
        // What the listener was asked to bind, not a measurement: the harness confirms the bound address itself
        // (`lsof -a -p <pid> -iTCP -sTCP:LISTEN`, check host-listens-on-loopback-only).
        receipts.log("listening", ["requestedHost": "127.0.0.1", "port": Int(port), "macFingerprint": FixtureEncoding.hex(fingerprint)])

        let commands: @Sendable ([String: Any]) async -> [String: Any] = { command in
            switch command["op"] as? String {
            case "end":
                let name = command["reason"] as? String ?? "endedAtMac"
                guard let reason = FixtureNames.endReason(named: name) else { return ["ok": false, "error": "unknown reason \(name)"] }
                receipts.log("command", ["op": "end", "reason": name, "scripted": true])
                guard let goodbye = await desk.end(reason) else { return ["ok": false, "error": "no session"] }
                await goodbye.value
                return ["ok": true, "reason": name]
            case "pin-device":
                guard let text = command["publicKey"] as? String, let key = try? HostOptions.publicKey(text) else {
                    return ["ok": false, "error": "publicKey must be base64 of the 65-byte uncompressed point"]
                }
                return ["ok": true, "deviceID": pin(key, how: "command")]
            case "physical-input":
                let snapshot = PhysicalInputSnapshot(available: command["available"] as? Bool ?? true,
                                                     lastEvent: command["held"] as? Bool == true ? .now : nil,
                                                     held: command["held"] as? Bool ?? false,
                                                     secureInput: command["secureInput"] as? Bool ?? false)
                FixturePhysicalInput.state.withLock { $0 = snapshot }
                receipts.log("command", ["op": "physical-input", "available": snapshot.available, "held": snapshot.held,
                                         "secureInput": snapshot.secureInput, "scripted": true])
                return ["ok": true]
            case "status":
                let desk = await desk.statusJSON()
                return ["ok": true, "desk": (try? JSONSerialization.jsonObject(with: desk)) ?? NSNull(), "port": Int(port)]
            case "bar":
                let result = await desk.barJSON(command["action"] as? String ?? "status")
                return (try? JSONSerialization.jsonObject(with: result) as? [String: Any]) ?? ["ok": false]
            default:
                return ["ok": false, "error": "unknown op"]
            }
        }
        let shutDown: @Sendable () async -> Void = {
            listener.stop()
            await desk.shutDown()
            sessions.cancel()
            events.cancel()
        }
        return (["port": Int(port), "pinsPath": pinsPath, "macFingerprint": FixtureEncoding.hex(fingerprint)], commands, shutDown)
    }

    static func serveInvites(options: HostOptions, mac: SoftwareTranscriptSigner, receipts: Receipts) async throws
        -> ([String: Any], @Sendable ([String: Any]) async -> [String: Any], @Sendable () async -> Void) {
        let registration = try CountingListener(label: "registration"), screen = try CountingListener(label: "screen")
        let registrationPort = try await registration.start { count in
            receipts.log("connection", ["listener": "registration", "count": count])
        }
        let screenPort = try await screen.start { count in receipts.log("connection", ["listener": "screen", "count": count]) }
        let fingerprint = FixtureEncoding.fingerprint(mac.publicKey)
        let macName = "AgentsToZ Fixture Mac", hostName = "agentstoz-fixture.local"
        // One fresh code per invitation, as each QR the Mac shows has its own.
        let deviceCode = RegistrationCode.generate(), legacyCode = RegistrationCode.generate(), controllerCode = RegistrationCode.generate()
        let device = try RegistrationInvite(macFingerprint: fingerprint, code: deviceCode, macName: macName, hostName: hostName,
                                            nearbyRegistrationService: ScreenNearby.registrationService(codeID: deviceCode.id),
                                            nearbyScreenService: ScreenNearby.screenService(fingerprint: fingerprint))
        let legacy = try RegistrationInvite(macFingerprint: fingerprint, code: legacyCode, macName: macName, hostName: hostName,
                                            address: "127.0.0.1", registrationPort: registrationPort, screenPort: screenPort)
        let controller = try RegistrationInvite(macFingerprint: fingerprint, code: controllerCode, macName: macName, hostName: hostName,
                                                nearbyRegistrationService: ScreenNearby.registrationService(codeID: controllerCode.id),
                                                nearbyScreenService: ScreenNearby.screenService(fingerprint: fingerprint),
                                                capabilities: .macController)
        // Read back through the phone's own parser before any phone sees them.
        func parsed(_ invite: RegistrationInvite) -> String {
            do {
                _ = try RegistrationInvite(deviceRegistrationText: invite.text)
                return "device"
            } catch RegistrationError.wrongPurpose {
                return "wrongPurpose"
            } catch {
                return "error: \(error)"
            }
        }
        let checks = ["device": parsed(device), "deviceLegacy": parsed(legacy), "controller": parsed(controller)]
        // Only `deviceLegacy` names an address and port: the counting listeners can only ever see a phone that follows
        // it. `device` and `controller` are nearby-only (Bonjour names this fixture never advertises), so a phone
        // following them can never connect here, and "0 connections" proves nothing about them.
        let reachable = ["device": false, "deviceLegacy": true, "controller": false]
        let invitesPath = (options.stateDir as NSString).appendingPathComponent("invites.json")
        try FixtureJSON.writeFile([
            "device": device.text, "deviceLegacy": legacy.text, "controller": controller.text,
            "macFingerprint": FixtureEncoding.hex(fingerprint), "registrationPort": Int(registrationPort),
            "screenPort": Int(screenPort), "deviceRegistrationParse": checks, "countingListenerReachable": reachable,
        ], to: invitesPath)
        receipts.log("invites", ["registrationPort": Int(registrationPort), "screenPort": Int(screenPort),
                                 "deviceRegistrationParse": checks, "countingListenerReachable": reachable, "advertised": false])
        let counts: @Sendable () -> [String: Any] = { ["registration": registration.count, "screen": screen.count] }
        let commands: @Sendable ([String: Any]) async -> [String: Any] = { command in
            switch command["op"] as? String {
            case "status", "counts": ["ok": true, "connections": counts()]
            default: ["ok": false, "error": "unknown op"]
            }
        }
        let shutDown: @Sendable () async -> Void = {
            registration.stop()
            screen.stop()
            receipts.log("connections", counts())
        }
        return (["invitesPath": invitesPath, "registrationPort": Int(registrationPort), "screenPort": Int(screenPort),
                 "deviceRegistrationParse": checks], commands, shutDown)
    }
}

exit(await FixtureHostMain.run())
#else
#error("The screen fixture host is macOS only.")
#endif
