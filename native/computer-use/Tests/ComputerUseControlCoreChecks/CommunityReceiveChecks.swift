import Foundation
#if !CORE_CHECKS
@testable import ComputerUseControlCore
import ComputerUseApproval
#endif

enum CommunityReceiveChecks {
    static let device = "11111111-1111-4111-8111-111111111111", instance = String(repeating: "a", count: 32), binding = String(repeating: "b", count: 64)
    static let now: Int64 = 1_793_622_000_000
    static var peer: CommunityReceivePeer { CommunityReceivePeer.parse(sessionID: "rcu_\(device)_\(instance)_22222222-2222-4222-8222-222222222222")! }
    static func testStrictChangesAndSubject() throws {
        try check(peer.deviceID == device && peer.instance == instance, "the Main-supplied remote caller carries the authenticated portal subject")
        try check(CommunityReceivePeer.parse(sessionID: "rcu_opaque") == nil, "an unbound legacy caller does not bypass Native receive policy")
        for value: [String: Any] in [["allowRemote": true], ["unblockDevices": [device]], ["allowRemote": 0], ["block": ["deviceId": device, "connection": instance, "minutes": 9_007_199_254_000_000]], ["block": ["deviceId": device, "connection": instance, "minutes": "30"]]] {
            try CommunityControlChecks.rejected { _ = try CommunityReceiveChange.decode(value, restoring: false, now: now) }
        }
        try CommunityControlChecks.rejected { _ = try CommunityReceiveChange.decode(["allowRemote": false], restoring: true, now: now) }
        try CommunityControlChecks.rejected { _ = try CommunityReceiveChange.decode(["allowRemote": 1], restoring: true, now: now) }
    }
    static func testBootstrapAndDurableOff() throws {
        let state = try CommunityReceiveState(policy: nil)
        try state.bootstrap(bindingKey: binding, legacyRestricted: false, save: { _ in })
        try check(state.policy!.allows(peer, bindingKey: binding, now: now), "existing standing plus fresh common policy can bootstrap once without another BIO")
        let off = try CommunityReceiveChange.decode(["allowRemote": false], restoring: false, now: now)
        try state.restrict(off, bindingKey: binding, now: now, save: { _ in })
        let encoded = try JSONEncoder().encode(state.policy!), reopened = try CommunityReceiveState(policy: JSONDecoder().decode(CommunityReceivePolicy.self, from: encoded))
        try reopened.bootstrap(bindingKey: binding, legacyRestricted: false, save: { _ in throw CheckFailure(description: "bootstrap replay tried to write") })
        try check(!reopened.policy!.allows(peer, bindingKey: binding, now: now), "restart and a fresh cert never undo a persisted off fence")
        try check(!reopened.policy!.allows(peer, bindingKey: String(repeating: "c", count: 64), now: now), "another enrollment/epoch inherits no positive permission")
    }
    static func testReviewCASAndBlocks() throws {
        let state = try CommunityReceiveState(policy: nil)
        try state.bootstrap(bindingKey: binding, legacyRestricted: false, save: { _ in })
        let before = state.policy!.revision
        try state.restrict(CommunityReceiveChange.decode(["block": ["deviceId": device]], restoring: false, now: now), bindingKey: binding, now: now, save: { _ in })
        let restore = try CommunityReceiveChange.decode(["allowRemote": true, "unblockDevices": [device]], restoring: true, now: now)
        try CommunityControlChecks.rejected { try state.approve(restore, expectedRevision: before, bindingKey: binding, now: now, save: { _ in }) }
        try check(!state.policy!.allows(peer, bindingKey: binding, now: now), "a late authentication callback cannot override a newer block")
        try state.approve(restore, expectedRevision: state.policy!.revision, bindingKey: binding, now: now, save: { _ in })
        try check(state.policy!.allows(peer, bindingKey: binding, now: now), "only the Native App's authenticated approval commit restores the exact current revision")
    }
    static func testMigrationAndStorageFailure() throws {
        let state = try CommunityReceiveState(policy: nil)
        try state.bootstrap(bindingKey: binding, legacyRestricted: true, save: { _ in })
        try check(!state.policy!.allowRemote, "existing legacy off/block is migrated negatively, never silently reopened")
        try CommunityControlChecks.rejected { try state.restrict(CommunityReceiveChange.decode(["allowRemote": false], restoring: false, now: now), bindingKey: binding, now: now, save: { _ in throw CheckFailure(description: "storage refused") }) }
        try check(state.failed && state.policy?.allowRemote == false, "a storage failure leaves no active receive authority in RAM")
        try CommunityControlChecks.rejected { try state.approve(CommunityReceiveChange.decode(["allowRemote": true], restoring: true, now: now), expectedRevision: state.policy!.revision, bindingKey: binding, now: now, save: { _ in }) }
        let bytes = try JSONEncoder().encode(state.policy!)
        let reopened = try CommunityReceiveStorage.decode(policy: bytes, marker: CommunityReceiveStorage.marker)
        try check(reopened == state.policy, "a ready private policy survives an ordinary reopen")
        try CommunityControlChecks.rejected { _ = try CommunityReceiveStorage.decode(policy: nil, marker: CommunityReceiveStorage.marker) }
        try CommunityControlChecks.rejected { _ = try CommunityReceiveStorage.decode(policy: bytes, marker: nil) }
    }
    static func testTimedConnectionBlock() throws {
        let state = try CommunityReceiveState(policy: nil)
        try state.bootstrap(bindingKey: binding, legacyRestricted: false, save: { _ in })
        try state.restrict(CommunityReceiveChange.decode(["block": ["deviceId": device, "connection": instance, "minutes": 1]], restoring: false, now: now), bindingKey: binding, now: now, save: { _ in })
        try check(!state.policy!.allows(peer, bindingKey: binding, now: now + 59_999) && state.policy!.allows(peer, bindingKey: binding, now: now + 60_000), "only the person's explicit connection-block duration expires automatically")
    }
}
