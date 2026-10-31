import AppKit
import ApplicationServices
import ComputerUseControlCore
import ComputerUseEngine
import Foundation

/// Isolated live AX check. It creates its own app and synthetic fields, never accepts another app/target.
/// No production grant, TCC permission, existing window or user data is created/modified here.
@MainActor
private final class Fixture: NSObject {
    let root: URL
    let first = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 440, height: 250), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let second = NSWindow(contentRect: NSRect(x: 560, y: 100, width: 440, height: 250), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let input = NSTextField(frame: NSRect(x: 25, y: 180, width: 380, height: 28))
    let other = NSTextField(frame: NSRect(x: 25, y: 180, width: 380, height: 28))
    let secret = NSSecureTextField(frame: NSRect(x: 25, y: 130, width: 380, height: 28))
    var applied = ""
    var applications = 0
    var button: NSButton!
    init(root: URL) {
        self.root = root
        super.init()
        first.title = "AgentsToZ isolated computer-use fixture"
        second.title = first.title
        input.stringValue = "first unchanged"; input.setAccessibilityLabel("AgentsToZ test input")
        other.stringValue = "second unchanged"; other.setAccessibilityLabel("AgentsToZ test input")
        secret.stringValue = "native-private-sentinel-DO-NOT-EXPOSE"; secret.setAccessibilityLabel("protected test field")
        first.contentView?.addSubview(input); first.contentView?.addSubview(secret)
        second.contentView?.addSubview(other)
        button = NSButton(title: "Apply synthetic text", target: self, action: #selector(apply))
        button.frame = NSRect(x: 25, y: 65, width: 250, height: 32)
        first.contentView?.addSubview(button)
        first.orderFront(nil); second.orderFront(nil)
        write()
    }
    @objc func apply() { applied = input.stringValue; applications += 1; write() }
    func write() {
        let center = first.convertPoint(toScreen: button.convert(NSPoint(x: button.bounds.midX, y: button.bounds.midY), to: nil))
        let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "windowId": first.windowNumber,
            "otherWindowId": second.windowNumber, "input": input.stringValue, "other": other.stringValue,
            "applied": applied, "applications": applications,
            "buttonX": center.x - first.frame.minX, "buttonY": first.frame.maxY - center.y,
            "secureUnchanged": secret.stringValue == "native-private-sentinel-DO-NOT-EXPOSE"]
        try? JSONSerialization.data(withJSONObject: state).write(to: root.appendingPathComponent("fixture.json"), options: .atomic)
    }
}

