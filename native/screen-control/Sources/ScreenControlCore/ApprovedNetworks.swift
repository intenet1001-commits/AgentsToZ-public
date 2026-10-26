import Foundation

// 결정 4: near-range screen sharing listens only on networks approved at the Mac (DESIGN 「4) 네트워크」).
// A network is told apart by its default router's hardware (MAC) address and the IPv4 subnet this Mac has on it: both
// come from the kernel's own tables without a permission prompt. The Wi‑Fi name needs Location permission since macOS
// 14, so it is never part of the identity, only an optional label. This is exposure control, not authentication: a
// device on another network that copies the router's address and subnet looks the same. What keeps the screen safe is
// still the key exchange (SIGMA + Face ID); approval decides where the Mac opens a port at all.

/// Which network this is: the default router's hardware address and the IPv4 subnet.
public struct NetworkIdentity: Hashable, Sendable, Codable {
    /// Six bytes.
    public let router: Data
    /// The network address (host bits cleared), four bytes.
    public let subnet: Data
    public let prefixLength: UInt8

    /// Nil for a hardware address that names no particular router: all zeros, broadcast, multicast, or the
    /// 02:00:00:00:00:00 placeholder a system shows when it hides the real one. Accepting it would make every network
    /// that shows it the same network.
    public init?(router: Data, address: Data, prefixLength: Int) {
        guard router.count == 6, address.count == 4, (1...32).contains(prefixLength) else { return nil }
        let bytes = [UInt8](router)
        guard bytes.contains(where: { $0 != 0 }), bytes != [UInt8](repeating: 0xFF, count: 6), bytes[0] & 0x01 == 0,
              bytes != [0x02, 0, 0, 0, 0, 0] else { return nil }
        self.router = Data(bytes)
        subnet = Data(IPv4Subnet.network(of: [UInt8](address), prefixLength: prefixLength))
        self.prefixLength = UInt8(prefixLength)
    }

    /// Stable for the list: router, subnet and prefix in hex.
    public var id: String { (router + subnet + Data([prefixLength])).map { String(format: "%02x", $0) }.joined() }

    /// The router hardware address's last two bytes, 「44:55」: tells two networks on the same common subnet apart on
    /// screen when there is no Wi‑Fi name. Only for showing; the whole address is the identity.
    public var routerTail: String { router.suffix(2).map { String(format: "%02X", $0) }.joined(separator: ":") }

    private enum CodingKeys: String, CodingKey { case router, subnet, prefixLength }

    /// A stored identity is checked like a new one: a row that names no router can never match.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let subnet = try container.decode(Data.self, forKey: .subnet), prefix = try container.decode(Int.self, forKey: .prefixLength)
        guard let identity = NetworkIdentity(router: try container.decode(Data.self, forKey: .router), address: subnet, prefixLength: prefix),
              identity.subnet == subnet else {
            throw DecodingError.dataCorruptedError(forKey: .router, in: container, debugDescription: "not a network identity")
        }
        self = identity
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(router, forKey: .router)
        try container.encode(subnet, forKey: .subnet)
        try container.encode(Int(prefixLength), forKey: .prefixLength)
    }
}

enum IPv4Subnet {
    static func network(of address: [UInt8], prefixLength: Int) -> [UInt8] {
        address.enumerated().map { index, byte in
            let bits = min(8, max(0, prefixLength - index * 8))
            return byte & UInt8(truncatingIfNeeded: 0xFF << (8 - bits))
        }
    }

    /// The prefix length of a contiguous netmask; nil for a mask with holes.
    static func prefixLength(ofMask mask: [UInt8]) -> Int? {
        guard mask.count == 4 else { return nil }
        let value = mask.reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        let ones = (~value).leadingZeroBitCount
        let contiguous: UInt32 = ones == 0 ? 0 : UInt32.max << UInt32(32 - ones)
        return value == contiguous ? ones : nil
    }

    static func text(_ address: [UInt8]) -> String { address.map(String.init).joined(separator: ".") }
}

/// This Mac's side of one Wi‑Fi or Ethernet interface, as read now.
public struct NetworkSnapshot: Equatable, Sendable {
    public enum Medium: String, Sendable { case wifi, ethernet }

    public let interface: String
    public let medium: Medium
    /// This Mac's IPv4 address on it, four bytes.
    public let address: [UInt8]
    public let prefixLength: Int
    /// The default router's IPv4 address on this interface, when there is one.
    public let router: [UInt8]?
    /// The router's hardware address from the ARP table; nil until the Mac has resolved it.
    public let routerHardware: Data?

