import ComputerUseApproval
import ComputerUseControlCore
import ComputerUseEngine
import Foundation

// Lab and test transport only (src/computerUseWorker.ts refuses to start it inside the bundled app): private
// inherited pipes, one JSON request per line, one bounded answer. Production runs the same engine inside
// AgentsToZ Control's own process (Sources/AgentsToZControl), never this executable.
@MainActor
final class LabWorker {
    var session: TargetSession?
    var halted: Bool { session?.halted ?? false }

    func handle(_ request: [String: Any]) async throws -> [String: Any] {
        guard let op = request["operation"] as? String else { throw ControlError.invalid }
        switch op {
        case "status":
            guard Set(request.keys) == ["operation"] else { throw ControlError.invalid }
            return ["backgroundOnly": true, "accessibility": ComputerUseEngine.accessibilityTrusted,
                    "secureInput": ComputerUseEngine.secureInput, "protocolVersion": ControlContract.workerProtocol]
        case "catalog":
            guard Set(request.keys) == ["operation"] else { throw ControlError.invalid }
            return ["windows": ComputerUseEngine.catalog()]
        case "bind":
            guard session == nil, Set(request.keys) == ["operation", "target"],
                  let raw = request["target"], JSONSerialization.isValidJSONObject(raw) else { throw ControlError.invalid }
            let t = try JSONDecoder().decode(ApprovalTarget.self, from: JSONSerialization.data(withJSONObject: raw))
            guard try ComputerUseEngine.identity(pid: t.pid, window: t.windowId) == t else { throw ControlError("target-changed") }
            let bound = TargetSession(target: t)
            try bound.validate()
            session = bound
            return ["bound": true, "protocolVersion": ControlContract.workerProtocol]
        case "observe":
            guard Set(request.keys) == ["operation"] else { throw ControlError.invalid }
            guard let session else { throw ControlError("target-not-bound") }
            return try await session.observe()
        case "press", "set-value":
            // `requestId`: the host's ledger ID, sent since the Control contract; validated, unused in the lab.
            let base: Set<String> = op == "press" ? ["operation", "snapshotId", "element"] : ["operation", "snapshotId", "element", "value"]
            let keys = Set(request.keys)
            guard keys == base || keys == base.union(["requestId"]),
                  request["requestId"] == nil || ControlRequest.requestId(request["requestId"]) != nil,
                  let id = request["snapshotId"] as? String, let key = request["element"] as? String else {
                throw ControlError.refuse("stale-observation")
            }
            guard let session else { throw ControlError.refuse("stale-observation") }
            return try await session.perform(op, snapshotId: id, element: key, value: request["value"] as? String)
        case "capture", "click":
            // No screen-image consent or capture binding exists here (the host also refuses these up front for a lab
            // worker). Nothing is read or sent, so this is a refusal, never an outcome-unknown click.
            throw ControlError.refuse("lab-worker-unsupported")
        // Nothing was read or dispatched for an operation this transport does not know.
        default: throw ControlError.refuse("unsupported-operation")
        }
    }
}

@main struct Main {
    @MainActor static func main() async {
        let worker = LabWorker()
        while let line = await Task.detached(operation: { readLine(strippingNewline: true) }).value {
            var response: [String: Any]
            do {
                guard line.utf8.count <= 32_000, let data = line.data(using: .utf8),
                      let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ControlError.invalid }
                response = try await worker.handle(request); response["success"] = true
            } catch {
                // Do not echo raw AX errors, text, credentials, paths or observation data into logs.
                let failure = error as? ControlError
                response = ["success": false, "code": failure?.code ?? "native-operation-unconfirmed",
                            "notDispatched": failure?.notDispatched == true]
                if let retry = failure?.retryAfterMs { response["retryAfterMs"] = retry }
            }
            response["halted"] = worker.halted
            guard let bytes = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
                  bytes.count <= ControlLimits.responseBytes else { break }
            FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
        }
    }
}
