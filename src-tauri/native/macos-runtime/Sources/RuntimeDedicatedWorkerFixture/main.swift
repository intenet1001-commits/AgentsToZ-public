import Darwin
import Foundation
import RuntimeBrokerProtocol

private enum DedicatedWorkerExit: Int32 {
    case invalidInvocation = 64
    case unsupportedPlatform = 69
    case dedicatedIdentityRequired = 77
    case launchdRequired = 78
    case accountPolicyRejected = 79
    case managerProbeFailed = 80
    case backgroundDomainRequired = 81
    case proofFailure = 82
}

private func fail(_ message: StaticString, _ code: DedicatedWorkerExit) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code.rawValue)
}

private func boundedLaunchdManagerName() -> String? {
    let process = Process()
    let output = Pipe()
    let errors = Pipe()
    let terminated = DispatchSemaphore(value: 0)
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["managername"]
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
    do {
        try process.run()
    } catch {
        return nil
    }
    if terminated.wait(timeout: .now() + .seconds(3)) == .timedOut {
        process.terminate()
        if terminated.wait(timeout: .now() + .milliseconds(250)) == .timedOut {
            let processIdentifier = process.processIdentifier
            if processIdentifier > 1 {
                _ = kill(processIdentifier, SIGKILL)
            }
            _ = terminated.wait(timeout: .now() + .seconds(1))
        }
        return nil
    }
    let stdout = output.fileHandleForReading.readDataToEndOfFile()
    let stderr = errors.fileHandleForReading.readDataToEndOfFile()
    guard process.terminationStatus == 0,
          stderr.isEmpty,
          stdout.count <= 64,
          let text = String(data: stdout, encoding: .utf8),
          text.last == "\n",
          !text.dropLast().contains("\n") else {
        return nil
    }
    return String(text.dropLast())
}

private func accountMatchesPolicy() -> Bool {
    let effectiveUser = geteuid()
    let effectiveGroup = getegid()
    guard effectiveUser != 0,
          RuntimeBrokerContract.dedicatedIdentifierRange.contains(Int(effectiveUser)),
          RuntimeBrokerContract.dedicatedIdentifierRange.contains(Int(effectiveGroup)),
          let account = getpwuid(effectiveUser),
          let group = getgrgid(effectiveGroup) else {
        return false
    }
    guard String(cString: account.pointee.pw_name) == RuntimeBrokerContract.dedicatedAccountName,
          String(cString: account.pointee.pw_dir) == RuntimeBrokerContract.dedicatedAccountHome,
          String(cString: account.pointee.pw_shell) == RuntimeBrokerContract.dedicatedAccountShell,
          account.pointee.pw_gid == effectiveGroup,
          String(cString: group.pointee.gr_name) == RuntimeBrokerContract.dedicatedAccountName else {
        return false
    }

    let groupCount = getgroups(0, nil)
    guard groupCount >= 0 else {
        return false
    }
    var groups = [gid_t](repeating: 0, count: Int(groupCount))
    if groupCount > 0 && getgroups(groupCount, &groups) != groupCount {
        return false
    }
    // wheel/root and admin membership would defeat the containment boundary.
    return !groups.contains(0) && !groups.contains(80)
}

private func readBrokerChallenge() -> Data? {
    let path = RuntimeBrokerContract.dedicatedFixtureRequestPath
    var pathMetadata = stat()
    guard path.withCString({ lstat($0, &pathMetadata) }) == 0,
          (pathMetadata.st_mode & S_IFMT) == S_IFREG,
          pathMetadata.st_nlink == 1,
          pathMetadata.st_uid == 0,
          (pathMetadata.st_mode & 0o222) == 0,
          pathMetadata.st_size == RuntimeBrokerContract.challengeByteCount else {
        return nil
    }
    let descriptor = path.withCString {
        open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    }
    guard descriptor >= 0 else {
        return nil
    }
    defer { close(descriptor) }
    var descriptorMetadata = stat()
    guard fstat(descriptor, &descriptorMetadata) == 0,
          descriptorMetadata.st_dev == pathMetadata.st_dev,
          descriptorMetadata.st_ino == pathMetadata.st_ino,
          descriptorMetadata.st_uid == 0,
          (descriptorMetadata.st_mode & 0o222) == 0,
          descriptorMetadata.st_size == RuntimeBrokerContract.challengeByteCount else {
        return nil
    }
    var bytes = [UInt8](repeating: 0, count: RuntimeBrokerContract.challengeByteCount)
    var offset = 0
    let byteCount = bytes.count
    while offset < byteCount {
        let amount = bytes.withUnsafeMutableBytes { buffer in
            read(descriptor, buffer.baseAddress!.advanced(by: offset), byteCount - offset)
        }
        if amount <= 0 {
            return nil
        }
        offset += amount
    }
    var trailing: UInt8 = 0
    guard read(descriptor, &trailing, 1) == 0 else {
        return nil
    }
    return Data(bytes)
}

private func encodedProof(managerName: String, challenge: Data) -> Data? {
    let value: [String: Any] = [
        "schemaVersion": 1,
        "kind": "macos-runtime-dedicated-worker-fixture",
        "mode": "dedicated-uid-launchd-user-domain",
        "result": "passed",
        "accountName": RuntimeBrokerContract.dedicatedAccountName,
        "effectiveUserIdentifier": Int(geteuid()),
        "effectiveGroupIdentifier": Int(getegid()),
        "managerName": managerName,
        "challenge": challenge.base64EncodedString(),
        "networkTouched": false,
        "fileMutationPerformed": false,
        "containerInvoked": false,
        "authoritative": false,
        "reusable": false,
        "ready": false,
    ]
    guard JSONSerialization.isValidJSONObject(value) else {
        return nil
    }
    return try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}

@main
private struct RuntimeDedicatedWorkerFixtureMain {
    static func main() {
        guard CommandLine.arguments.count == 2,
              CommandLine.arguments[1] == RuntimeBrokerContract.dedicatedWorkerFixtureFlag else {
            fail("runtime-dedicated-worker-fixture: invalid invocation", .invalidInvocation)
        }
        guard #available(macOS 26.0, *) else {
            fail("runtime-dedicated-worker-fixture: unsupported platform", .unsupportedPlatform)
        }
        guard geteuid() != 0,
              getegid() != 0,
              RuntimeBrokerContract.dedicatedIdentifierRange.contains(Int(geteuid())),
              RuntimeBrokerContract.dedicatedIdentifierRange.contains(Int(getegid())) else {
            fail("runtime-dedicated-worker-fixture: dedicated identity required", .dedicatedIdentityRequired)
        }
        guard getppid() == 1 else {
            fail("runtime-dedicated-worker-fixture: launchd parent required", .launchdRequired)
        }
        guard accountMatchesPolicy() else {
            fail("runtime-dedicated-worker-fixture: account policy rejected", .accountPolicyRejected)
        }
        guard let managerName = boundedLaunchdManagerName() else {
            fail("runtime-dedicated-worker-fixture: manager probe failed", .managerProbeFailed)
        }
        guard managerName == "Background" else {
            fail("runtime-dedicated-worker-fixture: background domain required", .backgroundDomainRequired)
        }
        guard let challenge = readBrokerChallenge(),
              var proof = encodedProof(managerName: managerName, challenge: challenge) else {
            fail("runtime-dedicated-worker-fixture: proof failed", .proofFailure)
        }
        proof.append(0x0A)
        do {
            try FileHandle.standardOutput.write(contentsOf: proof)
        } catch {
            fail("runtime-dedicated-worker-fixture: proof failed", .proofFailure)
        }
    }
}
