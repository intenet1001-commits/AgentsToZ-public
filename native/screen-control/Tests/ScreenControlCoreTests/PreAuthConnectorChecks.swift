import CryptoKit
import Foundation
import Network
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// A connector on this Mac (cloudflared) reaches the listener from the Mac's own address (SR-25, DESIGN 7.5). Its attempts
// pass an outer bucket that only slows them and are counted under their device from the first frame on, so one device's
// failures never block the Internet path for the others, random IDs cannot fill the gate, and direct LAN peers keep their
// half of the slots. Loopback sockets and an injected clock only.

extension ScreenControlChecks {
    static var preAuthConnectorChecks: [(String, (ScreenControlChecks) -> () async throws -> Void)] { [
        ("connector peers are this Mac's own address or loopback", { $0.testConnectorPeersAreThisMacsOwnAddress }),
        ("connector: two devices never block each other", { $0.testConnectorDevicesNeverBlockEachOther }),
        ("connector: no first frame slows but never blocks", { $0.testConnectorWithoutAFirstFrameIsNeverBlocked }),
        ("connector load leaves LAN its two slots", { $0.testConnectorLoadLeavesLANItsSlots }),
        ("connector: unknown IDs share one sub-bucket", { $0.testUnknownConnectorIDsShareOneSubBucket }),
        ("connector over a real loopback socket", { $0.testConnectorOverARealLoopbackSocket }),
        ("connector: a first frame in time outlives a slow lookup", { $0.testAFirstFrameInTimeOutlivesASlowLookup }),
    ] }

    func testConnectorPeersAreThisMacsOwnAddress() async throws {
        func endpoint(_ host: String) -> NWEndpoint { .hostPort(host: .init(host), port: 52741) }
        try check(ScreenListener.isSameHost(remote: endpoint("127.0.0.1"), local: nil)
                  && ScreenListener.isSameHost(remote: endpoint("::1"), local: nil)
                  && ScreenListener.isSameHost(remote: endpoint("192.168.1.5"), local: endpoint("192.168.1.5"))
                  && ScreenListener.isSameHost(remote: endpoint("::ffff:192.168.1.5"), local: endpoint("192.168.1.5"))
                  && ScreenListener.isSameHost(remote: endpoint("fe80::1"), local: endpoint("fe80::1")), "this Mac")
        try check(!ScreenListener.isSameHost(remote: endpoint("192.168.1.6"), local: endpoint("192.168.1.5"))
                  && !ScreenListener.isSameHost(remote: endpoint("192.168.1.6"), local: nil)
                  && !ScreenListener.isSameHost(remote: endpoint("fe80::2"), local: endpoint("fe80::1")), "another host")
        try check(ScreenListener.isLoopback(.ipv4(.loopback)) && ScreenListener.isLoopback(.ipv6(.loopback))
                  && !ScreenListener.isLoopback(.init("192.168.1.5")), "loopback")

        // Keys: the connector's never collide with an address's or the relay's.
        let id = Data(repeating: 7, count: 32)
        let linkLocal = PeerKey(host: "fe80::1")!, relay = PeerKey(relayEndpoint: URL(string: "wss://relay.invalid/")!)
        try check(PeerKey.connector.isConnector && PeerKey.connectorUnknownDevice.isConnector
                  && PeerKey.connectorDevice(id, known: true).isConnector
                  && PeerKey.connectorDevice(id, known: false) == .connectorUnknownDevice
                  && PeerKey.connectorDevice(id, known: true) != PeerKey.connectorDevice(Data(repeating: 8, count: 32), known: true)
                  && !linkLocal.isConnector && !relay.isConnector && !PeerKey(host: "254.0.0.1")!.isConnector, "distinct keys")
        try check(PeerKey.connector.description == "connector on this Mac" && relay.description == "internet relay"
                  && PeerKey.connectorDevice(id, known: true).description == "connector on this Mac, device 070707070707"
                  && PeerKey(host: "10.0.0.1")!.description == "10.0.0.1", "names")

        // A LAN ticket has no first-frame deadline and is never re-keyed; a connector ticket has one until it is.
        let gate = PreAuthGate()
        let now = ContinuousClock.now
        guard case .success(let lan) = await gate.admit(PeerKey(host: "10.0.0.9")!, at: now),
              case .success(let connector) = await gate.admit(.connector, at: now) else { throw CheckFailure(description: "admit") }
        try check(lan.firstFrameDeadline == nil && connector.firstFrameDeadline == now + .seconds(2)
                  && connector.deadline == now + .seconds(5), "deadlines")
        guard case .success(let same) = await gate.rekey(lan, device: id, known: true, at: now),
              case .success(let counted) = await gate.rekey(connector, device: id, known: true, at: now) else {
            throw CheckFailure(description: "rekey")
        }
        try check(same == lan && counted.peer == .connectorDevice(id, known: true) && counted.firstFrameDeadline == nil
                  && counted.deadline == connector.deadline, "re-keyed under the device, same overall deadline")
        // Any connector key is admitted into the outer bucket.
        guard case .success(let outer) = await gate.admit(.connectorDevice(id, known: true), at: now) else {
            throw CheckFailure(description: "outer admit")
        }
        try check(outer.peer == .connector, "admitted as the connector")
    }

