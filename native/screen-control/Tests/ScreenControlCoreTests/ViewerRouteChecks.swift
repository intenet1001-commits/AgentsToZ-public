import CryptoKit
import Foundation
import Network
import os
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// The AgentsToZ Viewer, Mac A (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.1, 6.4-6.6, 7.4, 8절, 12절): how it reaches a
// registered Mac B (ScreenTargetRoute.swift), what it keeps about B and when that changes (ViewerTargets.swift), a
// session over loopback against this build's listener, and the app's own sources (Sources/AgentsToZViewer). In-memory
// pipes, a loopback listener on a free port and a hand-moved clock only: no screen, input, keychain, TCC or Bonjour.

/// A recorded S-M3 result, which this build does not have: what the Viewer would do once control is allowed.
private let measuredCalibration = ScreenInputCalibration(status: .passed, hardwareSourceStates: [1], virtualKeyboardTypes: [77])

/// A row as the registration sheet stores it for Mac `mac`, with `controller` as this Mac's key for it.
private func viewerTarget(mac: P256.Signing.PublicKey, controller: P256.Signing.PublicKey, name: String = "3호 Mac mini",
                          privateNetwork: ScreenPrivateNetworkRoute? = nil, route: ViewerTarget.Route = .auto,
                          state: ViewerTarget.State = .confirmed) throws -> ViewerTarget {
    try ViewerTarget(hostPublicKey: mac, name: name, controllerKeyBlob: Data(repeating: 0xA5, count: 64),
                     controllerPublicKey: controller, privateNetwork: privateNetwork, route: route, state: state,
                     pairedAt: Date(timeIntervalSince1970: 1_793_000_000))
}

/// What B does at the far end of an in-memory path once it opened.
private enum FarMac: Sendable {
    /// Reads the hello and closes: no registration, a short block, another connection or an AgentsToZ Screen before 5.
    case closesAfterHello
    /// Answers the hello with one frame, then closes.
    case says(Data)
    /// Runs the key exchange as `mac`, serving `accepting`.
    case answers(MacHandshake, accepting: Set<ScreenPeerClass>)
}

/// One log for the approval and every path opened, in order, and what each B heard.
private final class RouteLog: Sendable {
    let events = Collector<String>()
    let attempts = Collector<ScreenTargetAttempt>()
    let heard = Collector<Data>()
    let sessions = Collector<SecureConnection>()

    /// The person's approval: logged, then this connection's signer.
    func approval(_ signer: any TranscriptSigner) -> @Sendable () async throws -> any TranscriptSigner {
        { [events] in
            events.add("approve")
            await Task.yield()
            return signer
        }
    }

    /// Opens an in-memory path to `nearby` or `privateNetwork`; a nil one fails to open, and nothing is sent on it.
    func opener(nearby: FarMac?, privateNetwork: FarMac?) -> ScreenTargetOpener {
        ScreenTargetOpener { [self] attempt in
            events.add(attempt.path.isNearby ? "open nearby" : "open private")
            attempts.add(attempt)
            guard let far = attempt.path.isNearby ? nearby : privateNetwork else { throw TransportError.timedOut }
            return pipe(to: far)
        }
    }

    /// The loopback listener at `endpoint` as the nearby path; the private path does not open.
    func loopback(_ endpoint: NWEndpoint) -> ScreenTargetOpener {
        ScreenTargetOpener { [self] attempt in
            events.add(attempt.path.isNearby ? "open nearby" : "open private")
            attempts.add(attempt)
            guard attempt.path.isNearby else { throw TransportError.timedOut }
            return try await ScreenClient.open(to: endpoint, maxFrame: ScreenListener.preAuthMaxFrame, timeout: attempt.timeout)
        }
    }

    private func pipe(to far: FarMac) -> any ScreenFrameTransport {
        let (near, end) = framePipe()
        Task { [heard, sessions] in
            guard let hello = try? await end.receive() else { return }
            heard.add(hello)
            switch far {
            case .closesAfterHello:
                end.cancel()
            case .says(let frame):
                try? await end.send(frame)
                end.cancel()
            case .answers(let mac, let accepting):
                do {
                    let (reply, pending) = try await mac.respond(to: hello, accepting: accepting)
                    try await end.send(reply)
                    let channel = try await pending.confirm(try await end.receive())
                    sessions.add(SecureConnection(framed: end, channel: channel))
                } catch {
                    end.cancel()
                }
            }
        }
        return near
    }
}

/// The Viewer's keychain item as the checks play it: bytes in memory, a read or write that may fail, writes counted.
private final class MemoryTargets: ViewerTargetsBackend, Sendable {
    enum Failure: Error, Equatable { case locked, full }
    private struct State { var data: Data?; var readFails = false; var writeFails = false; var writes = 0 }
    private let state = OSAllocatedUnfairLock(initialState: State())

    var data: Data? { state.withLock { $0.data } }
    var writes: Int { state.withLock { $0.writes } }
    func set(_ data: Data?) { state.withLock { $0.data = data } }
    func failReads(_ fail: Bool) { state.withLock { $0.readFails = fail } }
    func failWrites(_ fail: Bool) { state.withLock { $0.writeFails = fail } }

    func read() throws -> Data? {
        try state.withLock { state in
            if state.readFails { throw Failure.locked }
            return state.data
        }
    }

    func write(_ data: Data) throws {
        try state.withLock { state in
            if state.writeFails { throw Failure.full }
            state.writes += 1
            state.data = data
        }
    }
}

/// A one-use approval already spent, as `FaceIDApprovedSigner` answers a second signature.
private struct SpentSigner: TranscriptSigner, @unchecked Sendable {
    let key = P256.Signing.PrivateKey()
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { throw HandshakeError.alreadyUsed }
}

/// The connector's refusal, or a check failure when it connected.
private func refusal(_ connect: @escaping @Sendable () async throws -> ScreenTargetConnector.Connected,
                     line: Int = #line) async throws -> ScreenTargetConnectError {
    do {
        let connected = try await within(5, line: line, connect)
        await connected.viewer.close()
        throw CheckFailure(description: "line \(line): connected on \(connected.path)")
    } catch let error as ScreenTargetConnectError {
        return error
    }
}

extension ScreenControlChecks {
    static var viewerRouteChecks: [(String, (ScreenControlChecks) -> () async throws -> Void)] { [
        ("Viewer route: cancellation never opens a fallback or sends a hello", { $0.testViewerRouteCancellationDoesNotFallBack }),
        ("Viewer route: no socket before the biometric approval", { $0.testViewerRouteApprovesBeforeAnySocket }),
        ("Viewer route: nearby 3 s, then the saved private address 10 s", { $0.testViewerRouteFallsFromNearbyToPrivate }),
        ("Viewer route: nothing falls back once authentication bytes left", { $0.testViewerRouteNeverFallsBackAfterAuthBytes }),
        ("Viewer route: a private path only for a saved address", { $0.testViewerRoutePrivateOnlyWithASavedAddress }),
        ("Viewer route: an old, unknown or other B is refused in words", { $0.testViewerRouteRefusalsNameTheirCause }),
        ("Viewer targets: only damaged rows are dropped", { $0.testViewerTargetsDropOnlyDamagedRows }),
        ("Viewer targets: an unreadable list is never written over", { $0.testViewerTargetsLedgerNeverOverwritesAnUnreadableList }),
        ("Viewer targets: only a session B signed changes a row", { $0.testViewerTargetsChangeOnlyOnASignedSession }),
        ("Viewer loopback: view grant drops input, takeover (played for B), limit end", { $0.testViewerLoopbackViewTakeoverAndLimit }),
        ("Viewer session: gate, keys, entry, pointer, limits, band, words", { $0.testViewerSessionPieces }),
        ("Viewer session model: warning, held input, locked entry, store failures", { $0.testViewerSessionModel }),
        ("Viewer controls: a key runs only the control holding the focus", { $0.testViewerControlActuation }),
        ("Viewer source contract: hardware only, no other way in", { $0.testViewerSourceContract }),
    ] }

    // MARK: - Route

    func testViewerRouteCancellationDoesNotFallBack() async throws {
        let fixture = PeerFixture()
        let target = try viewerTarget(mac: fixture.macSigner.publicKey, controller: fixture.controllerSigner.publicKey,
                                      privateNetwork: try ScreenPrivateNetworkRoute(address: "10.0.0.7"))
        let log = RouteLog()
        let cancelledOpen = Task {
            try await ScreenTargetConnector.connect(target, approve: log.approval(fixture.controllerSigner),
                opener: ScreenTargetOpener { _ in
                    log.events.add("open cancelled")
                    withUnsafeCurrentTask { $0?.cancel() }
                    throw TransportError.timedOut
                })
        }
        do { _ = try await cancelledOpen.value; throw CheckFailure(description: "cancelled opener connected") }
        catch is CancellationError {}
        try check(log.events.all == ["approve", "open cancelled"], "cancellation must not fall back to the private address")

        let beforeHello = RouteLog()
        let cancelledHandshake = Task {
            try await ScreenTargetConnector.connect(target, approve: beforeHello.approval(fixture.controllerSigner),
                opener: beforeHello.opener(nearby: .answers(fixture.mac, accepting: [.phone, .controller]), privateNetwork: nil),
                progress: { phase in
                    if phase == .authenticatingMac { withUnsafeCurrentTask { $0?.cancel() } }
                })
        }
        do { _ = try await cancelledHandshake.value; throw CheckFailure(description: "cancelled handshake connected") }
        catch is CancellationError {}
        try check(beforeHello.heard.all.isEmpty, "an abandoned attempt must not send an authentication hello")
    }

    func testViewerRouteApprovesBeforeAnySocket() async throws {
        let fixture = PeerFixture()
        let target = try viewerTarget(mac: fixture.macSigner.publicKey, controller: fixture.controllerSigner.publicKey,
                                      privateNetwork: try ScreenPrivateNetworkRoute(address: "10.0.0.7"))
        // While the person has not approved yet, nothing opens.
        let log = RouteLog()
        let (release, released) = AsyncStream.makeStream(of: Void.self)
        let signer = fixture.controllerSigner
        let opener = log.opener(nearby: .answers(fixture.mac, accepting: [.phone, .controller]), privateNetwork: nil)
        let connecting = Task {
            try await ScreenTargetConnector.connect(target, approve: { [events = log.events] in
                events.add("approve")
                for await _ in release { break }
                return signer
            }, opener: opener)
        }
        try await waitUntil { log.events.all == ["approve"] }
        try await Task.sleep(for: .milliseconds(100))
        try check(log.events.all == ["approve"] && log.heard.all.isEmpty, "a path opened before the approval: \(log.events.all)")
        released.yield()
        let connected = try await finished(connecting, within: 5)
        try check(log.events.all == ["approve", "open nearby"] && log.heard.all.count == 1, "approval, then nearby: \(log.events.all)")
        try check(connected.path == .nearby(serviceName: ScreenNearby.screenService(
                      fingerprint: ScreenControlIdentity.fingerprint(of: fixture.macSigner.publicKey)))
                  && connected.unreachable.isEmpty && connected.viewer.connection.version == 5,
                  "a version-5 controller session on B's own nearby service")
        await connected.viewer.close()

        // A declined or failed approval opens nothing at all.
        struct Declined: Error, Equatable {}
        let declined = RouteLog()
        try await expectError(Declined()) {
            _ = try await ScreenTargetConnector.connect(target, approve: { [events = declined.events] in
                events.add("approve")
                throw Declined()
            }, opener: declined.opener(nearby: .closesAfterHello, privateNetwork: .closesAfterHello))
        }
        try check(declined.events.all == ["approve"] && declined.heard.all.isEmpty, "nothing opened: \(declined.events.all)")
    }

