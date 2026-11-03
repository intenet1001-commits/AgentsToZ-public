#if !CORE_CHECKS
import Foundation
import XCTest
@testable import ScreenControlCore

final class CommunityPendingRegistrationPresentationChecks: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let expiry: Int64 = 1_800_000_600_000
    private let digest = "012345abcdef" + String(repeating: "0", count: 52)
    func testFreshV2PendingAndLegacyNotEnrolledRetainTheOriginalCodeWithoutGrantingAuthority() throws {
        let original = try XCTUnwrap(CommunityPendingRegistrationPresentation(digest: digest, expiresAt: expiry, waiting: true, at: now))
        XCTAssertEqual(original.code, "0123 45AB CDEF"); XCTAssertEqual(original.expiresAt, expiry)
        XCTAssertTrue(original.preservesPending(afterLegacyError: "NOT_ENROLLED", unifiedRefreshSucceeded: true, legacyCertificateLookupFailed: true, hasAuthorization: false))
        // Repeated legacy lookup failures neither change the comparison nor extend the original ten-minute request.
        let refreshed = try XCTUnwrap(CommunityPendingRegistrationPresentation(digest: digest, expiresAt: expiry, waiting: true, at: now.addingTimeInterval(30)))
        XCTAssertEqual(refreshed, original)
    }
    func testActualRevocationFailedV2OrExistingAuthorizationCannotUseThePendingException() throws {
        let original = try XCTUnwrap(CommunityPendingRegistrationPresentation(digest: digest, expiresAt: expiry, waiting: true, at: now))
        for code in ["REGISTRATION_REVOKED", "REVOKED_IDENTITY", "INVALID_PROOF", "OTHER_COMMUNITY", "DEVICE_KEY_MISSING", "COMMUNITY_NOT_READY"] {
            XCTAssertFalse(original.preservesPending(afterLegacyError: code, unifiedRefreshSucceeded: true, legacyCertificateLookupFailed: true, hasAuthorization: false))
        }
        XCTAssertFalse(original.preservesPending(afterLegacyError: "NOT_ENROLLED", unifiedRefreshSucceeded: false, legacyCertificateLookupFailed: true, hasAuthorization: false))
        XCTAssertFalse(original.preservesPending(afterLegacyError: "NOT_ENROLLED", unifiedRefreshSucceeded: true, legacyCertificateLookupFailed: false, hasAuthorization: false))
        XCTAssertFalse(original.preservesPending(afterLegacyError: "NOT_ENROLLED", unifiedRefreshSucceeded: true, legacyCertificateLookupFailed: true, hasAuthorization: true))
    }
    func testPendingCodeIsHiddenExactlyAtTheOriginalExpiryAndNeverInventedFromMissingState() {
        XCTAssertNotNil(CommunityPendingRegistrationPresentation(digest: digest, expiresAt: expiry, waiting: true, at: now.addingTimeInterval(599.999)))
        XCTAssertNil(CommunityPendingRegistrationPresentation(digest: digest, expiresAt: expiry, waiting: true, at: now.addingTimeInterval(600)))
        XCTAssertNil(CommunityPendingRegistrationPresentation(digest: digest, expiresAt: expiry, waiting: false, at: now))
        XCTAssertNil(CommunityPendingRegistrationPresentation(digest: nil, expiresAt: expiry, waiting: true, at: now))
        XCTAssertNil(CommunityPendingRegistrationPresentation(digest: digest, expiresAt: nil, waiting: true, at: now))
        XCTAssertNil(CommunityPendingRegistrationPresentation(digest: String(repeating: "g", count: 64), expiresAt: expiry, waiting: true, at: now))
    }
}
#endif
