import Foundation
#if !CORE_CHECKS
@testable import ComputerUseControlCore
import ComputerUseApproval
#endif

struct ScopeStateChecks {
    static func testTakeoverDiagnosticsExcludePrivateValues() throws {
        for code in ["private/path", "private value", String(repeating: "x", count: 61), ""] {
            let time: Int64 = 100_000, owner = ControlOwner(pid: 10, start: 1234)
            let caller = ControlCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "a", count: 32))
            let id = String(repeating: "b", count: 64), end = time + 120_000
            let state = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in true })
            try state.submit(approvalId: id, scope: .desktop, caller: caller, label: "test", expiresAt: end, owner: owner)
            let payload = ScopeApprovalPayload(approvalId: id, scope: .desktop,
                caller: ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation),
                owner: ScopeApprovalOwner(pid: owner.pid, start: String(owner.start)), issuedAt: time, expiresAt: end)
            try state.approve(id, signed: ScopedSignedApproval(payload: payload, signature: Data([1]), publicKey: Data(repeating: 4, count: 65)), legacyActive: false)
            let grant = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: false)
            try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-1")
            let ticket = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_123", snapshotId: "snap-1")
            state.finishMutation(ticket, result: .humanTakeover, diagnosticReason: code)
            let receipt = try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_123")
            try check(receipt?.state == .humanTakeover && receipt?.reason == nil, "private or malformed diagnostics never escape")
            try expectCode("worker-halted") { _ = try state.access(grant.id, caller: caller, owner: owner) }
        }
    }
    static func testGuardSamplesAreBoundedAndOnlyExplainTheReceipt() throws {
        let names = ScopedGuardSample.counterNames, observed = [UInt32](repeating: 50, count: names.count)
        let idles: [(Double, Int)] = [(.nan, -1), (-0.001, -1), (.infinity, -1), (1.4999, 1_499), (1.5, 1_500), (1e9, 600_000)]
        for (idle, expected) in idles {
            let sample = ScopedGuardSample(idleSeconds: idle, sincePostSeconds: nil, counters: observed, observed: observed)
            try check(sample.idleMs == expected && sample.sincePostMs == nil && sample.counterChanges == [:], "idle age is bounded: \(idle)")
            try check(sample.json["sincePostMs"] == nil && (sample.json["counters"] as? [String: Int]) == [:], "no post time before an event")
        }
        let sinces: [(Double, Int)] = [(0, 0), (0.0049, 4), (1e9, 60_000), (-1, -1), (.nan, -1)]
        for (since, expected) in sinces {
            try check(ScopedGuardSample(idleSeconds: 2, sincePostSeconds: since, counters: nil, observed: observed).sincePostMs == expected,
                      "time since the action's own event is bounded: \(since)")
        }
        var changed = observed
        changed[0] = 49; changed[3] = 50 + 500; changed[4] = 51
        let sample = ScopedGuardSample(idleSeconds: 0.003, sincePostSeconds: 0.002, counters: changed, observed: observed)
        try check(sample.counterChanges == ["keyDown": -1, "mouseMoved": 99, "leftMouseDown": 1], "only changed counters, capped, by name")
        let vectors: [([UInt32]?, [UInt32]?)] = [(Array(changed.dropLast()), observed), (changed, Array(observed.dropLast())), (nil, observed), (changed, nil)]
        for (counters, base) in vectors {
            let unreadable = ScopedGuardSample(idleSeconds: 2, sincePostSeconds: 0, counters: counters, observed: base)
            try check(unreadable.counterChanges == nil && unreadable.json["counters"] is NSNull, "an unreadable vector is not reported as unchanged")
        }
        try check(ScopedGuardSamples(before: nil, after: nil, refusal: nil) == nil, "no readings, no field")
        let built = ScopedGuardSamples(before: ScopedGuardSample(idleSeconds: 5, sincePostSeconds: nil, counters: observed, observed: observed),
                                       after: sample, refusal: sample)
        try check(built != nil, "readings are kept")
        let samples = built!
        try check(JSONSerialization.isValidJSONObject(samples.json) && Set(samples.json.keys) == ["before", "after", "refusal"], "plain JSON")
        try check(Set(Receipt(requestId: "request_1", state: .dispatchedUnverified, reason: nil).json.keys) == ["requestId", "state"],
                  "a receipt without readings keeps its fields")

        for result in [MutationResult.humanTakeover, .dispatchedUnverified, .refused("guard-refused"), .unknown] {
            let time: Int64 = 100_000, owner = ControlOwner(pid: 10, start: 1234)
            let caller = ControlCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "a", count: 32))
            let id = String(repeating: "b", count: 64), end = time + 120_000
            let state = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in true })
            try state.submit(approvalId: id, scope: .desktop, caller: caller, label: "test", expiresAt: end, owner: owner)
            let payload = ScopeApprovalPayload(approvalId: id, scope: .desktop,
                caller: ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation),
                owner: ScopeApprovalOwner(pid: owner.pid, start: String(owner.start)), issuedAt: time, expiresAt: end)
            try state.approve(id, signed: ScopedSignedApproval(payload: payload, signature: Data([1]), publicKey: Data(repeating: 4, count: 65)), legacyActive: false)
            let grant = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: false)
            try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-1")
            let ticket = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_123", snapshotId: "snap-1")
            state.finishMutation(ticket, result: result, diagnosticReason: "human-active-idle", guardSamples: samples)
            let receipt = try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_123")
            try check(receipt?.guardSamples == samples && (receipt?.json["guardSamples"] as? [String: Any])?.count == 3,
                      "the receipt carries the readings: \(result)")
            let halted = result == .humanTakeover || result == .unknown
            try check(state.grant?.halted == halted, "readings never change the halt rule: \(result)")
            try check(receipt?.reason == (result == .humanTakeover ? "human-active-idle" : result == .refused("guard-refused") ? "guard-refused" : nil),
                      "readings never change the reason: \(result)")
        }
    }
    /// A refusal names the guard check that refused it in its own field; reason, state, halt and replay stay as they were.
    static func testRefusalNamesItsGuardCheck() throws {
        let time: Int64 = 100_000, owner = ControlOwner(pid: 10, start: 1234)
        let caller = ControlCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "a", count: 32))
        func acted(_ result: MutationResult, _ diagnostic: String?) throws -> (ScopeControlState, ScopedGrantEntry, Receipt?) {
            let id = String(repeating: "b", count: 64), end = time + 120_000
            let state = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in true })
            try state.submit(approvalId: id, scope: .desktop, caller: caller, label: "test", expiresAt: end, owner: owner)
            let payload = ScopeApprovalPayload(approvalId: id, scope: .desktop,
                caller: ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation),
                owner: ScopeApprovalOwner(pid: owner.pid, start: String(owner.start)), issuedAt: time, expiresAt: end)
            try state.approve(id, signed: ScopedSignedApproval(payload: payload, signature: Data([1]), publicKey: Data(repeating: 4, count: 65)), legacyActive: false)
            let grant = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: false)
            try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-1")
            state.finishMutation(try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_123", snapshotId: "snap-1"),
                                 result: result, diagnosticReason: diagnostic)
            return (state, grant, try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_123"))
        }
        for (result, guardCode) in [(MutationResult.refused("guard-refused"), "protected-overlay"), (.refused("guard-refused"), "target-changed"),
                                    (.refused("guard-refused"), "human-active")] {
            let (state, grant, receipt) = try acted(result, guardCode)
            try check(receipt?.state == .refused && receipt?.reason == "guard-refused" && receipt?.guardReason == guardCode,
                      "the refusal keeps its reason and names the guard check: \(guardCode)")
            try check(receipt?.json["guardReason"] as? String == guardCode && receipt?.json["reason"] as? String == "guard-refused",
                      "the guard check is its own wire field")
            try check(state.grant?.halted == false, "naming the check never halts the grant")
            try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-2")
            try expectCode("duplicate-request", notDispatched: true) {
                _ = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_123", snapshotId: "snap-2")
            }
        }
        for code in ["private/path", "Protected-Overlay", "private value", String(repeating: "x", count: 61), ""] {
            let (_, _, receipt) = try acted(.refused("guard-refused"), code)
            try check(receipt?.reason == "guard-refused" && receipt?.guardReason == nil && receipt?.json["guardReason"] == nil,
                      "a malformed check code never escapes: \(code)")
        }
        let (_, _, unnamed) = try acted(.refused("capture-required"), nil)
        try check(unnamed?.reason == "capture-required" && unnamed?.guardReason == nil, "a refusal without a guard check names none")
        for result in [MutationResult.confirmed, .dispatchedUnverified, .unknown, .humanTakeover] {
            let (_, _, receipt) = try acted(result, "human-active")
            try check(receipt?.guardReason == nil && receipt?.json["guardReason"] == nil, "only a refusal carries a guard check: \(result)")
            try check(receipt?.reason == (result == .humanTakeover ? "human-active" : nil), "takeover keeps its reason: \(result)")
        }
    }
    static func testCompletedUnverifiedRequiresFreshObservation() throws {
        let time: Int64 = 100_000, owner = ControlOwner(pid: 10, start: 1234)
        let caller = ControlCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "a", count: 32))
        let id = String(repeating: "b", count: 64), end = time + 120_000
        let state = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in true })
        try state.submit(approvalId: id, scope: .desktop, caller: caller, label: "test", expiresAt: end, owner: owner)
        let payload = ScopeApprovalPayload(approvalId: id, scope: .desktop,
            caller: ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation),
            owner: ScopeApprovalOwner(pid: owner.pid, start: String(owner.start)), issuedAt: time, expiresAt: end)
        try state.approve(id, signed: ScopedSignedApproval(payload: payload, signature: Data([1]), publicKey: Data(repeating: 4, count: 65)), legacyActive: false)
        let grant = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: false)
        try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-1")
        let first = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_123", snapshotId: "snap-1")
        state.finishMutation(first, result: .dispatchedUnverified)
        let current = try state.access(grant.id, caller: caller, owner: owner)
        try check(!current.halted, "completed unverified transmission does not revoke the grant")
        let receipt = try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_123")
        try check(receipt?.state == .dispatchedUnverified, "UI effect is never claimed confirmed")
        try expectCode("stale-observation", notDispatched: true) {
            _ = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_456", snapshotId: "snap-1")
        }
        try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-2")
        try expectCode("duplicate-request", notDispatched: true) {
            _ = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_123", snapshotId: "snap-2")
        }
        let second = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_456", snapshotId: "snap-2")
        state.finishMutation(second, result: .humanTakeover, diagnosticReason: "human-active-events")
        let stopped = try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_456")
        try check(stopped?.state == .humanTakeover && stopped?.reason == "human-active-events", "takeover retains the bounded guard code")
        try expectCode("worker-halted") { _ = try state.access(grant.id, caller: caller, owner: owner) }
    }
    /// Until switched off: no 10-minute end and no 64-action cap. Old receipts are dropped but their IDs stay spent, and
    /// a dropped receipt answers `receipt-evicted`, not "unknown". The grant still ends by revocation, its owner or 30 days.
    static func testGrantLastsUntilEndedAndKeepsEverySpentId() throws {
        var time: Int64 = 100_000
        let owner = ControlOwner(pid: 10, start: 1234)
        let caller = ControlCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "a", count: 32))
        let id = String(repeating: "b", count: 64), end = time + 120_000
        let state = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in true })
        try state.submit(approvalId: id, scope: .desktop, caller: caller, label: "test", expiresAt: end, owner: owner)
        let payload = ScopeApprovalPayload(approvalId: id, scope: .desktop,
            caller: ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation),
            owner: ScopeApprovalOwner(pid: owner.pid, start: String(owner.start)), issuedAt: time, expiresAt: end)
        try state.approve(id, signed: ScopedSignedApproval(payload: payload, signature: Data([1]), publicKey: Data(repeating: 4, count: 65)), legacyActive: false)
        let grant = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: false)
        try check(grant.expiresAt == time + ControlLimits.scopeGrantMs && ControlLimits.scopeGrantMs == 30 * 86_400_000,
                  "a scope grant's horizon is 30 days")
        try check(ControlLimits.grantMs == 600_000 && ControlLimits.receiptsPerGrant == 64, "the window grant keeps 10 minutes and 64")
        time += ControlLimits.grantMs + 1
        _ = try state.access(grant.id, caller: caller, owner: owner)
        let total = ControlLimits.scopeReceiptsKept + 40
        for n in 0..<total {
            time += 1
            try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-\(n)")
            let ticket = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_\(n)", snapshotId: "snap-\(n)")
            state.finishMutation(ticket, result: n % 2 == 0 ? .confirmed : .dispatchedUnverified)
        }
        try check(total > ControlLimits.receiptsPerGrant, "more than the window grant's 64 actions")
        try check(state.grant?.receipts.count == ControlLimits.scopeReceiptsKept && state.grant?.receiptOrder.count == ControlLimits.scopeReceiptsKept
                  && state.grant?.spent.count == total, "full receipts are bounded, spent IDs are all kept")
        try check(try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_\(total - 1)")?.state == .dispatchedUnverified,
                  "the newest receipt is kept")
        try check(try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_40")?.state == .confirmed,
                  "the oldest kept receipt is still read")
        try expectCode("receipt-evicted", notDispatched: true) { _ = try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_39") }
        try expectCode("receipt-evicted", notDispatched: true) { _ = try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_0") }
        try check(try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_never") == nil, "an unused ID is absent")
        try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-again")
        for reused in ["request_0", "request_39", "request_\(total - 1)"] {
            try expectCode("duplicate-request", notDispatched: true) {
                _ = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: reused, snapshotId: "snap-again")
            }
        }
        try check(state.grant?.spent.count == total, "a refused reuse consumes nothing")
        _ = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_new", snapshotId: "snap-again")
        try check(state.grant?.receiptOrder.first == "request_41" && state.grant?.receipts["request_40"] == nil, "the oldest receipt is dropped first")

        time = grant.expiresAt; state.prune()
        try check(state.grant == nil, "the 30-day horizon still ends the grant")
    }
    /// The memory bound: after `scopeActionsPerGrant` actions the next is refused before dispatch and needs a new approval.
    static func testActionsPerApprovalAreBounded() throws {
        var time: Int64 = 100_000
        let owner = ControlOwner(pid: 10, start: 1234)
        let caller = ControlCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "a", count: 32))
        let id = String(repeating: "b", count: 64), end = time + 120_000
        let state = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in true })
        try state.submit(approvalId: id, scope: .desktop, caller: caller, label: "test", expiresAt: end, owner: owner)
        let payload = ScopeApprovalPayload(approvalId: id, scope: .desktop,
            caller: ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation),
            owner: ScopeApprovalOwner(pid: owner.pid, start: String(owner.start)), issuedAt: time, expiresAt: end)
        try state.approve(id, signed: ScopedSignedApproval(payload: payload, signature: Data([1]), publicKey: Data(repeating: 4, count: 65)), legacyActive: false)
        let grant = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: false)
        for n in 0..<ControlLimits.scopeActionsPerGrant {
            try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap")
            state.finishMutation(try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_\(n)", snapshotId: "snap"), result: .confirmed)
        }
        time += 1
        try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap")
        try expectCode("receipt-limit", notDispatched: true) {
            _ = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_over", snapshotId: "snap")
        }
        try check(state.grant?.receipts.count == ControlLimits.scopeReceiptsKept && state.grant?.receipts["request_over"] == nil,
                  "the refused action leaves no receipt")
    }
    static func testFencesAndReceipts() throws {
        var time: Int64 = 100_000
        var alive = true
        let owner = ControlOwner(pid: 10, start: 1234)
        let caller = ControlCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "a", count: 32))
        let id = String(repeating: "b", count: 64)
        let state = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in alive })
        let end = time + 120_000
        let protected = ScopeApplicationIdentity(bundleId: "com.intenet.agentstozbycs.control", teamId: "",
            codeHash: String(repeating: "a", count: 40), pid: 33, processStart: "9")
        try expectCode("target-refused", notDispatched: true) {
            try state.submit(approvalId: String(repeating: "d", count: 64), scope: .application(protected),
                             caller: caller, label: "test", expiresAt: end, owner: owner)
        }
        try state.submit(approvalId: id, scope: .desktop, caller: caller, label: "test", expiresAt: end, owner: owner)
        let payload = ScopeApprovalPayload(approvalId: id, scope: .desktop,
            caller: ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation),
            owner: ScopeApprovalOwner(pid: owner.pid, start: String(owner.start)), issuedAt: time, expiresAt: end)
        let signed = ScopedSignedApproval(payload: payload, signature: Data([1]), publicKey: Data(repeating: 4, count: 65))
        try expectCode("scope-conflict") { try state.approve(id, signed: signed, legacyActive: true) }
        try state.approve(id, signed: signed, legacyActive: false)
        try expectCode("scope-conflict") { _ = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: true) }
        let wrongCaller = ControlCaller(sessionId: caller.sessionId, lane: caller.lane, generation: String(repeating: "e", count: 32))
        try expectCode("approval-unknown") { _ = try state.open(id, scope: .desktop, caller: wrongCaller, owner: owner, legacyActive: false) }
        let grant = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: false)
        try expectCode("approval-unknown") { _ = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: false) }
        try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-1")
        let ticket = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_123", snapshotId: "snap-1")
        let initial = try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_123")
        try check(initial?.state == .unknown, "unknown is recorded before dispatch")
        try expectCode("duplicate-request", notDispatched: true) {
            _ = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_123", snapshotId: "snap-1")
        }
        state.finishMutation(ticket, result: .unknown, diagnosticReason: "private/path")
        try expectCode("worker-halted") { _ = try state.access(grant.id, caller: caller, owner: owner) }
        let receipt = try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_123")
        try check(receipt?.state == .unknown && receipt?.reason == nil, "unknown survives a halted grant without diagnostic contents")
        let revoked = try state.revoke(grant.id, caller: caller, owner: owner)
        try check(revoked, "owner can revoke halted grant")

        let next = String(repeating: "f", count: 64)
        try state.submit(approvalId: next, scope: .desktop, caller: caller, label: "test", expiresAt: time + 10, owner: owner)
        time += 11; state.prune()
        let expired = state.entry(next, caller: caller, owner: owner)
        try check(expired?.state == .expired, "pending request expires")
        let last = String(repeating: "0", count: 64)
        try state.submit(approvalId: last, scope: .desktop, caller: caller, label: "test", expiresAt: time + 10, owner: owner)
        alive = false; state.prune()
        let cancelled = state.entry(last, caller: caller, owner: owner)
        try check(cancelled?.state == .cancelled, "owner ending cancels pending request")
    }

    /// The control bar's take and hand-back (2026-10-31): taking refuses every agent operation but a receipt without
    /// halting; handing back needs no new approval but a new observation; a takeover or unknown result still halts.
    static func testThePersonHoldsTheGrantFromTheBarWithoutEndingIt() throws {
        var time: Int64 = 100_000
        let owner = ControlOwner(pid: 10, start: 1234)
        let caller = ControlCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "a", count: 32))
        let id = String(repeating: "b", count: 64), end = time + 120_000
        let state = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in true })
        try state.submit(approvalId: id, scope: .desktop, caller: caller, label: "test", expiresAt: end, owner: owner)
        let payload = ScopeApprovalPayload(approvalId: id, scope: .desktop,
            caller: ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation),
            owner: ScopeApprovalOwner(pid: owner.pid, start: String(owner.start)), issuedAt: time, expiresAt: end)
        try state.approve(id, signed: ScopedSignedApproval(payload: payload, signature: Data([1]), publicKey: Data(repeating: 4, count: 65)), legacyActive: false)
        let grant = try state.open(id, scope: .desktop, caller: caller, owner: owner, legacyActive: false)
        try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-1")
        let done = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_1", snapshotId: "snap-1")
        state.finishMutation(done, result: .confirmed)
        try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-2")
        try check(state.handToPerson(), "the bar's take holds the grant")
        try check(!state.handToPerson(), "taking twice changes nothing")
        try check(state.grant?.person == true && state.grant?.halted == false, "held by the person, not halted")
        try expectCode("person-has-control", notDispatched: true) { _ = try state.access(grant.id, caller: caller, owner: owner) }
        try expectCode("person-has-control", notDispatched: true) { try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-3") }
        try expectCode("person-has-control", notDispatched: true) {
            _ = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_2", snapshotId: "snap-2")
        }
        try check(try state.receipt(grant.id, caller: caller, owner: owner, requestId: "request_1")?.state == .confirmed,
                  "a receipt is still read while the person holds the Mac")
        time += 60_000
        try state.handToAgent()
        try check(state.grant?.person == false && state.grant?.halted == false, "handed back without a new approval")
        try expectCode("stale-observation", notDispatched: true) {
            _ = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_3", snapshotId: "snap-2")
        }
        try check(state.grant?.spent.contains("request_1") == true && state.grant?.spent.contains("request_3") == false,
                  "a refused stale action is not spent; earlier IDs stay spent")
        try expectCode("process-busy", notDispatched: true) { try state.handToAgent() }
        // A take during a running action: the action's own guard decides, and a takeover halts as before.
        try state.recordObservation(grant.id, caller: caller, owner: owner, snapshotId: "snap-4")
        let running = try state.beginMutation(grant.id, caller: caller, owner: owner, requestId: "request_4", snapshotId: "snap-4")
        try check(state.handToPerson(), "the person may take while an action runs")
        _ = try state.access(grant.id, caller: caller, owner: owner, allowPerson: true)
        try expectCode("person-has-control", notDispatched: true) { _ = try state.access(grant.id, caller: caller, owner: owner) }
        try expectCode("process-busy", notDispatched: true) { try state.handToAgent() }
        state.finishMutation(running, result: .humanTakeover, diagnosticReason: "human-active-events")
        try check(state.grant?.halted == true, "a takeover still halts")
        try expectCode("grant-unknown") { try state.handToAgent() }
        try check(!state.handToPerson(), "a halted grant is not held")
    }
}
