import Foundation

/// Display-only metadata from an already verified prepared registration. It grants no device or manager authority.
public struct CommunityPendingRegistrationPresentation: Equatable, Sendable {
    public let code: String
    public let expiresAt: Int64
    public init?(digest: String?, expiresAt: Int64?, waiting: Bool, at now: Date = Date()) {
        guard waiting, let digest, let code = CommunityEnrollmentCode.formatted(digest: digest), let expiresAt,
              expiresAt > Int64(now.timeIntervalSince1970 * 1000) else { return nil }
        self.code = code; self.expiresAt = expiresAt
    }
    /// A successful v2 pending lookup can coexist with no legacy membership; every other failure stays negative.
    public func preservesPending(afterLegacyError code: String, unifiedRefreshSucceeded: Bool, legacyCertificateLookupFailed: Bool, hasAuthorization: Bool) -> Bool {
        code == "NOT_ENROLLED" && unifiedRefreshSucceeded && legacyCertificateLookupFailed && !hasAuthorization
    }
}
