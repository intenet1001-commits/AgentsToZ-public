import CoreGraphics
import Foundation

/// macOS keeps a process's first Screen Recording answer until it exits, so a switch the person turns on later stays
/// invisible to a running Control. Control asks a copy of itself, started with one fixed argument: the copy answers
/// from the current permission and exits before any app setup. It reads nothing else and accepts no other input.
enum ScreenRecordingProbe {
    static let argument = "--agentstoz-screen-recording-probe"

    /// First in `main`: the copy exits 0 when Screen Recording is allowed and 1 otherwise.
    static func answerIfAsked() {
        guard CommandLine.arguments.count == 2, CommandLine.arguments[1] == argument else { return }
        exit(CGPreflightScreenCaptureAccess() ? 0 : 1)
    }

    static func allowedInFreshProcess() async -> Bool {
        guard let executable = Bundle.main.executableURL else { return false }
        return await withCheckedContinuation { continuation in
            let child = Child(Process())
            child.process.executableURL = executable
            child.process.arguments = [argument]
            child.process.standardInput = FileHandle.nullDevice
            child.process.standardOutput = FileHandle.nullDevice
            child.process.standardError = FileHandle.nullDevice
            child.process.terminationHandler = { continuation.resume(returning: $0.terminationReason == .exit && $0.terminationStatus == 0) }
            do { try child.process.run() } catch { continuation.resume(returning: false); return }
            // A copy that does not answer within 5 s counts as "not yet"; the next check starts a new one.
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { if child.process.isRunning { child.process.terminate() } }
        }
    }

    private final class Child: @unchecked Sendable {
        let process: Process
        init(_ process: Process) { self.process = process }
    }
}
