import AppKit
import Foundation
import Security
import CryptoKit
import LocalAuthentication
import ComputerUseApproval
import ComputerUseControlCore

struct CommunityReceiveContext {
    let bindingKey: String, communityID: String, profileID: String, deviceID: String
    let revision: Int64, expiresAt: Int64
}
/// A separate item prevents older community-binding writers from dropping a persisted receive restriction.
private enum CommunityReceiveKeychain {
    static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecUseDataProtectionKeychain as String: true, kSecAttrService as String: "com.intenet.agentstozbycs.control.community-receive-policy.v1", kSecAttrAccount as String: "policy"] }
    static func read() throws -> CommunityReceivePolicy? {
        func item(_ account: String) throws -> Data? {
            var q = query; q[kSecAttrAccount as String] = account; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
            var value: CFTypeRef?; let code = SecItemCopyMatching(q as CFDictionary, &value)
            if code == errSecItemNotFound { return nil }
            guard code == errSecSuccess, let data = value as? Data, data.count <= 65_536 else { throw ControlError.refuse("receive-store-unavailable") }; return data
        }
        return try CommunityReceiveStorage.decode(policy: item("policy"), marker: item("ready"))
    }
    static func write(_ policy: CommunityReceivePolicy, expected: Int64?) throws {
        guard policy.valid, try read()?.revision == expected else { throw ControlError.refuse("receive-policy-changed") }
        let data = try JSONEncoder().encode(policy)
        guard data.count <= 65_536 else { throw ControlError.refuse("receive-policy-capacity") }
        if expected == nil {
            // Marker first: a partial first write or a later lost record is unavailability, never another bootstrap.
            var marker = query; marker[kSecAttrAccount as String] = "ready"; marker[kSecValueData as String] = CommunityReceiveStorage.marker
            marker[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(marker as CFDictionary, nil) == errSecSuccess else { throw ControlError.refuse("receive-store-unavailable") }
        }
        let code = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if code == errSecSuccess { return }
        guard code == errSecItemNotFound, expected == nil else { throw ControlError.refuse("receive-store-unavailable") }
        var item = query; item[kSecValueData as String] = data; item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw ControlError.refuse("receive-store-unavailable") }
    }
}

