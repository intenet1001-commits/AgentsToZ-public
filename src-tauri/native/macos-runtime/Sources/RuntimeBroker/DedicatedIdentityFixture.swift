import Darwin
import Foundation
import RuntimeBrokerProtocol

private final class RuntimeBoundedPipeCollector: @unchecked Sendable {
    private let maximumBytes: Int
    private let lock = NSLock()
    private let endOfFile = DispatchSemaphore(value: 0)
    private var data = Data()
    private var overflowed = false
    private var finished = false

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
    }

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
        let remaining = maximumBytes + 1 - data.count
        if remaining > 0 { data.append(next.prefix(remaining)) }
        if next.count > remaining || data.count > maximumBytes { overflowed = true }
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

enum RuntimeDedicatedIdentityFixture {
    private static let maximumCommandBytes = 4_096
    private static let launchctlURL = URL(fileURLWithPath: "/bin/launchctl")

    private struct AccountIdentity {
        let userIdentifier: uid_t
        let groupIdentifier: gid_t
    }

    private struct CommandResult {
        let status: Int32
        let stdout: Data
        let stderr: Data
    }

    static func run(challenge: Data) -> Data? {
        guard challenge.count == RuntimeBrokerContract.challengeByteCount,
              geteuid() == 0,
              getegid() == 0,
              getppid() == 1,
              let identity = dedicatedIdentity(),
              prepareFixtureDirectory(),
              exactRootOwnedRegularFile(
                RuntimeBrokerContract.dedicatedWorkerFixturePlistPath,
                executable: false
              ),
              exactRootOwnedRegularFile(
                RuntimeBrokerContract.dedicatedWorkerFixtureExecutablePath,
                executable: true
              ),
              prepareFixtureFiles(challenge: challenge) else {
            return nil
        }
        defer { cleanupFixtureFiles() }

        let domain = "user/\(identity.userIdentifier)"
        let service = "\(domain)/\(RuntimeBrokerContract.dedicatedWorkerFixtureServiceLabel)"
        _ = runLaunchctl(["bootout", service], timeout: .seconds(3))
        // A headless account may not have a user domain yet. A failure here can
        // also mean the domain already exists, so the following exact service
        // bootstrap remains the authoritative outcome.
        _ = runLaunchctl(["bootstrap", domain], timeout: .seconds(3))
        guard let bootstrap = runLaunchctl([
            "bootstrap",
            domain,
            RuntimeBrokerContract.dedicatedWorkerFixturePlistPath,
        ], timeout: .seconds(5)),
              bootstrap.status == 0,
              bootstrap.stdout.isEmpty,
              bootstrap.stderr.count <= maximumCommandBytes else {
            _ = runLaunchctl(["bootout", service], timeout: .seconds(3))
            return nil
        }
        defer { _ = runLaunchctl(["bootout", service], timeout: .seconds(3)) }

        let deadline = DispatchTime.now() + .seconds(5)
        var proof: Data?
        repeat {
            if let stdout = readExactRootFile(
                RuntimeBrokerContract.dedicatedFixtureStandardOutputPath,
                maximumBytes: RuntimeBrokerContract.maximumWireBytes
              ), !stdout.isEmpty {
                let stderr = readExactRootFile(
                    RuntimeBrokerContract.dedicatedFixtureStandardErrorPath,
                    maximumBytes: RuntimeBrokerContract.maximumWireBytes
                )
                if stderr?.isEmpty == true {
                    proof = validateProof(stdout, challenge: challenge, identity: identity)
                }
                break
            }
            usleep(20_000)
        } while DispatchTime.now() < deadline
        return proof
    }

    private static func dedicatedIdentity() -> AccountIdentity? {
        guard let account = getpwnam(RuntimeBrokerContract.dedicatedAccountName),
              let group = getgrnam(RuntimeBrokerContract.dedicatedAccountName) else {
            return nil
        }
        let userIdentifier = account.pointee.pw_uid
        let groupIdentifier = group.pointee.gr_gid
        guard RuntimeBrokerContract.dedicatedIdentifierRange.contains(Int(userIdentifier)),
              RuntimeBrokerContract.dedicatedIdentifierRange.contains(Int(groupIdentifier)),
              account.pointee.pw_gid == groupIdentifier,
              String(cString: account.pointee.pw_dir) == RuntimeBrokerContract.dedicatedAccountHome,
              String(cString: account.pointee.pw_shell) == RuntimeBrokerContract.dedicatedAccountShell else {
            return nil
        }
        return AccountIdentity(
            userIdentifier: userIdentifier,
            groupIdentifier: groupIdentifier
        )
    }

