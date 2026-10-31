import Foundation
#if !CORE_CHECKS
import ComputerUseApproval
#endif

public enum ApprovalState: String, Sendable { case pending, approved, consumed, denied, cancelled, expired }

/// What the person signed in Control's own window, as the host verifies it (src/computerUseApproval.ts).
public struct SignedApproval: Equatable, Sendable {
    public let payload: ApprovalPayload
    public let signature: Data
    /// The 65-byte X9.63 public point of the approval key, delivered over the verified connection only.
    public let publicKey: Data
    public init(payload: ApprovalPayload, signature: Data, publicKey: Data) {
        self.payload = payload; self.signature = signature; self.publicKey = publicKey
    }
    public var json: [String: Any] {
        ["approvalId": payload.approvalId, "target": ControlResponse.target(payload.target),
         "caller": ["sessionId": payload.caller.sessionId, "lane": payload.caller.lane],
         "issuedAt": payload.issuedAt, "expiresAt": payload.expiresAt, "signature": signature.base64EncodedString()]
    }
}

public struct ApprovalEntry: Sendable {
    public let approvalId: String
    public let target: ApprovalTarget
    public let caller: ControlCaller
    public let label: String
    public let expiresAt: Int64
    public let owner: ControlOwner
    public internal(set) var state: ApprovalState = .pending
    public internal(set) var decidedAt: Int64?
    public internal(set) var signed: SignedApproval?
    public internal(set) var screenAccessApproved = false
}

public enum ReceiptState: String, Sendable {
    case unknown, confirmed, refused
    case dispatchedUnverified = "dispatched-unverified"
    case humanTakeover = "human-takeover"
}
public struct Receipt: Equatable, Sendable {
    public let requestId: String
    public let state: ReceiptState
    public let reason: String?
    /// v2 only: bounded guard readings around the action (ScopedGuardSamples). Never evidence of who caused an event.
    public var guardSamples: ScopedGuardSamples? = nil
    /// v2 refused only: the native guard check that refused it (a code, never a message), beside the generic `reason`.
    public var guardReason: String? = nil
    public var json: [String: Any] {
        var out: [String: Any] = ["requestId": requestId, "state": state.rawValue]
        if let reason { out["reason"] = reason }
        if let guardReason { out["guardReason"] = guardReason }
        if let guardSamples { out["guardSamples"] = guardSamples.json }
        return out
    }
}

/// The app process a target lives in. Windows of one process share state (focus, menus, documents), so
/// observations and changes are ordered per process, whatever window a grant captured.
public struct ProcessKey: Hashable, Sendable {
    public let pid: Int32
    public let processStart: String
}

public struct GrantEntry: Sendable {
    public let id: String
    public let approvalId: String
    public let target: ApprovalTarget
    public let caller: ControlCaller
    public let label: String
    public let owner: ControlOwner
    public let expiresAt: Int64
    public let screenAccessApproved: Bool
    public internal(set) var haltReason: String?
    struct Observation: Sendable { let snapshotId: String; let revision: UInt64; let at: Int64 }
    var observation: Observation?
    var receipts: [String: Receipt] = [:]
    public var halted: Bool { haltReason != nil }
    public var process: ProcessKey { ProcessKey(pid: target.pid, processStart: target.processStart) }
}

public struct MutationTicket: Equatable, Sendable {
    public let grantId: String
    public let requestId: String
    public let process: ProcessKey
}
public struct CaptureTicket: Sendable {
    let grantId: String
    let process: ProcessKey
    let snapshotId: String
    let revision: UInt64
}

public enum MutationResult: Equatable, Sendable {
    case refused(String), confirmed, dispatchedUnverified, unknown, humanTakeover
}

