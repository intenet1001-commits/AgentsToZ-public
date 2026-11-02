import Foundation
import CryptoKit

/// Local reachability preferences, scoped to the issuer's community and the pinned host key.
/// They contain no membership/key material and cannot turn a discovered device into an enrolled one.
public struct ScreenCommunityRoutePreferences: Codable, Sendable {
    private struct Choice: Codable, Sendable {
        var address: String?
        var selection: ViewerTarget.Route?
    }
    private var entries: [String: Choice] = [:]
    public init() {}
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let values = try container.decode([String: Choice].self, forKey: .entries)
        guard values.count <= 1024, values.keys.allSatisfy({ $0.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.[0-9a-f]{64}$", options: .regularExpression) != nil }),
              values.values.allSatisfy({ $0.address == nil || $0.address == "" || ScreenPrivateNetworkRoute.validAddress($0.address!) }) else { throw ScreenCommunityError.malformed }
        entries = values
    }
    private func key(communityID: String, hostKey: Data) throws -> String {
        guard UUID(uuidString: communityID)?.uuidString.lowercased() == communityID else { throw ScreenCommunityError.malformed }
        _ = try P256.Signing.PublicKey(x963Representation: hostKey)
        return communityID + "." + SHA256.hash(data: hostKey).map { String(format: "%02x", $0) }.joined()
    }
    public mutating func save(address: ScreenPrivateNetworkRoute?, selection: ViewerTarget.Route? = nil, communityID: String, hostKey: Data) throws {
        let key = try key(communityID: communityID, hostKey: hostKey)
        guard entries[key] != nil || entries.count < 1024 else { throw ScreenCommunityError.service("ROUTE_PREFERENCES_FULL") }
        entries[key] = Choice(address: address?.address ?? "", selection: selection ?? entries[key]?.selection)
    }
    public func address(published: ScreenPrivateNetworkRoute?, communityID: String, hostKey: Data) throws -> ScreenPrivateNetworkRoute? {
        guard let chosen = entries[try key(communityID: communityID, hostKey: hostKey)]?.address else { return published }
        return chosen.isEmpty ? nil : try ScreenPrivateNetworkRoute(address: chosen)
    }
    public func applying(to target: ViewerTarget, communityID: String) throws -> ViewerTarget {
        // A local choice is applied only to an existing verified target. It never creates a peer/key/grant.
        let key = try key(communityID: communityID, hostKey: target.hostPublicKey)
        var result = target
        result = result.usingPrivateNetwork(try address(published: target.privateNetwork, communityID: communityID, hostKey: target.hostPublicKey))
        if let selection = entries[key]?.selection { result = result.choosingRoute(selection) }
        return result
    }
}
