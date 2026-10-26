import Darwin
import Foundation
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// 결정 4 / SR-14: the screen listener opens only on networks approved at the Mac. The decisions run on made-up
// snapshots; the routing-table readers on made-up kernel tables laid out as sysctl returns them.

private let homeRouter = Data([0x80, 0x11, 0x22, 0x33, 0x44, 0x55])
private let officeRouter = Data([0x3C, 0x22, 0xFB, 0x01, 0x02, 0x03])

private func snapshot(_ address: [UInt8] = [192, 168, 0, 12], prefix: Int = 24, router: [UInt8]? = [192, 168, 0, 1],
                      hardware: Data? = homeRouter, interface: String = "en0",
                      medium: NetworkSnapshot.Medium = .wifi) -> NetworkSnapshot {
    NetworkSnapshot(interface: interface, medium: medium, address: address, prefixLength: prefix, router: router, routerHardware: hardware)
}

private func approved(_ snapshot: NetworkSnapshot, _ label: String = "집", at date: Date = Date(timeIntervalSince1970: 1_800_000_000)) -> ApprovedNetwork {
    ApprovedNetwork(identity: snapshot.identity!, label: label, approvedAt: date)
}

/// One routing message as the kernel lays it out: rt_msghdr, then each address in `RTAX_*` order padded to four bytes
/// (an empty one still takes four).
func routeMessage(index: UInt16, flags: Int32, addresses: [Int32: [UInt8]], version: Int32 = RTM_VERSION) -> [UInt8] {
    var header = rt_msghdr()
    header.rtm_version = UInt8(version)
    header.rtm_type = UInt8(RTM_GET)
    header.rtm_index = index
    header.rtm_flags = flags
    var body: [UInt8] = []
    for slot in addresses.keys.sorted() {
        header.rtm_addrs |= 1 << slot
        let address = addresses[slot]!
        body += address + [UInt8](repeating: 0, count: (address.isEmpty ? 4 : 1 + ((address.count - 1) | 3)) - address.count)
    }
    header.rtm_msglen = UInt16(MemoryLayout<rt_msghdr>.size + body.count)
    return withUnsafeBytes(of: header) { Array($0) } + body
}

func sockaddrIn(_ address: [UInt8]) -> [UInt8] { [16, UInt8(AF_INET), 0, 0] + address + [UInt8](repeating: 0, count: 8) }

func sockaddrDL(index: UInt16, hardware: [UInt8], name: String = "") -> [UInt8] {
    var link: [UInt8] = [0, UInt8(AF_LINK)] + withUnsafeBytes(of: index) { Array($0) }
        + [6, UInt8(name.utf8.count), UInt8(hardware.count), 0] + Array(name.utf8) + hardware
    link += [UInt8](repeating: 0, count: max(0, 20 - link.count))
    link[0] = UInt8(link.count)
    return link
}

private let defaultFlags = RTF_UP | RTF_GATEWAY | RTF_STATIC

