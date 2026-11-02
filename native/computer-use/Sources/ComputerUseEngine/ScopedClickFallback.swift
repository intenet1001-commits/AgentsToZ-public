import ComputerUseControlCore

/// Called only after no AX action was available. Never send pointer events for AX-only requests.
enum ScopedClickFallback {
    static func perform(accessibilityOnly: Bool, pointer: () -> MutationResult) -> MutationResult {
        guard !accessibilityOnly else { return .refused("ax-target-unavailable") }
        return pointer()
    }
}
