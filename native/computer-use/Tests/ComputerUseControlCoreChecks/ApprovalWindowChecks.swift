import Foundation
#if !CORE_CHECKS
@testable import ComputerUseControlCore
import ComputerUseApproval
#endif

/// 2026-10-31: a request waits 10 minutes for the person (it was 120 s, which often ran out before they reached Control).
struct ApprovalWindowChecks {
    static func testRequestsWaitTenMinutes() throws {
        try check(ControlLimits.approvalMs == 600_000, "a request waits up to 10 minutes")
        try check(ComputerUseScopeApproval.maxGrantMs >= ControlLimits.approvalMs + ControlLimits.skewMs,
                  "the signed window holds a request that waits the whole 10 minutes")
        var time: Int64 = 100_000
        let owner = ControlOwner(pid: 10, start: 1234)
        let caller = ControlCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "a", count: 32))
        let state = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in true })
        let signed = { (id: String, end: Int64) in
            ScopedSignedApproval(payload: ScopeApprovalPayload(approvalId: id, scope: .desktop,
                caller: ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation),
                owner: ScopeApprovalOwner(pid: owner.pid, start: String(owner.start)), issuedAt: time, expiresAt: end),
                signature: Data([1]), publicKey: Data(repeating: 4, count: 65))
        }
        try expectCode("approval-expired") {
            try state.submit(approvalId: String(repeating: "f", count: 64), scope: .desktop, caller: caller, label: "test",
                             expiresAt: time + ControlLimits.approvalMs + ControlLimits.skewMs + 1, owner: owner)
        }
        // Approved at once: the signature spans the longest deadline Control accepts.
        let full = String(repeating: "b", count: 64), fullEnd = time + ControlLimits.approvalMs + ControlLimits.skewMs
        try state.submit(approvalId: full, scope: .desktop, caller: caller, label: "test", expiresAt: fullEnd, owner: owner)
        try state.approve(full, signed: signed(full, fullEnd), legacyActive: false)
        // Approved nine minutes later, and it still opens.
        let late = String(repeating: "d", count: 64), lateEnd = time + ControlLimits.approvalMs
        try state.submit(approvalId: late, scope: .desktop, caller: caller, label: "test", expiresAt: lateEnd, owner: owner)
        time += 540_000
        state.prune()
        try check(state.entry(late, caller: caller, owner: owner)?.state == .pending, "still waiting after nine minutes")
        try state.approve(late, signed: signed(late, lateEnd), legacyActive: false)
        _ = try state.open(late, scope: .desktop, caller: caller, owner: owner, legacyActive: false)

        let waiting = ScopeControlState(now: { time }, newId: { String(repeating: "c", count: 32) }, ownerAlive: { _ in true })
        let ending = String(repeating: "e", count: 64)
        try waiting.submit(approvalId: ending, scope: .desktop, caller: caller, label: "test",
                           expiresAt: time + ControlLimits.approvalMs, owner: owner)
        time += ControlLimits.approvalMs + 1
        waiting.prune()
        try check(waiting.entry(ending, caller: caller, owner: owner)?.state == .expired, "a request still ends after 10 minutes")

        for (seconds, text) in [(600, "10분 0초 남음"), (587, "9분 47초 남음"), (60, "1분 0초 남음"), (59, "59초 남음"), (0, "0초 남음"), (-3, "0초 남음")] {
            try check(ControlCountdown.text(secondsLeft: seconds) == text, "\(seconds) s reads \(text)")
        }
    }
}