extension ScreenControlChecks {
    func testNetworkIdentityIsTheRouterAndTheSubnet() async throws {
        let home = snapshot()
        let identity = try unwrap(home.identity, "a router with a known hardware address identifies the network")
        try check(identity.router == homeRouter && identity.subnet == Data([192, 168, 0, 0]) && identity.prefixLength == 24,
                  "router hardware address + subnet with host bits cleared")
        try check(snapshot([192, 168, 0, 77]).identity == identity, "another address on the same network is the same network")
        try check(snapshot(interface: "en7", medium: .ethernet).identity == identity, "the same network over Ethernet")
        try check(snapshot(hardware: officeRouter).identity != identity, "another router is another network")
        try check(snapshot([192, 168, 1, 12], router: [192, 168, 1, 1]).identity != identity, "another subnet is another network")
        try check(snapshot([192, 168, 0, 12], prefix: 16).identity != identity, "another prefix is another network")

        // No identity without a router whose hardware address names it.
        try check(snapshot(router: nil).identity == nil, "no router")
        try check(snapshot(hardware: nil).identity == nil, "hardware address not resolved yet")
        for unusable in [Data(count: 6), Data(repeating: 0xFF, count: 6), Data([0x01, 0x00, 0x5E, 0x00, 0x00, 0xFB]),
                         Data([0x02, 0, 0, 0, 0, 0]), Data([0x80, 0x11, 0x22, 0x33, 0x44])] {
            try check(snapshot(hardware: unusable).identity == nil, "\(unusable.map { $0 }) names no particular router")
        }
        try check(snapshot().canBeIdentified && snapshot(hardware: nil).canBeIdentified, "identified, or not resolved yet: may be told apart")
        try check(!snapshot(router: nil).canBeIdentified && !snapshot(router: nil, hardware: nil).canBeIdentified
                  && !snapshot(hardware: Data([0x02, 0, 0, 0, 0, 0])).canBeIdentified,
                  "no router, or a placeholder router address: can never be told apart")
        try check(snapshot(hardware: Data([0x06, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E])).identity != nil,
                  "a locally administered router address (a phone's hotspot) is a router")
        try check(NetworkIdentity(router: homeRouter, address: Data([10, 0, 0, 1]), prefixLength: 0) == nil
                  && NetworkIdentity(router: homeRouter, address: Data([10, 0, 0, 1]), prefixLength: 33) == nil, "prefix 1...32")

        // Stored as checked: a row that names no router, or a subnet with host bits, does not read back.
        let stored = try JSONEncoder().encode(approved(home))
        try check(try JSONDecoder().decode(ApprovedNetwork.self, from: stored) == approved(home), "round trip")
        for (from, to) in [(homeRouter.base64EncodedString(), Data(count: 6).base64EncodedString()),
                           (Data([192, 168, 0, 0]).base64EncodedString(), Data([192, 168, 0, 12]).base64EncodedString())] {
            let tampered = Data(String(decoding: stored, as: UTF8.self).replacingOccurrences(of: from, with: to).utf8)
            try check(tampered != stored && (try? JSONDecoder().decode(ApprovedNetwork.self, from: tampered)) == nil, "refused: \(to)")
        }

        // Labels that name nobody, and masks.
        try check(snapshot().subnetText == "192.168.0.x", "/24")
        try check(snapshot([10, 1, 4, 9], prefix: 16).subnetText == "10.1.x.x", "/16")
        try check(snapshot([10, 1, 4, 9], prefix: 8).subnetText == "10.x.x.x", "/8")
        try check(snapshot([192, 168, 5, 9], prefix: 22).subnetText == "192.168.4.0/22", "/22")
        try check(snapshot().addressText == "192.168.0.12", "address")
        try check(identity.routerTail == "44:55" && snapshot(hardware: officeRouter).identity?.routerTail == "02:03",
                  "the router's last two bytes tell rows on the same subnet apart")
        try check(IPv4Subnet.prefixLength(ofMask: [255, 255, 255, 0]) == 24 && IPv4Subnet.prefixLength(ofMask: [255, 255, 252, 0]) == 22
                  && IPv4Subnet.prefixLength(ofMask: [255, 255, 255, 255]) == 32 && IPv4Subnet.prefixLength(ofMask: [0, 0, 0, 0]) == 0,
                  "contiguous masks")
        try check(IPv4Subnet.prefixLength(ofMask: [255, 0, 255, 0]) == nil && IPv4Subnet.prefixLength(ofMask: [255, 255, 255]) == nil,
                  "a mask with holes is not a subnet")

        try check(snapshot().sameLink(as: snapshot(hardware: nil)), "same link while the hardware address is unreadable")
        try check(!snapshot().sameLink(as: snapshot([192, 168, 0, 13], hardware: nil)), "another address is another link")
        try check(!snapshot().sameLink(as: snapshot(router: [192, 168, 0, 254], hardware: nil)), "another router address")
        try check(!snapshot().sameLink(as: snapshot(hardware: nil, interface: "en7")), "another interface")
        try check(!snapshot(router: nil).sameLink(as: snapshot(router: nil)), "no router, no link to keep")
    }