    func testConnectorDevicesNeverBlockEachOther() async throws {
        var policy = PreAuthPolicy()
        policy.failuresBeforeBlock = 5
        let gate = PreAuthGate(policy: policy)
        let a = Data(repeating: 0xA, count: 32), b = Data(repeating: 0xB, count: 32)
        let start = ContinuousClock.now
        var block: PreAuthGate.Event?
        for attempt in 0..<5 {
            let now = start + .seconds(attempt)
            guard case .success(let ticket) = await gate.admit(.connector, at: now),
                  case .success = await gate.rekey(ticket, device: a, known: true, at: now) else {
                throw CheckFailure(description: "attempt \(attempt) of A")
            }
            block = await gate.finish(ticket, succeeded: false, at: now)
        }
        try check(block == .blocked(.connectorDevice(a, known: true), until: start + .seconds(4) + policy.blockFor),
                  "A's fifth failure blocks A: \(String(describing: block))")
        let later = start + .seconds(5)
        guard case .success(let again) = await gate.admit(.connector, at: later) else {
            throw CheckFailure(description: "the connector itself was blocked")
        }
        try check(await gate.rekey(again, device: a, known: true, at: later)
                  == .failure(PreAuthAccountRefusal(peer: .connectorDevice(a, known: true), refusal: .blocked)), "A stays blocked")
        guard case .success(let other) = await gate.admit(.connector, at: later),
              case .success(let counted) = await gate.rekey(other, device: b, known: true, at: later) else {
            throw CheckFailure(description: "B was turned away by A's block")
        }
        try check(counted.peer == .connectorDevice(b, known: true), "B in its own sub-bucket")
        try check(await gate.finish(counted, succeeded: true, at: later) == nil, "B connects")

        // One attempt at a time per device; a refusal lets go of the outer slot and counts nothing.
        let busyAt = start + .seconds(30)
        guard case .success(let first) = await gate.admit(.connector, at: busyAt),
              case .success = await gate.rekey(first, device: b, known: true, at: busyAt),
              case .success(let second) = await gate.admit(.connector, at: busyAt) else { throw CheckFailure(description: "busy setup") }
        try check(await gate.rekey(second, device: b, known: true, at: busyAt)
                  == .failure(PreAuthAccountRefusal(peer: .connectorDevice(b, known: true), refusal: .busy)), "B already in flight")
        guard case .success(let third) = await gate.admit(.connector, at: busyAt) else {
            throw CheckFailure(description: "a refused re-key kept its outer slot")
        }
        try check(await gate.finish(second, succeeded: false, at: busyAt) == nil, "the refused attempt was already let go")
        _ = await gate.finish(first, succeeded: true, at: busyAt)
        _ = await gate.finish(third, succeeded: false, at: busyAt)
        // The sub-bucket's own rate: 1 per second, burst 3.
        let burstAt = start + .seconds(60)
        var outcomes: [Bool] = []
        for _ in 0..<4 {
            guard case .success(let ticket) = await gate.admit(.connector, at: burstAt) else { throw CheckFailure(description: "outer") }
            let rekeyed = await gate.rekey(ticket, device: b, known: true, at: burstAt)
            if case .success = rekeyed { outcomes.append(true); _ = await gate.finish(ticket, succeeded: true, at: burstAt) }
            else {
                try check(rekeyed == .failure(PreAuthAccountRefusal(peer: .connectorDevice(b, known: true), refusal: .tooFast)), "too fast")
                outcomes.append(false)
            }
        }
        try check(outcomes == [true, true, true, false], "burst of three: \(outcomes)")
    }

