import Foundation

/// Owned by a serial native approval UI. Cancelling a retired attempt never authorizes its late reply.
/// This tracks only the authentication wait; the LAContext remains usable for signing after completion.
public final class ApprovalAuthentication {
    public private(set) var approvalId: String?
    private var expiresAt: Int64 = 0
    private var cancel: (() -> Void)?

    public init() {}

    public func begin(_ id: String, expiresAt: Int64, cancel: @escaping () -> Void) -> Bool {
        guard approvalId == nil else { return false }
        approvalId = id; self.expiresAt = expiresAt; self.cancel = cancel
        return true
    }

    /// Clear before invoking native cancellation: its completion may reenter the owner immediately.
    public func cancelUnlessPending(_ pending: Bool, now: Int64) {
        guard approvalId != nil, !pending || now >= expiresAt else { return }
        let cancellation = cancel
        approvalId = nil; expiresAt = 0; cancel = nil
        cancellation?()
    }

    /// A cancelled A cannot finish a later B, even when A's native callback reports success.
    @discardableResult public func complete(_ id: String, now: Int64) -> Bool {
        guard approvalId == id else { return false }
        guard now < expiresAt else { cancelUnlessPending(false, now: now); return false }
        approvalId = nil; expiresAt = 0; cancel = nil
        return true
    }
}