    private static func prepareFixtureDirectory() -> Bool {
        let components: [(String, mode_t)] = [
            ("/Library/Application Support/com.intenet.agentstozbycs", 0o755),
            ("/Library/Application Support/com.intenet.agentstozbycs/agent-runtime", 0o755),
            (RuntimeBrokerContract.dedicatedFixtureRoot, 0o711),
        ]
        for (path, mode) in components {
            var metadata = stat()
            let status = path.withCString { lstat($0, &metadata) }
            if status != 0 {
                guard errno == ENOENT,
                      path.withCString({ mkdir($0, mode) }) == 0 else {
                    return false
                }
                guard path.withCString({ chown($0, 0, 0) }) == 0,
                      path.withCString({ chmod($0, mode) }) == 0 else {
                    return false
                }
                guard path.withCString({ lstat($0, &metadata) }) == 0 else {
                    return false
                }
            }
            guard (metadata.st_mode & S_IFMT) == S_IFDIR,
                  metadata.st_uid == 0,
                  metadata.st_gid == 0,
                  (metadata.st_mode & 0o7777) == mode else {
                return false
            }
        }
        return true
    }

    private static func prepareFixtureFiles(challenge: Data) -> Bool {
        cleanupFixtureFiles()
        guard createRootFile(
            RuntimeBrokerContract.dedicatedFixtureRequestPath,
            mode: 0o444,
            content: challenge
        ), createRootFile(
            RuntimeBrokerContract.dedicatedFixtureStandardOutputPath,
            mode: 0o600,
            content: Data()
        ), createRootFile(
            RuntimeBrokerContract.dedicatedFixtureStandardErrorPath,
            mode: 0o600,
            content: Data()
        ) else {
            cleanupFixtureFiles()
            return false
        }
        return true
    }

    private static func createRootFile(_ path: String, mode: mode_t, content: Data) -> Bool {
        let descriptor = path.withCString {
            open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
        }
        guard descriptor >= 0 else {
            return false
        }
        defer { close(descriptor) }
        guard fchown(descriptor, 0, 0) == 0,
              fchmod(descriptor, mode) == 0 else {
            return false
        }
        var offset = 0
        let wroteAll = content.withUnsafeBytes { buffer -> Bool in
            while offset < buffer.count {
                let amount = write(
                    descriptor,
                    buffer.baseAddress!.advanced(by: offset),
                    buffer.count - offset
                )
                if amount <= 0 {
                    return false
                }
                offset += amount
            }
            return true
        }
        return wroteAll && fsync(descriptor) == 0
    }

    private static func cleanupFixtureFiles() {
        for path in [
            RuntimeBrokerContract.dedicatedFixtureRequestPath,
            RuntimeBrokerContract.dedicatedFixtureStandardOutputPath,
            RuntimeBrokerContract.dedicatedFixtureStandardErrorPath,
        ] {
            _ = path.withCString { unlink($0) }
        }
    }

    private static func exactRootOwnedRegularFile(_ path: String, executable: Bool) -> Bool {
        var metadata = stat()
        guard path.withCString({ lstat($0, &metadata) }) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_nlink == 1,
              metadata.st_uid == 0,
              (metadata.st_mode & 0o022) == 0 else {
            return false
        }
        return !executable || (metadata.st_mode & 0o111) != 0
    }

