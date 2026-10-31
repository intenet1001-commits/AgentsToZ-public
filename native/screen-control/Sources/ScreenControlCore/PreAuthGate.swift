import Foundation
import Network

// Before a device proves who it is, a LAN peer may cost the Mac only a bounded amount of work (SR-14, DESIGN
// 「4) 네트워크」). Anyone who has seen a registered device ID can send a hello that makes the Mac sign with its
// Secure Enclave key and run ECDH, so the listener asks this gate before every attempt:
//   - one attempt in flight per peer and a few overall;
//   - a token bucket per peer, then one for the whole listener;
//   - a deadline for the whole key exchange;
//   - repeated failures block the peer for a while, and the host tells the registered devices.
// Peers are grouped by IPv4 address or IPv6 /64, because one LAN host can answer for a whole /64.

public struct PreAuthPolicy: Sendable {
    public var maxInFlightPerPeer = 1
    public var maxInFlight = 4
    public var peerRate = 1.0, peerBurst = 3.0       // attempts per second
    public var globalRate = 4.0, globalBurst = 8.0
    public var deadline: Duration = .seconds(5)
    public var failuresBeforeBlock = 5
    public var failureWindow: Duration = .seconds(600)
    public var blockFor: Duration = .seconds(600)
    /// Peers remembered at once. Past this, new peers are turned away until old state ages out.
    public var maxTrackedPeers = 4096

    public init() {}
}

/// A peer as the gate counts it: an IPv4 address, or the /64 an IPv6 address belongs to.
public struct PeerKey: Hashable, Sendable, CustomStringConvertible {
    let bytes: Data

    public init?(_ endpoint: NWEndpoint) {
        guard case .hostPort(let host, _) = endpoint else { return nil }
        switch host {
        case .ipv4(let address): bytes = address.rawValue
        case .ipv6(let address):
            if let mapped = address.asIPv4 { bytes = mapped.rawValue } else { bytes = address.rawValue.prefix(8) }
        default: return nil
        }
    }

    public init?(host: String) {
        if let address = IPv4Address(host) {
            self.init(.hostPort(host: .ipv4(address), port: 0))
        } else if let address = IPv6Address(host) {
            self.init(.hostPort(host: .ipv6(address), port: 0))
        } else {
            return nil
        }
    }

    /// Relay-assigned IDs cannot be trusted as distinct origins. All attempts through one relay share a
    /// conservative peer bucket, in addition to the gate's global budget.
    public init(relayEndpoint: URL) { bytes = Data([0xff]) + sha256(Data(relayEndpoint.absoluteString.utf8)) }

    public var description: String {
        bytes.count == 33 ? "internet relay" : bytes.count == 4 ? bytes.map(String.init).joined(separator: ".")
                         : bytes.map { String(format: "%02x", $0) }.joined() + "::/64"
    }
}

public enum PreAuthRefusal: Error, Equatable, Sendable {
    /// The peer failed too often and is blocked for now.
    case blocked
    /// An attempt is already running for this peer, or too many overall.
    case busy
    /// Attempts are coming faster than the budget allows.
    case tooFast
}

/// One admitted attempt. Hand it back with `finish` whatever happens.
public struct PreAuthTicket: Hashable, Sendable {
    let id: UInt64
    public let peer: PeerKey
    public let deadline: ContinuousClock.Instant
}

public actor PreAuthGate {
    /// Something the host should tell the registered devices about.
    public enum Event: Equatable, Sendable {
        case blocked(PeerKey, until: ContinuousClock.Instant)
    }

    private struct PeerState {
        var bucket: TokenBucket
        var failures: [ContinuousClock.Instant] = []
        var blockedUntil: ContinuousClock.Instant?
    }

    private let policy: PreAuthPolicy
    private var global: TokenBucket
    private var peers: [PeerKey: PeerState] = [:]
    private var inFlight: [UInt64: PreAuthTicket] = [:]
    private var events: [Event] = []
    private var nextID: UInt64 = 0

    public init(policy: PreAuthPolicy = PreAuthPolicy()) {
        self.policy = policy
        global = TokenBucket(perSecond: policy.globalRate, burst: policy.globalBurst)
    }

    /// Whether `peer` may start a key exchange now. Checks the per-peer budget before the global one, so one noisy
    /// peer spends only its own budget.
    public func admit(_ peer: PeerKey, at now: ContinuousClock.Instant) -> Result<PreAuthTicket, PreAuthRefusal> {
        expireOverdue(at: now)
        if let until = peers[peer]?.blockedUntil, now < until { return .failure(.blocked) }
        guard inFlight.values.filter({ $0.peer == peer }).count < policy.maxInFlightPerPeer,
              inFlight.count < policy.maxInFlight else { return .failure(.busy) }
        if peers[peer] == nil {
            forgetIdlePeers(at: now)
            guard peers.count < policy.maxTrackedPeers else { return .failure(.busy) }
            peers[peer] = PeerState(bucket: TokenBucket(perSecond: policy.peerRate, burst: policy.peerBurst))
        }
        guard peers[peer]!.bucket.admit(at: now), global.admit(at: now) else { return .failure(.tooFast) }
        nextID += 1
        let ticket = PreAuthTicket(id: nextID, peer: peer, deadline: now + policy.deadline)
        inFlight[ticket.id] = ticket
        return .success(ticket)
    }

    /// Ends an attempt. A success clears the peer's failures; enough failures inside the window block the peer.
    /// Returns the block to report, if this failure caused one. A ticket that already expired is ignored: it was
    /// counted as a failure then.
    @discardableResult
    public func finish(_ ticket: PreAuthTicket, succeeded: Bool, at now: ContinuousClock.Instant) -> Event? {
        guard inFlight.removeValue(forKey: ticket.id) != nil else { return nil }
        if succeeded {
            peers[ticket.peer]?.failures.removeAll()
            return nil
        }
        return recordFailure(ticket.peer, at: now)
    }

    /// Blocks caused by attempts that ran past their deadline without being finished.
    public func takeEvents() -> [Event] {
        defer { events.removeAll() }
        return events
    }

    private func expireOverdue(at now: ContinuousClock.Instant) {
        for ticket in inFlight.values where now >= ticket.deadline {
            inFlight[ticket.id] = nil
            if let event = recordFailure(ticket.peer, at: now) { events.append(event) }
        }
    }

    private func recordFailure(_ peer: PeerKey, at now: ContinuousClock.Instant) -> Event? {
        guard var state = peers[peer] else { return nil }
        state.failures = state.failures.filter { now - $0 < policy.failureWindow } + [now]
        var event: Event?
        if state.failures.count >= policy.failuresBeforeBlock {
            state.failures.removeAll()
            state.blockedUntil = now + policy.blockFor
            event = .blocked(peer, until: now + policy.blockFor)
        }
        peers[peer] = state
        return event
    }

    /// Drops peers whose state no longer matters: a full bucket, no failures in the window, no running block,
    /// nothing in flight. Forgetting such a peer changes no decision.
    private func forgetIdlePeers(at now: ContinuousClock.Instant) {
        let busy = Set(inFlight.values.map(\.peer))
        peers = peers.filter { key, state in
            busy.contains(key) || !state.bucket.isFull(at: now)
                || state.failures.contains { now - $0 < policy.failureWindow }
                || state.blockedUntil.map { now < $0 } == true
        }
    }
}
