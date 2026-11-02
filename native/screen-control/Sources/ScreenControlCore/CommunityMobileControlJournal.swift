import Foundation

public protocol CommunityMobileControlJournalBackend: Sendable {
    func read() throws -> Data?
    func write(_ bytes: Data) throws
}
public final class CommunityMobileControlJournal: @unchecked Sendable {
    public enum Phase: String, Codable, Sendable { case prepared, unknown, accepted, consumed }
    public struct Record: Codable, Sendable, Identifiable {
        public var id: String { operation.operationId }
        public let operation: CommunityMobileControlOperation, purpose: CommunityMobileControlPurpose
        public let ownerHash: String, targetDeviceID: String, targetEnrollmentID: String, targetName: String, commandDigest: String
        public fileprivate(set) var phase: Phase, result: Data?, resultDigest: String?
    }
    private struct State: Codable { var version = 1; var records: [Record] = [] }
    private let backend: any CommunityMobileControlJournalBackend
    private let lock = NSLock()
    public static let maximumRecords = 64, maximumBytes = 2_000_000
    public init(backend: any CommunityMobileControlJournalBackend) { self.backend = backend }
    private func read() throws -> State {
        guard let bytes = try backend.read() else { return State() }
        let object = try CommunityMobileControlJSON.object(bytes, maximum: Self.maximumBytes)
        guard Set(object.keys) == ["version","records"] else { throw ScreenCommunityError.malformed }
        let state = try JSONDecoder().decode(State.self, from: bytes)
        guard state.version == 1, state.records.count <= Self.maximumRecords, Set(state.records.map(\.id)).count == state.records.count else { throw ScreenCommunityError.malformed }
        for record in state.records {
            try record.operation.validate()
            guard CommunityMobileControlBytes.id(record.targetDeviceID), CommunityMobileControlBytes.id(record.targetEnrollmentID), CommunityAccessName.isValid(record.targetName),
                  [record.ownerHash,record.commandDigest].allSatisfy({ $0.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil }) else { throw ScreenCommunityError.malformed }
            if let result = record.result {
                guard result.count <= 16_000, record.resultDigest == CommunityMobileControlBytes.hex(CommunityMobileControlBytes.hash(result)) else { throw ScreenCommunityError.malformed }
            } else if record.resultDigest != nil || record.phase == .accepted || record.phase == .consumed { throw ScreenCommunityError.malformed }
        }
        return state
    }
    private func save(_ state: State) throws {
        let bytes = try JSONEncoder().encode(state); guard bytes.count <= Self.maximumBytes else { throw ScreenCommunityError.service("CONTROL_JOURNAL_FULL") }; try backend.write(bytes)
    }
    public func records(ownerHash: String) throws -> [Record] { try lock.withLock { try read().records.filter { $0.ownerHash == ownerHash } } }
    /// Fails before dispatch on a previous ID or unavailable store. Existing unknown operations are never prepared again.
    public func prepare(operation: CommunityMobileControlOperation, context: CommunityMobileControlContext, command: Data) throws -> Record {
        try operation.validate(); _ = try CommunityMobileControlJSON.object(command, maximum:20_000)
        let owner = try CommunityMobileControlPolicy.receiptOwner(context.mobile), digest = CommunityMobileControlBytes.hex(CommunityMobileControlBytes.hash(command))
        return try lock.withLock {
            var state = try read(); guard !state.records.contains(where: { $0.id == operation.operationId }) else { throw ScreenCommunityError.service("CONTROL_RECEIPT_REQUIRED") }
            guard state.records.count < Self.maximumRecords else { throw ScreenCommunityError.service("CONTROL_JOURNAL_FULL") }
            let record = Record(operation:operation,purpose:context.purpose,ownerHash:owner,targetDeviceID:context.receiver.body.deviceId,targetEnrollmentID:context.receiver.body.enrollmentId,targetName:context.receiver.body.name,commandDigest:digest,phase:.prepared,result:nil,resultDigest:nil)
            state.records.append(record); try save(state); return record
        }
    }
    private func update(_ id: String, owner: String, change: (inout Record) throws -> Void) throws {
        try lock.withLock {
            var state = try read(); guard let index = state.records.firstIndex(where: { $0.id == id && $0.ownerHash == owner }) else { throw ScreenCommunityError.wrongRequest }
            try change(&state.records[index]); try save(state)
        }
    }
    public func markUnknown(_ id: String, ownerHash: String) throws {
        try update(id,owner:ownerHash) { if $0.phase == .prepared { $0.phase = .unknown } }
    }
    /// Only a strictly decoded purpose-specific terminal result may be accepted/consumed. Pending stays unknown.
    public func receive(_ id: String, ownerHash: String, response: CommunityMobileControlResponse, terminal: Bool) throws {
        try update(id,owner:ownerHash) { record in
            if record.phase == .accepted || record.phase == .consumed { guard record.resultDigest == response.resultDigest else { throw ScreenCommunityError.wrongRequest }; return }
            record.result = response.result; record.resultDigest = response.resultDigest; record.phase = terminal ? .accepted : .unknown
        }
    }
    public func markConsumed(_ id: String, ownerHash: String, resultDigest: String) throws {
        try update(id,owner:ownerHash) { record in
            guard record.phase == .accepted || record.phase == .consumed, record.resultDigest == resultDigest else { throw ScreenCommunityError.wrongRequest }; record.phase = .consumed
        }
    }
    /// Explicit local cleanup only; unfinished/unknown operations cannot be forgotten to make room.
    public func forgetConsumed(_ id: String, ownerHash: String) throws {
        try lock.withLock {
            var state = try read(); guard let index = state.records.firstIndex(where: { $0.id == id && $0.ownerHash == ownerHash && $0.phase == .consumed }) else { throw ScreenCommunityError.wrongRequest }
            state.records.remove(at:index); try save(state)
        }
    }
}
