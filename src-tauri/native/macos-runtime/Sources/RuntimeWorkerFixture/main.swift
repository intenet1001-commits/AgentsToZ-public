import Darwin
import Foundation
import RuntimeBrokerProtocol

private enum WorkerExit: Int32 {
    case invalidInvocation = 64
    case malformedRequest = 65
    case inputFailure = 74
    case outputFailure = 75
}

private func fail(_ message: StaticString, _ code: WorkerExit) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code.rawValue)
}

private func readBoundedInput() throws -> Data {
    var result = Data()
    while true {
        let remaining = RuntimeBrokerContract.maximumWireBytes + 1 - result.count
        guard remaining > 0 else {
            throw RuntimeBrokerFixtureEnvelopeError.oversized
        }
        let next = try FileHandle.standardInput.read(upToCount: min(remaining, 1_024)) ?? Data()
        if next.isEmpty {
            break
        }
        result.append(next)
        if result.count > RuntimeBrokerContract.maximumWireBytes {
            throw RuntimeBrokerFixtureEnvelopeError.oversized
        }
    }
    guard result.last == 0x0A,
          result.dropLast().last != 0x0A else {
        throw RuntimeBrokerFixtureEnvelopeError.malformed
    }
    result.removeLast()
    return result
}

@main
private struct RuntimeWorkerFixtureMain {
    static func main() {
        guard CommandLine.arguments.count == 2,
              CommandLine.arguments[1] == RuntimeBrokerContract.workerFixtureFlag else {
            fail("runtime-worker-fixture: invalid invocation", .invalidInvocation)
        }

        let input: Data
        do {
            input = try readBoundedInput()
        } catch {
            fail("runtime-worker-fixture: input rejected", .inputFailure)
        }

        let request: RuntimeBrokerFixtureRequest
        do {
            request = try RuntimeBrokerFixtureEnvelope.decodeRequest(input)
        } catch {
            fail("runtime-worker-fixture: request rejected", .malformedRequest)
        }

        do {
            var response = try RuntimeBrokerFixtureEnvelope.encodeResponse(
                request: request,
                effectiveUserIdentifier: geteuid(),
                effectiveGroupIdentifier: getegid()
            )
            response.append(0x0A)
            try FileHandle.standardOutput.write(contentsOf: response)
        } catch {
            fail("runtime-worker-fixture: output failed", .outputFailure)
        }
    }
}
