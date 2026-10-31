import Foundation
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

private enum RegistryFailure: Error { case locked, write }
extension ScreenControlChecks {
    func testReadFailureCannotReplaceAnUnreadableRegistry() async throws {
        var wrote = false
        do {
            _ = try persistRegistrationMutation(read: { () throws -> [String] in throw RegistryFailure.locked },
                write: { _ in wrote = true }, update: { $0.append("new") })
            try check(false, "an unreadable registry must refuse registration")
        } catch RegistryFailure.locked {}
        try check(!wrote, "read failure never overwrites an unreadable registry")
    }
    func testStaleViewsAlwaysPreserveTheCurrentOtherDevice() async throws {
        var persisted = ["first", "added-from-other-view"]
        let next = try persistRegistrationMutation(read: { persisted }, write: { persisted = $0 }) { $0.append("new") }
        try check(next == ["first", "added-from-other-view", "new"], "fresh store contains the other view's registration")
        try check(persisted == next, "only the persisted registry may be published")
    }
    func testFailedRevokeDoesNotPublishADeletedRow() async throws {
        let persisted = ["one", "two"]
        var visible = persisted
        do {
            visible = try persistRegistrationMutation(read: { persisted }, write: { _ in throw RegistryFailure.write }) { $0.removeAll { $0 == "one" } }
            try check(false, "a failed write must not publish an apparently revoked registration")
        } catch RegistryFailure.write {}
        try check(visible == persisted, "the UI still shows the unrevoked device after a failed write")
    }
}
