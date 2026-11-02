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
//
// A connector on this Mac (cloudflared, say) reaches the listener from the Mac's own address, so every Internet attempt
// would share one peer, and a few bad ones would block the Internet path for everyone (SR-25, DESIGN 7.5). Connector
// attempts therefore pass an outer bucket that only slows them down, and are counted under their device from the first
// frame on (`rekey`), before the Mac signs anything: each known device in its own sub-bucket, every unknown ID in one.

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
    /// Connector attempts in flight at once: half of `maxInFlight`, so direct LAN peers always keep the other half.
    public var connectorMaxInFlight = 2
    public var connectorRate = 2.0, connectorBurst = 4.0
    /// A connector attempt that has not sent its first frame by then is cut. Neither this nor a malformed first frame
    /// ever blocks the connector: before the first frame the gate cannot tell one device's attempt from another's.
    public var connectorFirstFrame: Duration = .seconds(2)
    /// One device's sub-bucket behind the connector (and the one every unknown ID shares). Its failures block it alone,
    /// by `failuresBeforeBlock`, `failureWindow` and `blockFor`.
    public var deviceMaxInFlight = 1
    public var deviceRate = 1.0, deviceBurst = 3.0

    public init() {}
}

/// A peer as the gate counts it: an IPv4 address, or the /64 an IPv6 address belongs to.
public struct PeerKey: Hashable, Sendable, CustomStringConvertible {
    let bytes: Data

    private init(bytes: Data) { self.bytes = bytes }

    /// Every attempt that reaches the listener from this Mac itself, before its first frame: the connector's outer bucket.
    public static let connector = PeerKey(bytes: Data([0xfe]))
    /// The one sub-bucket of connector attempts whose device ID neither registry knows.
    public static let connectorUnknownDevice = PeerKey(bytes: Data([0xfc]))

    /// The sub-bucket a connector attempt is counted in once its first frame named `deviceID`.
    public static func connectorDevice(_ deviceID: Data, known: Bool) -> PeerKey {
        known ? PeerKey(bytes: Data([0xfd]) + deviceID) : connectorUnknownDevice
    }

    /// The connector's outer key or one of its sub-buckets.
    public var isConnector: Bool {
        switch (bytes.count, bytes.first) {
        case (1, 0xfe?), (1, 0xfc?), (33, 0xfd?): true
        default: false
        }
    }

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
        switch (bytes.count, bytes.first) {
        case (1, 0xfe?): "connector on this Mac"
        case (1, 0xfc?): "connector on this Mac, unknown device"
        case (33, 0xfd?): "connector on this Mac, device " + bytes.dropFirst().prefix(6).map { String(format: "%02x", $0) }.joined()
        case (33, _): "internet relay"
        case (4, _): bytes.map(String.init).joined(separator: ".")
        default: bytes.map { String(format: "%02x", $0) }.joined() + "::/64"
        }
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

/// A connector attempt its device's sub-bucket turned away after the first frame (`PreAuthGate.rekey`). The gate has
/// already let go of the attempt without counting a failure.
public struct PreAuthAccountRefusal: Error, Equatable, Sendable {
    public let peer: PeerKey
    public let refusal: PreAuthRefusal
}

/// One admitted attempt. Hand it back with `finish` whatever happens.
public struct PreAuthTicket: Hashable, Sendable {
    let id: UInt64
    /// The bucket the attempt is counted in: its address, the relay, or the connector and, after `rekey`, its device.
    public let peer: PeerKey
    public let deadline: ContinuousClock.Instant
    /// For a connector attempt not yet counted under its device: when its first frame must have arrived.
    public let firstFrameDeadline: ContinuousClock.Instant?

    init(id: UInt64, peer: PeerKey, deadline: ContinuousClock.Instant, firstFrameDeadline: ContinuousClock.Instant? = nil) {
        self.id = id
        self.peer = peer
        self.deadline = deadline
        self.firstFrameDeadline = firstFrameDeadline
    }

    /// When the gate gives up on it: the first-frame deadline until the attempt is counted under its device.
    var expiry: ContinuousClock.Instant { firstFrameDeadline.map { min($0, deadline) } ?? deadline }
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
    /// peer spends only its own budget. Any connector key is admitted as `PeerKey.connector`, in the outer bucket.
    public func admit(_ peer: PeerKey, at now: ContinuousClock.Instant) -> Result<PreAuthTicket, PreAuthRefusal> {
        expireOverdue(at: now)
        let peer = peer.isConnector ? PeerKey.connector : peer
        if let until = peers[peer]?.blockedUntil, now < until { return .failure(.blocked) }
        let running = peer.isConnector ? inFlight.values.filter(\.peer.isConnector).count
                                       : inFlight.values.filter({ $0.peer == peer }).count
        guard running < (peer.isConnector ? policy.connectorMaxInFlight : policy.maxInFlightPerPeer),
              inFlight.count < policy.maxInFlight else { return .failure(.busy) }
        if peers[peer] == nil {
            forgetIdlePeers(at: now)
            guard peers.count < policy.maxTrackedPeers else { return .failure(.busy) }
            peers[peer] = peer.isConnector ? PeerState(bucket: TokenBucket(perSecond: policy.connectorRate, burst: policy.connectorBurst))
                                           : PeerState(bucket: TokenBucket(perSecond: policy.peerRate, burst: policy.peerBurst))
        }
        guard peers[peer]!.bucket.admit(at: now), global.admit(at: now) else { return .failure(.tooFast) }
        nextID += 1
        let ticket = PreAuthTicket(id: nextID, peer: peer, deadline: now + policy.deadline,
                                   firstFrameDeadline: peer.isConnector ? now + policy.connectorFirstFrame : nil)
        inFlight[ticket.id] = ticket
        return .success(ticket)
    }

