import Foundation

/// A late read cannot revive a review that the person closed or replaced while awaiting the native identity.
/// It only fences a read; it creates no signer, authority, approval or session.
@MainActor
public final class CommunityReviewLifecycle {
    private var generation: UInt64 = 0
    public init() {}
    public func cancel() { generation &+= 1 }
    public func freshCertificate(using read: @MainActor () async throws -> ScreenCommunityCertificate) async throws -> ScreenCommunityCertificate {
        try await prepare(using: read)
    }
    /// Includes every asynchronous preparation step, such as both the fresh issuer read and native identity IPC.
    public func prepare<Value: Sendable>(using read: @MainActor () async throws -> Value) async throws -> Value {
        generation &+= 1; let epoch = generation
        let value = try await read()
        guard epoch == generation, !Task.isCancelled else { throw ScreenCommunityError.service("REVIEW_CONTEXT_CHANGED") }
        return value
    }
}