    func testApprovedNetworksDecideWhereTheMacListens() async throws {
        let home = snapshot(), office = snapshot([10, 0, 1, 20], prefix: 16, router: [10, 0, 0, 1], hardware: officeRouter)
        let cafe = snapshot([192, 168, 0, 12], hardware: Data([0xA4, 0x00, 0x00, 0x00, 0x00, 0x01]))
        let list = [approved(home), approved(office, "회사")]
        let atHome = NetworkBinding(snapshot: home, identity: home.identity!)

        try check(NetworkApproval.decide(nil, approved: list, bound: atHome) == .wait(.noNetwork), "no network: stop")
        try check(NetworkApproval.decide(home, approved: list, bound: nil) == .bind(atHome), "approved: listen on its address")
        try check(NetworkApproval.decide(home, approved: list, bound: atHome) == .stay, "nothing changed: stay")
        try check(NetworkApproval.decide(snapshot([192, 168, 0, 12]), approved: list, bound: atHome) == .stay, "the same reading again")

        // Moving between approved networks rebinds to the new address.
        try check(NetworkApproval.decide(office, approved: list, bound: atHome)
                  == .bind(NetworkBinding(snapshot: office, identity: office.identity!)), "moved to another approved network: rebind")
        let renumbered = snapshot([192, 168, 0, 40])
        try check(NetworkApproval.decide(renumbered, approved: list, bound: atHome)
                  == .bind(NetworkBinding(snapshot: renumbered, identity: home.identity!)), "a new address on the same network: rebind")
        let sameAddressOtherNetwork = snapshot([192, 168, 0, 12], hardware: officeRouter)
        let both = list + [approved(sameAddressOtherNetwork, "다른 집")]
        try check(NetworkApproval.decide(sameAddressOtherNetwork, approved: both, bound: atHome)
                  == .bind(NetworkBinding(snapshot: sameAddressOtherNetwork, identity: sameAddressOtherNetwork.identity!)),
                  "another approved network that gave the same address: rebind")

        // Anything not approved stops, whatever was bound before. Same subnet with another router, or the same router
        // with another subnet, is not the approved network.
        try check(NetworkApproval.decide(cafe, approved: list, bound: atHome) == .wait(.unapproved(cafe, cafe.identity!)),
                  "unapproved: stop")
        try check(NetworkApproval.decide(cafe, approved: list, bound: nil) == .wait(.unapproved(cafe, cafe.identity!)),
                  "unapproved before anything was bound")
        let sameRouterOtherSubnet = snapshot([192, 168, 7, 12], router: [192, 168, 7, 1])
        try check(NetworkApproval.decide(sameRouterOtherSubnet, approved: list, bound: atHome)
                  == .wait(.unapproved(sameRouterOtherSubnet, sameRouterOtherSubnet.identity!)), "same router, other subnet")
        try check(NetworkApproval.decide(home, approved: [], bound: atHome) == .wait(.unapproved(home, home.identity!)),
                  "removed from the list while listening: stop")

        // A network that cannot be told apart never starts listening; one already bound stays only while nothing
        // about its link changed and it is still approved.
        let unreadable = snapshot(hardware: nil)
        try check(NetworkApproval.decide(unreadable, approved: list, bound: nil) == .wait(.unidentified(unreadable)), "unknown: wait")
        try check(NetworkApproval.decide(snapshot(router: nil), approved: list, bound: nil) == .wait(.unidentified(snapshot(router: nil))),
                  "no router: wait")
        try check(NetworkApproval.decide(unreadable, approved: list, bound: atHome) == .stay,
                  "bound, same link, the ARP entry is being refreshed: stay")
        try check(NetworkApproval.decide(unreadable, approved: list, bound: atHome, unreadableFor: .seconds(5)) == .stay,
                  "still within the grace")
        try check(NetworkApproval.decide(unreadable, approved: list, bound: atHome, unreadableFor: NetworkApproval.unreadableGrace)
                  == .wait(.unidentified(unreadable)), "unreadable for the whole grace: stop, it may be another network by now")
        try check(NetworkApproval.unreadableGrace <= .seconds(6), "the grace is two 3-second re-checks, no longer")
        try check(NetworkApproval.decide(home, approved: list, bound: atHome, unreadableFor: .seconds(60)) == .stay,
                  "readable again: the grace no longer matters")
        try check(NetworkApproval.decide(unreadable, approved: [approved(office)], bound: atHome) == .wait(.unidentified(unreadable)),
                  "bound but no longer approved: stop")
        let movedUnreadable = snapshot([192, 168, 0, 13], hardware: nil)
        try check(NetworkApproval.decide(movedUnreadable, approved: list, bound: atHome) == .wait(.unidentified(movedUnreadable)),
                  "the link changed and cannot be told apart: stop")
        let otherRouterUnreadable = snapshot(router: [192, 168, 0, 254], hardware: nil)
        try check(NetworkApproval.decide(otherRouterUnreadable, approved: list, bound: atHome)
                  == .wait(.unidentified(otherRouterUnreadable)), "another router address, unreadable: stop")
    }