/// Approval requests, grants, receipts and the per-process observation order of AgentsToZ Control. Pure and
/// synchronous; the app calls it on the main actor. Nothing here dispatches input, shows UI or touches the keychain.
///
/// - A request waits at most 10 min; at most 8 wait at once. Decided ones stay readable for 120 s, to their owner only.
/// - Approving (Control's window only) records the person's signature; no grant exists yet. `open-grant` turns that one
///   approval, before it expires, into one grant for the same main-app process generation, caller credential (session,
///   lane, generation) and exact target. It lives 10 min; at most 8 exist.
/// - Ending the session (`revoke-session`), the sidecar channel (`disconnect-owner`) or the main app's process
///   generation (quit, restart, reused PID) ends its requests and grants. XPC connections may be per request, so a
///   closed connection ends nothing by itself.
/// - One observation allows one attempt. A change to a process makes every other observation of it stale, and
///   changes to one process run one at a time; other processes stay independent.
/// - Receipts are never replayed: a known request ID is refused, an unknown or taken-over result stops the grant.
public final class ControlState {
    private let now: () -> Int64
    private let newId: () -> String
    private let ownerAlive: (ControlOwner) -> Bool
    public private(set) var approvals: [String: ApprovalEntry] = [:]
    public private(set) var grants: [String: GrantEntry] = [:]
    private var revisions: [ProcessKey: UInt64] = [:]
    private var busy: Set<ProcessKey> = []

