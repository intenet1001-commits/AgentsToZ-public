import Foundation

/// Diagnostic only: one content-free reading of what the two physical-input checks compare — the HID idle age and
/// the physical-event counters — taken around a scoped action. It holds no coordinates, key codes, text, screen data
/// or tokens, never decides an outcome or relaxes a check, and cannot tell a person's event from a synthetic one.
public struct ScopedGuardSample: Equatable, Sendable {
    /// The counters the physical-input guard compares, in its order. The engine checks it reads the same list.
    public static let counterNames = ["keyDown", "keyUp", "flagsChanged", "mouseMoved", "leftMouseDown", "leftMouseUp",
        "rightMouseDown", "rightMouseUp", "otherMouseDown", "otherMouseUp", "leftMouseDragged", "rightMouseDragged",
        "otherMouseDragged", "scrollWheel"]
    public static let maxIdleMs = 600_000, maxSincePostMs = 60_000, maxCounterChange = 99
    /// Milliseconds since the last input the OS records for the HID system state, capped; -1 when the OS value was not
    /// a finite non-negative number.
    public let idleMs: Int
    /// Milliseconds since this action began posting its latest event, capped; nil before its first event, -1 when invalid.
    public let sincePostMs: Int?
    /// Each changed counter since the observation: 1...99 (99 means at least 99) or -1 when it went down. Nil when a
    /// vector was missing or of the wrong length.
    public let counterChanges: [String: Int]?

    public init(idleSeconds: Double, sincePostSeconds: Double?, counters: [UInt32]?, observed: [UInt32]?) {
        idleMs = Self.milliseconds(idleSeconds, cap: Self.maxIdleMs)
        sincePostMs = sincePostSeconds.map { Self.milliseconds($0, cap: Self.maxSincePostMs) }
        counterChanges = Self.changes(counters, observed: observed)
    }
    static func milliseconds(_ seconds: Double, cap: Int) -> Int {
        guard seconds.isFinite, seconds >= 0 else { return -1 }
        return Int(min(seconds * 1000, Double(cap)).rounded(.down))
    }
    static func changes(_ counters: [UInt32]?, observed: [UInt32]?) -> [String: Int]? {
        guard let counters, let observed, counters.count == counterNames.count, observed.count == counterNames.count else { return nil }
        var result: [String: Int] = [:]
        for (index, name) in counterNames.enumerated() where counters[index] != observed[index] {
            result[name] = counters[index] < observed[index] ? -1 : Int(min(counters[index] - observed[index], UInt32(maxCounterChange)))
        }
        return result
    }
    public var json: [String: Any] {
        var out: [String: Any] = ["idleMs": idleMs, "counters": counterChanges.map { $0 as Any } ?? NSNull()]
        if let sincePostMs { out["sincePostMs"] = sincePostMs }
        return out
    }
}

/// At most three kept samples for one action: immediately before its first synthetic event, at the start of the last guard
/// after an event (every such guard reads; only the last is kept), and when a guard first refused. They travel only in that
/// action's receipt and are never replayed.
public struct ScopedGuardSamples: Equatable, Sendable {
    public let before: ScopedGuardSample?
    public let after: ScopedGuardSample?
    public let refusal: ScopedGuardSample?
    public init?(before: ScopedGuardSample?, after: ScopedGuardSample?, refusal: ScopedGuardSample?) {
        guard before != nil || after != nil || refusal != nil else { return nil }
        self.before = before; self.after = after; self.refusal = refusal
    }
    public var json: [String: Any] {
        var out: [String: Any] = [:]
        if let before { out["before"] = before.json }
        if let after { out["after"] = after.json }
        if let refusal { out["refusal"] = refusal.json }
        return out
    }
}
