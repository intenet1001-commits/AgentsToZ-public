import Darwin
import Foundation
import RuntimeBrokerProtocol
import Security

private enum FixtureExit: Int32 {
    case invalidInvocation = 64
    case workerRejected = 65
    case workerUnavailable = 66
    case randomFailure = 70
    case workerLaunchFailure = 71
    case workerTimeout = 72
    case workerOutputRejected = 73
    case proofFailure = 74
}

private func fail(_ message: StaticString, _ code: FixtureExit) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code.rawValue)
}

private final class BoundedPipeCollector: @unchecked Sendable {
    private let lock = NSLock()
    private let endOfFile = DispatchSemaphore(value: 0)
    private var data = Data()
    private var overflowed = false
    private var finished = false

    func consume(_ next: Data) {
        lock.lock()
        defer { lock.unlock() }
        if next.isEmpty {
            if !finished {
                finished = true
                endOfFile.signal()
            }
            return
        }
        let remaining = RuntimeBrokerContract.maximumWireBytes + 1 - data.count
        if remaining > 0 {
            data.append(next.prefix(remaining))
        }
        if next.count > remaining || data.count > RuntimeBrokerContract.maximumWireBytes {
            overflowed = true
        }
    }

    func waitForEndOfFile() {
        _ = endOfFile.wait(timeout: .now() + .milliseconds(500))
    }

    func snapshot() -> (data: Data, overflowed: Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (data, overflowed)
    }
}

private func verifiedSiblingWorkerURL() -> URL? {
    let brokerURL = URL(fileURLWithPath: CommandLine.arguments[0])
        .standardizedFileURL
        .resolvingSymlinksInPath()
    let workerURL = brokerURL.deletingLastPathComponent()
        .appendingPathComponent(RuntimeBrokerContract.workerFixtureExecutableName)
    var metadata = stat()
    let status = workerURL.path.withCString { path in
        lstat(path, &metadata)
    }
    guard status == 0,
          metadata.st_uid == geteuid(),
          metadata.st_nlink == 1,
          (metadata.st_mode & S_IFMT) == S_IFREG,
          (metadata.st_mode & 0o111) != 0,
          (metadata.st_mode & 0o6022) == 0 else {
        return nil
    }
    return workerURL
}

private func randomChallenge() -> Data? {
    var bytes = [UInt8](
        repeating: 0,
        count: RuntimeBrokerContract.challengeByteCount
    )
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        return nil
    }
    return Data(bytes)
}

private func runWorker(
    workerURL: URL,
    request: Data
) -> (status: Int32, stdout: Data, stderr: Data)? {
    let process = Process()
    let inputPipe = Pipe()
    let outputPipe = Pipe()
    let errorPipe = Pipe()
    let outputCollector = BoundedPipeCollector()
    let errorCollector = BoundedPipeCollector()
    let terminated = DispatchSemaphore(value: 0)

    process.executableURL = workerURL
    process.arguments = [RuntimeBrokerContract.workerFixtureFlag]
    process.currentDirectoryURL = workerURL.deletingLastPathComponent()
    process.environment = [
        "LANG": "C",
        "LC_ALL": "C",
        "PATH": "/usr/bin:/bin",
    ]
    process.standardInput = inputPipe
    process.standardOutput = outputPipe
    process.standardError = errorPipe
    process.terminationHandler = { _ in terminated.signal() }
    outputPipe.fileHandleForReading.readabilityHandler = { handle in
        outputCollector.consume(handle.availableData)
    }
    errorPipe.fileHandleForReading.readabilityHandler = { handle in
        errorCollector.consume(handle.availableData)
    }

    do {
        try process.run()
    } catch {
        outputPipe.fileHandleForReading.readabilityHandler = nil
        errorPipe.fileHandleForReading.readabilityHandler = nil
        return nil
    }

    var wireRequest = request
    wireRequest.append(0x0A)
    do {
        try inputPipe.fileHandleForWriting.write(contentsOf: wireRequest)
        try inputPipe.fileHandleForWriting.close()
    } catch {
        process.terminate()
    }

    if terminated.wait(timeout: .now() + .seconds(3)) == .timedOut {
        process.terminate()
        if terminated.wait(timeout: .now() + .milliseconds(250)) == .timedOut {
            let childPID = process.processIdentifier
            if childPID > 1 {
                _ = kill(childPID, SIGKILL)
            }
            _ = terminated.wait(timeout: .now() + .seconds(1))
        }
        outputPipe.fileHandleForReading.readabilityHandler = nil
        errorPipe.fileHandleForReading.readabilityHandler = nil
        fail("runtime-broker-fixture: worker timeout", .workerTimeout)
    }

    outputCollector.waitForEndOfFile()
    errorCollector.waitForEndOfFile()
    outputPipe.fileHandleForReading.readabilityHandler = nil
    errorPipe.fileHandleForReading.readabilityHandler = nil
    let output = outputCollector.snapshot()
    let error = errorCollector.snapshot()
    guard !output.overflowed, !error.overflowed else {
        fail("runtime-broker-fixture: worker output rejected", .workerOutputRejected)
    }
    return (process.terminationStatus, output.data, error.data)
}

private func singleJSONLine(_ data: Data) -> Data? {
    guard data.last == 0x0A,
          data.dropLast().last != 0x0A,
          !data.dropLast().contains(0x0A) else {
        return nil
    }
    return Data(data.dropLast())
}

@main
private struct RuntimeBrokerFixtureMain {
    static func main() {
        guard CommandLine.arguments.count == 2,
              CommandLine.arguments[1] == RuntimeBrokerContract.fixtureFlag else {
            fail("runtime-broker-fixture: invalid invocation", .invalidInvocation)
        }
        guard let workerURL = verifiedSiblingWorkerURL() else {
            fail("runtime-broker-fixture: worker unavailable", .workerUnavailable)
        }
        guard let challenge = randomChallenge() else {
            fail("runtime-broker-fixture: random source failed", .randomFailure)
        }

        let request: RuntimeBrokerFixtureRequest
        let encodedRequest: Data
        do {
            request = try RuntimeBrokerFixtureRequest(challenge: challenge)
            encodedRequest = try RuntimeBrokerFixtureEnvelope.encodeRequest(request)
        } catch {
            fail("runtime-broker-fixture: request construction failed", .proofFailure)
        }

        guard let result = runWorker(workerURL: workerURL, request: encodedRequest) else {
            fail("runtime-broker-fixture: worker launch failed", .workerLaunchFailure)
        }
        guard result.status == 0,
              result.stderr.isEmpty,
              let responseLine = singleJSONLine(result.stdout) else {
            fail("runtime-broker-fixture: worker rejected", .workerRejected)
        }

        let response: RuntimeBrokerFixtureResponse
        do {
            response = try RuntimeBrokerFixtureEnvelope.decodeResponse(responseLine)
        } catch {
            fail("runtime-broker-fixture: worker response rejected", .workerOutputRejected)
        }
        guard response.challenge == challenge,
              response.effectiveUserIdentifier == geteuid(),
              response.effectiveGroupIdentifier == getegid() else {
            fail("runtime-broker-fixture: worker identity rejected", .workerRejected)
        }

        do {
            var proof = try RuntimeBrokerFixtureEnvelope.encodePublicProof()
            proof.append(0x0A)
            try FileHandle.standardOutput.write(contentsOf: proof)
        } catch {
            fail("runtime-broker-fixture: proof output failed", .proofFailure)
        }
    }
}