    func testViewerRouteFallsFromNearbyToPrivate() async throws {
        let fixture = PeerFixture()
        let saved = try ScreenPrivateNetworkRoute(address: "10.0.0.7")
        let target = try viewerTarget(mac: fixture.macSigner.publicKey, controller: fixture.controllerSigner.publicKey,
                                      privateNetwork: saved)
        let nearby = ScreenTargetPath.nearby(serviceName: target.screenService)
        try check(ScreenTargetRoute.plan(target) == [ScreenTargetAttempt(path: nearby, timeout: .seconds(3)),
                                                     ScreenTargetAttempt(path: .privateNetwork(saved), timeout: .seconds(10))],
                  "자동: nearby for 3 s, then the saved address for 10 s")

        // Nearby does not open; the saved address does, and the session is B's.
        let log = RouteLog()
        let connected = try await within(5) {
            try await ScreenTargetConnector.connect(target, approve: log.approval(fixture.controllerSigner), opener: log.opener(
                nearby: nil, privateNetwork: .answers(fixture.mac, accepting: [.controller])))
        }
        try check(log.events.all == ["approve", "open nearby", "open private"]
                  && log.attempts.all.map(\.timeout) == [.seconds(3), .seconds(10)], "in order: \(log.events.all)")
        try check(connected.path == .privateNetwork(saved) && connected.unreachable == [nearby]
                  && connected.viewer.connection.version == 5 && log.heard.all.count == 1, "the session runs on the private path")
        try await waitUntil { log.sessions.all.count == 1 }
        try await log.sessions.all[0].send(ControlMessage.sessionLimits(grant: .view, limits: .standard))
        let notices = Collector<ScreenNotice>()
        let viewer = connected.viewer
        let reading = Task { for await notice in viewer.notices { notices.add(notice) } }
        let watching = Task { for try await _ in viewer.pictures() {} }
        try await waitUntil { notices.all == [.sessionLimits(grant: .view, limits: .standard)] }
        log.sessions.all[0].close()
        _ = try? await finished(watching)
        reading.cancel()

        // Neither opens: nothing was sent anywhere, and the words point at Cloudflare as well.
        let neither = RouteLog()
        let error = try await refusal {
            try await ScreenTargetConnector.connect(target, approve: neither.approval(fixture.controllerSigner),
                                                    opener: neither.opener(nearby: nil, privateNetwork: nil))
        }
        try check(error == .unreachable([nearby, .privateNetwork(saved)]) && neither.heard.all.isEmpty, "unreachable: \(error)")
        try check(ScreenTargetText.connectFailure(error) == ScreenTargetText.unreachable + " · " + ScreenTargetText.unreachableInternet
                  && ScreenTargetText.connectFailure(.unreachable([nearby])) == ScreenTargetText.unreachable, "unreachable in words")
    }

    func testViewerRouteNeverFallsBackAfterAuthBytes() async throws {
        let fixture = PeerFixture()
        let counting = CountingSigner()
        let saved = try ScreenPrivateNetworkRoute(address: "172.16.4.9")
        let target = try viewerTarget(mac: fixture.macSigner.publicKey, controller: counting.publicKey, privateNetwork: saved)
        let nearby = ScreenTargetPath.nearby(serviceName: target.screenService)
        // Another Mac on B's nearby name that knows this key: its answer does not verify as the pinned B.
        let impostor = PeerFixture(controllerSigner: counting)
        let cases: [(String, FarMac, ScreenTargetRefusal)] = [
            ("closed after the hello", .closesAfterHello, .unanswered),
            ("a busy notice", .says(PreAuthNotice.busy.message), .notice(.busy)),
            ("a not-accepted notice", .says(PreAuthNotice.notAccepted.message), .notice(.notAccepted)),
            ("garbage", .says(Data([0, 0, 0, 1, 9, 9])), .notThisMac),
            ("another Mac", .answers(impostor.mac, accepting: [.controller]), .notThisMac),
        ]
        for (name, far, expected) in cases {
            let log = RouteLog()
            let error = try await refusal {
                try await ScreenTargetConnector.connect(target, approve: log.approval(counting), opener: log.opener(
                    nearby: far, privateNetwork: .answers(fixture.mac, accepting: [.controller])))
            }
            try check(error == .refused(nearby, expected), "\(name): \(error)")
            try check(log.events.all == ["approve", "open nearby"], "\(name): the saved address was tried after: \(log.events.all)")
            try check(log.heard.all.count == 1 && (try DeviceHelloSummary(log.heard.all[0]).offeredVersion) == 5,
                      "\(name): B heard one controller hello")
            try check(target.after(connecting: .failure(error)) == target, "\(name): nothing stored changes")
        }
        try check(await counting.counter.count == 0, "nothing was signed for any of them")
    }

    func testViewerRoutePrivateOnlyWithASavedAddress() async throws {
        let fixture = PeerFixture()
        let saved = try ScreenPrivateNetworkRoute(address: "192.168.0.7")
        let mac = fixture.macSigner.publicKey, key = fixture.controllerSigner.publicKey

        // 「인터넷만」 with nothing saved: no approval is asked and nothing opens.
        let unsaved = try viewerTarget(mac: mac, controller: key, route: .private)
        try check(ScreenTargetRoute.plan(unsaved).isEmpty, "no private path without a saved address")
        let none = RouteLog()
        try await expectError(ScreenTargetConnectError.noRoute) {
            _ = try await ScreenTargetConnector.connect(unsaved, approve: none.approval(fixture.controllerSigner),
                                                        opener: none.opener(nearby: .closesAfterHello, privateNetwork: .closesAfterHello))
        }
        try check(none.events.all.isEmpty && ScreenTargetText.connectFailure(.noRoute) == ScreenTargetText.noRoute,
                  "nothing asked or opened: \(none.events.all)")

        // 자동 with nothing saved: nearby alone; its failure ends there, whatever B might answer elsewhere.
        let auto = try viewerTarget(mac: mac, controller: key)
        let nearby = ScreenTargetPath.nearby(serviceName: auto.screenService)
        try check(ScreenTargetRoute.plan(auto) == [ScreenTargetAttempt(path: nearby, timeout: .seconds(3))], "auto: nearby only")
        let autoLog = RouteLog()
        let autoError = try await refusal {
            try await ScreenTargetConnector.connect(auto, approve: autoLog.approval(fixture.controllerSigner), opener: autoLog.opener(
                nearby: nil, privateNetwork: .answers(fixture.mac, accepting: [.controller])))
        }
        try check(autoError == .unreachable([nearby]) && autoLog.events.all == ["approve", "open nearby"], "auto: \(autoLog.events.all)")

        // 근거리만 with an address saved: never the address.
        let nearbyOnly = auto.savingAddress(saved).choosingRoute(.nearby)
        try check(ScreenTargetRoute.plan(nearbyOnly) == [ScreenTargetAttempt(path: nearby, timeout: .seconds(3))], "nearby only")
        let nearbyLog = RouteLog()
        let nearbyError = try await refusal {
            try await ScreenTargetConnector.connect(nearbyOnly, approve: nearbyLog.approval(fixture.controllerSigner),
                                                    opener: nearbyLog.opener(nearby: nil, privateNetwork: .answers(fixture.mac, accepting: [.controller])))
        }
        try check(nearbyError == .unreachable([nearby]) && nearbyLog.events.all == ["approve", "open nearby"], "nearby only")

        // 인터넷만 with an address saved: never nearby.
        let privateOnly = nearbyOnly.choosingRoute(.private)
        try check(ScreenTargetRoute.plan(privateOnly) == [ScreenTargetAttempt(path: .privateNetwork(saved), timeout: .seconds(10))],
                  "private only")
        let privateLog = RouteLog()
        let connected = try await within(5) {
            try await ScreenTargetConnector.connect(privateOnly, approve: privateLog.approval(fixture.controllerSigner),
                                                    opener: privateLog.opener(nearby: .closesAfterHello,
                                                                              privateNetwork: .answers(fixture.mac, accepting: [.controller])))
        }
        try check(connected.path == .privateNetwork(saved) && privateLog.events.all == ["approve", "open private"], "private only")
        await connected.viewer.close()
        // The route choice and the saved address change nothing else in the row.
        try check(privateOnly.id == auto.id && privateOnly.state == auto.state && privateOnly.keyFingerprint4 == auto.keyFingerprint4
                  && privateOnly.privateNetwork == saved && privateOnly.route == .private, "only what the person chose")
    }

    func testViewerRouteRefusalsNameTheirCause() async throws {
        let saved = try ScreenPrivateNetworkRoute(address: "10.1.2.3")

        // An AgentsToZ Screen older than 5 does not know Mac controllers: it closes without a word. Only the nearby
        // advertisement's pv (looked up for the words, never for a decision) can say it may be old.
        let fixture = PeerFixture()
        let target = try viewerTarget(mac: fixture.macSigner.publicKey, controller: fixture.controllerSigner.publicKey,
                                      privateNetwork: saved)
        let nearby = ScreenTargetPath.nearby(serviceName: target.screenService)
        let old = RouteLog()
        let silent = try await refusal {
            try await ScreenTargetConnector.connect(target, approve: old.approval(fixture.controllerSigner), opener: old.opener(
                nearby: .closesAfterHello, privateNetwork: .answers(fixture.mac, accepting: [.controller])))
        }
        try check(silent == .refused(nearby, .unanswered) && old.events.all == ["approve", "open nearby"], "an old B: \(silent)")
        try check(ScreenTargetText.connectFailure(silent, nearbyHint: .older) == ScreenTargetText.unanswered + " · " + ScreenTargetText.olderScreen
                  && ScreenTargetText.connectFailure(silent, nearbyHint: .current) == ScreenTargetText.unanswered
                  && ScreenTargetText.connectFailure(silent) == ScreenTargetText.unanswered
                  && ScreenTargetText.connectFailure(.refused(.privateNetwork(saved), .unanswered), nearbyHint: .older)
                      == ScreenTargetText.unanswered, "unanswered in words, the pv hint only for nearby")
        try check(ScreenNearbyVersionHint.from(txt: ["pv": "5"]) == .current && ScreenNearbyVersionHint.from(txt: ["pv": "6"]) == .current
                  && ScreenNearbyVersionHint.from(txt: ["pv": "4"]) == .older && ScreenNearbyVersionHint.from(txt: [:]) == .older
                  && ScreenNearbyVersionHint.from(txt: ["pv": "five"]) == .older, "the pv hint")

        // A version-5 B that does not hold this key, over loopback: it names the refusal, and nothing is signed.
        let stranger = PeerFixture(knowsControllers: false)
        let (listener, endpoint) = try await peerListener(stranger.mac, accepting: [.phone, .controller])
        defer { listener.stop() }
        let counting = CountingSigner()
        let strangerTarget = try viewerTarget(mac: stranger.macSigner.publicKey, controller: counting.publicKey, privateNetwork: saved)
        let unknown = RouteLog()
        let notice = try await refusal {
            try await ScreenTargetConnector.connect(strangerTarget, approve: unknown.approval(counting), opener: unknown.loopback(endpoint))
        }
        try check(notice == .refused(.nearby(serviceName: strangerTarget.screenService), .notice(.notAccepted))
                  && unknown.events.all == ["approve", "open nearby"], "an unknown key: \(notice) \(unknown.events.all)")
        try check(await counting.counter.count == 0 && strangerTarget.after(connecting: .failure(notice)) == strangerTarget,
                  "signed nothing, stored nothing")
        let path = ScreenTargetPath.nearby(serviceName: strangerTarget.screenService)
        try check(ScreenTargetText.connectFailure(notice) == ScreenTargetText.noticeNotAccepted
                  && ScreenTargetText.connectFailure(.refused(path, .notice(.rateLimited))) == ScreenTargetText.noticeLater
                  && ScreenTargetText.connectFailure(.refused(path, .notice(.blocked))) == ScreenTargetText.noticeLater
                  && ScreenTargetText.connectFailure(.refused(path, .notice(.busy))) == ScreenTargetText.noticeBusy, "notices in words")

        // A B that holds this key as a phone answers in 4: an old Mac, refused before this Mac signs.
        let asPhoneKey = CountingSigner()
        let asPhone = PeerFixture(phoneSigner: asPhoneKey)
        let phoneTarget = try viewerTarget(mac: asPhone.macSigner.publicKey, controller: asPhoneKey.publicKey)
        let four = RouteLog()
        let tooOld = try await refusal {
            try await ScreenTargetConnector.connect(phoneTarget, approve: four.approval(asPhoneKey),
                                                    opener: four.opener(nearby: .answers(asPhone.mac, accepting: [.phone]), privateNetwork: nil))
        }
        try check(tooOld == .refused(.nearby(serviceName: phoneTarget.screenService), .macTooOld)
                  && ScreenTargetText.connectFailure(tooOld) == ScreenTargetText.macTooOld, "an old Mac: \(tooOld)")
        try check(await asPhoneKey.counter.count == 0, "nothing signed for a version-4 answer")

        // An approval already spent (the Secure Enclave key signs once per approval).
        let spent = SpentSigner()
        let spentMac = PeerFixture(controllerSigner: spent)
        let spentTarget = try viewerTarget(mac: spentMac.macSigner.publicKey, controller: spent.publicKey)
        let used = RouteLog()
        let unusable = try await refusal {
            try await ScreenTargetConnector.connect(spentTarget, approve: used.approval(spent),
                                                    opener: used.opener(nearby: .answers(spentMac.mac, accepting: [.controller]), privateNetwork: nil))
        }
        try check(unusable == .refused(.nearby(serviceName: spentTarget.screenService), .approvalUnusable)
                  && ScreenTargetText.connectFailure(unusable) == ScreenTargetText.approvalUnusable, "a spent approval: \(unusable)")
        try check(ScreenTargetText.connectFailure(.refused(path, .notThisMac)) == ScreenTargetText.notThisMac
                  && ScreenTargetText.connectFailure(.refused(path, .failed("x"))) == ScreenTargetText.unanswered, "the rest in words")
    }