    /// Notes that a connector attempt's first frame arrived at `arrived`, the moment it was read, before the host looks its
    /// device up. A frame that came before the first-frame deadline lifts that deadline, so neither the lookup's time nor
    /// another attempt's admission meanwhile expires the attempt; the exchange's overall deadline still holds until `rekey`
    /// counts it under its device. Any other attempt, or one already let go, is left as it is.
    public func heardFirstFrame(_ ticket: PreAuthTicket, at arrived: ContinuousClock.Instant) {
        guard let stored = inFlight[ticket.id], let first = stored.firstFrameDeadline, arrived < first else { return }
        inFlight[stored.id] = PreAuthTicket(id: stored.id, peer: stored.peer, deadline: stored.deadline)
    }

    /// Counts a connector attempt under the device its first frame named, before the Mac signs anything (SR-25): its own
    /// sub-bucket when either registry knows the ID (`known`), the shared unknown one otherwise, so random IDs cannot fill
    /// the tracked peers. Any other attempt, or one already counted, comes back unchanged. A refusal lets go of the attempt
    /// without counting a failure; one that already expired is refused as `busy`.
    public func rekey(_ ticket: PreAuthTicket, device deviceID: Data, known: Bool,
                      at now: ContinuousClock.Instant) -> Result<PreAuthTicket, PreAuthAccountRefusal> {
        expireOverdue(at: now)
        let account = PeerKey.connectorDevice(deviceID, known: known)
        guard let stored = inFlight[ticket.id] else { return .failure(PreAuthAccountRefusal(peer: account, refusal: .busy)) }
        guard stored.peer == .connector else { return .success(stored) }
        func refuse(_ refusal: PreAuthRefusal) -> Result<PreAuthTicket, PreAuthAccountRefusal> {
            inFlight[stored.id] = nil
            return .failure(PreAuthAccountRefusal(peer: account, refusal: refusal))
        }
        if let until = peers[account]?.blockedUntil, now < until { return refuse(.blocked) }
        guard inFlight.values.filter({ $0.peer == account }).count < policy.deviceMaxInFlight else { return refuse(.busy) }
        if peers[account] == nil {
            forgetIdlePeers(at: now)
            guard peers.count < policy.maxTrackedPeers else { return refuse(.busy) }
            peers[account] = PeerState(bucket: TokenBucket(perSecond: policy.deviceRate, burst: policy.deviceBurst))
        }
        guard peers[account]!.bucket.admit(at: now) else { return refuse(.tooFast) }
        let rekeyed = PreAuthTicket(id: stored.id, peer: account, deadline: stored.deadline)
        inFlight[stored.id] = rekeyed
        return .success(rekeyed)
    }

    /// Ends an attempt. A success clears the peer's failures; enough failures inside the window block the peer.
    /// Returns the block to report, if this failure caused one. A ticket that already expired is ignored: it was
    /// counted as a failure then. The attempt is settled as the gate last counted it, whichever copy of the ticket comes
    /// back; a connector attempt that never reached its device's sub-bucket counts no failure.
    @discardableResult
    public func finish(_ ticket: PreAuthTicket, succeeded: Bool, at now: ContinuousClock.Instant) -> Event? {
        guard let stored = inFlight.removeValue(forKey: ticket.id) else { return nil }
        if succeeded {
            peers[stored.peer]?.failures.removeAll()
            return nil
        }
        return recordFailure(stored.peer, at: now)
    }

    /// Blocks caused by attempts that ran past their deadline without being finished.
    public func takeEvents() -> [Event] {
        defer { events.removeAll() }
        return events
    }

    /// The number of peers and sub-buckets the gate remembers.
    var trackedPeers: Int { peers.count }

    private func expireOverdue(at now: ContinuousClock.Instant) {
        for ticket in inFlight.values where now >= ticket.expiry {
            inFlight[ticket.id] = nil
            if let event = recordFailure(ticket.peer, at: now) { events.append(event) }
        }
    }

    private func recordFailure(_ peer: PeerKey, at now: ContinuousClock.Instant) -> Event? {
        // Before its first frame a connector attempt is nobody's in particular: it only spends the outer rate.
        guard peer != .connector, var state = peers[peer] else { return nil }
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
        var busy = Set(inFlight.values.map(\.peer))
        if inFlight.values.contains(where: \.peer.isConnector) { busy.insert(.connector) }
        peers = peers.filter { key, state in
            busy.contains(key) || !state.bucket.isFull(at: now)
                || state.failures.contains { now - $0 < policy.failureWindow }
                || state.blockedUntil.map { now < $0 } == true
        }
    }
}
