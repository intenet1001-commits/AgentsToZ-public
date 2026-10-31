/// Synchronous registry mutation: read the current document, persist the complete replacement, then
/// return the value that a UI/handshake cache may publish. A tolerant display snapshot is never a write base.
/// Callers serialize this at their owner (the Mac service and iOS views both use MainActor).
public func persistRegistrationMutation<Row>(
    read: () throws -> [Row], write: ([Row]) throws -> Void,
    update: (inout [Row]) -> Void
) throws -> [Row] {
    var rows = try read()
    update(&rows)
    try write(rows)
    return rows
}