@main
enum NativeLab {
    @MainActor static func main() async {
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--fixture" {
            let app = NSApplication.shared; app.setActivationPolicy(.accessory)
            let fixture = Fixture(root: URL(fileURLWithPath: CommandLine.arguments[2]))
            withExtendedLifetime(fixture) { app.run() }
            return
        }
        guard CommandLine.arguments.count == 1 else { emit(["state": "refused", "reason": "no-external-targets"]); exit(2) }
        guard ComputerUseEngine.accessibilityTrusted else {
            emit(["state": "blocked", "reason": "accessibility-not-granted", "inputDispatched": false]); exit(2)
        }
        let manager = FileManager.default
        let root = manager.temporaryDirectory.appendingPathComponent("agentstoz-computer-use-native-" + UUID().uuidString)
        let child = Process()
        var session: TargetSession?
        do {
            try manager.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer {
                session?.stop()
                if child.isRunning { child.terminate(); child.waitUntilExit() }
                try? manager.removeItem(at: root)
            }
            let app = root.appendingPathComponent("Computer Use Test.app"), contents = app.appendingPathComponent("Contents")
            let binary = contents.appendingPathComponent("MacOS/Fixture")
            try manager.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
            try manager.copyItem(at: URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL, to: binary)
            let plist: [String: Any] = ["CFBundleIdentifier": "dev.agentstoz.computerusefixture", "CFBundleExecutable": "Fixture",
                "CFBundleName": "AgentsToZ Computer Use Test", "CFBundlePackageType": "APPL", "LSUIElement": true]
            try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
            let signer = Process(); signer.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
            signer.arguments = ["--force", "--sign", "-", app.path]
            signer.standardOutput = FileHandle.nullDevice; signer.standardError = FileHandle.nullDevice
            try signer.run(); signer.waitUntilExit(); guard signer.terminationStatus == 0 else { throw ControlError("fixture-sign-failed") }
            child.executableURL = binary; child.arguments = ["--fixture", root.path]
            child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
            try child.run()
            let ready = root.appendingPathComponent("fixture.json")
            for _ in 0..<100 {
                if manager.fileExists(atPath: ready.path) { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            func state() throws -> [String: Any] { try JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as! [String: Any] }
            let initial = try state()
            guard let pid = initial["pid"] as? Int32, let window = initial["windowId"] as? UInt32 else { throw ControlError("fixture-not-ready") }
            var target = try? ComputerUseEngine.identity(pid: pid, window: window)
            for _ in 0..<20 {
                target = try? ComputerUseEngine.identity(pid: pid, window: window)
                if target != nil { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            guard let target else {
                let running = NSRunningApplication(processIdentifier: pid)
                let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, window) as? [[String: Any]] ?? []
                emit(["state": "fixture-diagnostic", "hasApplication": running != nil,
                      "bundleRegistered": running?.bundleIdentifier == "dev.agentstoz.computerusefixture",
                      "windowFound": windows.count == 1,
                      "onScreen": windows.first?[kCGWindowIsOnscreen as String] as? Bool ?? false,
                      "layer": windows.first?[kCGWindowLayer as String] as? Int ?? -1])
                throw ControlError("fixture-target-not-ready")
            }
            let bound = TargetSession(target: target); session = bound
            let observation = try await bound.observe()
            let encoded = String(decoding: try JSONSerialization.data(withJSONObject: observation), as: UTF8.self)
            guard !encoded.contains("native-private-sentinel"), !encoded.contains("protected test field"),
                  let elements = observation["elements"] as? [[String: Any]],
                  let field = elements.first(where: { $0["label"] as? String == "AgentsToZ test input" }),
                  let fieldID = field["id"] as? String, let snapshot = observation["snapshotId"] as? String else { throw ControlError("fixture-observation-incomplete") }
            let text = "AgentsToZ native input ✓"
            let entered = try await bound.perform("set-value", snapshotId: snapshot, element: fieldID, value: text)
            guard entered["humanStatePreserved"] as? Bool == true else { throw ControlError("human-takeover") }
            let next = try await bound.observe()
            guard let nextElements = next["elements"] as? [[String: Any]],
                  let button = nextElements.first(where: { $0["label"] as? String == "Apply synthetic text" }),
                  let buttonID = button["id"] as? String, let nextSnapshot = next["snapshotId"] as? String else { throw ControlError("fixture-button-missing") }
            let pressed = try await bound.perform("press", snapshotId: nextSnapshot, element: buttonID, value: nil)
            guard pressed["humanStatePreserved"] as? Bool == true else { throw ControlError("human-takeover") }
            var result = try state()
            for _ in 0..<20 {
                if result["applied"] as? String == text { break }
                try await Task.sleep(for: .milliseconds(50)); result = try state()
            }
            guard result["applied"] as? String == text, result["other"] as? String == "second unchanged", result["secureUnchanged"] as? Bool == true else {
                throw ControlError("fixture-readback-failed")
            }
            let visualObservation = try await bound.observe()
            guard let visualID = visualObservation["snapshotId"] as? String else { throw ControlError("fixture-observation-incomplete") }
            do {
                _ = try await bound.capture(snapshotId: visualID, screenAccessApproved: false)
                throw ControlError("screen-consent-not-enforced")
            } catch let error as ControlError where error.code == "screen-consent-required" { }
            guard CGPreflightScreenCaptureAccess() else {
                emit(["state": "blocked", "reason": "screen-permission-not-granted", "axChecksPassed": true, "productionGrantTested": false]); return
            }
            let image = try await bound.capture(snapshotId: visualID, screenAccessApproved: true)
            guard image["mediaType"] as? String == "image/jpeg", let imageData = image["data"] as? String,
                  let jpeg = Data(base64Encoded: imageData), jpeg.count <= 240_000,
                  jpeg.starts(with: [0xff, 0xd8]), let x = result["buttonX"] as? Double,
                  let y = result["buttonY"] as? Double else { throw ControlError("fixture-capture-invalid") }
            let clicked = try await bound.click(snapshotId: visualID, x: x, y: y)
            guard clicked["humanStatePreserved"] as? Bool == true else { throw ControlError("human-takeover") }
            for _ in 0..<20 {
                result = try state()
                if result["applications"] as? Int == 2 { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            guard result["applications"] as? Int == 2, result["other"] as? String == "second unchanged",
                  result["secureUnchanged"] as? Bool == true else { throw ControlError("fixture-coordinate-readback-failed") }
            emit(["state": "passed", "checks": ["exact-window", "ordinary-text-input", "button-press", "independent-readback", "secure-field-omitted", "other-window-preserved", "human-state-preserved", "screen-consent-required", "window-screenshot", "coordinate-button-press"], "productionGrantTested": false])
        } catch {
            emit(["state": "failed", "reason": (error as? ControlError)?.code ?? "fixture-failed", "productionGrantTested": false]); exit(1)
        }
    }
    static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        print(String(decoding: data, as: UTF8.self))
    }
}
