#if os(macOS)
import AppKit
import CryptoKit
import XCTest
import ScreenControlCore
@testable import AgentsToZViewer

/// Pure in-memory fixture; presentation checks never read an installed account or Keychain item.
final class EmptyUnifiedStoreBackend: ViewerTargetsBackend, @unchecked Sendable {
    func read() throws -> Data? { nil }
    func write(_ data: Data) throws { XCTFail("Rendering must not persist or create a device key") }
}
final class UnifiedEnrollmentChecks: XCTestCase {
    func testDependenciesFollowViewChoiceWithoutGrantingUnselectedFeatures() {
        var selection = ViewerFeatureSelection()
        selection.set(.screenView, selected: false)
        XCTAssertFalse(selection.capabilities.contains(.screenControl))
        selection.set(.receiveControl, selected: true)
        XCTAssertTrue(selection.capabilities.contains(.receiveView))
        XCTAssertFalse(selection.capabilities.contains(.teams))
        selection.selectAll()
        XCTAssertEqual(selection.capabilities, CommunityCapability.allCases.filter{$0 != .desktopTrust && $0 != .ownerDelegation})
        selection.set(.receiveView, selected: false)
        XCTAssertFalse(selection.capabilities.contains(.receiveControl))
    }
    func testStagedEnrollmentStopsPollingAtItsDeadline() {
        let receipt = ViewerPreparedEnrollment(planId: UUID().uuidString.lowercased(), communityId: UUID().uuidString.lowercased(), digest: "unused", expiresAt: 1_800_000_600_000)
        XCTAssertTrue(receipt.isCurrent(at: Date(timeIntervalSince1970: 1_800_000_599.999)))
        XCTAssertFalse(receipt.isCurrent(at: Date(timeIntervalSince1970: 1_800_000_600)))
    }
    @MainActor func testGrantMustMatchEverySelectedSubjectAndKey() throws {
        let issuer = P256.Signing.PrivateKey(), host = P256.Signing.PrivateKey(), bio = P256.Signing.PrivateKey(), operation = P256.Signing.PrivateKey()
        let profile = UUID().uuidString.lowercased(), device = UUID().uuidString.lowercased(), enrollment = UUID().uuidString.lowercased()
        let authority = try ScreenCommunityAuthority(origin: URL(string: "https://fixture.workers.dev")!, issuer: issuer.publicKey, profileID: profile)
        let plan = try CommunityAccessPlan(profileId: profile, deviceId: device, name: "Mac3", kind: .desktop,
            hostKey: host.publicKey.x963Representation, biometricKey: bio.publicKey.x963Representation,
            operationKey: operation.publicKey.x963Representation, capabilities: [.screenView])
        let issued = Date(timeIntervalSince1970: 1_800_000_000), at = Int64(issued.timeIntervalSince1970 * 1000)
        var body: [String: Any] = ["version": 1, "communityId": UUID().uuidString.lowercased(), "profileId": profile,
            "enrollmentId": enrollment, "deviceId": device, "deviceKind": "desktop", "name": "Mac3",
            "hostPublicKey": plan.hostKey, "publicKey": plan.operationKey, "biometricPublicKey": plan.biometricKey,
            "controlKey": NSNull(), "agentDeviceId": NSNull(), "capabilities": ["screen.view"], "revision": 1, "keyEpoch": 1, "issuedAt": at, "expiresAt": at + 90_000]
        func signed(_ object: [String: Any]) throws -> ScreenCommunityEnvelope {
            let bytes = try JSONSerialization.data(withJSONObject: [2, "authorization", UUID().uuidString.lowercased(), at, object])
            return ScreenCommunityEnvelope(payload: ScreenCommunityRequest.base64(bytes), signature: ScreenCommunityRequest.base64(try issuer.signature(for: Data("agentstoz.community-access.response/v2\0".utf8) + bytes).rawRepresentation))
        }
        let envelope = try signed(body)
        let reply = try CommunityAccessReply.verify(envelope, authority: authority, now: issued.addingTimeInterval(100))
        XCTAssertThrowsError(try reply.authorization(authority: authority, now: issued.addingTimeInterval(100)))
        let historical = try reply.authorization(authority: authority, now: issued)
        XCTAssertNoThrow(try ViewerUnifiedEnrollment.validate(historical, plan: plan, expectedEnrollment: enrollment))
        XCTAssertFalse(historical.isCurrent(at: issued.addingTimeInterval(100)))
        body["deviceId"] = UUID().uuidString.lowercased()
        let other = try CommunityAccessReply.verify(signed(body), authority: authority, now: issued).authorization(authority: authority, now: issued)
        XCTAssertThrowsError(try ViewerUnifiedEnrollment.validate(other, plan: plan))
        body["deviceId"] = device; body["capabilities"] = ["screen.view", "screen.control"]
        let escalated = try CommunityAccessReply.verify(signed(body), authority: authority, now: issued).authorization(authority: authority, now: issued)
        XCTAssertThrowsError(try ViewerUnifiedEnrollment.validate(escalated, plan: plan))
    }
    func testNativeOnlySelectionsPreserveTheActualMainCandidateIdentity() throws {
        let host = P256.Signing.PrivateKey(), bio = P256.Signing.PrivateKey(), operation = P256.Signing.PrivateKey(), control = P256.Signing.PrivateKey()
        let profile = UUID().uuidString.lowercased(), device = UUID().uuidString.lowercased(), portalDevice = UUID().uuidString.lowercased()
        for capability in [CommunityCapability.browser,.agentSettings,.communicate,.teams] {
            let plan = try CommunityAccessPlan(profileId:profile,deviceId:device,name:"Mac",kind:.desktop,
                hostKey:host.publicKey.x963Representation,biometricKey:bio.publicKey.x963Representation,
                operationKey:operation.publicKey.x963Representation,controlKey:control.publicKey.x963Representation,
                agentDeviceId:portalDevice,capabilities:[capability])
            XCTAssertEqual(plan.agentDeviceId,portalDevice)
            XCTAssertEqual(plan.controlKey,ScreenCommunityRequest.base64(control.publicKey.x963Representation))
            let decoded = try JSONDecoder().decode(CommunityAccessPlan.self,from:JSONEncoder().encode(plan))
            XCTAssertEqual(decoded.agentDeviceId,portalDevice); XCTAssertEqual(try plan.digest,try decoded.digest)
            XCTAssertEqual(plan.capabilities,[capability])
        }
    }
    @MainActor func testUnifiedSheetIsPresentationOnlyUntilActualOwnerApproval() throws {
        _ = NSApplication.shared
        let account = ViewerCommunityAccount(unifiedStore: ViewerUnifiedStore(backend: EmptyUnifiedStoreBackend())), sheet = ViewerCommunitySheet(account: ViewerCommunityAccount(unifiedStore: ViewerUnifiedStore(backend: EmptyUnifiedStoreBackend())))
        defer { sheet.close() }
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let views = descendants(try XCTUnwrap(sheet.window.contentView))
        XCTAssertTrue(views.contains { ($0 as? PresentationButton)?.title == "전체 선택" })
        XCTAssertTrue(views.contains { ($0 as? PresentationButton)?.title == "선택한 기능 한 번에 등록 요청" })
        XCTAssertEqual(views.compactMap { $0 as? HumanButton }.map(\.title), ["첫 관리 Mac으로 커뮤니티 만들기"])
        XCTAssertEqual(views.compactMap { $0 as? PresentationButton }.filter { $0.title.hasPrefix("☐") || $0.title.hasPrefix("☑") }.count, CommunityCapability.allCases.count)
        XCTAssertFalse(sheet.window.isVisible)
        XCTAssertNil(account.unified?.authorization)
    }
    @MainActor func testStatusPollingPreservesFormObjectsTextAndComparisonUntilSemanticContextChanges() throws {
        _ = NSApplication.shared
        let body = ViewerCommunityStableBody()
        XCTAssertTrue(body.beginUpdate(key: "same-plan-same-role-same-revision"))
        let text = NSTextField(string: "아젠투지 3호 / 입력 중"), comparison = NSButton(checkboxWithTitle: "코드 확인", target: nil, action: nil)
        comparison.state = .on; body.addArrangedSubview(text); body.addArrangedSubview(comparison)
        for _ in 0..<10 { XCTAssertFalse(body.beginUpdate(key: "same-plan-same-role-same-revision")) }
        XCTAssertTrue(body.arrangedSubviews.first === text); XCTAssertTrue(body.arrangedSubviews.last === comparison)
        XCTAssertEqual(text.stringValue, "아젠투지 3호 / 입력 중"); XCTAssertEqual(comparison.state, .on)
        XCTAssertTrue(body.beginUpdate(key: "new-role-new-management-digest")); XCTAssertTrue(body.arrangedSubviews.isEmpty)
    }
    @MainActor func testApprovalQueueAndRefreshPrecedeFeatureSelectionWithoutStartingAnySession() throws {
        _ = NSApplication.shared
        let account = ViewerCommunityAccount(unifiedStore: ViewerUnifiedStore(backend: EmptyUnifiedStoreBackend()))
        let sheet = ViewerCommunitySheet(account: account); defer { sheet.close() }
        let scroll = try XCTUnwrap(sheet.window.contentView as? NSScrollView)
        scroll.layoutSubtreeIfNeeded()
        func descendants(_ view:NSView)->[NSView] { [view]+view.subviews.flatMap(descendants) }
        let views=descendants(try XCTUnwrap(scroll.documentView))
        let queue=try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.stringValue=="관리 역할·승인 요청" })
        let features=try XCTUnwrap(views.compactMap { $0 as? NSTextField }.first { $0.stringValue=="이 기기에서 사용할 기능" })
        let doc=try XCTUnwrap(scroll.documentView)
        XCTAssertLessThan(queue.convert(queue.bounds,to:doc).minY,features.convert(features.bounds,to:doc).minY)
        XCTAssertTrue(views.contains { ($0 as? PresentationButton)?.title=="등록 상태 새로 고침" })
        XCTAssertFalse(sheet.window.isVisible);XCTAssertNil(account.unified?.authorization)
        XCTAssertEqual(CommunityManagementChoice.allCases.first,.unchanged)
    }

}
#endif