    public init(now: @escaping () -> Int64, newId: @escaping () -> String = ControlState.randomId,
                ownerAlive: @escaping (ControlOwner) -> Bool = ProcessGeneration.alive) {
        self.now = now; self.newId = newId; self.ownerAlive = ownerAlive
    }
    public static func randomId() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
    }

    /// Expires waiting requests and unused approvals, forgets old decisions, and removes expired grants and everything
    /// of a main-app process generation that is gone.
    public func prune() {
        let t = now()
        var owners: [ControlOwner: Bool] = [:]
        func alive(_ owner: ControlOwner) -> Bool {
            if let known = owners[owner] { return known }
            let value = ownerAlive(owner); owners[owner] = value; return value
        }
        for (id, entry) in approvals {
            var e = entry
            if [.pending, .approved].contains(e.state), !alive(e.owner) {
                e.state = .cancelled; e.decidedAt = t; e.signed = nil
            } else if [.pending, .approved].contains(e.state), t > e.expiresAt {
                e.state = .expired; e.decidedAt = t; e.signed = nil
            } else if ![.pending, .approved].contains(e.state), let decided = e.decidedAt, t - decided > ControlLimits.decidedRetentionMs {
                approvals[id] = nil; continue
            }
            approvals[id] = e
        }
        for (id, grant) in grants where t >= grant.expiresAt || !alive(grant.owner) { grants[id] = nil }
    }
    public var pending: [ApprovalEntry] { approvals.values.filter { $0.state == .pending }.sorted { $0.expiresAt < $1.expiresAt } }
    public var active: [GrantEntry] { grants.values.sorted { $0.expiresAt < $1.expiresAt } }

    // MARK: Agent path (XPC)

    public func submit(approvalId: String, target: ApprovalTarget, caller: ControlCaller, label: String,
                       expiresAt: Int64, owner: ControlOwner) throws {
        prune()
        guard approvals[approvalId] == nil else { throw ControlError.invalid }
        guard !RefusedTargets.refuses(target) else { throw ControlError("target-refused") }
        let t = now()
        guard expiresAt > t, expiresAt <= t + ControlLimits.approvalMs + ControlLimits.skewMs else { throw ControlError("approval-expired") }
        guard pending.count < ControlLimits.pendingApprovals else { throw ControlError("approval-limit") }
        approvals[approvalId] = ApprovalEntry(approvalId: approvalId, target: target, caller: caller, label: label,
                                              expiresAt: expiresAt, owner: owner)
    }
    /// The request as its own owner and caller see it; anyone else learns nothing.
    public func entry(_ approvalId: String, caller: ControlCaller, owner: ControlOwner) -> ApprovalEntry? {
        prune()
        guard let e = approvals[approvalId], e.owner == owner, e.caller == caller else { return nil }
        return e
    }
    /// The checks of `openGrant` without using anything up, so the caller can validate the engine before the one-use
    /// approval is consumed.
    public func checkOpen(_ approvalId: String, caller: ControlCaller, target: ApprovalTarget, owner: ControlOwner) throws {
        prune()
        guard let e = approvals[approvalId], e.state == .approved, e.owner == owner, e.caller == caller else {
            throw ControlError("approval-unknown")
        }
        guard e.target == target else { throw ControlError("target-changed") }
        guard grants.count < ControlLimits.grants else { throw ControlError("grant-limit") }
    }
    /// One use: an approved, unexpired approval of the same owner, caller credential and exact target becomes a grant.
    public func openGrant(_ approvalId: String, caller: ControlCaller, target: ApprovalTarget, owner: ControlOwner) throws -> GrantEntry {
        try checkOpen(approvalId, caller: caller, target: target, owner: owner)
        guard var e = approvals[approvalId] else { throw ControlError("approval-unknown") }
        let grant = GrantEntry(id: newId(), approvalId: approvalId, target: e.target, caller: e.caller, label: e.label,
                               owner: owner, expiresAt: now() + ControlLimits.grantMs, screenAccessApproved: e.screenAccessApproved)
        grants[grant.id] = grant
        e.state = .consumed; e.decidedAt = now(); e.signed = nil
        approvals[approvalId] = e
        return grant
    }
    /// A grant of this owner and caller credential. Unknown and someone else's grants get the same answer.
    public func access(_ grantId: String, caller: ControlCaller, owner: ControlOwner, allowHalted: Bool = false) throws -> GrantEntry {
        prune()
        guard let g = grants[grantId], g.owner == owner, g.caller == caller else { throw ControlError("grant-unknown") }
        guard allowHalted || !g.halted else { throw ControlError("worker-halted") }
        return g
    }
    /// The Workroom session ended: its waiting and approved requests are cancelled and its grants removed, within
    /// the requesting main process generation only.
    @discardableResult public func revokeSession(_ sessionId: String, owner: ControlOwner) -> (revoked: [String], cancelled: Int) {
        end(owner) { $0.sessionId == sessionId }
    }
    /// Revocation only: the main app's sidecar channel ended. Every request and grant of this main process
    /// generation ends; other generations and anything this owner did not hold are untouched.
    @discardableResult public func disconnectOwner(_ owner: ControlOwner) -> (revoked: [String], cancelled: Int) {
        end(owner) { _ in true }
    }
    private func end(_ owner: ControlOwner, _ matches: (ControlCaller) -> Bool) -> (revoked: [String], cancelled: Int) {
        var cancelled = 0
        for (id, entry) in approvals where [.pending, .approved].contains(entry.state) && entry.owner == owner && matches(entry.caller) {
            var e = entry; e.state = .cancelled; e.decidedAt = now(); e.signed = nil; approvals[id] = e; cancelled += 1
        }
        let revoked = grants.values.filter { $0.owner == owner && matches($0.caller) }.map(\.id).sorted()
        for id in revoked { grants[id] = nil }
        return (revoked, cancelled)
    }
    /// A person withdraws a waiting or approved-but-unopened request of this main process generation.
    @discardableResult public func cancel(_ approvalId: String, owner: ControlOwner) -> Bool {
        prune()
        guard var e = approvals[approvalId], e.owner == owner, [.pending, .approved].contains(e.state) else { return false }
        e.state = .cancelled; e.decidedAt = now(); e.signed = nil; approvals[approvalId] = e
        return true
    }
    /// The requests of one main process generation for its own UI, newest deadline last.
    public func approvals(of owner: ControlOwner) -> [ApprovalEntry] {
        prune()
        return approvals.values.filter { $0.owner == owner }.sorted { ($0.expiresAt, $0.approvalId) < ($1.expiresAt, $1.approvalId) }
    }
    /// Revocation is idempotent after expiry or helper restart. A live grant of another caller/owner still refuses.
    /// The unknown case reveals no existence and never removes anything belonging to another session.
    @discardableResult public func revoke(_ grantId: String, caller: ControlCaller, owner: ControlOwner) throws -> Bool {
        prune()
        guard let grant = grants[grantId] else { return false }
        guard grant.owner == owner, grant.caller == caller else { throw ControlError("grant-unknown") }
        grants[grantId] = nil
        return true
    }
    public func remove(_ grantId: String) { grants[grantId] = nil }

    // MARK: The person's decisions (Control's own window only; never reachable over XPC)

    /// Records the person's signed approval. The signature itself is made by the window after LocalAuthentication;
    /// this only checks it answers exactly this request. No grant exists until the main app opens it.
    public func approve(_ approvalId: String, signed: SignedApproval, screenAccessApproved: Bool = false) throws {
        prune()
        guard var e = approvals[approvalId], e.state == .pending else { throw ControlError("approval-unknown") }
        guard now() <= e.expiresAt else { throw ControlError("approval-expired") }
        let p = signed.payload
        guard p.approvalId == approvalId, p.target == e.target, p.caller == e.caller.approvalCaller, p.expiresAt == e.expiresAt,
              signed.publicKey.count == 65, !signed.signature.isEmpty else { throw ControlError.invalid }
        // Say so now rather than after the person approved something that cannot open.
        guard grants.count < ControlLimits.grants else { throw ControlError("grant-limit") }
        e.state = .approved; e.decidedAt = now(); e.signed = signed; e.screenAccessApproved = screenAccessApproved
        approvals[approvalId] = e
    }
    public func deny(_ approvalId: String) {
        guard var e = approvals[approvalId], e.state == .pending else { return }
        e.state = .denied; e.decidedAt = now(); approvals[approvalId] = e
    }
    /// The person stops one grant or all of them; the main app sees `halted` on its next request.
    public func halt(_ grantId: String, reason: String) {
        guard var g = grants[grantId], g.haltReason == nil else { return }
        g.haltReason = reason; g.observation = nil; grants[grantId] = g
    }
    @discardableResult public func stopAll() -> Int {
        let ids = grants.values.filter { !$0.halted }.map(\.id)
        for id in ids { halt(id, reason: "human-stop") }
        return ids.count
    }

    // MARK: Observation and change order (per process)

    /// Starts an observation and returns the process revision it reads at. Replaces the grant's last observation.
    public func beginObservation(_ grantId: String) throws -> UInt64 {
        guard var g = grants[grantId], !g.halted else { throw ControlError("worker-halted") }
        g.observation = nil; grants[grantId] = g
        guard !busy.contains(g.process) else { throw ControlError.refuse("process-busy") }
        return revisions[g.process, default: 0]
    }
    /// Keeps the observation only if nothing changed the process meanwhile.
    public func finishObservation(_ grantId: String, snapshotId: String, revision: UInt64) throws {
        guard var g = grants[grantId], !g.halted else { throw ControlError("worker-halted") }
        guard revisions[g.process, default: 0] == revision, !busy.contains(g.process) else { throw ControlError("observation-discarded") }
        g.observation = GrantEntry.Observation(snapshotId: snapshotId, revision: revision, at: now())
        grants[grantId] = g
    }
    /// Capture is read-only but holds the process lane during asynchronous image production.
    /// It does not consume the observation; a later mutation consumes it as usual.
    public func beginCapture(_ grantId: String, snapshotId: String) throws -> CaptureTicket {
        guard let g = grants[grantId], !g.halted else { throw ControlError.refuse("worker-halted") }
        guard g.screenAccessApproved else { throw ControlError.refuse("screen-consent-required") }
        guard let observation = g.observation, observation.snapshotId == snapshotId,
              now() - observation.at <= ControlLimits.observationMs,
              observation.revision == revisions[g.process, default: 0] else { throw ControlError.refuse("stale-observation") }
        guard !busy.contains(g.process) else { throw ControlError.refuse("process-busy") }
        busy.insert(g.process)
        return CaptureTicket(grantId: grantId, process: g.process, snapshotId: snapshotId, revision: observation.revision)
    }
    public func cancelCapture(_ ticket: CaptureTicket) { busy.remove(ticket.process) }
    public func finishCapture(_ ticket: CaptureTicket) throws {
        busy.remove(ticket.process)
        prune()
        guard let g = grants[ticket.grantId], !g.halted, g.process == ticket.process, g.screenAccessApproved,
              let observation = g.observation, observation.snapshotId == ticket.snapshotId,
              observation.revision == ticket.revision, revisions[g.process, default: 0] == ticket.revision,
              now() - observation.at <= ControlLimits.observationMs else { throw ControlError.refuse("observation-discarded") }
    }
    /// Admits one change. Consumes the observation first, so a refusal never leaves it reusable. On success the
    /// process is busy, its revision moves (every other observation of it is now stale) and the receipt is unknown
    /// until `finishMutation`.
    public func beginMutation(_ grantId: String, requestId: String, snapshotId: String) throws -> MutationTicket {
        guard var g = grants[grantId], !g.halted else { throw ControlError.refuse("worker-halted") }
        guard g.receipts[requestId] == nil else { throw ControlError.refuse("duplicate-request") }
        guard g.receipts.count < ControlLimits.receiptsPerGrant else { throw ControlError.refuse("receipt-limit") }
        let observation = g.observation
        g.observation = nil; grants[grantId] = g
        guard let observation, observation.snapshotId == snapshotId, now() - observation.at <= ControlLimits.observationMs,
              observation.revision == revisions[g.process, default: 0] else { throw ControlError.refuse("stale-observation") }
        guard !busy.contains(g.process) else { throw ControlError.refuse("process-busy") }
        busy.insert(g.process)
        revisions[g.process, default: 0] &+= 1
        g.receipts[requestId] = Receipt(requestId: requestId, state: .unknown, reason: nil)
        grants[grantId] = g
        return MutationTicket(grantId: grantId, requestId: requestId, process: g.process)
    }
    /// Records what happened. An unknown or taken-over result stops the grant; nothing is retried. The process stays
    /// ordered even if the grant ended meanwhile.
    @discardableResult public func finishMutation(_ ticket: MutationTicket, _ result: MutationResult) -> Receipt {
        busy.remove(ticket.process)
        let receipt: Receipt = switch result {
        case .refused(let code): Receipt(requestId: ticket.requestId, state: .refused, reason: code)
        case .confirmed: Receipt(requestId: ticket.requestId, state: .confirmed, reason: nil)
        case .dispatchedUnverified: Receipt(requestId: ticket.requestId, state: .dispatchedUnverified, reason: nil)
        case .unknown: Receipt(requestId: ticket.requestId, state: .unknown, reason: nil)
        case .humanTakeover: Receipt(requestId: ticket.requestId, state: .humanTakeover, reason: nil)
        }
        guard var g = grants[ticket.grantId] else { return receipt }
        g.receipts[ticket.requestId] = receipt
        if result == .unknown, g.haltReason == nil { g.haltReason = "outcome-unknown" }
        if result == .humanTakeover, g.haltReason == nil { g.haltReason = "human-takeover" }
        grants[ticket.grantId] = g
        return receipt
    }
    public func receipt(_ grantId: String, requestId: String) -> Receipt? { grants[grantId]?.receipts[requestId] }
    public func isBusy(_ process: ProcessKey) -> Bool { busy.contains(process) }
}