    func testConnectorWithoutAFirstFrameIsNeverBlocked() async throws {
        let gate = PreAuthGate()
        let start = ContinuousClock.now
        for attempt in 0..<20 {
            let now = start + .seconds(3 * attempt)
            guard case .success(let ticket) = await gate.admit(.connector, at: now) else {
                throw CheckFailure(description: "attempt \(attempt) turned away")
            }
            // Half time out before their first frame, half fail on a malformed one: neither is anyone's failure.
            if attempt.isMultiple(of: 2) {
                try check(ticket.firstFrameDeadline == now + .seconds(2), "first-frame deadline")
            } else {
                try check(await gate.finish(ticket, succeeded: false, at: now + .milliseconds(10)) == nil, "no block")
            }
        }
        try check(await gate.takeEvents().isEmpty, "no blocks to report")
        // Overdue first frames free their slots at the first-frame deadline, not the overall one.
        let at = start + .seconds(100)
        guard case .success = await gate.admit(.connector, at: at), case .success = await gate.admit(.connector, at: at) else {
            throw CheckFailure(description: "two slots")
        }
        try check(await gate.admit(.connector, at: at) == .failure(.busy), "two in flight")
        guard case .success = await gate.admit(.connector, at: at + .milliseconds(2100)) else {
            throw CheckFailure(description: "an overdue first frame kept its slot")
        }
        try check(await gate.takeEvents().isEmpty, "still nothing blocked")
        // The outer rate: 2 per second, burst 4.
        let rateGate = PreAuthGate()
        var admitted = 0
        for _ in 0..<6 {
            if case .success(let ticket) = await rateGate.admit(.connector, at: at) {
                admitted += 1
                _ = await rateGate.finish(ticket, succeeded: false, at: at)
            }
        }
        try check(admitted == 4, "burst of four, then slower: \(admitted)")
    }

    func testConnectorLoadLeavesLANItsSlots() async throws {
        let gate = PreAuthGate()
        let now = ContinuousClock.now
        let id = Data(repeating: 1, count: 32)
        guard case .success(let one) = await gate.admit(.connector, at: now), case .success(let two) = await gate.admit(.connector, at: now) else {
            throw CheckFailure(description: "connector slots")
        }
        _ = await gate.rekey(one, device: id, known: true, at: now)
        _ = await gate.rekey(two, device: Data(repeating: 2, count: 32), known: false, at: now)
        try check(await gate.admit(.connector, at: now) == .failure(.busy), "re-keyed attempts still hold the connector's two")
        guard case .success = await gate.admit(PeerKey(host: "192.168.1.20")!, at: now),
              case .success = await gate.admit(PeerKey(host: "192.168.1.21")!, at: now) else {
            throw CheckFailure(description: "LAN lost its slots to the connector")
        }
        try check(await gate.admit(PeerKey(host: "192.168.1.22")!, at: now) == .failure(.busy), "four overall")
    }

