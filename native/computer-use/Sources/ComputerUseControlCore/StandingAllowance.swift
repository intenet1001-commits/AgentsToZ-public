import Foundation
#if !CORE_CHECKS
import ComputerUseApproval
#endif

/// The standing allowance (상시 허용): while it exists, Control approves a desktop (전체 Mac) request of any AgentsToZ AI
/// on this Mac by itself, without asking the person each time. Only the person turns it on, in Control's own window
/// with Touch ID or the login password; it lives in a Secure Enclave key whose label is `label`, so it survives app and
/// Control restarts and updates. Turning it off, or the person's 「중단」, deletes the key.
/// An application scope is never covered: it names one process generation, which ends with that app.
public struct StandingAllowance: Equatable, Sendable {
    public let since: Int64
    public init(since: Int64) { self.since = since }

    private static let prefix = "agentstoz-standing scope=desktop since="
    public var label: String { Self.prefix + String(since) }
    public static func parse(_ label: String) -> StandingAllowance? {
        guard label.hasPrefix(prefix) else { return nil }
        let digits = label.dropFirst(prefix.count)
        guard (1...16).contains(digits.count), digits.allSatisfy({ $0.isASCII && $0.isNumber }), digits.first != "0",
              let since = Int64(digits) else { return nil }
        return StandingAllowance(since: since)
    }
    public static func covers(_ scope: ScopeApprovalScope) -> Bool { scope == .desktop }
    public var json: [String: Any] { ["scope": ["kind": "desktop"], "since": since] }
}
