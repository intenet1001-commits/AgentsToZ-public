import Foundation
#if !CORE_CHECKS
import ComputerUseApproval
#endif

/// Pure v2 state. This does not authenticate, create a UI, capture, post events, or expose a live capability.
public struct ScopedSignedApproval: Sendable {
    public let payload: ScopeApprovalPayload
    public let signature: Data
    public let publicKey: Data
    public init(payload: ScopeApprovalPayload, signature: Data, publicKey: Data) {
        self.payload = payload; self.signature = signature; self.publicKey = publicKey
    }
    public var json: [String: Any]? {
        guard let data = try? JSONEncoder().encode(payload), var fields = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        fields["signature"] = signature.base64EncodedString()
        return fields
    }
}
public struct ScopedApprovalEntry: Sendable {
    public let approvalId: String
    public let scope: ScopeApprovalScope
    public let caller: ControlCaller
    public let label: String
    public let expiresAt: Int64
    public let owner: ControlOwner
    public internal(set) var state: ApprovalState = .pending
    public internal(set) var signed: ScopedSignedApproval?
    public internal(set) var decidedAt: Int64?
}
public struct ScopedGrantEntry: Sendable {
    public let id: String
    public let approvalId: String
    public let scope: ScopeApprovalScope
    public let caller: ControlCaller
    public let owner: ControlOwner
    public let label: String
    public let expiresAt: Int64
    public internal(set) var halted = false
    /// The person took the Mac from the on-screen control bar: every agent operation but a receipt is refused, and the
    /// grant stays until they hand it back from the bar or end it. Only the native bar sets or clears this.
    public internal(set) var person = false
    var snapshotId: String?
    var snapshotAt: Int64 = 0
    /// Only the newest `ControlLimits.scopeReceiptsKept`, in `receiptOrder` (oldest first).
    var receipts: [String: Receipt] = [:]
    var receiptOrder: [String] = []
    /// Every request ID this grant consumed, so one whose full receipt was dropped is still never dispatched again.
    var spent: Set<String> = []
}
public struct ScopedMutationTicket: Equatable, Sendable { public let grantId: String; public let requestId: String }

public final class ScopeControlState {
    private let now: () -> Int64
    private let newId: () -> String
    private let ownerAlive: (ControlOwner) -> Bool
    public private(set) var approvals: [String: ScopedApprovalEntry] = [:]
    public private(set) var grant: ScopedGrantEntry?
    private var mutation: ScopedMutationTicket?

    public init(now: @escaping () -> Int64, newId: @escaping () -> String = ControlState.randomId,
                ownerAlive: @escaping (ControlOwner) -> Bool = ProcessGeneration.alive) {
        self.now = now; self.newId = newId; self.ownerAlive = ownerAlive
    }
    public func prune() {
        let time = now()
        for (id, entry) in approvals {
            var current = entry
            if [.pending, .approved].contains(entry.state), !ownerAlive(entry.owner) {
                current.state = .cancelled; current.signed = nil; current.decidedAt = time
            } else if [.pending, .approved].contains(entry.state), time > entry.expiresAt {
                current.state = .expired; current.signed = nil; current.decidedAt = time
            } else if ![.pending, .approved].contains(entry.state), let decided = entry.decidedAt,
                      time - decided > ControlLimits.decidedRetentionMs {
                approvals[id] = nil; continue
            }
            approvals[id] = current
        }
        if let current = grant, time >= current.expiresAt || !ownerAlive(current.owner) { grant = nil }
    }
    public var pending: [ScopedApprovalEntry] { approvals.values.filter { $0.state == .pending }.sorted { $0.expiresAt < $1.expiresAt } }