    func testUnknownConnectorIDsShareOneSubBucket() async throws {
        var policy = PreAuthPolicy()
        policy.failuresBeforeBlock = 5
        let gate = PreAuthGate(policy: policy)
        let start = ContinuousClock.now
        var blocked: [PreAuthGate.Event] = []
        for attempt in 0..<40 {
            let now = start + .seconds(attempt)
            guard case .success(let ticket) = await gate.admit(.connector, at: now) else { throw CheckFailure(description: "outer \(attempt)") }
            switch await gate.rekey(ticket, device: randomBytes(32), known: false, at: now) {
            case .success(let counted):
                try check(counted.peer == .connectorUnknownDevice, "unknown IDs share one sub-bucket")
                if let event = await gate.finish(ticket, succeeded: false, at: now) { blocked.append(event) }
            case .failure(let refused):
                try check(refused == PreAuthAccountRefusal(peer: .connectorUnknownDevice, refusal: .blocked), "\(refused)")
            }
        }
        let tracked = await gate.trackedPeers
        try check(tracked == 2, "the connector and its unknown sub-bucket only: \(tracked)")
        try check(blocked.count == 1, "the shared sub-bucket blocks once in its window")
        // A known device is untouched by the unknown sub-bucket's block.
        let now = start + .seconds(41)
        guard case .success(let known) = await gate.admit(.connector, at: now),
              case .success(let counted) = await gate.rekey(known, device: Data(repeating: 9, count: 32), known: true, at: now) else {
            throw CheckFailure(description: "a known device was blocked with the unknown ones")
        }
        try check(counted.peer == .connectorDevice(Data(repeating: 9, count: 32), known: true), "its own sub-bucket")
    }

    func testConnectorOverARealLoopbackSocket() async throws {
        var policy = roomierPolicy()
        policy.connectorFirstFrame = .milliseconds(300)
        policy.deadline = .seconds(3)
        policy.failuresBeforeBlock = 3
        let a = SoftwareSigner(), b = SoftwareSigner(), macSigner = SoftwareSigner()
        let keys = Dictionary(uniqueKeysWithValues: [a, b].map { (ScreenControlIdentity.fingerprint(of: $0.publicKey), $0.publicKey) })
        let mac = MacHandshake(signer: macSigner, replay: NonceReplayCache(), registeredKey: { keys[$0] })
        let (listener, endpoint) = try await peerListener(mac, accepting: [.phone], connectors: .sameHost, policy: policy)
        defer { listener.stop() }
        let aKey = PeerKey.connectorDevice(ScreenControlIdentity.fingerprint(of: a.publicKey), known: true)

        // Silent connections are cut at the first-frame deadline and never block the connector.
        for _ in 0..<4 {
            let started = ContinuousClock.now
            let silent = try await rawConnection(to: endpoint)
            try await waitForEnd(silent)
            try check(ContinuousClock.now - started < .milliseconds(1500), "cut at the first-frame deadline")
            try check(try await nextEvent(listener) == .failed(.connector, reason: "\(TransportError.timedOut)"), "counted against nobody")
        }

        // A known device connects through it and is counted under its own sub-bucket.
        let phone = try await within(5) {
            try await ScreenClient.connect(to: endpoint, handshake: DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: b.publicKey),
                                           signer: b)
        }
        let session = try await nextSession(listener)
        try check(session.peer == .connectorDevice(ScreenControlIdentity.fingerprint(of: b.publicKey), known: true)
                  && session.peerClass == .phone && phone.version == 4, "B's session, by device: \(session.peer)")
        phone.close(); session.connection.close()