    func testApprovedNetworkListIsCappedAndRenewed() async throws {
        func network(_ n: Int, label: String = "", at seconds: Double = 0) -> ApprovedNetwork {
            approved(snapshot([10, UInt8(n), 0, 2], prefix: 16, router: [10, UInt8(n), 0, 1]), label.isEmpty ? "망 \(n)" : label,
                     at: Date(timeIntervalSince1970: 1_800_000_000 + seconds))
        }
        var list = try NetworkApproval.approve(network(1), in: [])
        list = try NetworkApproval.approve(network(2), in: list)
        try check(list.map(\.label) == ["망 1", "망 2"], "added in order")
        list = try NetworkApproval.approve(network(1, label: "다시 승인", at: 60), in: list)
        try check(list.map(\.label) == ["다시 승인", "망 2"] && list[0].approvedAt == network(1, at: 60).approvedAt,
                  "approving the same network again renews it in place")

        for n in 3...NetworkApproval.limit { list = try NetworkApproval.approve(network(n), in: list) }
        try check(list.count == NetworkApproval.limit && NetworkApproval.limit == 16, "sixteen fit")
        try await expectError(ApprovedNetworkError.full) { _ = try NetworkApproval.approve(network(17), in: list) }
        let renewed = try NetworkApproval.approve(network(5, label: "가득 차도 갱신"), in: list)
        try check(renewed.count == 16 && renewed[4].label == "가득 차도 갱신", "renewing works at the limit")

        list = NetworkApproval.remove(network(2).id, from: list)
        try check(list.count == 15 && !list.contains { $0.id == network(2).id }, "removed")
        try check(NetworkApproval.decide(snapshot([10, 2, 0, 2], prefix: 16, router: [10, 2, 0, 1]), approved: list, bound: nil)
                  == .wait(.unapproved(snapshot([10, 2, 0, 2], prefix: 16, router: [10, 2, 0, 1]), network(2).identity)),
                  "a removed network does not listen")
        list = try NetworkApproval.approve(network(17), in: list)
        try check(list.count == 16 && list.last?.id == network(17).id, "room again after removing one")

        // Read back: one row per network (the latest approval at the first row's place), at most sixteen.
        let stored = [network(1, label: "옛", at: 0), network(2), network(1, label: "새", at: 99)] + (3...20).map { network($0) }
        let normalized = NetworkApproval.normalized(stored)
        try check(normalized.count == 16 && normalized[0].label == "새" && normalized[1].id == network(2).id
                  && Set(normalized.map(\.id)).count == 16, "deduplicated and capped")
        try check(NetworkApproval.normalized(try JSONDecoder().decode([ApprovedNetwork].self, from: JSONEncoder().encode(normalized)))
                  == normalized, "list round trip")
    }

