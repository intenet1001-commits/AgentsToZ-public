#if os(macOS)
import AppKit
import CryptoKit
import XCTest
@testable import ScreenControlCore
@testable import AgentsToZViewer

/// Software keys, a fixed clock and offscreen controls only. No account, network or authentication.
final class ViewerReviewExpiryChecks: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let at: Int64 = 1_800_000_000_000
    private func review(challenge: String = "original-challenge") throws -> CommunityAccessReview {
        let plan = try CommunityAccessPlan(profileId: UUID().uuidString.lowercased(), deviceId: UUID().uuidString.lowercased(),
            name: "아젠투지 / Mac", kind: .desktop, hostKey: P256.Signing.PrivateKey().publicKey.x963Representation,
            biometricKey: P256.Signing.PrivateKey().publicKey.x963Representation,
            operationKey: P256.Signing.PrivateKey().publicKey.x963Representation, capabilities: [.screenView])
        return CommunityAccessReview(plan: plan, planId: UUID().uuidString.lowercased(), admin: UUID().uuidString.lowercased(),
            digest: try plan.digest, challenge: challenge, revision: 7, expiresAt: at + 120_000)
    }
    func testOriginal120SecondBoundaryClearsConfirmationAndRetainsOnlyTheSamePendingRequest() throws {
        let original = try review()
        var state = ViewerEnrollmentReviewPresentation()
        state.open(original, requestExpiresAt: at + 600_000)
        state.confirm(digest: original.digest, confirmed: true, at: now)
        XCTAssertTrue(state.confirmation.isConfirmed(for: original, now: now.addingTimeInterval(119.999)))
        XCTAssertFalse(state.expire(at: now.addingTimeInterval(119.999), choice: .unchanged))
        XCTAssertEqual(state.review?.challenge, original.challenge); XCTAssertNil(state.expired)
        XCTAssertTrue(state.expire(at: now.addingTimeInterval(120), choice: .unchanged))
        XCTAssertNil(state.review)
        XCTAssertFalse(state.confirmation.isConfirmed(for: original, now: now))
        let expired = try XCTUnwrap(state.expired)
        XCTAssertEqual(expired.planId, original.planId); XCTAssertEqual(expired.requestExpiresAt, at + 600_000)
        XCTAssertEqual(expired.choice, .unchanged)
        XCTAssertEqual(expired.message, "검토 유효기간 만료·원래 등록 요청 유지")
        state.validatePending([.init(planId: original.planId, name: original.plan.name, kind: .desktop, expiresAt: at + 600_000)])
        XCTAssertEqual(state.expired, expired)
        // Polling and an attempted old confirmation cannot renew or approve the expired challenge.
        XCTAssertFalse(state.expire(at: now.addingTimeInterval(150), choice: .unchanged))
        state.confirm(digest: original.digest, confirmed: true, at: now)
        XCTAssertNil(state.review); XCTAssertEqual(state.expired, expired)
        XCTAssertFalse(state.confirmation.isConfirmed(for: original, now: now))
    }
    func testContextCancellationAndPendingRemovalCannotBeMislabelledAsReviewExpiry() throws {
        let original = try review()
        var state = ViewerEnrollmentReviewPresentation()
        state.open(original, requestExpiresAt: at + 600_000)
        state.dismiss() // The same path used by close, role/revision change and a failed context refresh.
        XCTAssertFalse(state.expire(at: now.addingTimeInterval(120), choice: .unchanged))
        XCTAssertNil(state.expired); XCTAssertNil(state.review)
        state.open(original, requestExpiresAt: at + 600_000)
        state.expire(at: now.addingTimeInterval(120), choice: .unchanged)
        state.validatePending([])
        XCTAssertNil(state.expired)
        // If the original plan also expired, the UI must not claim it is still pending.
        state.open(original, requestExpiresAt: original.expiresAt)
        state.expire(at: now.addingTimeInterval(120), choice: .unchanged)
        XCTAssertNil(state.review); XCTAssertNil(state.expired)
    }
    func testExplicitNewReviewStartsUncheckedAndDoesNotCarryTheOldChallenge() throws {
        let original = try review()
        let next = CommunityAccessReview(plan: original.plan, planId: original.planId, admin: original.admin,
            digest: original.digest, challenge: "new-explicit-review", revision: original.revision, expiresAt: at + 240_000)
        var state = ViewerEnrollmentReviewPresentation()
        state.open(original, requestExpiresAt: at + 600_000)
        state.confirm(digest: original.digest, confirmed: true, at: now)
        state.expire(at: now.addingTimeInterval(120), choice: .unchanged)
        state.open(next, requestExpiresAt: at + 600_000)
        XCTAssertNil(state.expired); XCTAssertEqual(state.review?.challenge, next.challenge)
        XCTAssertFalse(state.confirmation.isConfirmed(for: original, now: now))
        XCTAssertFalse(state.confirmation.isConfirmed(for: next, now: now))
    }
    @MainActor func testExpiryControlsRequireAnExplicitClickAndNeverOfferApproval() throws {
        _ = NSApplication.shared
        let original = try review()
        var state = ViewerEnrollmentReviewPresentation()
        state.open(original, requestExpiresAt: at + 600_000)
        state.expire(at: now.addingTimeInterval(120), choice: .unchanged)
        let expired = try XCTUnwrap(state.expired)
        var calls: [ViewerEnrollmentReviewPresentation.Expired] = []
        let (notice, retry) = ViewerCommunitySheet.expiredReviewControls(expired) { calls.append($0) }
        XCTAssertTrue(notice.stringValue.hasPrefix("검토 유효기간 만료·원래 등록 요청 유지"))
        XCTAssertEqual(retry.title, "같은 등록 요청 다시 검토")
        XCTAssertEqual(retry.state, .off); XCTAssertFalse((retry as NSButton) is HumanButton)
        XCTAssertTrue(calls.isEmpty)
        retry.performClick(nil)
        XCTAssertEqual(calls, [expired]); XCTAssertEqual(calls.first?.planId, original.planId)
        XCTAssertNil(state.review); XCTAssertFalse(state.confirmation.isConfirmed(for: original, now: now))
    }
}
#endif