    public func submit(approvalId: String, scope: ScopeApprovalScope, caller: ControlCaller, label: String,
                       expiresAt: Int64, owner: ControlOwner) throws {
        prune()
        guard ComputerUseApproval.lowerHexString(approvalId, length: 64), approvals[approvalId] == nil,
              ComputerUseScopeApproval.validScope(scope), ControlRequest.label(label) != nil,
              ComputerUseScopeApproval.validCaller(ScopeApprovalCaller(sessionId: caller.sessionId, lane: caller.lane, generation: caller.generation)),
              ownerAlive(owner) else { throw ControlError.invalid }
        if case .application(let app) = scope, ScopedProtectedTargets.refuses(bundleId: app.bundleId) {
            throw ControlError.refuse("target-refused")
        }
        guard expiresAt > now(), expiresAt <= now() + ControlLimits.approvalMs + ControlLimits.skewMs else { throw ControlError("approval-expired") }
        guard pending.count < ControlLimits.pendingApprovals else { throw ControlError("approval-limit") }
        approvals[approvalId] = ScopedApprovalEntry(approvalId: approvalId, scope: scope, caller: caller,
                                                    label: label, expiresAt: expiresAt, owner: owner)
    }
    public func entry(_ id: String, caller: ControlCaller, owner: ControlOwner) -> ScopedApprovalEntry? {
        prune(); guard let current = approvals[id], current.caller == caller, current.owner == owner else { return nil }; return current
    }
    public func deny(_ id: String) {
        guard var current = approvals[id], current.state == .pending else { return }
        current.state = .denied; current.decidedAt = now(); current.signed = nil; approvals[id] = current
    }
    /// Called only by the native human approval path after identity, TCC and authentication rechecks.
    public func approve(_ id: String, signed: ScopedSignedApproval, legacyActive: Bool) throws {
        prune()
        guard var current = approvals[id], current.state == .pending else { throw ControlError("approval-unknown") }
        guard !legacyActive && grant == nil && mutation == nil else { throw ControlError("scope-conflict") }
        let payload = signed.payload
        let caller = ScopeApprovalCaller(sessionId: current.caller.sessionId, lane: current.caller.lane, generation: current.caller.generation)
        let owner = ScopeApprovalOwner(pid: current.owner.pid, start: String(current.owner.start))
        guard payload.approvalId == id, payload.scope == current.scope, payload.caller == caller, payload.owner == owner,
              payload.expiresAt == current.expiresAt, payload.issuedAt <= now(), payload.expiresAt > now(),
              (try? ComputerUseScopeApproval.bytes(payload)) != nil, signed.publicKey.count == 65, !signed.signature.isEmpty else {
            throw ControlError.invalid
        }
        current.state = .approved; current.signed = signed; current.decidedAt = now(); approvals[id] = current
    }
    public func open(_ id: String, scope: ScopeApprovalScope, caller: ControlCaller, owner: ControlOwner,
                     legacyActive: Bool) throws -> ScopedGrantEntry {
        prune()
        guard var entry = approvals[id], entry.state == .approved, entry.caller == caller, entry.owner == owner else {
            throw ControlError("approval-unknown")
        }
        guard entry.scope == scope else { throw ControlError("target-changed") }
        guard !legacyActive && grant == nil && mutation == nil else { throw ControlError("scope-conflict") }
        let id = newId()
        guard ComputerUseApproval.lowerHexString(id, length: 32) else { throw ControlError.invalid }
        let bound = ScopedGrantEntry(id: id, approvalId: entry.approvalId, scope: entry.scope, caller: caller,
                                     owner: owner, label: entry.label, expiresAt: now() + ControlLimits.scopeGrantMs)
        grant = bound; entry.state = .consumed; entry.signed = nil; entry.decidedAt = now(); approvals[entry.approvalId] = entry
        return bound
    }
    /// `allowPerson`: the check an action repeats while it runs. The person's 「직접 하기」 refuses the next operation at its
    /// start; one already admitted finishes (background input does not collide with them).
    public func access(_ id: String, caller: ControlCaller, owner: ControlOwner, allowHalted: Bool = false,
                       allowPerson: Bool = false) throws -> ScopedGrantEntry {
        prune()
        guard let current = grant, current.id == id, current.caller == caller, current.owner == owner else { throw ControlError("grant-unknown") }
        guard allowHalted || !current.halted else { throw ControlError("worker-halted") }
        guard allowHalted || allowPerson || !current.person else { throw ControlError.refuse("person-has-control") }
        return current
    }
    /// The person's 「직접 하기」 on the control bar. A running action is not cut off here: it finishes (its in-flight checks
    /// pass `allowPerson`) or a pointer action's input guard stops it, and a takeover or unknown result still halts.
    @discardableResult public func handToPerson() -> Bool {
        guard var current = grant, !current.halted, !current.person else { return false }
        current.person = true; current.snapshotId = nil; grant = current; return true
    }
    /// The person's 「AI에게 넘기기」 on the control bar, after the bar checked the click. The agent starts from a new
    /// observation; a halted grant never comes back this way.
    public func handToAgent() throws {
        prune()
        guard var current = grant, !current.halted else { throw ControlError("grant-unknown") }
        guard current.person, mutation == nil else { throw ControlError.refuse("process-busy") }
        current.person = false; current.snapshotId = nil; grant = current
    }
    public func recordObservation(_ id: String, caller: ControlCaller, owner: ControlOwner, snapshotId: String) throws {
        var current = try access(id, caller: caller, owner: owner)
        guard mutation == nil, ControlRequest.token(snapshotId, ControlLimits.snapshotBytes) != nil else { throw ControlError.refuse("process-busy") }
        current.snapshotId = snapshotId; current.snapshotAt = now(); grant = current
    }
    /// Creates an unknown receipt before native dispatch. A consumed observation or request ID is never replayed.
    public func beginMutation(_ id: String, caller: ControlCaller, owner: ControlOwner, requestId: String,
                              snapshotId: String) throws -> ScopedMutationTicket {
        let observed: Bool
        do { // The copy ends here, so the in-place changes below never copy the spent set of a long grant.
            let current = try access(id, caller: caller, owner: owner)
            guard ControlRequest.requestId(requestId) != nil, !current.spent.contains(requestId) else { throw ControlError.refuse("duplicate-request") }
            guard current.spent.count < ControlLimits.scopeActionsPerGrant else { throw ControlError.refuse("receipt-limit") }
            guard mutation == nil else { throw ControlError.refuse("process-busy") }
            let elapsed = now() - current.snapshotAt
            observed = current.snapshotId == snapshotId && elapsed >= 0 && elapsed <= ControlLimits.observationMs
        }
        grant?.snapshotId = nil
        guard observed else { throw ControlError.refuse("stale-observation") }
        grant?.spent.insert(requestId)
        grant?.receipts[requestId] = Receipt(requestId: requestId, state: .unknown, reason: nil)
        grant?.receiptOrder.append(requestId)
        // Only a settled receipt is dropped: an unknown or takeover halts the grant, so it is always the newest.
        if (grant?.receiptOrder.count ?? 0) > ControlLimits.scopeReceiptsKept, let oldest = grant?.receiptOrder.removeFirst() {
            grant?.receipts[oldest] = nil
        }
        let ticket = ScopedMutationTicket(grantId: id, requestId: requestId); mutation = ticket; return ticket
    }
    public func finishMutation(_ ticket: ScopedMutationTicket, result: MutationResult, diagnosticReason: String? = nil,
                               guardSamples: ScopedGuardSamples? = nil) {
        guard mutation == ticket else { return }
        mutation = nil
        guard grant?.id == ticket.grantId else { return }
        // Metadata only: never return exception messages, paths or event contents.
        let diagnostic = diagnosticReason.flatMap { code in
            (1...60).contains(code.utf8.count) && code.utf8.allSatisfy { (97...122).contains($0) || $0 == 45 } ? code : nil
        }
        let state: ReceiptState, reason: String?
        var guardReason: String?
        switch result {
        case .confirmed: state = .confirmed; reason = nil
        // `reason` stays the generic refusal (for example guard-refused); the failing guard check rides beside it.
        case .refused(let code): state = .refused; reason = code; guardReason = diagnostic
        // A fully released sequence may be sent successfully without proving its UI effect. The consumed snapshot
        // still forces a fresh observation, and this exact request ID stays non-replayable.
        case .dispatchedUnverified: state = .dispatchedUnverified; reason = nil
        case .unknown: state = .unknown; reason = nil; grant?.halted = true
        case .humanTakeover: state = .humanTakeover; grant?.halted = true; reason = diagnostic
        }
        // Content-free by construction; it explains a receipt and never changes its state, halt or replay rule.
        grant?.receipts[ticket.requestId] = Receipt(requestId: ticket.requestId, state: state, reason: reason,
                                                    guardSamples: guardSamples, guardReason: guardReason)
    }
    /// A spent ID whose full receipt was dropped answers `receipt-evicted`, never absent: it was settled and is never resent.
    public func receipt(_ id: String, caller: ControlCaller, owner: ControlOwner, requestId: String) throws -> Receipt? {
        let current = try access(id, caller: caller, owner: owner, allowHalted: true)
        if let receipt = current.receipts[requestId] { return receipt }
        if current.spent.contains(requestId) { throw ControlError.refuse("receipt-evicted") }
        return nil
    }
    public func stop() { if var current = grant { current.halted = true; current.snapshotId = nil; grant = current } }
    @discardableResult public func revoke(_ id: String, caller: ControlCaller, owner: ControlOwner) throws -> Bool {
        prune(); guard let current = grant else { return false }
        guard current.id == id, current.caller == caller, current.owner == owner else { throw ControlError("grant-unknown") }
        grant = nil; return true
    }
    public func end(owner: ControlOwner, sessionId: String? = nil) {
        for (id, entry) in approvals where entry.owner == owner && (sessionId == nil || entry.caller.sessionId == sessionId!) && [.pending, .approved].contains(entry.state) {
            var current = entry; current.state = .cancelled; current.signed = nil; current.decidedAt = now(); approvals[id] = current
        }
        if let current = grant, current.owner == owner, sessionId == nil || current.caller.sessionId == sessionId { grant = nil }
    }
}
