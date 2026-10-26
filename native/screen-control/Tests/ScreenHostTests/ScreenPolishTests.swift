#if os(macOS)
import Foundation
import ScreenControlCore
@testable import ScreenHost
import XCTest

final class ScreenPolishTests: XCTestCase {
    private func network(_ label: String = "집") -> ApprovedNetwork {
        ApprovedNetwork(identity: NetworkIdentity(router: Data([0x80, 1, 2, 3, 4, 5]),
            address: Data([192, 168, 1, 7]), prefixLength: 24)!, label: label)
    }

    func testDamagedNetworkRowsDoNotDiscardOtherApprovals() throws {
        let valid = try JSONSerialization.jsonObject(with: JSONEncoder().encode(network()))
        let data = try JSONSerialization.data(withJSONObject: [valid, NSNull(), ["identity": "broken"], 42, valid])
        let loaded = try ScreenStore.decodeNetworks(data)
        XCTAssertEqual(loaded.networks.count, 1) // normalization still removes duplicate identities
        XCTAssertEqual(loaded.networks.first?.label, "집")
        XCTAssertEqual(loaded.discardedCount, 3)
    }

    func testInvalidNetworkDocumentFailsClosedAndAllBadRowsAreCounted() throws {
        XCTAssertThrowsError(try ScreenStore.decodeNetworks(Data("{}".utf8)))
        XCTAssertThrowsError(try ScreenStore.decodeNetworks(Data("[".utf8)))
        let loaded = try ScreenStore.decodeNetworks(Data("[null,42,{}]".utf8))
        XCTAssertTrue(loaded.networks.isEmpty)
        XCTAssertEqual(loaded.discardedCount, 3)
        let empty = try ScreenStore.decodeNetworks(Data("[]".utf8))
        XCTAssertTrue(empty.networks.isEmpty)
        XCTAssertEqual(empty.discardedCount, 0)
    }

    @MainActor func testRouterDiscoveryIsRecheckedAtTheNextFastTick() {
        XCTAssertTrue(ScreenService.Waiting.noRouter(label: "Wi-Fi").needsSoonRecheck)
        XCTAssertTrue(ScreenService.Waiting.unidentified(label: "Wi-Fi").needsSoonRecheck)
        XCTAssertTrue(ScreenService.Waiting.noNetwork.needsSoonRecheck)
        XCTAssertFalse(ScreenService.Waiting.unapproved(label: "Wi-Fi").needsSoonRecheck)
    }
}
#endif