    // MARK: - Targets

    func testViewerTargetsDropOnlyDamagedRows() async throws {
        let controller = SoftwareSigner().publicKey
        let macs = (0..<3).map { _ in SoftwareSigner().publicKey }
        let first = try viewerTarget(mac: macs[0], controller: controller, name: "1호 MacBook",
                                     privateNetwork: try ScreenPrivateNetworkRoute(address: "10.0.0.2"))
        let second = try viewerTarget(mac: macs[1], controller: controller, name: "2호", route: .nearby, state: .needsCheck)
        let third = try viewerTarget(mac: macs[2], controller: controller, name: "3호")
            .after(connecting: .success(Date(timeIntervalSince1970: 1_800_000_123)))
            .after(hearing: .sessionLimits(grant: .control, limits: .standard))

        // What a row holds follows from B's key and this Mac's key for it.
        let fingerprint = ScreenControlIdentity.fingerprint(of: macs[0])
        try check(first.id == ViewerTarget.hex(fingerprint) && first.screenService == ScreenNearby.screenService(fingerprint: fingerprint)
                  && first.hostPublicKey == macs[0].x963Representation
                  && first.keyFingerprint4 == ViewerTarget.hex(ScreenControlIdentity.fingerprint(of: controller).prefix(2))
                  && first.keyFingerprint4.count == 4 && first.displayName == "1호 MacBook" && first.grantLastHeard == nil
                  && first.pinnedMac().fingerprint == fingerprint, "a row from the registration sheet")
        try check(try viewerTarget(mac: macs[0], controller: controller, name: "\u{202E}cod.exe").name == ViewerTarget.unnamedMac
                  && (try viewerTarget(mac: macs[0], controller: controller, name: "").name) == ViewerTarget.unnamedMac
                  && RegistrationInvite.isShowableName(ViewerTarget.unnamedMac), "a name B sent that cannot be shown")

        let document = try ViewerTargetsDocument.encode([first, second, third])
        try check(try ViewerTargetsDocument.decode(document) == .init(targets: [first, second, third], dropped: 0), "round trip")
        guard let object = try JSONSerialization.jsonObject(with: document) as? [String: Any], object["format"] as? Int == 1,
              let rows = object["targets"] as? [[String: Any]], rows.count == 3 else {
            throw CheckFailure(description: "the stored document")
        }
        try check(Set(rows[0].keys) == ["id", "hostPublicKey", "name", "screenService", "controllerKeyBlob", "keyFingerprint4",
                                        "privateNetwork", "route", "state", "pairedAt"]
                  && rows[0]["pairedAt"] as? Double == 1_793_000_000 && rows[0]["route"] as? String == "auto"
                  && Set(rows[2].keys).isSuperset(of: ["grantLastHeard", "lastConnectedAt"]), "row keys: \(rows[0].keys.sorted())")

        // Every damaged row is dropped alone and counted; the others load.
        func changed(_ key: String, _ value: Any?) -> [String: Any] {
            var row = rows[1]
            row[key] = value
            return row
        }
        let other = ScreenControlIdentity.fingerprint(of: SoftwareSigner().publicKey)
        let damaged: [Any] = [
            changed("id", ViewerTarget.hex(other)),
            changed("id", (rows[1]["id"] as? String ?? "").uppercased()),
            changed("screenService", ScreenNearby.screenService(fingerprint: other)),
            changed("hostPublicKey", macs[1].compressedRepresentation.base64EncodedString()),
            changed("hostPublicKey", nil),
            changed("keyFingerprint4", "AB12"),
            changed("keyFingerprint4", "ab1"),
            changed("controllerKeyBlob", ""),
            changed("controllerKeyBlob", Data(count: 8193).base64EncodedString()),
            changed("name", "\u{202E}cod.exe"),
            changed("alias", "line\nbreak"),
            changed("privateNetwork", ["address": "8.8.8.8"]),
            changed("route", "relay"),
            changed("state", "unknown"),
            changed("grantLastHeard", "admin"),
            changed("pairedAt", "yesterday"),
            "not a row", 7, NSNull(), [rows[1]],
            rows[0],
        ]
        let mixed = try JSONSerialization.data(withJSONObject: ["format": 1, "targets": [rows[0] as Any] + damaged + [rows[2] as Any]])
        let decoded = try ViewerTargetsDocument.decode(mixed)
        try check(decoded.targets == [first, third] && decoded.dropped == damaged.count,
                  "kept \(decoded.targets.map(\.name)), dropped \(decoded.dropped) of \(damaged.count)")

        // The document as a whole: an unknown format or a broken document is an error, never an empty list.
        typealias DecodeError = ViewerTargetsDocument.DecodeError
        let wholes: [(String, DecodeError)] = [
            (#"{"format":2,"targets":[]}"#, .unknownFormat), (#"{"format":0,"targets":[]}"#, .unknownFormat),
            (#"{"format":true,"targets":[]}"#, .malformed), (#"{"format":"1","targets":[]}"#, .malformed),
            (#"{"format":1.5,"targets":[]}"#, .malformed), (#"{"targets":[]}"#, .malformed), (#"{"format":1}"#, .malformed),
            (#"{"format":1,"targets":{}}"#, .malformed), ("[]", .malformed), ("not json", .malformed), ("", .malformed),
        ]
        for (text, expected) in wholes {
            try await expectError(expected) { _ = try ViewerTargetsDocument.decode(Data(text.utf8)) }
        }
        try check(try ViewerTargetsDocument.decode(Data(#"{"format":1,"targets":[]}"#.utf8)) == .init(targets: [], dropped: 0),
                  "an empty list is a list")

        // At most 64 rows: more are dropped and counted, and never written.
        let many = try (0...ViewerTargetsDocument.maxTargets).map { _ in try viewerTarget(mac: SoftwareSigner().publicKey, controller: controller) }
        try await expectError(DecodeError.malformed) { _ = try ViewerTargetsDocument.encode(many) }
        try await expectError(DecodeError.malformed) { _ = try ViewerTargetsDocument.encode([first, first]) }
        let full = try ViewerTargetsDocument.encode(Array(many.prefix(ViewerTargetsDocument.maxTargets)))
        guard var fullObject = try JSONSerialization.jsonObject(with: full) as? [String: Any],
              let fullRows = fullObject["targets"] as? [Any] else { throw CheckFailure(description: "the full document") }
        fullObject["targets"] = fullRows + [rows[2] as Any]
        let over = try ViewerTargetsDocument.decode(try JSONSerialization.data(withJSONObject: fullObject))
        try check(over.targets.count == ViewerTargetsDocument.maxTargets && over.dropped == 1 && !over.targets.contains(third),
                  "the 65th row is dropped and counted")
    }

    func testViewerTargetsLedgerNeverOverwritesAnUnreadableList() async throws {
        let controller = SoftwareSigner().publicKey
        let first = try viewerTarget(mac: SoftwareSigner().publicKey, controller: controller, name: "1호")
        let second = try viewerTarget(mac: SoftwareSigner().publicKey, controller: controller, name: "2호")
        let backend = MemoryTargets()
        let ledger = ViewerTargetsLedger(backend: backend)
        try check(ledger.contents == .unread && ledger.targets == nil, "nothing read yet")
        try check(ledger.load() == .loaded(.init(targets: [], dropped: 0)) && backend.writes == 0, "nothing stored is an empty list")
        try ledger.update { $0 + [first] }
        try ledger.replace(first.choosingRoute(.nearby))
        try ledger.replace(second)
        try check(ledger.targets == [first.choosingRoute(.nearby)] && backend.writes == 3
                  && (try backend.data.map(ViewerTargetsDocument.decode))?.targets == [first.choosingRoute(.nearby)],
                  "replace changes the row it names and adds nothing")

        func refuses(_ change: () throws -> Void, line: Int = #line) throws {
            do {
                try change()
                throw CheckFailure(description: "line \(line): an unreadable list was written")
            } catch ViewerTargetsLedger.LedgerError.unreadable {
            }
        }

        // The keychain cannot be read now (locked, missing entitlement): an error, never an empty list, and no write.
        let stored = backend.data
        backend.failReads(true)
        guard case .unreadable = ledger.load(), ledger.targets == nil else { throw CheckFailure(description: "read failure shown as a list") }
        try refuses { try ledger.update { _ in [] } }
        try refuses { try ledger.remove(id: first.id) }
        try refuses { try ledger.replace(first) }
        try check(backend.writes == 3 && backend.data == stored, "nothing written while unreadable")
        backend.failReads(false)

        // A format from a newer Viewer, or a broken item: the same, and its bytes stay.
        for bytes in [Data(#"{"format":2,"targets":[]}"#.utf8), Data("garbage".utf8)] {
            backend.set(bytes)
            guard case .unreadable = ledger.load() else { throw CheckFailure(description: "\(bytes) read as a list") }
            try refuses { try ledger.update { _ in [second] } }
            try check(backend.data == bytes && backend.writes == 3, "kept as it was")
        }

        // A damaged row: the rest load and the count shows. The next change the person makes keeps the good rows.
        guard var object = try JSONSerialization.jsonObject(with: try ViewerTargetsDocument.encode([first, second])) as? [String: Any],
              let rows = object["targets"] as? [Any] else { throw CheckFailure(description: "document") }
        object["targets"] = rows + [["id": "broken"]]
        backend.set(try JSONSerialization.data(withJSONObject: object))
        try check(ledger.load() == .loaded(.init(targets: [first, second], dropped: 1)), "the damaged row alone is dropped")
        try ledger.remove(id: first.id)
        try check(try backend.data.map(ViewerTargetsDocument.decode) == ViewerTargetsDocument.Decoded(targets: [second], dropped: 0),
                  "the good rows stay")

        // A failed write leaves the stored list, and the ledger, as they were.
        backend.failWrites(true)
        try await expectError(MemoryTargets.Failure.full) { try ledger.update { $0 + [first] } }
        try check(ledger.targets == [second] && (try backend.data.map(ViewerTargetsDocument.decode))?.targets == [second],
                  "nothing changed by a failed write")
    }

    func testViewerTargetsChangeOnlyOnASignedSession() async throws {
        let target = try viewerTarget(mac: SoftwareSigner().publicKey, controller: SoftwareSigner().publicKey, state: .needsCheck)
        let path = ScreenTargetPath.nearby(serviceName: target.screenService)
        let saved = try ScreenPrivateNetworkRoute(address: "10.9.8.7"), other = try ScreenPrivateNetworkRoute(address: "10.9.8.6")

        // Every failure, whoever could have caused it, leaves the row exactly as it was: no "unknown at B", no retry.
        let failures: [ScreenTargetConnectError] = [
            .noRoute, .unreachable([path, .privateNetwork(saved)]), .refused(path, .notice(.notAccepted)),
            .refused(path, .notice(.rateLimited)), .refused(path, .notice(.blocked)), .refused(path, .notice(.busy)),
            .refused(path, .unanswered), .refused(path, .macTooOld), .refused(path, .notThisMac), .refused(path, .approvalUnusable),
            .refused(path, .failed("reset")),
        ]
        for failure in failures {
            try check(target.after(connecting: .failure(failure)) == target, "\(failure) changed the row")
        }
        // A session B signed for this key: B holds it.
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        let confirmed = target.after(connecting: .success(at))
        try check(confirmed.state == .confirmed && confirmed.lastConnectedAt == at && confirmed.grantLastHeard == nil
                  && confirmed.privateNetwork == nil && confirmed.route == target.route, "confirmed by a signed session")

        // Inside it, only sessionLimits names the grant; an address hint is never saved by itself.
        let notices: [ScreenNotice] = [.addressHint([saved]), .inputAvailability(.viewOnly), .remoteInputPaused, .macLocked,
                                       .displays(count: 2, current: 1), .spaceChanged, .textAndReturnResult(id: 1, .blocked)]
        for notice in notices {
            try check(confirmed.after(hearing: notice) == confirmed, "\(notice) changed the row")
        }
        try check(confirmed.after(hearing: .sessionLimits(grant: .control, limits: .standard)).grantLastHeard == .control
                  && confirmed.after(hearing: .sessionLimits(grant: .view, limits: .standard)).grantLastHeard == .view,
                  "the grant B said")
        // However it ends, even revoked: the person removes the row.
        for reason in SessionEndReason.allCases.map(Optional.some) + [nil] {
            try check(confirmed.after(ending: reason) == confirmed, "\(String(describing: reason)) changed the row")
        }

        // The address B names is offered, never saved: only during a nearby session with none saved, or as a change.
        try check(ViewerAddressOffer.offer(saved: nil, hint: [saved], path: path) == .save(saved)
                  && ViewerAddressOffer.offer(saved: nil, hint: [], path: path) == ViewerAddressOffer.none
                  && ViewerAddressOffer.offer(saved: nil, hint: [saved], path: .privateNetwork(other)) == ViewerAddressOffer.none
                  && ViewerAddressOffer.offer(saved: saved, hint: [other, saved], path: path) == ViewerAddressOffer.none
                  && ViewerAddressOffer.offer(saved: other, hint: [saved], path: path) == .changed(from: other, to: saved)
                  && ViewerAddressOffer.offer(saved: other, hint: [saved], path: .privateNetwork(other)) == .changed(from: other, to: saved),
                  "address offers")
        let withAddress = confirmed.savingAddress(saved)
        try check(withAddress.privateNetwork == saved && withAddress.state == .confirmed && withAddress.lastConnectedAt == at
                  && (try ViewerTargetsDocument.decode(ViewerTargetsDocument.encode([withAddress]))).targets == [withAddress],
                  "the person's click saves it, and it is stored")
    }

    // MARK: - Loopback

    func testViewerLoopbackViewTakeoverAndLimit() async throws {
        // B: this build's listener for phones and Mac controllers, with A's key in its controller registry (the fixture
        // enrollment), fake capture and a hand-moved clock. B's own wiring (ScreenService) belongs to wp-screen-host;
        // here the check plays its two rules: the registration grants `view`, and a phone's arrival takes over. The
        // takeover is played: the check ends B's pump with `.takenOver` when the phone's session arrives, as B's arbiter
        // (DESIGN 6.5) is to do. What A makes of every notice is the Viewer's own `ViewerSessionModel`.
        let fixture = PeerFixture()
        let (listener, endpoint) = try await peerListener(fixture.mac, accepting: [.phone, .controller])
        defer { listener.stop() }
        let log = RouteLog()
        let loopback = log.loopback(endpoint)
        let backend = MemoryTargets()
        let ledger = ViewerTargetsLedger(backend: backend)
        let target = try viewerTarget(mac: fixture.macSigner.publicKey, controller: fixture.controllerSigner.publicKey, state: .needsCheck)
        try ledger.update { _ in [target] }

        // A connects as the Viewer's 「연결」 does: approval, nearby, the controller's key exchange at 5.
        let connected = try await within(5) {
            try await ScreenTargetConnector.connect(target, approve: log.approval(fixture.controllerSigner), opener: loopback)
        }
        let session = try await nextSession(listener)
        try ledger.replace(target.after(connecting: .success(Date(timeIntervalSince1970: 1_800_000_000))))
        try check(log.events.all == ["approve", "open nearby"] && connected.path == .nearby(serviceName: target.screenService)
                  && connected.viewer.connection.version == 5 && session.peerClass == .controller && session.connection.version == 5,
                  "a controller session at 5: \(log.events.all)")
        try check(ledger.targets?.first?.state == .confirmed, "B signed a session for this key")

        let clock = ManualClock()
        let injected = Collector<InputEvent>()
        let receiver = InputReceiver(physicalInput: { .init(available: true) }, inject: { injected.add($0) })
        let keyframes = KeyframeCounter()
        let limits = SessionLimits(idle: .seconds(3600), maximum: .seconds(3600))
        let hint = [try ScreenPrivateNetworkRoute(address: "10.20.30.40")]
        let pump = try VideoPump(connection: session.connection, input: receiver, limits: limits, clock: clock.session) { _ in keyframes }
        let running = Task {
            try await pump.run(features: SessionFeatures(reportsInputAvailability: true, grant: .view, addressHint: hint))
        }
        let viewer = connected.viewer
        let notices = Collector<ScreenNotice>()
        let reading = Task { for await notice in viewer.notices { notices.add(notice) } }
        let watching = Task { for try await _ in viewer.pictures() {} }
        try await waitUntil { notices.all.count >= 4 }
        try check(Array(notices.all.prefix(4)) == [.sessionLimits(grant: .view, limits: limits), .addressHint(hint),
                                                   .inputAvailability(.viewOnly), .remoteInputPaused], "A hears: \(notices.all)")

        // What the Viewer makes of it, as ViewerSession drives its model: each notice heard against the row as stored
        // now, and the row written only when the notice changed it. View only, the grant stored, the address offered
        // and not saved, the band, the warning.
        var model = ViewerSessionModel(path: connected.path, started: clock.start)
        var measured = ViewerSessionModel(path: connected.path, started: clock.start, calibration: measuredCalibration)
        let writesBefore = backend.writes
        for notice in notices.all {
            guard let stored = ledger.targets?.first else { throw CheckFailure(description: "the row") }
            if let updated = model.hear(notice, stored: stored) { try ledger.replace(updated) }
            _ = measured.hear(notice, stored: stored)
        }
        guard let row = ledger.targets?.first else { throw CheckFailure(description: "the row") }
        let admittedHere = model.admit(.pointerMove(x: 0.5, y: 0.5), at: clock.now)
        let admittedMeasured = measured.admit(.key(code: 0x00, isDown: true, modifiers: []), at: clock.now)
        try check(model.state.grant == .view && !model.sendsInput && !measured.sendsInput && !admittedHere && !admittedMeasured
                  && model.held.isEmpty && measured.held.isEmpty && model.lockedEntry == .hidden, "nothing goes to B")
        try check(backend.writes == writesBefore + 1 && row.grantLastHeard == .view && row.privateNetwork == nil
                  && model.addressOffer == .save(hint[0]) && model.offeredAddress == hint[0],
                  "the grant stored once, the address only offered")
        try check(model.bandLines == [ScreenTargetText.viewOnlyByBuild, ScreenTargetText.otherCapture]
                  && measured.bandLines == [ScreenTargetText.viewOnly, ScreenTargetText.otherCapture], "the band")
        let quietAt5459 = model.tick(at: clock.start + .seconds(3299))
        let shownBefore = model.limitWarningShown
        let cameAt5500 = model.tick(at: clock.start + .seconds(3300))
        try check(model.watch.deadline == clock.start + .seconds(3600) && model.watch.warningAt == clock.start + .seconds(3300)
                  && !quietAt5459 && !shownBefore && cameAt5500 && model.limitWarningShown
                  && model.bandLines.first == ScreenTargetText.limitWarning, "A warns five minutes before B's limit")

        // Input under a view grant (another build of A, or a modified one) reaches B's socket anyway: B drops it (SR-21).
        viewer.input(.pointerMove(x: 0.5, y: 0.5))
        viewer.input(.button(.left, isDown: true))
        viewer.input(.key(code: 0x00, isDown: true, modifiers: []))
        viewer.input(.textAndReturn(id: 1, text: "secret"))
        try await waitUntil { notices.all.contains(.textAndReturnResult(id: 1, .blocked)) }
        try check(injected.all.isEmpty && pump.endReason == nil, "nothing reached B's input: \(injected.all)")

        // A phone, unchanged at version 4, connects to B: B ends the controller's session as taken over.
        let phone = try await within(5) {
            try await ScreenViewer.connect(to: endpoint, mac: fixture.pinnedMac, signer: fixture.phoneSigner)
        }
        let phoneSession = try await nextSession(listener)
        try check(phoneSession.peerClass == .phone && phone.connection.version == 4 && phoneSession.connection.version == 4,
                  "the phone settles on 4")
        await pump.end(.takenOver).value
        _ = try await finished(watching)
        try await finished(running)
        try check(viewer.endReason == .takenOver && ScreenTargetText.ended(viewer.endReason) == "등록된 폰이 B에 연결해 끝났습니다",
                  "A says why: \(String(describing: viewer.endReason))")
        // B's real arbiter is not under test here: this only shows A's side of a takeover B signed.
        try check(row.after(ending: viewer.endReason) == row && ledger.targets == [row], "the ending changes nothing stored")
        reading.cancel()
        await phone.close()
        phoneSession.connection.close()

        // A connects again, with a new approval. B's maximum ends the session; A warned five minutes before.
        let again = try await within(5) {
            try await ScreenTargetConnector.connect(target, approve: log.approval(fixture.controllerSigner), opener: loopback)
        }
        let second = try await nextSession(listener)
        let limitClock = ManualClock()
        let limitKeyframes = KeyframeCounter()
        let limitPump = try VideoPump(connection: second.connection, input: receiver, limits: limits,
                                      clock: limitClock.session) { _ in limitKeyframes }
        let limitRunning = Task { try await limitPump.run(features: SessionFeatures(grant: .view)) }
        let secondViewer = again.viewer
        let heard = Collector<ScreenNotice>()
        let limitReading = Task { for await notice in secondViewer.notices { heard.add(notice) } }
        let limitWatching = Task { for try await _ in secondViewer.pictures() {} }
        try await waitUntil { !heard.all.isEmpty && limitClock.sleeperCount >= 1 }
        var limitModel = ViewerSessionModel(path: again.path, started: limitClock.start)
        for notice in heard.all { _ = limitModel.hear(notice, stored: row) }
        try check(heard.all.first == .sessionLimits(grant: .view, limits: limits), "the limits: \(heard.all)")
        limitClock.advance(by: .seconds(3300))
        let early = limitModel.tick(at: limitClock.now - .seconds(1))
        let warned = limitModel.tick(at: limitClock.now)
        try check(!early && warned && limitModel.limitWarningShown, "the warning at 55:00")
        limitClock.advance(by: .seconds(299))
        let before = limitKeyframes.requests
        try await secondViewer.requestKeyframe()
        try await waitUntil { limitKeyframes.requests > before }
        try check(limitPump.endReason == nil && secondViewer.endReason == nil, "alive at 59:59")
        limitClock.advance(by: .seconds(1))
        _ = try await finished(limitWatching)
        try await finished(limitRunning)
        try check(limitPump.endReason == .timeLimit && secondViewer.endReason == .timeLimit
                  && ScreenTargetText.ended(secondViewer.endReason) == "연결 한도가 끝났습니다. 계속하려면 다시 연결하세요(생체 인증)",
                  "B's limit ended it and A says so: \(String(describing: secondViewer.endReason))")
        try check(log.events.all == ["approve", "open nearby", "approve", "open nearby"] && injected.all.isEmpty,
                  "each connection its own approval: \(log.events.all)")
        limitReading.cancel()
    }

    // MARK: - Session pieces

    func testViewerSessionPieces() async throws {
        // Control needs this build's S-M3 measurement, B's control grant, B taking input and no pause here.
        var control = ScreenMacState()
        control.hear(.sessionLimits(grant: .control, limits: .standard))
        control.hear(.inputAvailability(.ready))
        var paused = control, secure = control, locked = control, view = ScreenMacState()
        paused.hear(.remoteInputPaused)
        secure.hear(.inputAvailability(.secureInput))
        locked.hear(.macLocked)
        view.hear(.sessionLimits(grant: .view, limits: .standard))
        try check(!ScreenInputCalibration.current.allowsControl && !ViewerInputGate.allows(control, pausedHere: false),
                  "this build is view only (S-M3 unmeasured)")
        try check(ViewerInputGate.allows(control, pausedHere: false, calibration: measuredCalibration)
                  && !ViewerInputGate.allows(control, pausedHere: true, calibration: measuredCalibration)
                  && !ViewerInputGate.allows(paused, pausedHere: false, calibration: measuredCalibration)
                  && !ViewerInputGate.allows(secure, pausedHere: false, calibration: measuredCalibration)
                  && !ViewerInputGate.allows(view, pausedHere: false, calibration: measuredCalibration)
                  && !ViewerInputGate.allows(ScreenMacState(), pausedHere: false, calibration: measuredCalibration), "the input gate")
        var unlocked = locked, lockedView = view
        unlocked.hear(.macUnlocked)
        lockedView.hear(.macLocked)
        try check(ViewerInputGate.allowsLockedEntry(locked, calibration: measuredCalibration)
                  && !ViewerInputGate.allowsLockedEntry(control, calibration: measuredCalibration)
                  && !ViewerInputGate.allowsLockedEntry(unlocked, calibration: measuredCalibration)
                  && !ViewerInputGate.allowsLockedEntry(lockedView, calibration: measuredCalibration)
                  && !ViewerInputGate.allowsLockedEntry(locked), "the locked-Mac entry only while B itself says it is locked")
        // A lock screen holds Secure Event Input itself, so a locked B reports `.secureInput` and pauses remote input for
        // that alone: the entry stays open. Anything else B names closes it, and so does silence about B's input.
        func lockedWith(_ notices: [ScreenNotice]) -> ScreenMacState {
            var state = ScreenMacState()
            state.hear(.sessionLimits(grant: .control, limits: .standard))
            for notice in notices { state.hear(notice) }
            state.hear(.macLocked)
            return state
        }
        let lockScreen = lockedWith([.inputAvailability(.secureInput), .remoteInputPaused])
        try check(ViewerInputGate.allowsLockedEntry(lockScreen, calibration: measuredCalibration)
                  && !ViewerInputGate.allows(lockScreen, pausedHere: false, calibration: measuredCalibration)
                  && !ViewerInputGate.allowsLockedEntry(lockScreen), "a lock screen's own secure input keeps the entry open")
        for reason in [ScreenInputAvailability.permissionsRequired, .monitorUnavailable, .localActivity, .viewOnly,
                       .notificationsUnconfirmed, .controlNotInThisBuild] {
            try check(!ViewerInputGate.allowsLockedEntry(lockedWith([.inputAvailability(reason), .remoteInputPaused]),
                                                         calibration: measuredCalibration), "\(reason) closes the entry")
        }
        try check(!ViewerInputGate.allowsLockedEntry(lockedWith([]), calibration: measuredCalibration)
                  && !ViewerInputGate.allowsLockedEntry(lockedWith([.inputAvailability(.ready), .remoteInputPaused]),
                                                        calibration: measuredCalibration), "no input state, or someone at B")

        // The band outside the picture: the most specific limit first, and the capture caveat always.
        let other = ScreenTargetText.otherCapture
        try check(ScreenTargetText.band(control, pausedHere: false) == [ScreenTargetText.viewOnlyByBuild, other]
                  && ScreenTargetText.band(control, pausedHere: false, calibration: measuredCalibration) == [other]
                  && ScreenTargetText.band(control, pausedHere: true, calibration: measuredCalibration) == [ScreenTargetText.inputPausedHere, other]
                  && ScreenTargetText.band(view, pausedHere: false, calibration: measuredCalibration) == [ScreenTargetText.viewOnly, other]
                  && ScreenTargetText.band(secure, pausedHere: false, calibration: measuredCalibration) == [ScreenTargetText.secureInput, other]
                  && ScreenTargetText.band(paused, pausedHere: false, calibration: measuredCalibration) == [ScreenTargetText.remoteInputPaused, other]
                  && ScreenTargetText.band(locked, pausedHere: false, calibration: measuredCalibration) == [ScreenTargetText.macLocked, other],
                  "the band")
        // Every reason B gives for not taking input has its line; none is left blank or named as another.
        let reasons: [(ScreenInputAvailability, String)] = [(.secureInput, ScreenTargetText.secureInput),
                                                            (.permissionsRequired, ScreenTargetText.permissionsRequired),
                                                            (.monitorUnavailable, ScreenTargetText.monitorUnavailable),
                                                            (.localActivity, ScreenTargetText.remoteInputPaused),
                                                            (.viewOnly, ScreenTargetText.viewOnly),
                                                            (.notificationsUnconfirmed, ScreenTargetText.notificationsUnconfirmed),
                                                            (.controlNotInThisBuild, ScreenTargetText.controlNotInThisBuild)]
        for (reason, line) in reasons {
            var state = control
            state.hear(.inputAvailability(reason))
            state.hear(.remoteInputPaused)
            try check(ScreenTargetText.band(state, pausedHere: false, calibration: measuredCalibration) == [line, other],
                      "\(reason): \(ScreenTargetText.band(state, pausedHere: false, calibration: measuredCalibration))")
        }
        try check(Set(reasons.map(\.0)) == Set(ScreenInputAvailability.allCases.filter { $0 != .ready }), "every reason")

        // ⌃⌥⌘, ends the session here and ⌃⌥⌘. stays here; nothing else is kept from B.
        let chord: KeyModifiers = [.control, .option, .command]
        try check(ViewerKeyRoute.route(keyCode: 0x2B, isDown: true, modifiers: chord) == .endSession
                  && ViewerKeyRoute.route(keyCode: 0x2B, isDown: false, modifiers: chord) == .swallow
                  && ViewerKeyRoute.route(keyCode: 0x2F, isDown: true, modifiers: chord) == .swallow
                  && ViewerKeyRoute.route(keyCode: 0x2F, isDown: false, modifiers: chord) == .swallow
                  && ViewerKeyRoute.route(keyCode: 0x2B, isDown: true, modifiers: [.control, .option, .command, .shift]) == .endSession,
                  "the Viewer's own keys")
        try check(ViewerKeyRoute.route(keyCode: 0x2B, isDown: true, modifiers: [.command]) == .forward
                  && ViewerKeyRoute.route(keyCode: 0x2B, isDown: true, modifiers: [.control, .option]) == .forward
                  && ViewerKeyRoute.route(keyCode: 0x2F, isDown: true, modifiers: [.command, .option]) == .forward
                  && ViewerKeyRoute.route(keyCode: 0x00, isDown: true, modifiers: chord) == .forward
                  && ViewerKeyRoute.route(keyCode: 0x30, isDown: true, modifiers: [.command]) == .forward, "B's keys")

        // The locked-Mac entry's buffer: hardware keys only, plain text within the limit, one textAndReturn, then empty.
        var buffer = ViewerSecureBuffer()
        try check(!buffer.type("x", refusal: .synthetic) && !buffer.type("x", refusal: .screenInjection)
                  && !buffer.type("x", refusal: .remoteDesktop) && buffer.isEmpty, "a refused key types nothing")
        try check(buffer.type("pa", refusal: nil) && buffer.type("ss", refusal: nil) && buffer.count == 4, "typed")
        try check(!buffer.type("\n", refusal: nil) && !buffer.type("\t", refusal: nil) && !buffer.type("", refusal: nil)
                  && buffer.count == 4, "no control characters")
        try check(!buffer.deleteBackward(refusal: .ownEvent) && buffer.deleteBackward(refusal: nil) && buffer.count == 3, "delete")
        try check(buffer.take(id: 0) == nil && buffer.count == 3, "id 0 is never sent")
        try check(buffer.take(id: 9) == .textAndReturn(id: 9, text: "pas") && buffer.isEmpty && buffer.take(id: 10) == nil,
                  "one event, then empty")
        try check(buffer.type(String(repeating: "a", count: InputCodec.maxTextBytes), refusal: nil) && !buffer.type("a", refusal: nil)
                  && buffer.count == InputCodec.maxTextBytes, "at most maxTextBytes")
        buffer.clear()
        try check(buffer.isEmpty && buffer.type("한글", refusal: nil) && buffer.count == 2, "cleared, and Korean")

        // The pointer: a fraction of B's display inside the picture; nothing over the bars or the band.
        let inside = ViewerPointer.unit(x: 150, y: 100, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100)
        let origin = ViewerPointer.unit(x: 100, y: 50, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100)
        let corner = ViewerPointer.unit(x: 300, y: 150, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100)
        try check(inside?.x == 0.25 && inside?.y == 0.5 && origin?.x == 0 && origin?.y == 0 && corner?.x == 1 && corner?.y == 1,
                  "inside the picture")
        // Outside the picture, a held button is let go at the nearest edge.
        let left = ViewerPointer.clampedUnit(x: 40, y: 100, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100)
        let below = ViewerPointer.clampedUnit(x: 150, y: -30, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100)
        let within = ViewerPointer.clampedUnit(x: 150, y: 100, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100)
        try check(left?.x == 0 && left?.y == 0.5 && below?.x == 0.25 && below?.y == 0 && within?.x == 0.25 && within?.y == 0.5
                  && ViewerPointer.clampedUnit(x: 1, y: 1, videoX: 0, videoY: 0, videoWidth: 0, videoHeight: 10) == nil
                  && ViewerPointer.clampedUnit(x: .nan, y: 1, videoX: 0, videoY: 0, videoWidth: 10, videoHeight: 10) == nil,
                  "clamped to the picture")
        try check(ViewerPointer.unit(x: 99, y: 100, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100) == nil
                  && ViewerPointer.unit(x: 150, y: 151, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100) == nil
                  && ViewerPointer.unit(x: 150, y: 100, videoX: 100, videoY: 50, videoWidth: 0, videoHeight: 100) == nil
                  && ViewerPointer.unit(x: .nan, y: 100, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100) == nil
                  && ViewerPointer.unit(x: .infinity, y: 100, videoX: 100, videoY: 50, videoWidth: 200, videoHeight: 100) == nil,
                  "outside the picture")

        // The limit watch: B's limits from the session's start and the last input A sent; never later than B.
        let start = ContinuousClock.now
        var watch = ViewerLimitWatch(started: start)
        watch.hear(.inputAvailability(.ready))
        try check(watch.deadline == nil && watch.warningAt == nil && !watch.warns(at: start + .seconds(86_400)),
                  "nothing until B tells its limits")
        watch.hear(.sessionLimits(grant: .control, limits: SessionLimits(idle: .seconds(3600))))
        try check(watch.deadline == start + .seconds(3600) && watch.warningAt == start + .seconds(3300), "idle from the start")
        watch.sentInput(at: start + .seconds(1000))
        watch.sentInput(at: start + .seconds(500))
        try check(watch.deadline == start + .seconds(4600) && watch.warningAt == start + .seconds(4300), "idle from the last input")
        watch.hear(.sessionLimits(grant: .control, limits: SessionLimits(idle: .seconds(3600), maximum: .seconds(4000))))
        try check(watch.deadline == start + .seconds(4000), "the maximum when it comes first")
        var short = ViewerLimitWatch(started: start)
        short.hear(.sessionLimits(grant: .view, limits: SessionLimits(idle: .seconds(120))))
        try check(short.warningAt == start && short.warns(at: start), "a short limit warns from the start")

        // Why a session ended, in B's signed words.
        try check(ScreenTargetText.ended(.takenOver) == "등록된 폰이 B에 연결해 끝났습니다"
                  && ScreenTargetText.ended(.busy) == "다른 기기가 B를 보고 있습니다"
                  && ScreenTargetText.ended(.idle) == ScreenTargetText.ended(.timeLimit)
                  && ScreenTargetText.ended(nil) == "연결이 끝났습니다", "endings")
        let distinct = Set(SessionEndReason.allCases.map { ScreenTargetText.ended($0) })
        try check(distinct.count == SessionEndReason.allCases.count - 2 && !distinct.contains(ScreenTargetText.ended(nil)),
                  "each reason its words (idle and time limit, and the two ways off, share theirs)")
    }

    // MARK: - Session model

    func testViewerSessionModel() async throws {
        let start = ContinuousClock.now
        let path = ScreenTargetPath.nearby(serviceName: "az-screen-000000000000000000000000")
        let fixture = PeerFixture()
        let row = try viewerTarget(mac: fixture.macSigner.publicKey, controller: fixture.controllerSigner.publicKey)
        var model = ViewerSessionModel(path: path, started: start, calibration: measuredCalibration)
        let granted = model.hear(.sessionLimits(grant: .control, limits: SessionLimits(idle: .seconds(3600))), stored: row)
        try check(granted == row.after(hearing: .sessionLimits(grant: .control, limits: .standard)) && granted?.grantLastHeard == .control,
                  "the grant changes the row")
        let current = granted ?? row
        try check(model.hear(.inputAvailability(.ready), stored: current) == nil
                  && model.hear(.sessionLimits(grant: .control, limits: SessionLimits(idle: .seconds(3600))), stored: current) == nil,
                  "nothing else changes it, nor the same grant again")
        try check(model.sendsInput && model.lockedEntry == .hidden && model.bandLines == [ScreenTargetText.otherCapture], "control")

        // The warning comes up five minutes before B's deadline and goes down again when input moves it later.
        let quiet = model.tick(at: start + .seconds(3299))
        try check(!quiet && !model.limitWarningShown, "quiet before 55:00")
        let up = model.tick(at: start + .seconds(3300))
        try check(up && model.limitWarningShown && model.bandLines.first == ScreenTargetText.limitWarning, "up at 55:00")
        let still = model.tick(at: start + .seconds(3310))
        try check(!still && model.limitWarningShown, "it stays while it holds")
        let admitted = model.admit(.pointerMove(x: 0.1, y: 0.1), at: start + .seconds(3320))
        let down = model.tick(at: start + .seconds(3325))
        try check(admitted && down && !model.limitWarningShown && !model.bandLines.contains(ScreenTargetText.limitWarning),
                  "input moved the deadline: down again")
        try check(model.watch.deadline == start + .seconds(6920), "the idle deadline from the last input")

        // What B holds down: noted as sent, let go when input stops going to B, releases only. Caps Lock is a lock.
        let pressed: [InputEvent] = [.button(.left, isDown: true), .key(code: 0x37, isDown: true, modifiers: [.command]),
                                     .key(code: 0x38, isDown: true, modifiers: [.command, .shift]),
                                     .key(code: 0x00, isDown: true, modifiers: [.command, .shift]),
                                     .key(code: 0x39, isDown: true, modifiers: []),
                                     .key(code: 0x01, isDown: true, modifiers: []), .key(code: 0x01, isDown: false, modifiers: [])]
        for event in pressed {
            let went = model.admit(event, at: start + .seconds(3330))
            try check(went, "\(event) goes to B")
        }
        try check(model.held.keys == [0x37, 0x38, 0x00] && model.held.buttons == [.left] && !model.needsRelease,
                  "held: \(model.held)")
        model.setPausedHere(true)
        let newPress = model.admit(.key(code: 0x02, isDown: true, modifiers: []), at: start + .seconds(3331))
        try check(model.needsRelease && !newPress, "paused here: nothing new, something to let go")
        let released = model.releaseHeld()
        let again = model.releaseHeld()
        try check(released == [.button(.left, isDown: false), .key(code: 0x00, isDown: false, modifiers: [.command, .shift]),
                               .key(code: 0x37, isDown: false, modifiers: [.shift]), .key(code: 0x38, isDown: false, modifiers: [])]
                  && model.held.isEmpty && !model.needsRelease && again.isEmpty,
                  "buttons, keys, then modifiers, once: \(released)")
        let releasesOnly = released.allSatisfy { event in
            switch event {
            case .button(_, let isDown), .key(_, let isDown, _): !isDown
            default: false
            }
        }
        try check(releasesOnly, "only releases")
        model.setPausedHere(false)
        let resumed = model.admit(.button(.right, isDown: true), at: start + .seconds(3332))
        try check(resumed, "resumed")
        _ = model.hear(.remoteInputPaused, stored: current)
        let paused = model.needsRelease
        let letGo = model.releaseHeld()
        try check(paused && letGo == [.button(.right, isDown: false)], "B paused: let go")
        _ = model.hear(.remoteInputResumed, stored: current)

        // The locked-Mac entry: open while B says it is locked (its lock screen's secure input included), one send per
        // buffer, closed with the words when B refuses it, open again after B unlocks and locks.
        _ = model.hear(.macUnlocked, stored: current)
        try check(model.lockedEntry == .notLockedWarning, "unlocked B while keys go to it: the fake lock screen warning")
        _ = model.hear(.inputAvailability(.secureInput), stored: current)
        _ = model.hear(.remoteInputPaused, stored: current)
        _ = model.hear(.macLocked, stored: current)
        try check(model.lockedEntry == .open && !model.sendsInput
                  && model.bandLines == [ScreenTargetText.secureInput, ScreenTargetText.macLocked, ScreenTargetText.otherCapture],
                  "locked: \(model.bandLines)")
        var buffer = ViewerSecureBuffer()
        let empty = model.takeLockedEntry(&buffer, at: start + .seconds(3400))
        try check(empty == nil, "nothing typed, nothing sent")
        _ = buffer.type("pw", refusal: nil)
        let sent = model.takeLockedEntry(&buffer, at: start + .seconds(3400))
        try check(sent == .textAndReturn(id: 1, text: "pw") && buffer.isEmpty, "one textAndReturn: \(String(describing: sent))")
        _ = model.hear(.textAndReturnResult(id: 9, .blocked), stored: current)
        try check(model.lockedEntry == .open, "another id's refusal changes nothing")
        _ = model.hear(.textAndReturnResult(id: 1, .blocked), stored: current)
        _ = buffer.type("pw", refusal: nil)
        let refusedSend = model.takeLockedEntry(&buffer, at: start + .seconds(3401))
        try check(model.lockedEntry == .unavailable && refusedSend == nil && buffer.count == 2,
                  "B refused it: 「잠긴 B에는 입력할 수 없음」, and the buffer is not sent")
        _ = model.hear(.macUnlocked, stored: current)
        _ = model.hear(.macLocked, stored: current)
        let retried = model.takeLockedEntry(&buffer, at: start + .seconds(3402))
        try check(retried == .textAndReturn(id: 2, text: "pw"), "after B unlocked and locked again")
        var viewOnly = ViewerSessionModel(path: path, started: start)
        _ = viewOnly.hear(.sessionLimits(grant: .control, limits: .standard), stored: row)
        _ = viewOnly.hear(.macLocked, stored: row)
        try check(viewOnly.lockedEntry == .unavailable, "this build: locked B, no entry, the words")
        _ = viewOnly.hear(.macUnlocked, stored: row)
        try check(viewOnly.lockedEntry == .hidden, "no warning when keys do not go to B")

        // The address: offered from B's hint; a failed save keeps the offer and says so; a save clears both.
        let address = try ScreenPrivateNetworkRoute(address: "10.20.30.40")
        let other = try ScreenPrivateNetworkRoute(address: "10.9.9.9")
        _ = model.hear(.addressHint([address]), stored: current)
        try check(model.offeredAddress == address && model.addressOffer == .save(address), "offered")
        model.storeWriteFailed(ScreenTargetText.addressSaveFailed)
        try check(model.offeredAddress == address && model.bandLines.last == ScreenTargetText.addressSaveFailed, "failed: kept, said")
        model.addressSaved()
        try check(model.offeredAddress == nil && !model.bandLines.contains(ScreenTargetText.addressSaveFailed), "saved")
        _ = model.hear(.addressHint([address]), stored: current.savingAddress(other))
        try check(model.addressOffer == .changed(from: other, to: address), "changed")

        // Dropped input is told once.
        let first = model.noteDroppedInput(), second = model.noteDroppedInput()
        try check(first && !second && model.bandLines.filter { $0 == ScreenInputOriginText.droppedInput }.count == 1, "once")
    }

    func testViewerControlActuation() async throws {
        let own: Int64 = 4100, screen: Int64 = 4200
        func event(_ kind: ScreenInputEvent.Kind, pid: Int64 = 0, age: Double = 0.05) -> ScreenInputEvent {
            ScreenInputEvent(kind: kind, ageSeconds: age, sourcePid: pid, keyboardType: 40, sourceState: 1)
        }
        func judge(_ event: ScreenInputEvent?, sameWindow: Bool = true, inside: Bool = false,
                   focus: Bool = false) -> ScreenInputRefusal? {
            ViewerControlActuation.refusal(event, sameWindow: sameWindow, insideControl: inside, controlHasFocus: focus,
                                           ownPid: own, screenPid: screen)
        }
        // A key runs the control only while that control holds the keyboard focus: a key-down typed anywhere else in the
        // window (another row, the locked-Mac entry) never presses 「이 Mac에서 삭제」 or a toolbar button.
        try check(judge(event(.keyDown), focus: true) == nil, "Space or Return on the focused control")
        try check(judge(event(.keyDown), inside: true, focus: false) == .notTheControl, "a key in the window, another view's focus")
        try check(judge(event(.keyDown), sameWindow: false, focus: true) == .notTheControl, "a key in another window")
        try check(judge(event(.keyDown, pid: 5300), focus: true) == .synthetic
                  && judge(event(.keyDown, pid: screen), focus: true) == .screenInjection
                  && judge(event(.keyDown, age: 3), focus: true) == .staleEvent, "the key itself is judged too")
        try check(judge(event(.keyUp), inside: true, focus: true) == .notTheControl, "a key-up runs nothing")
        // A click is a fresh hardware mouse-up inside the control, whatever has the focus.
        try check(judge(event(.leftMouseUp), inside: true) == nil && judge(event(.leftMouseUp), inside: true, focus: true) == nil,
                  "a click inside")
        try check(judge(event(.leftMouseUp), inside: false, focus: true) == .notTheControl
                  && judge(event(.leftMouseDown), inside: true) == .notTheControl
                  && judge(event(.leftMouseUp), sameWindow: false, inside: true) == .notTheControl, "not this control")
        // An AX press or AppleScript `click button`: no current event.
        try check(judge(nil, inside: true, focus: true) == .noCurrentEvent && judge(nil, sameWindow: false) == .noCurrentEvent, "AX")
        func protected(_ event: ScreenInputEvent?, tracked: Bool, clicks: Int, inside: Bool = true, focus: Bool = false) -> ScreenInputRefusal? {
            ViewerControlActuation.refusal(event, sameWindow: true, insideControl: inside, controlHasFocus: focus,
                                          ownPid: own, screenPid: screen, requiresTrackedClick: true,
                                          trackedOwnMouseDown: tracked, clickCount: clicks)
        }
        try check(protected(event(.leftMouseUp), tracked: true, clicks: 1) == nil, "the button tracked its own single hardware click")
        try check(protected(event(.leftMouseUp), tracked: false, clicks: 1) == .notTheControl
                  && protected(event(.leftMouseUp), tracked: true, clicks: 2) == .notTheControl
                  && protected(event(.leftMouseUp), tracked: true, clicks: 1, inside: false) == .notTheControl,
                  "a borrowed click, repeat or mouse-up outside cannot raise authority")
        try check(protected(event(.leftMouseUp, pid: 5300), tracked: true, clicks: 1) == .synthetic
                  && protected(event(.leftMouseUp, age: 3), tracked: true, clicks: 1) == .staleEvent,
                  "tracking does not replace the origin and freshness checks")
        try check(protected(event(.keyDown), tracked: false, clicks: 0, focus: true) == nil
                  && protected(event(.keyDown), tracked: false, clicks: 0, focus: false) == .notTheControl,
                  "focused hardware keyboard activation stays separate")
        try check(ViewerControlActuation.refusal(event(.leftMouseUp), sameWindow: true, insideControl: true, controlHasFocus: false,
                                                 ownPid: own, screenPid: screen, requiresTrackedClick: false,
                                                 trackedOwnMouseDown: false, clickCount: 2) == nil,
                  "the additional mouse constraint does not change a reduction")
        try check([UInt16(0x31), 0x24, 0x4c].allSatisfy { ViewerControlActuation.buttonKey($0, repeated: false, commandControlOrOption: false) }
                  && !ViewerControlActuation.buttonKey(0x31, repeated: true, commandControlOrOption: false)
                  && !ViewerControlActuation.buttonKey(0x31, repeated: false, commandControlOrOption: true)
                  && !ViewerControlActuation.buttonKey(0x30, repeated: false, commandControlOrOption: false), "button keys")
    }

    // MARK: - Source contract

    func testViewerSourceContract() async throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appending(path: "Sources").appending(path: "AgentsToZViewer")
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".swift") }.sorted()
        let expected: Set<String> = ["HumanAction.swift", "InputForwarder.swift", "PairingSheet.swift", "SecureEntryView.swift",
                                     "SessionWindow.swift", "TargetList.swift", "ViewerApp.swift", "ViewerConnection.swift",
                                     "ViewerSession.swift", "ViewerStore.swift", "main.swift"]
        try check(Set(names).isSuperset(of: expected), "the Viewer's sources: \(names)")
        var sources: [String: String] = [:]
        for name in names {
            sources[name] = viewerCode(try String(contentsOf: directory.appending(path: name), encoding: .utf8))
        }

        // Imports: the core and system frameworks; never ScreenHost, capture, or anything that posts events.
        let allowedImports: Set<String> = ["AppKit", "AVFoundation", "Carbon.HIToolbox", "Foundation", "LocalAuthentication",
                                           "Network", "os", "ScreenControlCore", "Security"]
        for (name, text) in sources {
            for line in text.split(separator: "\n") where line.hasPrefix("import ") {
                let module = line.dropFirst("import ".count).trimmingCharacters(in: .whitespaces)
                try check(allowedImports.contains(module), "\(name) imports \(module)")
            }
        }

        // Nothing but a person opens a session (SR-23, SR-32): no arguments, defaults (which read `-key value`
        // arguments), environment, URL, document, AppleScript, Services, XPC, user activity, listener or local API;
        // and nothing that captures, taps or posts input, reads a pasteboard or a secure field.
        let forbidden = ["ScreenHost", "CommandLine", ".arguments", ".environment", "getenv", "UserDefaults", "NSXPC", "xpc_",
                         "NSAppleScript", "NSAppleEventManager", "kAEGetURL", "kInternetEventClass", "openURLs", "openFile",
                         "NSScriptCommand", "servicesProvider", "NSUpdateDynamicServices", "NSUserActivity", "continueUserActivity",
                         "NSWorkspace.shared.open", "Process(", "NSTask", "posix_spawn", "URLSession", "NWListener", "ScreenListener",
                         "localhost", "127.0.0.1", "3001", "ScreenCaptureKit", "SCStream", "CGWindowListCreateImage",
                         "CGEventTap", "tapCreate", "CGEvent(", "CGEventPost", ".post(", "postNotificationName",
                         "addGlobalMonitorForEvents", "NSPasteboard", "NSSecureTextField", "sendAction(",
                         "NSGestureRecognizer", "NSPopUpButton", "NSSegmentedControl", "NSSwitch", "NSSlider", "NSStepper",
                         "NSComboBox", "doubleAction", "ScreenInputCalibration(", "calibration:"]
        for (name, text) in sources {
            for token in forbidden {
                try check(!text.contains(token), "\(name) uses \(token)")
            }
        }
        // The application delegate answers launch, last window and quit only: no open-URL or open-file entry.
        for (name, text) in sources {
            for function in viewerMatches(#"func (application\w*)\("#, in: text) {
                try check(["applicationDidFinishLaunching", "applicationShouldHandleReopen", "applicationShouldTerminateAfterLastWindowClosed",
                           "applicationWillTerminate"].contains(function[1]), "\(name): \(function[1])")
            }
        }

        // Every action is HumanActions.fire; the menu's Quit and Close only end a session.
        let all = sources.values.joined(separator: "\n")
        let selectors = viewerMatches(#"#selector\(([A-Za-z_.]+\([^)]*\))\)"#, in: all).map { $0[1] }
        try check(selectors.count == all.components(separatedBy: "#selector(").count - 1
                  && Set(selectors).isSubset(of: ["HumanActions.fire(_:)", "present(_:)", "NSApplication.terminate(_:)", "NSWindow.performClose(_:)"]),
                  "selectors: \(selectors)")
        for (name, text) in sources where name != "HumanAction.swift" {
            for token in [".action =", ".action=", "HumanProof(", "NSButton(", "@IBAction", "Selector("] {
                try check(!text.contains(token), "\(name): \(token) outside HumanAction.swift")
            }
            try check(name == "ViewerPresentation.swift" || !text.contains("@objc"), "\(name): unexpected Objective-C action")
        }
        let presentation = sources["ViewerPresentation.swift"] ?? ""
        try check(presentation.contains("private func present(_ sender: Any?) { handler() }")
                  && !presentation.contains("HumanProof") && !presentation.contains("HumanActions")
                  && !presentation.contains("ScreenControlCore"), "presentation has no authority-producing path")
        let targetActions = sources["TargetList.swift"] ?? ""
        try check(targetActions.contains("PresentationButton(title: \"Mac 추가…\")")
                  && targetActions.contains("PresentationButton(title: \"커뮤니티 목록 새로 고침\")")
                  && targetActions.contains("PresentationButton(title: \"화면 등록 안내…\")")
                  && targetActions.contains("PresentationButton(title: \"사설망 주소 설정…\")")
                  && targetActions.contains("HumanButton(title: \"연결\")"), "legacy connection still uses its HumanProof control")
        let trustSelection=String(viewerFunctionBody(targetActions,named:"private func desktopTrustSelection("))
        let trustConnect=String(viewerFunctionBody(targetActions,named:"private func connectTrusted("))
        let selectedHandoff=String(viewerFunctionBody(targetActions,named:"private func consumeScreenSelection("))
        try check(targetActions.contains("if desktopTrustSelection(target.id) != nil") && targetActions.contains("PresentationButton(title:\"기기 신뢰로 연결\")") &&
                  trustSelection.contains("CommunityDesktopScreenTrust.verified(") && trustSelection.contains("controller:own,receiver:peer") &&
                  trustConnect.contains("guard desktopTrustSelection(id) != nil") && trustConnect.contains("connectInternal(id,trusted:true)"),
                  "ordinary connection UI is bound to both signed current desktop-trust subjects, not a button count")
        try check(selectedHandoff.contains("ScreenCommunityCommand(.viewerTargetConsume)") && selectedHandoff.contains("account.currentAuthorization()") &&
                  selectedHandoff.contains("connecting==nil,active==nil") && selectedHandoff.contains("hint.validate(authority:unified.authority,own:own,target:peer)") &&
                  selectedHandoff.contains("connectTrusted(selected)") && !selectedHandoff.contains("connectInternal("),
                  "Screen handoff is single-consume, freshly revalidated and never falls back to legacy connection")
        let handoffGuard=String(viewerFunctionBody(targetActions,named:"func guardTripped(")),handoffPrepare=String(viewerFunctionBody(targetActions,named:"func prepareScreenSelection<"))
        try check(selectedHandoff.contains("prepareScreenSelection") && handoffPrepare.contains("screenSelectionLifecycle.prepare") &&
                  handoffGuard.contains("screenSelectionLifecycle.cancel()"),"OS guard invalidates even a selection still awaiting IPC/auth before connecting exists")
        let communityRoutes = sources["CommunityRouteSheet.swift"] ?? ""
        try check(communityRoutes.contains("HumanButton(title: \"주소 저장\")")
                  && communityRoutes.contains("private func submit(_ proof: HumanProof)")
                  && communityRoutes.contains("ScreenPrivateNetworkRoute(address: raw), proof)"), "community address changes require fresh local hardware proof")
        try check(!viewerFunctionBody(targetActions, named: "private func refreshCommunity(").contains("ledger.")
                  && !viewerFunctionBody(targetActions, named: "private func presentPairing(").contains("HumanProof"),
                  "discovery does not change enrollment, grants, addresses or keys")
        for (name, text) in sources where text.contains("addLocalMonitorForEvents") {
            try check(name == "InputForwarder.swift", "\(name) watches events")
        }

        // A proof exists only where ScreenInputOrigin judged the event (SR-26, SR-29).
        let human = sources["HumanAction.swift"] ?? ""
        for (name, text) in sources where name != "HumanAction.swift" {
            try check(!text.contains("performClick"), "\(name) programmatically clicks a button")
        }
        let mouse = viewerFunctionBody(human, named: "override func mouseDown(")
        let ax = viewerFunctionBody(human, named: "override func accessibilityPerformPress(")
        let programmatic = viewerFunctionBody(human, named: "override func performClick(")
        let buttonKey = viewerFunctionBody(human, named: "override func keyDown(")
        try check(mouse.contains("tracksOwnMouseDown = true") && mouse.contains("guardedAtMouseDown = requiresGuardedActuation")
                  && mouse.contains("defer") && ax.contains("guard !requiresGuardedActuation") && ax.contains("return false")
                  && programmatic.contains("guard !requiresGuardedActuation") && buttonKey.contains("HumanActions.shared.fireKey(self, event: event)")
                  && buttonKey.contains("ViewerControlActuation.buttonKey("), "guarded clicks, AX, programmatic and hardware-key paths")
        try check(viewerMatches(#"struct HumanProof: Sendable \{\s*fileprivate init\(\) \{\}\s*\}"#, in: human).count == 1,
                  "HumanProof can only be made in HumanAction.swift")
        let made = viewerRanges(of: "HumanProof()", in: human)
        try check(made.count == 3, "three places make a proof: \(made.count)")
        for range in made {
            let body = viewerEnclosingFunction(human, before: range.lowerBound)
            try check(body.contains("verdict(for:") || body.contains("ScreenInputOrigin.forward("),
                      "a proof made without a judgment: \(body.prefix(80))")
        }
        let verdict = viewerFunctionBody(human, named: "func verdict(for")
        try check(verdict.contains("ViewerControlActuation.refusal(")
                  && verdict.contains("controlHasFocus: window?.firstResponder === control")
                  && verdict.contains("tracksOwnMouseDown") && verdict.contains("guardedAtMouseDown") && verdict.contains("clickCount:")
                  && !verdict.contains("isKeyWindow") && !verdict.contains("ScreenInputOrigin.")
                  && viewerFunctionBody(human, named: "func fire(").contains("NSApp.currentEvent")
                  && viewerFunctionBody(human, named: "func fire(").contains("button.requiresGuardedActuation, NSApp.currentEvent?.type == .keyDown")
                  && viewerFunctionBody(human, named: "static func forwardProof(").contains("ScreenInputOrigin.forward("),
                  "clicks and keys are judged by ViewerControlActuation (a key only on the focused control), forwarded input by ScreenInputOrigin")

        // Only ViewerSession sends to B, and only from a function that takes the proof, or from `releaseHeld`, which lets
        // go of what such a function pressed and nothing else. Everything else it asks of the session sends no input.
        for (name, text) in sources {
            for member in viewerMatches(#"\bviewer\.(\w+)"#, in: text).map({ $0[1] }) {
                if name == "ViewerSession.swift" {
                    try check(["input", "desktopControl", "unenrollSelf", "notices", "pictures", "endReason", "requestKeyframe",
                               "close"].contains(member), "ViewerSession uses viewer.\(member)")
                } else {
                    try check(member == "close", "\(name) uses viewer.\(member)")
                }
            }
        }
        let session = sources["ViewerSession.swift"] ?? ""
        let sends = ["viewer.input(", "viewer.desktopControl(", "viewer.unenrollSelf("].flatMap { viewerRanges(of: $0, in: session) }
        var senders: Set<String> = []
        for range in sends {
            let declaration = String(viewerEnclosingFunction(session, before: range.lowerBound).prefix { $0 != "{" })
            senders.insert(declaration.split(separator: "(").first.map(String.init) ?? declaration)
            if declaration.hasPrefix("func releaseHeld()") {
                let body = viewerFunctionBody(session, named: "func releaseHeld()")
                try check(viewerRanges(of: "viewer.", in: String(body)).count == 1
                          && body.contains("for event in model.releaseHeld() { viewer.input(event) }"),
                          "releaseHeld sends only the model's releases: \(body)")
            } else if declaration.contains("func sendTrusted(") {
                let body=viewerFunctionBody(session,named:"func sendTrusted(")
                try check(body.contains("desktopTrust?.current()?.canControl == true") && body.contains("model.admit(input,at:.now)"),"trusted input requires its live control lease and model admission")
            } else if declaration.contains("func performTrusted(") {
                let body=viewerFunctionBody(session,named:"func performTrusted(")
                try check(body.contains("desktopTrust?.current() != nil") && body.contains("desktopTrust?.current()?.canControl == true") && body.contains("model.admitControl(at:.now)"),"trusted toolbar effects require the same current typed lease")
            } else if declaration.contains("func sendChordEvents(") {
                let body=viewerFunctionBody(session,named:"private func sendChordEvents(")
                let callers=Set(viewerRanges(of:"sendChordEvents(",in:session).compactMap { use -> String? in
                    let line=session[..<use.lowerBound].split(separator:"\n",omittingEmptySubsequences:false).last ?? ""
                    if line.trimmingCharacters(in:.whitespaces)=="private func" {return nil}
                    let owner=viewerEnclosingFunction(session,before:use.lowerBound)
                    return String(owner.prefix{$0 != "{"}.split(separator:"(").first ?? "")
                })
                try check(session.contains("private func sendChordEvents(") && body.contains("guard !ended, model.sendsInput") &&
                          callers==["func sendChord","func performTrusted"] &&
                          session.contains("func sendChord(_ keys: [UInt16], modifiers: KeyModifiers, proof: HumanProof)"),"shared chord sender remains private, with legacy HumanProof or typed-trust callers only")
            } else {
                try check(declaration.contains("proof: HumanProof"), "sent to B without a proof: \(declaration)")
            }
        }
        try check(senders == ["func send", "func sendTrusted", "func performTrusted", "func sendChordEvents", "func navigate", "func sendLockedEntry", "func unenroll",
                              "func releaseHeld"], "the functions that send to B: \(senders.sorted())")
        // The stored list changes on a hardware click, or on what B said inside its signed session (`hear`), and no write
        // fails silently: each failure is said (the band or the list's status line).
        for (name, text) in sources {
            for token in ["ledger.replace(", "ledger.remove(", "ledger.update("] {
                for range in viewerRanges(of: token, in: text) {
                    let declaration = viewerEnclosingFunction(text, before: range.lowerBound).prefix { $0 != "{" }
                    if name=="TargetList.swift",declaration.hasPrefix("func connectInternal(") {
                        let body=viewerFunctionBody(text,named:"private func connectInternal(")
                        let callers=Set(viewerRanges(of:"connectInternal(",in:text).compactMap { use -> String? in
                            let line=text[..<use.lowerBound].split(separator:"\n",omittingEmptySubsequences:false).last ?? ""
                            if line.trimmingCharacters(in:.whitespaces)=="private func" {return nil}
                            return String(viewerEnclosingFunction(text,before:use.lowerBound).prefix{$0 != "{"}.split(separator:"(").first ?? "")
                        })
                        try check(callers==["func connect","func connectTrusted"] &&
                                  text.contains("private func connect(_ id: String, _ proof: HumanProof)") &&
                                  viewerFunctionBody(text,named:"private func connectTrusted(").contains("guard desktopTrustSelection(id) != nil") &&
                                  body.contains("guard !trusted || common") && body.contains("ViewerConnection.connect(target)") &&
                                  body.contains("self.ticket == mine, !Task.isCancelled") && body.contains("if self.stored(id) == nil") &&
                                  body.contains("if !common, let current") && body.contains("current.after(connecting: .success(Date()))"),
                                  "shared connector updates only a legacy row after authenticated success, under its original human/trusted caller and lifecycle")
                    } else {
                        try check(declaration.contains("HumanProof") || declaration.hasPrefix("func hear(_ notice: ScreenNotice)"),
                                  "\(name) changes the list in \(declaration)")
                    }
                    let from = text.index(range.lowerBound, offsetBy: -24, limitedBy: text.startIndex) ?? text.startIndex
                    let before = text[from..<range.lowerBound]
                    try check(!before.contains("try?"), "\(name) drops a failed write: \(before)\(token)")
                }
            }
        }
        try check(viewerFunctionBody(session, named: "func saveOfferedAddress(").contains("model.storeWriteFailed(ScreenTargetText.addressSaveFailed)")
                  && viewerFunctionBody(session, named: "private func hear(").contains("model.storeWriteFailed(ScreenTargetText.listUpdateFailed)")
                  && viewerFunctionBody(session, named: "private func hear(").contains("if model.needsRelease { releaseHeld() }")
                  && viewerFunctionBody(session, named: "func setPausedHere(").contains("if model.needsRelease { releaseHeld() }"),
                  "a failed save keeps the offer and says so; input that stops lets go of what B holds")
        // Keyboard and pointer go to B only after forwardProof; the entry's characters never come from a field's value.
        let forwarder = sources["InputForwarder.swift"] ?? ""
        try check(viewerFunctionBody(forwarder, named: "func deliver(").contains("HumanActions.forwardProof(for: event)")
                  && !forwarder.contains("interpretKeyEvents"), "the forwarder judges every event")
        for (name, text) in sources where name != "InputForwarder.swift" {
            try check(!text.contains("session.send("), "\(name) forwards input")
        }
        let entry = sources["SecureEntryView.swift"] ?? ""
        for token in ["stringValue", "NSTextField", "NSTextView", "insertText", "interpretKeyEvents", "setAccessibilityValue",
                      "accessibilityValue", "paste"] {
            try check(!entry.contains(token), "the locked-Mac entry uses \(token)")
        }
        let keyDown = viewerFunctionBody(entry, named: "override func keyDown(")
        guard let judged = keyDown.range(of: "HumanActions.forwardProof(for: event)"), let typed = keyDown.range(of: "buffer.type(") else {
            throw CheckFailure(description: "the entry's keyDown")
        }
        try check(judged.lowerBound < typed.lowerBound && entry.contains("EnableSecureEventInput()")
                  && entry.contains("DisableSecureEventInput()") && entry.contains("setAccessibilityRole(.staticText)"),
                  "hardware keys only, under Secure Event Input, and no settable value")
        for (name, text) in sources where name != "SecureEntryView.swift" {
            try check(!text.contains("buffer.type("), "\(name) fills the entry")
        }
        // The 「Mac 추가」 sheet (DESIGN 6.3): code ②'s field is filled by hardware key-downs alone, as
        // ControllerPairingCodeEntry judges them, and has no settable value; K_A reaches the list only with the proof of the
        // click that picked B's window, and only once the pairing succeeded.
        let pairing = sources["PairingSheet.swift"] ?? "", targetList = sources["TargetList.swift"] ?? ""
        let sessionWindow = sources["SessionWindow.swift"] ?? ""
        for (name, text) in sources where !["HumanAction.swift", "PairingSheet.swift", "TargetList.swift", "SessionWindow.swift"].contains(name) {
            try check(!text.contains("guarded:"), "\(name) changes a button's actuation policy")
        }
        try check(pairing.contains("HumanButton(title: title, handler: handler)")
                  && pairing.components(separatedBy: "PresentationButton(").count == 9
                  && !pairing.contains("guarded:") && !pairing.contains("reduction:")
                  && targetList.contains("HumanButton(title: \"이 Mac에서 삭제\", guarded: { false })")
                  && targetList.components(separatedBy: "guarded:").count == 2
                  && sessionWindow.contains("HumanButton(title: \"끊기\", guarded: { false })")
                  && sessionWindow.components(separatedBy: "guarded:").count == 3
                  && sessionWindow.contains("self?.session.pausedHere ?? true"), "sheet dismissal needs no proof; enrollment stays guarded, pause becomes guarded when it resumes")
        let codeField = String(viewerFunctionBody(pairing, named: "final class PairingCodeView"))
        for token in ["stringValue", "NSTextField", "NSTextView", "insertText", "interpretKeyEvents", "setAccessibilityValue",
                      "accessibilityValue", "paste"] {
            try check(!codeField.isEmpty && !codeField.contains(token), "code ②'s field uses \(token)")
        }
        for token in ["SecItem", "ledger."] {
            try check(!pairing.contains(token), "the pairing sheet uses \(token)")
        }
        try check(viewerFunctionBody(codeField, named: "override func keyDown(")
                    .contains("entry.key(key, event: ViewerEvent.read(event), ownPid: ViewerEvent.ownPid, screenPid: ViewerEvent.screenPid())")
                  && codeField.contains("setAccessibilityRole(.staticText)")
                  && viewerFunctionBody(pairing, named: "func pick(").contains("self.onPaired(result, key, proof)")
                  && viewerFunctionBody(targetList, named: "private func presentPairing(")
                    .contains("guard pairing == nil, connecting == nil, active == nil")
                  && viewerFunctionBody(targetList, named: "func guardTripped(").contains("pairing?.close()"),
                  "code ② from hardware keys only; the row is kept with the picking click's proof; no sheet beside a session")
        // The session window is left out of other apps' capture (SR-23), takes hover, and keeps this Mac's display from
        // idle sleep only while the picture is visible; ending the session lets it go and closes the entry, Secure Event
        // Input off, since closing a window resigns no responder.
        let window = sources["SessionWindow.swift"] ?? ""
        try check(window.contains("window.sharingType = .none") && window.contains("window.acceptsMouseMovedEvents = true"),
                  "sharingType, hover")
        let visibility = viewerFunctionBody(window, named: "private func followVisibility(")
        let wrapUp = viewerFunctionBody(window, named: "private func wrapUp(")
        try check(visibility.contains("window.occlusionState.contains(.visible)") && visibility.contains(".idleDisplaySleepDisabled")
                  && visibility.contains("endActivity(") && wrapUp.contains("endActivity(") && wrapUp.contains("entry.endEntry()")
                  && wrapUp.contains("forwarder?.stop()") && wrapUp.contains("window.makeFirstResponder(nil)")
                  && viewerFunctionBody(window, named: "func windowWillClose(").contains("wrapUp()")
                  && window.components(separatedBy: "self.wrapUp()").count == 2, "awake while visible; the end wraps up")
        try check(viewerFunctionBody(entry, named: "func endEntry(").contains("endSecureInput()")
                  && viewerFunctionBody(entry, named: "deinit").contains("DisableSecureEventInput()")
                  && viewerFunctionBody(entry, named: "private func followFocus(").contains("window?.isKeyWindow == true, NSApp.isActive"),
                  "Secure Event Input only while the entry has the focus of the key window in the active app")
        // A connection called off (this Mac locked, slept or switched users; the Mac removed here) never opens a window.
        let list = sources["TargetList.swift"] ?? ""
        let connect = viewerFunctionBody(list, named: "private func connectInternal(")
        try check(connect.contains("self.ticket == mine, !Task.isCancelled") && connect.contains("connecting = (id, mine, task)")
                  && viewerFunctionBody(list, named: "func guardTripped(").contains("callOffConnecting(")
                  && viewerFunctionBody(list, named: "func guardTripped(").contains("screenSelectionLifecycle.cancel()")
                  && viewerFunctionBody(list, named: "private func remove(").contains("callOffConnecting("),
                  "the guards and removal call off a connection in progress")
        let forwarderStart = viewerFunctionBody(forwarder, named: "func start(")
        try check(forwarderStart.contains("NSWindow.didResignKeyNotification") && forwarderStart.contains("session.releaseHeld()"),
                  "the window losing the keyboard focus lets go of what B holds")
    }
}

// MARK: - Reading the Viewer's sources

/// Swift source without comments, string literals kept: a rule matches code, never a comment that mentions it.
private func viewerCode(_ source: String) -> String {
    let characters = Array(source)
    var code = "", index = 0, inString = false, depth = 0
    while index < characters.count {
        let character = characters[index]
        let next: Character? = index + 1 < characters.count ? characters[index + 1] : nil
        if depth > 0 {
            if character == "*", next == "/" { depth -= 1; index += 2; continue }
            if character == "/", next == "*" { depth += 1; index += 2; continue }
            if character == "\n" { code.append(character) }
            index += 1
            continue
        }
        if inString {
            code.append(character)
            if character == "\\", let next {
                code.append(next)
                index += 2
                continue
            }
            if character == "\"" || character == "\n" { inString = false }
            index += 1
            continue
        }
        if character == "/", next == "/" {
            while index < characters.count, characters[index] != "\n" { index += 1 }
            continue
        }
        if character == "/", next == "*" { depth = 1; index += 2; continue }
        if character == "\"" { inString = true }
        code.append(character)
        index += 1
    }
    return code
}

/// Each match of `pattern`, as the whole match followed by its groups.
private func viewerMatches(_ pattern: String, in text: String) -> [[String]] {
    guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
    return expression.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { match in
        (0..<match.numberOfRanges).map { group in Range(match.range(at: group), in: text).map { String(text[$0]) } ?? "" }
    }
}

private func viewerRanges(of token: String, in text: String) -> [Range<String.Index>] {
    var found: [Range<String.Index>] = [], from = text.startIndex
    while let range = text.range(of: token, range: from..<text.endIndex) {
        found.append(range)
        from = range.upperBound
    }
    return found
}

/// From the nearest `func ` before `position` up to `position`: the declaration and the body so far.
private func viewerEnclosingFunction(_ text: String, before position: String.Index) -> Substring {
    guard let start = text.range(of: "func ", options: .backwards, range: text.startIndex..<position)?.lowerBound else { return "" }
    return text[start..<position]
}

/// The body of the first function whose declaration starts with `prefix`, braces balanced.
private func viewerFunctionBody(_ text: String, named prefix: String) -> Substring {
    guard let start = text.range(of: prefix)?.lowerBound, let open = text[start...].firstIndex(of: "{") else { return "" }
    var depth = 0, index = open
    while index < text.endIndex {
        if text[index] == "{" { depth += 1 }
        if text[index] == "}" {
            depth -= 1
            if depth == 0 { return text[start...index] }
        }
        index = text.index(after: index)
    }
    return text[start...]
}