    private static func readExactRootFile(_ path: String, maximumBytes: Int) -> Data? {
        var pathMetadata = stat()
        guard path.withCString({ lstat($0, &pathMetadata) }) == 0,
              (pathMetadata.st_mode & S_IFMT) == S_IFREG,
              pathMetadata.st_nlink == 1,
              pathMetadata.st_uid == 0,
              pathMetadata.st_size >= 0,
              pathMetadata.st_size <= maximumBytes else {
            return nil
        }
        let descriptor = path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
        guard descriptor >= 0 else {
            return nil
        }
        defer { close(descriptor) }
        var descriptorMetadata = stat()
        guard fstat(descriptor, &descriptorMetadata) == 0,
              descriptorMetadata.st_dev == pathMetadata.st_dev,
              descriptorMetadata.st_ino == pathMetadata.st_ino,
              descriptorMetadata.st_size == pathMetadata.st_size else {
            return nil
        }
        var data = Data(count: Int(descriptorMetadata.st_size))
        var offset = 0
        let readAll = data.withUnsafeMutableBytes { buffer -> Bool in
            while offset < buffer.count {
                let amount = read(
                    descriptor,
                    buffer.baseAddress!.advanced(by: offset),
                    buffer.count - offset
                )
                if amount <= 0 {
                    return false
                }
                offset += amount
            }
            return true
        }
        guard readAll else {
            return nil
        }
        var trailing: UInt8 = 0
        guard read(descriptor, &trailing, 1) == 0 else {
            return nil
        }
        return data
    }

    private static func runLaunchctl(
        _ arguments: [String],
        timeout: DispatchTimeInterval
    ) -> CommandResult? {
        let process = Process()
        let output = Pipe()
        let errors = Pipe()
        let outputCollector = RuntimeBoundedPipeCollector(maximumBytes: maximumCommandBytes)
        let errorCollector = RuntimeBoundedPipeCollector(maximumBytes: maximumCommandBytes)
        let terminated = DispatchSemaphore(value: 0)
        process.executableURL = launchctlURL
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: "/")
        process.environment = [
            "LANG": "C",
            "LC_ALL": "C",
            "PATH": "/usr/bin:/bin",
        ]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = errors
        process.terminationHandler = { _ in terminated.signal() }
        output.fileHandleForReading.readabilityHandler = { handle in
            outputCollector.consume(handle.availableData)
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            errorCollector.consume(handle.availableData)
        }
        do {
            try process.run()
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        if terminated.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            if terminated.wait(timeout: .now() + .milliseconds(250)) == .timedOut {
                let processIdentifier = process.processIdentifier
                if processIdentifier > 1 {
                    _ = kill(processIdentifier, SIGKILL)
                }
                _ = terminated.wait(timeout: .now() + .seconds(1))
            }
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        outputCollector.waitForEndOfFile()
        errorCollector.waitForEndOfFile()
        output.fileHandleForReading.readabilityHandler = nil
        errors.fileHandleForReading.readabilityHandler = nil
        let stdout = outputCollector.snapshot()
        let stderr = errorCollector.snapshot()
        guard !stdout.overflowed, !stderr.overflowed else {
            return nil
        }
        return CommandResult(
            status: process.terminationStatus,
            stdout: stdout.data,
            stderr: stderr.data
        )
    }

    private static func validateProof(
        _ wire: Data,
        challenge: Data,
        identity: AccountIdentity
    ) -> Data? {
        guard wire.count <= RuntimeBrokerContract.maximumWireBytes,
              wire.last == 0x0A,
              !wire.dropLast().contains(0x0A),
              let value = try? JSONSerialization.jsonObject(with: wire.dropLast()),
              let object = value as? [String: Any] else {
            return nil
        }
        let expectedKeys: Set<String> = [
            "schemaVersion", "kind", "mode", "result", "accountName",
            "effectiveUserIdentifier", "effectiveGroupIdentifier", "managerName",
            "challenge", "networkTouched", "fileMutationPerformed", "containerInvoked",
            "authoritative", "reusable", "ready",
        ]
        guard Set(object.keys) == expectedKeys,
              object["schemaVersion"] as? Int == 1,
              object["kind"] as? String == "macos-runtime-dedicated-worker-fixture",
              object["mode"] as? String == "dedicated-uid-launchd-user-domain",
              object["result"] as? String == "passed",
              object["accountName"] as? String == RuntimeBrokerContract.dedicatedAccountName,
              object["effectiveUserIdentifier"] as? Int == Int(identity.userIdentifier),
              object["effectiveGroupIdentifier"] as? Int == Int(identity.groupIdentifier),
              object["managerName"] as? String == "Background",
              object["challenge"] as? String == challenge.base64EncodedString(),
              object["networkTouched"] as? Bool == false,
              object["fileMutationPerformed"] as? Bool == false,
              object["containerInvoked"] as? Bool == false,
              object["authoritative"] as? Bool == false,
              object["reusable"] as? Bool == false,
              object["ready"] as? Bool == false else {
            return nil
        }
        return try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) + Data([0x0A])
    }
}