/// No positive XPC commit exists. Only this App's OS-authenticated management continuation calls state.approve.
@MainActor final class CommunityReceiveService {
    static let shared = CommunityReceiveService()
    private var state: CommunityReceiveState?
    private var unavailable = false
    private struct Review {
        let id: String, owner: ControlOwner, context: CommunityReceiveContext, expected: Int64, change: CommunityReceiveChange, deadline: Int64, startedTick: TimeInterval, deadlineTick: TimeInterval
        var state = "pending"
    }
    private var reviews: [String: Review] = [:]
    private var retired = Set<String>()
    private var authentications: [String: LAContext] = [:]
    private init() { do { state = try CommunityReceiveState(policy: CommunityReceiveKeychain.read()) } catch { unavailable = true } }
    private func synchronize() throws {
        guard !unavailable else { throw ControlError.refuse("receive-store-unavailable") }
        let latest = try CommunityReceiveKeychain.read()
        guard (latest?.revision ?? 0) >= (state?.policy?.revision ?? 0) else { unavailable = true; throw ControlError.refuse("receive-policy-rollback") }
        if latest != state?.policy { state = try CommunityReceiveState(policy: latest) }
    }
    private func context(_ owner: ControlOwner) throws -> CommunityReceiveContext { try CommunityControlService.shared.receiveContext(owner: owner) }
    func status(owner: ControlOwner, legacyRestricted: Bool) throws -> [String: Any] {
        try synchronize()
        let ctx = try? context(owner), configured = CommunityControlAuthority.configured?.origin != nil
        if let ctx, let state, state.policy == nil {
            try state.bootstrap(bindingKey: ctx.bindingKey, legacyRestricted: legacyRestricted) { try CommunityReceiveKeychain.write($0, expected: nil) }
        }
        let p = state?.policy, matches = ctx != nil && p?.bindingKey == ctx?.bindingKey
        return ["receiveProtocolVersion": 1, "configured": configured, "authorized": matches && !unavailable,
            "communityId": ctx?.communityID as Any? ?? NSNull(), "profileId": ctx?.profileID as Any? ?? NSNull(), "deviceId": ctx?.deviceID as Any? ?? NSNull(),
            "issuerRevision": ctx?.revision as Any? ?? NSNull(), "expiresAt": ctx.map { min($0.expiresAt, nowMs() + 5_000) } ?? nowMs() + 5_000,
            "policy": p?.json as Any? ?? ["revision": 0, "allowRemote": false, "blockedDevices": [], "blockedConnections": []],
            "restorationRequiresAuthentication": true]
    }
    func restrict(_ raw: [String: Any], owner: ControlOwner) throws -> [String: Any] {
        // End native remote grants before touching durable state; a failed storage operation can never leave input alive.
        ScopedControlShared.service.endRemoteReception()
        do {
            try synchronize(); guard let state else { throw ControlError.refuse("receive-store-unavailable") }
            let change = try CommunityReceiveChange.decode(raw, restoring: false, now: nowMs()), key = (try? context(owner))?.bindingKey, expected = state.policy?.revision
            try state.restrict(change, bindingKey: key, now: nowMs()) { try CommunityReceiveKeychain.write($0, expected: expected) }
        }
        catch { unavailable = true; CommunityControlService.shared.receiveStorageFailed(); throw error }
        return ["restricted": true, "revision": state?.policy?.revision ?? 0]
    }
    func review(requestID: String, expected: Int64, raw: [String: Any], owner: ControlOwner) throws -> [String: Any] {
        try synchronize(); let ctx = try context(owner), change = try CommunityReceiveChange.decode(raw, restoring: true, now: nowMs())
        if let old = reviews[requestID] {
            guard old.owner == owner, old.context.bindingKey == ctx.bindingKey, old.expected == expected, old.change == change else { throw ControlError.refuse("receive-request-conflict") }
            return ["reviewId": requestID, "state": old.state]
        }
        guard !retired.contains(requestID), reviews.values.allSatisfy({ $0.state != "pending" || $0.deadline <= nowMs() }),
              (state?.policy?.revision ?? 0) == expected else { throw ControlError.refuse("receive-policy-changed") }
        while reviews.count >= 16 { if let key = reviews.first(where: { $0.value.state != "pending" })?.key { reviews.removeValue(forKey: key); retired.insert(key) } else { throw ControlError.refuse("receive-review-busy") } }
        guard retired.count < 128 else { throw ControlError.refuse("receive-review-capacity") }
        reviews[requestID] = Review(id: requestID, owner: owner, context: ctx, expected: expected, change: change, deadline: nowMs() + 60_000, startedTick: ProcessInfo.processInfo.systemUptime, deadlineTick: ProcessInfo.processInfo.systemUptime + 60)
        Task { @MainActor [weak self] in
            NSApplication.shared.activate(ignoringOtherApps: true)
            let authentication = LAContext()
            self?.authentications[requestID] = authentication
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(60))
                if var pending = self?.reviews[requestID], pending.state == "pending" { pending.state = "expired"; self?.reviews[requestID] = pending; self?.authentications.removeValue(forKey: requestID)?.invalidate() }
            }
            let authenticated = await withCheckedContinuation { continuation in
                authentication.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "공통 권한관리에서 꺼 두거나 차단한 다른 Mac AI의 원격 제어 권한을 복구합니다. 평소 화면 연결에는 이 인증을 요구하지 않습니다.") { okay, _ in continuation.resume(returning: okay) }
            }
            guard let self, var review = self.reviews[requestID], review.state == "pending" else { return }
            self.authentications.removeValue(forKey: requestID)
            do {
                let current = try self.context(review.owner); try self.synchronize()
                guard authenticated, ProcessGeneration.alive(review.owner), nowMs() < review.deadline,
                      ProcessInfo.processInfo.systemUptime >= review.startedTick, ProcessInfo.processInfo.systemUptime < review.deadlineTick,
                      current.bindingKey == review.context.bindingKey, current.revision == review.context.revision,
                      let state = self.state else { throw ControlError.refuse("receive-authentication-refused") }
                let expectedRevision = state.policy?.revision
                try state.approve(review.change, expectedRevision: review.expected, bindingKey: current.bindingKey, now: nowMs()) { try CommunityReceiveKeychain.write($0, expected: expectedRevision) }
                review.state = "approved"
            } catch { review.state = self.state?.failed == true ? "unknown" : "denied" }
            self.reviews[requestID] = review
        }
        return ["reviewId": requestID, "state": "pending"]
    }
    func reviewStatus(_ id: String, owner: ControlOwner) -> [String: Any] {
        guard let review = reviews[id], review.owner == owner else { return ["reviewId": id, "state": "unknown"] }
        return ["reviewId": id, "state": review.state == "pending" && (review.deadline <= nowMs() || ProcessInfo.processInfo.systemUptime >= review.deadlineTick) ? "expired" : review.state]
    }
    func end(owner: ControlOwner) {
        for (id, var review) in reviews where review.owner == owner && review.state == "pending" {
            review.state = "unknown"; reviews[id] = review; authentications.removeValue(forKey: id)?.invalidate()
        }
    }
    func allows(sessionID: String, owner: ControlOwner) -> Bool {
        do {
            try synchronize(); let ctx = try context(owner)
            guard let peer = CommunityReceivePeer.parse(sessionID: sessionID), let state, let policy = state.policy else { return false }
            return !state.failed && policy.allows(peer, bindingKey: ctx.bindingKey, now: nowMs())
        } catch { return false }
    }
}