    public init(interface: String, medium: Medium, address: [UInt8], prefixLength: Int, router: [UInt8]?, routerHardware: Data?) {
        self.interface = interface
        self.medium = medium
        self.address = address
        self.prefixLength = prefixLength
        self.router = router
        self.routerHardware = routerHardware
    }

    /// Nil without a router or before its hardware address is known: such a network cannot be told apart.
    public var identity: NetworkIdentity? {
        guard router != nil, let routerHardware else { return nil }
        return NetworkIdentity(router: routerHardware, address: Data(address), prefixLength: prefixLength)
    }

    /// False when this network can never be told apart, so never approved: no router, or a router whose hardware address
    /// names no particular router. True when it is identified, or its router's hardware address is just not known yet.
    public var canBeIdentified: Bool { router != nil && (routerHardware == nil || identity != nil) }

    public var addressText: String { IPv4Subnet.text(address) }

    /// A label that names no one: 「192.168.0.x」 for the common prefixes, 「10.1.4.0/22」 otherwise.
    public var subnetText: String {
        let network = IPv4Subnet.network(of: address, prefixLength: prefixLength)
        guard prefixLength % 8 == 0, (8...24).contains(prefixLength) else { return IPv4Subnet.text(network) + "/\(prefixLength)" }
        let kept = prefixLength / 8
        return (network.prefix(kept).map(String.init) + Array(repeating: "x", count: 4 - kept)).joined(separator: ".")
    }

    /// The same interface, address, subnet and router: nothing about the link changed, even when the router's hardware
    /// address could not be read this time.
    public func sameLink(as other: NetworkSnapshot) -> Bool {
        interface == other.interface && address == other.address && prefixLength == other.prefixLength
            && router != nil && router == other.router
    }
}

/// A network the person approved at the Mac, behind Touch ID or the login password.
public struct ApprovedNetwork: Codable, Hashable, Sendable, Identifiable {
    public let identity: NetworkIdentity
    /// What the list shows: the Wi‑Fi name when the system gave it without asking, otherwise a neutral label.
    public var label: String
    public var approvedAt: Date

    public init(identity: NetworkIdentity, label: String, approvedAt: Date = Date()) {
        self.identity = identity
        self.label = label
        self.approvedAt = approvedAt
    }

    public var id: String { identity.id }
}

public enum ApprovedNetworkError: Error, Equatable, Sendable {
    /// The list holds `NetworkApproval.limit` networks; one must be removed first.
    case full
}

/// Where the listener is bound now: the snapshot it was bound from and the approved identity it matched.
public struct NetworkBinding: Equatable, Sendable {
    public let snapshot: NetworkSnapshot
    public let identity: NetworkIdentity

    public init(snapshot: NetworkSnapshot, identity: NetworkIdentity) {
        self.snapshot = snapshot
        self.identity = identity
    }
}

/// Why the Mac is not listening while screen control is on.
public enum NetworkWait: Equatable, Sendable {
    /// No Wi‑Fi or Ethernet IPv4 address.
    case noNetwork
    /// No router, or its hardware address is not known yet: this network cannot be approved or matched.
    case unidentified(NetworkSnapshot)
    /// A network that is not on the approved list. Approving it at the Mac lets it listen here.
    case unapproved(NetworkSnapshot, NetworkIdentity)
}

public enum NetworkDecision: Equatable, Sendable {
    /// Keep listening where it is.
    case stay
    /// Listen on this binding's address: the first time, or after moving to another approved network.
    case bind(NetworkBinding)
    /// Do not listen: stop if listening, end any session.
    case wait(NetworkWait)
}

public enum NetworkApproval {
    /// How many networks may be approved at once.
    public static let limit = 16

    /// Adds `network`, or renews it in place (label and date) when the same identity is already approved. A new one
    /// past `limit` is refused rather than pushing an old approval out unseen.
    public static func approve(_ network: ApprovedNetwork, in list: [ApprovedNetwork]) throws(ApprovedNetworkError) -> [ApprovedNetwork] {
        var list = normalized(list)
        if let index = list.firstIndex(where: { $0.identity == network.identity }) {
            list[index] = network
            return list
        }
        guard list.count < limit else { throw .full }
        return list + [network]
    }

    public static func remove(_ id: String, from list: [ApprovedNetwork]) -> [ApprovedNetwork] {
        normalized(list).filter { $0.id != id }
    }

