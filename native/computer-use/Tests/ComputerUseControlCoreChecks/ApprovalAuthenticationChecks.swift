import Foundation
#if !CORE_CHECKS
@testable import ComputerUseControlCore
#endif

struct ApprovalAuthenticationChecks {
    static func testExpiredAuthenticationReleasesItsWaitAndRejectsLateSuccess() throws {
        let authentication = ApprovalAuthentication()
        var cancelled = 0
        try check(authentication.begin("expired", expiresAt: 200) { cancelled += 1 }, "start the first native prompt")
        try check(!authentication.begin("other", expiresAt: 300) {}, "one native authentication wait at a time")
        authentication.cancelUnlessPending(true, now: 199)
        try check(cancelled == 0 && authentication.approvalId == "expired", "a live prompt is not interrupted")
        authentication.cancelUnlessPending(true, now: 200)
        try check(cancelled == 1 && authentication.approvalId == nil, "deadline cancels the old native prompt even with a stale pending row")
        authentication.cancelUnlessPending(false, now: 201)
        try check(cancelled == 1, "one invalidation only")
        try check(!authentication.complete("expired", now: 201), "late native success for the expired prompt cannot authorize signing")
        try check(authentication.begin("fresh", expiresAt: 400) { cancelled += 10 }, "a new native prompt can start")
        try check(!authentication.complete("expired", now: 201) && authentication.approvalId == "fresh", "the old callback cannot release the new wait")
        authentication.cancelUnlessPending(true, now: 399)
        try check(cancelled == 1, "the old deadline cannot cancel a fresh prompt")
        try check(authentication.complete("fresh", now: 399), "only the fresh native completion is accepted")
        authentication.cancelUnlessPending(false, now: 401)
        try check(cancelled == 1, "finished authentication leaves its LAContext valid for signing")
    }

    static func testRevokedAuthenticationCancelsBeforeReentrantCompletion() throws {
        let authentication = ApprovalAuthentication()
        var completionAccepted = true, cancelled = 0
        try check(authentication.begin("revoked", expiresAt: 900) {
            cancelled += 1
            completionAccepted = authentication.complete("revoked", now: 100)
        }, "start the request")
        authentication.cancelUnlessPending(false, now: 100)
        try check(cancelled == 1 && !completionAccepted, "withdrawal invalidates before a synchronous native callback")
        try check(authentication.approvalId == nil, "an ended request cannot keep the approval UI busy")
    }

    static func testLateSuccessBeforeTheNextTimerTickIsRefused() throws {
        let authentication = ApprovalAuthentication()
        var cancelled = 0
        try check(authentication.begin("deadline", expiresAt: 500) { cancelled += 1 }, "begin an authentication wait")
        // The native callback can arrive before the one-second expiry timer gets to run.
        try check(!authentication.complete("deadline", now: 500), "completion checks its own deadline before signing")
        try check(cancelled == 1 && authentication.approvalId == nil, "expired context is invalidated without waiting for a timer tick")
        try check(authentication.begin("next", expiresAt: 700) {}, "the expired callback cannot leave the next request blocked")
        try check(authentication.complete("next", now: 699), "the next request can complete before its own deadline")
    }
}