    func testRoutingTablesAreReadStrictly() async throws {
        let wifi: UInt16 = 16, other: UInt16 = 7
        let routes = routeMessage(index: wifi, flags: RTF_UP | RTF_GATEWAY | RTF_HOST,
                                  addresses: [RTAX_DST: sockaddrIn([8, 8, 8, 8]), RTAX_GATEWAY: sockaddrIn([192, 168, 0, 9])])
            + routeMessage(index: other, flags: defaultFlags,
                           addresses: [RTAX_DST: sockaddrIn([0, 0, 0, 0]), RTAX_GATEWAY: sockaddrIn([10, 0, 0, 1]), RTAX_NETMASK: []])
            + routeMessage(index: wifi, flags: defaultFlags | RTF_IFSCOPE,
                           addresses: [RTAX_DST: sockaddrIn([0, 0, 0, 0]), RTAX_GATEWAY: sockaddrIn([192, 168, 0, 254]), RTAX_NETMASK: []])
            + routeMessage(index: wifi, flags: defaultFlags,
                           addresses: [RTAX_DST: sockaddrIn([192, 168, 5, 0]), RTAX_GATEWAY: sockaddrIn([192, 168, 0, 7]),
                                       RTAX_NETMASK: [8, UInt8(AF_INET), 0, 0, 255, 255, 255]])
            + routeMessage(index: wifi, flags: defaultFlags,
                           addresses: [RTAX_DST: sockaddrIn([0, 0, 0, 0]), RTAX_GATEWAY: sockaddrIn([192, 168, 0, 1]), RTAX_NETMASK: [],
                                       RTAX_IFA: sockaddrIn([192, 168, 0, 12])])
        try check(NetworkProbe.defaultRouter(in: routes, interfaceIndex: wifi) == [192, 168, 0, 1],
                  "this interface's default route; an unscoped one wins over a scoped one, host and subnet routes are not default")
        // Destination 0.0.0.0 alone is not a default route: a VPN's 0.0.0.0/1 half and a host route to 0.0.0.0 come
        // first here, unscoped on the same interface, and must not be taken for it.
        let halfRoute = routeMessage(index: wifi, flags: defaultFlags,
                                     addresses: [RTAX_DST: sockaddrIn([0, 0, 0, 0]), RTAX_GATEWAY: sockaddrIn([192, 168, 0, 66]),
                                                 RTAX_NETMASK: [5, UInt8(AF_INET), 0, 0, 128]])
        let hostRoute = routeMessage(index: wifi, flags: defaultFlags | RTF_HOST,
                                     addresses: [RTAX_DST: sockaddrIn([0, 0, 0, 0]), RTAX_GATEWAY: sockaddrIn([192, 168, 0, 77])])
        try check(NetworkProbe.defaultRouter(in: halfRoute + routes, interfaceIndex: wifi) == [192, 168, 0, 1],
                  "a route to 0.0.0.0 with a non-empty mask (0.0.0.0/1) is not the default route")
        try check(NetworkProbe.defaultRouter(in: hostRoute + routes, interfaceIndex: wifi) == [192, 168, 0, 1],
                  "a host route to 0.0.0.0 is not the default route")
        try check(NetworkProbe.defaultRouter(in: routes, interfaceIndex: other) == [10, 0, 0, 1], "the other interface's own router")
        try check(NetworkProbe.defaultRouter(in: routes, interfaceIndex: 9) == nil, "no default route on this interface")
        let scopedOnly = routeMessage(index: wifi, flags: defaultFlags | RTF_IFSCOPE,
                                      addresses: [RTAX_DST: sockaddrIn([0, 0, 0, 0]), RTAX_GATEWAY: sockaddrIn([192, 168, 0, 254]), RTAX_NETMASK: []])
        try check(NetworkProbe.defaultRouter(in: scopedOnly, interfaceIndex: wifi) == [192, 168, 0, 254], "only a scoped default route")
        let down = routeMessage(index: wifi, flags: RTF_GATEWAY,
                                addresses: [RTAX_DST: sockaddrIn([0, 0, 0, 0]), RTAX_GATEWAY: sockaddrIn([192, 168, 0, 1]), RTAX_NETMASK: []])
        try check(NetworkProbe.defaultRouter(in: down, interfaceIndex: wifi) == nil, "a route that is not up")

        let hardware: [UInt8] = [0x80, 0x11, 0x22, 0x33, 0x44, 0x55]
        let arp = routeMessage(index: other, flags: RTF_UP | RTF_HOST | RTF_LLINFO,
                               addresses: [RTAX_DST: sockaddrIn([192, 168, 0, 1]), RTAX_GATEWAY: sockaddrDL(index: other, hardware: [9, 9, 9, 9, 9, 9])])
            + routeMessage(index: wifi, flags: RTF_UP | RTF_HOST | RTF_LLINFO,
                           addresses: [RTAX_DST: sockaddrIn([192, 168, 0, 2]), RTAX_GATEWAY: sockaddrDL(index: wifi, hardware: [])])
            + routeMessage(index: wifi, flags: RTF_UP | RTF_HOST | RTF_LLINFO,
                           addresses: [RTAX_DST: sockaddrIn([192, 168, 0, 1]), RTAX_GATEWAY: sockaddrDL(index: wifi, hardware: hardware, name: "en0"),
                                       RTAX_IFA: sockaddrIn([192, 168, 0, 12])])
        try check(NetworkProbe.hardwareAddress(of: [192, 168, 0, 1], in: arp, interfaceIndex: wifi) == Data(hardware),
                  "the router's entry on this interface, past the interface name")
        try check(NetworkProbe.hardwareAddress(of: [192, 168, 0, 2], in: arp, interfaceIndex: wifi) == nil, "an unresolved entry")
        try check(NetworkProbe.hardwareAddress(of: [192, 168, 0, 1], in: arp, interfaceIndex: 9) == nil, "another interface's entry")
        try check(NetworkProbe.hardwareAddress(of: [192, 168, 0, 3], in: arp, interfaceIndex: wifi) == nil, "no entry")

        // Malformed tables: whatever comes before the damage is read, nothing past a buffer's end is.
        let good = NetworkProbe.messages(in: arp).count
        try check(good == 3, "three messages")
        for cut in [1, 50, MemoryLayout<rt_msghdr>.size + 3, arp.count - 1] {
            _ = NetworkProbe.messages(in: Array(arp.prefix(cut)))
        }
        try check(NetworkProbe.messages(in: Array(arp.prefix(arp.count - 1))).count == 2, "a cut last message is dropped")
        var overlong = arp
        overlong[0] = 0xFF; overlong[1] = 0xFF
        try check(NetworkProbe.messages(in: overlong).isEmpty, "a length past the dump ends the walk")
        var short = arp
        short[0] = 4; short[1] = 0
        try check(NetworkProbe.messages(in: short).isEmpty, "a length shorter than the header ends the walk")
        let oldVersion = routeMessage(index: wifi, flags: defaultFlags, addresses: [RTAX_DST: sockaddrIn([0, 0, 0, 0]),
                                      RTAX_GATEWAY: sockaddrIn([192, 168, 0, 1]), RTAX_NETMASK: []], version: RTM_VERSION - 1)
        try check(NetworkProbe.defaultRouter(in: oldVersion + scopedOnly, interfaceIndex: wifi) == [192, 168, 0, 254],
                  "a message of another version is skipped, the next one read")
        var spill = routeMessage(index: wifi, flags: defaultFlags, addresses: [RTAX_DST: sockaddrIn([0, 0, 0, 0]),
                                 RTAX_GATEWAY: sockaddrIn([192, 168, 0, 1]), RTAX_NETMASK: []])
        spill[MemoryLayout<rt_msghdr>.size + 16] = 200   // the gateway claims 200 bytes in a message that has 20 left
        try check(NetworkProbe.defaultRouter(in: spill + scopedOnly, interfaceIndex: wifi) == [192, 168, 0, 254],
                  "an address longer than its message drops that message only")

        // The real tables are readable without privileges, and parse.
        let liveRoutes = try unwrap(NetworkProbe.table(RTF_GATEWAY), "routing table readable")
        let liveARP = try unwrap(NetworkProbe.table(RTF_LLINFO), "ARP table readable")
        _ = NetworkProbe.messages(in: liveRoutes)
        _ = NetworkProbe.messages(in: liveARP)
        let loopback = try unwrap(NetworkProbe.snapshot(interface: "lo0", medium: .ethernet), "lo0 has 127.0.0.1")
        try check(loopback.address == [127, 0, 0, 1] && loopback.prefixLength == 8 && loopback.identity == nil,
                  "loopback: no router, so never an approvable network")
    }
}

private func unwrap<T>(_ value: T?, _ message: String, line: Int = #line) throws -> T {
    guard let value else { throw CheckFailure(description: "line \(line): \(message)") }
    return value
}
