import Foundation

/// A short comparison code is presentation only; approval still signs the complete verified plan digest.
public enum CommunityEnrollmentCode {
    public static func formatted(digest: String) -> String? {
        guard digest.count == 64, digest.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        let prefix = Array(digest.prefix(12).uppercased())
        return stride(from: 0, to: 12, by: 4).map { String(prefix[$0..<($0 + 4)]) }.joined(separator: " ")
    }
}

/// RAM-only acknowledgement of one exact review. It creates no signer or device authority.
public struct CommunityEnrollmentConfirmation: Sendable {
    private struct Binding: Equatable, Sendable {
        let planId: String, digest: String, challenge: String, admin: String
        let revision: Int64, expiresAt: Int64
        let managementDigest: String?
        init(_ review: CommunityAccessReview) {
            planId = review.planId; digest = review.digest; challenge = review.challenge; admin = review.admin
            revision = review.revision; expiresAt = review.expiresAt; managementDigest = review.management?.digest
        }
    }
    private var binding: Binding?
    public init() {}
    public mutating func reset() { binding = nil }
    public mutating func setConfirmed(_ confirmed: Bool, for review: CommunityAccessReview, now: Date = Date()) {
        binding = nil
        guard confirmed, Self.isCurrent(review, now: now) else { return }
        binding = Binding(review)
    }
    public func isConfirmed(for review: CommunityAccessReview, now: Date = Date()) -> Bool {
        Self.isCurrent(review, now: now) && binding == Binding(review)
    }
    private static func isCurrent(_ review: CommunityAccessReview, now: Date) -> Bool {
        review.expiresAt > Int64(now.timeIntervalSince1970 * 1000) &&
        review.hasValidManagementBinding && CommunityEnrollmentCode.formatted(digest: review.digest) != nil && (try? review.plan.digest) == review.digest
    }
}