    /// As stored or read: one row per identity (the latest approval, at the first row's place), at most `limit`.
    public static func normalized(_ list: [ApprovedNetwork]) -> [ApprovedNetwork] {
        var rows: [ApprovedNetwork] = []
        for network in list {
            if let index = rows.firstIndex(where: { $0.identity == network.identity }) {
                if network.approvedAt > rows[index].approvedAt { rows[index] = network }
            } else {
                rows.append(network)
            }
        }
        return Array(rows.prefix(limit))
    }

    /// How long the Mac keeps listening on a bound network whose router's hardware address cannot be read: two 3-second
    /// re-checks. Another network with the same subnet, address and router address looks the same until then.
    public static let unreadableGrace: Duration = .seconds(6)

    /// What to do with the listener given what the Mac sees now. Only an approved identity listens. When the router's
    /// hardware address cannot be read but nothing about the link changed since it was bound (an ARP entry that expired
    /// or is being refreshed), it stays, as long as that network is still approved and the address has been unreadable
    /// for less than `unreadableGrace` (`unreadableFor`: zero the first time); anything else waits until the network
    /// can be told apart.
    public static func decide(_ snapshot: NetworkSnapshot?, approved: [ApprovedNetwork], bound: NetworkBinding?,
                              unreadableFor: Duration = .zero) -> NetworkDecision {
        guard let snapshot else { return .wait(.noNetwork) }
        func isApproved(_ identity: NetworkIdentity) -> Bool { approved.contains { $0.identity == identity } }
        guard let identity = snapshot.identity else {
            if let bound, bound.snapshot.sameLink(as: snapshot), isApproved(bound.identity), unreadableFor < unreadableGrace {
                return .stay
            }
            return .wait(.unidentified(snapshot))
        }
        guard isApproved(identity) else { return .wait(.unapproved(snapshot, identity)) }
        if let bound, bound.identity == identity, bound.snapshot.interface == snapshot.interface,
           bound.snapshot.address == snapshot.address {
            return .stay
        }
        return .bind(NetworkBinding(snapshot: snapshot, identity: identity))
    }
}

#if os(macOS)
import Darwin

/// Reads an interface's network from the kernel: its IPv4 address and mask (getifaddrs), the default router (the
/// routing table) and that router's hardware address (the ARP table), both through sysctl. No process is started and
/// nothing asks for permission. The parsers take the raw tables so they can be checked with made-up ones.
public enum NetworkProbe {
    /// Nil when the interface has no IPv4 address.
    public static func snapshot(interface: String, medium: NetworkSnapshot.Medium) -> NetworkSnapshot? {
        guard let (address, prefixLength) = ipv4(on: interface) else { return nil }
        let index = UInt16(truncatingIfNeeded: if_nametoindex(interface))
        let router = index == 0 ? nil : table(RTF_GATEWAY).flatMap { defaultRouter(in: $0, interfaceIndex: index) }
        let hardware = router.flatMap { router in table(RTF_LLINFO).flatMap { hardwareAddress(of: router, in: $0, interfaceIndex: index) } }
        return NetworkSnapshot(interface: interface, medium: medium, address: address, prefixLength: prefixLength,
                               router: router, routerHardware: hardware)
    }

    /// The IPv4 routes carrying `flags` (`RTF_GATEWAY`: routes through a router; `RTF_LLINFO`: the ARP table).
    static func table(_ flags: Int32) -> [UInt8]? {
        var mib: [Int32] = [CTL_NET, PF_ROUTE, 0, AF_INET, NET_RT_FLAGS, flags]
        // The table can grow between asking for its size and reading it.
        for _ in 0..<3 {
            var length = 0
            guard sysctl(&mib, 6, nil, &length, nil, 0) == 0, length <= 16 << 20 else { return nil }
            if length == 0 { return [] }
            var buffer = [UInt8](repeating: 0, count: length + length / 2 + 1024)
            length = buffer.count
            if sysctl(&mib, 6, &buffer, &length, nil, 0) == 0 { return Array(buffer.prefix(length)) }
            guard errno == ENOMEM else { return nil }
        }
        return nil
    }

    /// One routing message: its interface, flags, and each address it carries by `RTAX_*` slot (the raw sockaddr).
    struct RouteMessage {
        let interfaceIndex: UInt16
        let flags: Int32
        let addresses: [Int: [UInt8]]
    }

