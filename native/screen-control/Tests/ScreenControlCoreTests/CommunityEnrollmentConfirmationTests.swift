#if !CORE_CHECKS
import CryptoKit
import XCTest
@testable import ScreenControlCore

final class CommunityEnrollmentConfirmationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func plan(name: String = "Mac3", capabilities: [CommunityCapability] = [.screenView]) throws -> CommunityAccessPlan {
        try CommunityAccessPlan(profileId: UUID().uuidString.lowercased(), deviceId: UUID().uuidString.lowercased(), name: name, kind: .desktop,
            hostKey: P256.Signing.PrivateKey().publicKey.x963Representation, biometricKey: P256.Signing.PrivateKey().publicKey.x963Representation,
            operationKey: P256.Signing.PrivateKey().publicKey.x963Representation, capabilities: capabilities)
    }
    private func review(_ plan: CommunityAccessPlan, id: String = UUID().uuidString.lowercased(), admin: String = UUID().uuidString.lowercased(), challenge: String = "challenge-a", revision: Int64 = 1, digest: String? = nil, expiresAt: Int64 = 1_800_000_060_000) throws -> CommunityAccessReview {
        CommunityAccessReview(plan: plan, planId: id, admin: admin, digest: try digest ?? plan.digest, challenge: challenge, revision: revision, expiresAt: expiresAt)
    }
    func testBothSidesFormatExactly48BitsFromTheCompleteDigest() {
        let digest = "012345abcdef" + String(repeating: "0", count: 52)
        XCTAssertEqual(CommunityEnrollmentCode.formatted(digest: digest), "0123 45AB CDEF")
        XCTAssertNil(CommunityEnrollmentCode.formatted(digest: String(digest.prefix(12))))
        XCTAssertNil(CommunityEnrollmentCode.formatted(digest: digest.uppercased()))
        XCTAssertNil(CommunityEnrollmentCode.formatted(digest: String(repeating: "g", count: 64)))
    }
    func testConfirmationCannotMoveToAnotherPlanChallengeRevisionOrAdministrator() throws {
        let plan = try plan(), first = try review(plan)
        var confirmation = CommunityEnrollmentConfirmation()
        XCTAssertFalse(confirmation.isConfirmed(for: first, now: now))
        confirmation.setConfirmed(true, for: first, now: now)
        XCTAssertTrue(confirmation.isConfirmed(for: first, now: now))
        for replacement in [
            try review(plan, admin: first.admin, challenge: first.challenge),
            try review(plan, id: first.planId, admin: first.admin, challenge: "challenge-b"),
            try review(plan, id: first.planId, admin: first.admin, challenge: first.challenge, revision: 2),
            try review(plan, id: first.planId, challenge: first.challenge),
            try review(plan, id: first.planId, admin: first.admin, challenge: first.challenge, expiresAt: first.expiresAt + 1)
        ] { XCTAssertFalse(confirmation.isConfirmed(for: replacement, now: now)) }
        confirmation.reset(); XCTAssertFalse(confirmation.isConfirmed(for: first, now: now))
        confirmation.setConfirmed(true, for: first, now: now); confirmation.setConfirmed(false, for: first, now: now)
        XCTAssertFalse(confirmation.isConfirmed(for: first, now: now))
    }
    func testExpiryAndSameDisplayCodeDoNotAuthorizeAChangedFullDigest() throws {
        let plan = try plan(), first = try review(plan)
        var confirmation = CommunityEnrollmentConfirmation()
        confirmation.setConfirmed(true, for: first, now: now)
        XCTAssertFalse(confirmation.isConfirmed(for: first, now: now.addingTimeInterval(60)))
        let replacementDigest = String(first.digest.prefix(12)) + String(repeating: first.digest.suffix(52) == String(repeating: "0", count: 52) ? "1" : "0", count: 52)
        let impostor = try review(plan, id: first.planId, admin: first.admin, challenge: first.challenge, digest: replacementDigest)
        XCTAssertEqual(CommunityEnrollmentCode.formatted(digest: impostor.digest), CommunityEnrollmentCode.formatted(digest: first.digest))
        XCTAssertFalse(confirmation.isConfirmed(for: impostor, now: now))
        confirmation.setConfirmed(true, for: impostor, now: now)
        XCTAssertFalse(confirmation.isConfirmed(for: impostor, now: now))
        let changed = try review(self.plan(name: "Mac3", capabilities: [.screenView, .screenControl]), id: first.planId, admin: first.admin, challenge: first.challenge)
        XCTAssertFalse(confirmation.isConfirmed(for: changed, now: now))
    }
}
#endif
