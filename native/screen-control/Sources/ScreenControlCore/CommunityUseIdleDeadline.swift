import Foundation

/// Local RAM lifetime is bounded by real activity time even when the device wall clock lags the issuer.
public enum CommunityUseIdleDeadline {
    public static func observedTick(observedAt: Date, wallNow: Date, tickNow: ContinuousClock.Instant) -> ContinuousClock.Instant? {
        let age = wallNow.timeIntervalSince(observedAt)
        guard age.isFinite, age >= 0, age <= 55 else { return nil }
        return tickNow.advanced(by: .seconds(-age))
    }
    public static func bounded(serverIdleExpiresAt: Int64, wallNow: Date, tickNow: ContinuousClock.Instant,
                               humanTick: ContinuousClock.Instant) -> ContinuousClock.Instant {
        let remaining = max(0, min(3_600, Double(serverIdleExpiresAt) / 1_000 - wallNow.timeIntervalSince1970))
        let serverBound = tickNow.advanced(by: .seconds(remaining))
        let localBound = min(humanTick, tickNow).advanced(by: .seconds(3_600))
        return min(serverBound, localBound)
    }
}