        // A fails after its first frame three times: A's sub-bucket alone is blocked, and the event names it.
        for attempt in 0..<3 {
            let raw = try await rawConnection(to: endpoint)
            try await raw.send(DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: a.publicKey).hello)
            _ = try await within(3) { try await raw.receive() }   // the Mac's answer
            try await raw.send(randomBytes(64))
            try await waitForEnd(raw)
            try check(try await nextEvent(listener) == .failed(aKey, reason: "\(HandshakeError.malformed)"), "A's failure \(attempt)")
        }
        guard case .blocked(aKey, _) = try await nextEvent(listener) else { throw CheckFailure(description: "A's block not reported") }
        do {
            _ = try await ScreenClient.connect(to: endpoint, handshake: DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: a.publicKey),
                                               signer: a, timeout: .seconds(2))
            throw CheckFailure(description: "blocked A got through")
        } catch is TransportError {}
        try check(try await nextEvent(listener) == .refused(aKey, .blocked), "A refused after its first frame")
        let again = try await within(5) {
            try await ScreenClient.connect(to: endpoint, handshake: DeviceHandshake(mac: pinned(macSigner.publicKey), devicePublicKey: b.publicKey),
                                           signer: b)
        }
        let second = try await nextSession(listener)
        try check(second.peer.isConnector, "B still connects through the connector")
        again.close(); second.connection.close()
    }

    func testAFirstFrameInTimeOutlivesASlowLookup() async throws {
        // In the gate: the frame came at 1.9 s, the device lookup ran past the 2 s first-frame deadline, and another
        // attempt was admitted meanwhile. The attempt is still counted under its device, with the overall deadline.
        let gate = PreAuthGate()
        let id = Data(repeating: 5, count: 32), account = PeerKey.connectorDevice(id, known: true)
        let start = ContinuousClock.now
        guard case .success(let ticket) = await gate.admit(.connector, at: start) else { throw CheckFailure(description: "admit") }
        await gate.heardFirstFrame(ticket, at: start + .milliseconds(1900))
        guard case .success = await gate.admit(.connector, at: start + .milliseconds(2500)) else {
            throw CheckFailure(description: "a second attempt")
        }
        guard case .success(let counted) = await gate.rekey(ticket, device: id, known: true, at: start + .milliseconds(2600)) else {
            throw CheckFailure(description: "a first frame that came in time was refused after a slow lookup")
        }
        try check(counted.peer == account && counted.firstFrameDeadline == nil && counted.deadline == start + .seconds(5),
                  "counted under its device, by the overall deadline")
        // A frame read at or after the deadline stays late: the attempt goes as one that never sent anything.
        guard case .success(let late) = await gate.admit(.connector, at: start + .seconds(10)) else {
            throw CheckFailure(description: "a later attempt")
        }
        await gate.heardFirstFrame(late, at: start + .seconds(12))
        try check(await gate.rekey(late, device: id, known: true, at: start + .seconds(12))
                  == .failure(PreAuthAccountRefusal(peer: account, refusal: .busy)), "a late first frame is not made timely")
        try check(await gate.takeEvents().isEmpty, "nothing blocked")

        // Through the key exchange: the Mac's lookup takes 600 ms, twice the first-frame deadline, for a hello sent at once.
        var policy = roomierPolicy()
        policy.connectorFirstFrame = .milliseconds(300)
        policy.deadline = .seconds(4)
        let phone = SoftwareSigner(), macSigner = SoftwareSigner()
        let phoneKey = phone.publicKey, phoneID = ScreenControlIdentity.fingerprint(of: phoneKey)
        let lookups = Collector<Int>()
        let slow = MacHandshake(signer: macSigner, replay: NonceReplayCache(), registeredKey: { id in
            lookups.add(1)
            try? await Task.sleep(for: .milliseconds(600))
            return id == phoneID ? phoneKey : nil
        })
        let (deviceEnd, macEnd) = framePipe()
        let pipeGate = PreAuthGate(policy: policy)
        let accepting = Task { try await ScreenTransportHandshake.accept(over: macEnd, peer: .connector, handshake: slow, gate: pipeGate) }
        let connecting = Task {
            try await ScreenTransportHandshake.connect(over: deviceEnd, handshake: DeviceHandshake(mac: pinned(macSigner.publicKey),
                                                                                                   devicePublicKey: phoneKey), signer: phone)
        }
        let session = try await finished(accepting, within: 5)
        let connection = try await finished(connecting, within: 5)
        try check(session.peer == .connectorDevice(phoneID, known: true) && connection.version == 4 && !lookups.all.isEmpty,
                  "a slow lookup kept the attempt: \(session.peer)")
        connection.close(); session.connection.close()
    }
}
