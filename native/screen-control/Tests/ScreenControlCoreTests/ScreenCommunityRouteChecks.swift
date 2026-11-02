#if !CORE_CHECKS
import XCTest
import CryptoKit
@testable import ScreenControlCore

final class ScreenCommunityRouteChecks: XCTestCase {
    func testPrivateRouteChoicesSurviveReloadWithoutCrossingCommunityOrHostKeys() throws {
        let host = P256.Signing.PrivateKey().publicKey, otherHost = P256.Signing.PrivateKey().publicKey, viewer = P256.Signing.PrivateKey().publicKey
        let community = UUID().uuidString.lowercased(), otherCommunity = UUID().uuidString.lowercased()
        let published = try ScreenPrivateNetworkRoute(address: "192.168.1.20"), chosen = try ScreenPrivateNetworkRoute(address: "10.5.6.7")
        let target = try ViewerTarget(hostPublicKey: host, name: "Mac", controllerKeyBlob: Data([1]), controllerPublicKey: viewer,
            privateNetwork: published, state: .confirmed, pairedAt: Date())
        var preferences = ScreenCommunityRoutePreferences()
        try preferences.save(address: chosen, selection: .private, communityID: community, hostKey: host.x963Representation)
        let restored = try JSONDecoder().decode(ScreenCommunityRoutePreferences.self, from: JSONEncoder().encode(preferences))
        let next = try restored.applying(to: target, communityID: community)
        XCTAssertEqual(next.privateNetwork, chosen); XCTAssertEqual(next.route, .private)
        XCTAssertEqual(next.hostPublicKey, target.hostPublicKey); XCTAssertEqual(next.controllerKeyBlob, target.controllerKeyBlob)
        XCTAssertEqual(try restored.address(published: published, communityID: otherCommunity, hostKey: host.x963Representation), published)
        XCTAssertEqual(try restored.address(published: published, communityID: community, hostKey: otherHost.x963Representation), published)
        try preferences.save(address: nil, communityID: community, hostKey: host.x963Representation)
        XCTAssertNil(try preferences.applying(to: target, communityID: community).privateNetwork)
        XCTAssertThrowsError(try JSONDecoder().decode(ScreenCommunityRoutePreferences.self, from: Data("{\"entries\":{\"bad\":{\"address\":\"8.8.8.8\"}}}".utf8)))
    }
}
#endif