    /// Every well-formed message in a table dump. A length that runs past its message or the dump ends the walk.
    static func messages(in dump: [UInt8]) -> [RouteMessage] {
        let header = MemoryLayout<rt_msghdr>.size
        var messages: [RouteMessage] = []
        var offset = 0
        while dump.count - offset >= header {
            let message = dump.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: offset, as: rt_msghdr.self) }
            let length = Int(message.rtm_msglen)
            guard length >= header, length <= dump.count - offset else { break }
            defer { offset += length }
            guard Int32(message.rtm_version) == RTM_VERSION else { continue }
            var addresses: [Int: [UInt8]] = [:]
            var cursor = offset + header
            let end = offset + length
            var complete = true
            for slot in 0..<Int(RTAX_MAX) where message.rtm_addrs & (Int32(1) << Int32(slot)) != 0 {
                guard cursor < end, Int(dump[cursor]) <= end - cursor else { complete = false; break }
                let size = Int(dump[cursor])
                addresses[slot] = Array(dump[cursor..<cursor + size])
                // Each address is padded to four bytes; an empty one still takes four.
                cursor += min(size > 0 ? 1 + ((size - 1) | 3) : 4, end - cursor)
            }
            guard complete else { continue }
            messages.append(RouteMessage(interfaceIndex: message.rtm_index, flags: message.rtm_flags, addresses: addresses))
        }
        return messages
    }

    /// The IPv4 address in a sockaddr_in (or sockaddr_inarp).
    static func ipv4(_ sockaddr: [UInt8]?) -> [UInt8]? {
        guard let sockaddr, sockaddr.count >= 8, Int32(sockaddr[1]) == AF_INET else { return nil }
        return Array(sockaddr[4..<8])
    }

    /// The default route's router on this interface: destination 0.0.0.0 with an empty mask. A route that is not scoped
    /// to the interface wins over a scoped one; both name the same router in practice.
    static func defaultRouter(in dump: [UInt8], interfaceIndex: UInt16) -> [UInt8]? {
        let routes = messages(in: dump).filter { message in
            guard message.interfaceIndex == interfaceIndex, message.flags & RTF_UP != 0, message.flags & RTF_GATEWAY != 0,
                  message.flags & RTF_HOST == 0, ipv4(message.addresses[Int(RTAX_DST)]) == [0, 0, 0, 0],
                  ipv4(message.addresses[Int(RTAX_GATEWAY)]) != nil else { return false }
            // An absent or empty mask is 0.0.0.0; a shortened one keeps only its leading bytes.
            let mask = message.addresses[Int(RTAX_NETMASK)] ?? []
            return mask.count <= 4 || mask[4...].allSatisfy { $0 == 0 }
        }
        let route = routes.first { $0.flags & RTF_IFSCOPE == 0 } ?? routes.first
        return route.flatMap { ipv4($0.addresses[Int(RTAX_GATEWAY)]) }
    }

    /// The six-byte hardware address the ARP table holds for `address` on this interface; nil while unresolved.
    static func hardwareAddress(of address: [UInt8], in dump: [UInt8], interfaceIndex: UInt16) -> Data? {
        for message in messages(in: dump) where ipv4(message.addresses[Int(RTAX_DST)]) == address {
            // sockaddr_dl: length, family, index (2), type, name length, address length, selector length, then the name
            // and the address.
            guard let link = message.addresses[Int(RTAX_GATEWAY)], link.count >= 8, Int32(link[1]) == AF_LINK else { continue }
            let index = link.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 2, as: UInt16.self) }
            let nameLength = Int(link[5]), addressLength = Int(link[6])
            guard index == interfaceIndex, addressLength == 6, 8 + nameLength + addressLength <= link.count else { continue }
            return Data(link[(8 + nameLength)..<(8 + nameLength + addressLength)])
        }
        return nil
    }

    /// The interface's IPv4 address and prefix length; a link-local 169.254 address only when it has no other.
    static func ipv4(on interface: String) -> (address: [UInt8], prefixLength: Int)? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0 else { return nil }
        defer { freeifaddrs(head) }
        var found: [(address: [UInt8], prefixLength: Int)] = []
        var cursor = head
        while let entry = cursor {
            defer { cursor = entry.pointee.ifa_next }
            guard String(cString: entry.pointee.ifa_name) == interface, let address = entry.pointee.ifa_addr,
                  Int32(address.pointee.sa_family) == AF_INET, let mask = entry.pointee.ifa_netmask else { continue }
            func bytes(_ sockaddr: UnsafeMutablePointer<sockaddr>) -> [UInt8] {
                sockaddr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { pointer in
                    withUnsafeBytes(of: pointer.pointee.sin_addr) { Array($0) }
                }
            }
            if let prefixLength = IPv4Subnet.prefixLength(ofMask: bytes(mask)) { found.append((bytes(address), prefixLength)) }
        }
        return found.first { $0.address.prefix(2) != [169, 254] } ?? found.first
    }
}
#endif
