import ComputerUseApproval
import Foundation

// Lab only, never shipped. Two read-only checks:
//   (stdin JSON)                         signs one approval payload with a fresh in-memory key and prints what the
//                                        host would receive, to check the TypeScript verifier against Swift.
//   --requirement <bundle> <identifier> [team]
//                                        statically checks an installed bundle's signature against the helper
//                                        connection requirement format (no launch, no change).
// It shows no UI and proves nothing about a person; the signed helper with its Secure Enclave key does that.
let arguments = CommandLine.arguments
if arguments.count >= 4, arguments[1] == "--requirement" {
    let requirement = HelperSigning.requirement(identifier: arguments[3], team: arguments.count > 4 ? arguments[4] : HelperSigning.team)
    let ok = HelperSigning.bundle(at: URL(fileURLWithPath: arguments[2]), satisfies: requirement)
    print(ok ? "satisfied" : "not-satisfied")
    exit(ok ? 0 : 3)
}
let input = FileHandle.standardInput.readDataToEndOfFile()
do {
    let payload = try JSONDecoder().decode(ApprovalPayload.self, from: input)
    let key = try ComputerUseApproval.makeEphemeralLabKey()
    let out: [String: String] = [
        "publicKey": try ComputerUseApproval.publicPoint(of: key).base64EncodedString(),
        "signature": try ComputerUseApproval.sign(payload, with: key).base64EncodedString(),
        "bytes": try ComputerUseApproval.bytes(payload).base64EncodedString()]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]))
    FileHandle.standardOutput.write(Data([10]))
} catch {
    FileHandle.standardError.write(Data("approval-lab: \(error)\n".utf8))
    exit(1)
}
