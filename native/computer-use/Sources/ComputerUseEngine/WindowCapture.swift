import AppKit
import CoreGraphics
import ComputerUseControlCore
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Bounds of one window image: the longest side in pixels and the JPEG size (320KB once base64 encoded, the host's cap).
public enum WindowCaptureLimits {
    public static let longestSide = 1280.0
    public static let jpegBytes = 240_000
}

/// The window list and the pixels: the only ScreenCaptureKit parts of a capture. Production uses
/// `ScreenCaptureKitWindows`; a test substitutes both so the person's stop or a takeover lands exactly at each await.
@MainActor
protocol WindowCaptureSource {
    associatedtype Window
    func windows() async throws -> [Window]
    func describe(_ window: Window) -> (windowId: UInt32, pid: Int32?, frame: CGRect)
    func image(of window: Window, width: Int, height: Int) async throws -> CGImage
}

@MainActor
struct ScreenCaptureKitWindows: WindowCaptureSource {
    func windows() async throws -> [SCWindow] {
        try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true).windows
    }
    func describe(_ window: SCWindow) -> (windowId: UInt32, pid: Int32?, frame: CGRect) {
        (window.windowID, window.owningApplication?.processID, window.frame)
    }
    func image(of window: SCWindow, width: Int, height: Int) async throws -> CGImage {
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = false
        let filter = SCContentFilter(desktopIndependentWindow: window)
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }
}

/// What a capture re-reads from its session at every suspension. `validate` throws once the grant is halted (the
/// person's stop, revocation, expiry) or the target changed; `observationCurrent` is the same snapshot within 15 s.
@MainActor
struct WindowCaptureChecks {
    let validate: () throws -> Void
    let observationCurrent: () -> Bool
    let humanState: () -> TargetSession.HumanState
    /// The bound window's AX frame in points, or nil when it cannot be read exactly.
    let windowFrame: () -> CGRect?
}

/// Window, then pixels, with every authorization re-read after each await: a grant revoked or halted, a stale
/// observation or a person using the Mac while ScreenCaptureKit works yields no image. Returns the payload and the
/// AX frame the image covers; the caller binds coordinate clicks to that frame.
@MainActor
func captureWindow<Source: WindowCaptureSource>(windowId: UInt32, pid: Int32, checks: WindowCaptureChecks,
                                                source: Source) async throws -> (payload: [String: Any], frame: CGRect) {
    try checks.validate()
    let before = checks.humanState()
    guard before.verifiable else { throw ControlError.refuse("human-state-unavailable") }
    let windows = try await source.windows()
    // The grant can be revoked while ScreenCaptureKit resolves its window list. Do not
    // initiate pixel collection after that suspension if the session or observation ended.
    try checks.validate()
    guard checks.observationCurrent(), checks.humanState() == before else { throw ControlError.refuse("observation-discarded") }
    let matches = windows.filter { let w = source.describe($0); return w.windowId == windowId && w.pid == pid }
    guard matches.count == 1, let window = matches.first else { throw ControlError.refuse("window-not-exact") }
    let frame = source.describe(window).frame
    guard frame.width.isFinite, frame.height.isFinite, frame.width > 0, frame.height > 0,
          let axFrame = checks.windowFrame(), axFrame == frame else { throw ControlError.refuse("window-not-exact") }
    let pointSize = frame.size
    let scale = min(1.0, WindowCaptureLimits.longestSide / max(pointSize.width, pointSize.height))
    let width = max(1, Int((pointSize.width * scale).rounded(.down)))
    let height = max(1, Int((pointSize.height * scale).rounded(.down)))
    // Recheck the exact frame and all authorization immediately before requesting pixels.
    try checks.validate()
    guard checks.observationCurrent(), checks.windowFrame() == axFrame,
          checks.humanState() == before else { throw ControlError.refuse("observation-discarded") }
    let image = try await source.image(of: window, width: width, height: height)
    try checks.validate()
    guard checks.observationCurrent(), checks.windowFrame() == axFrame,
          checks.humanState() == before else { throw ControlError.refuse("observation-discarded") }
    // Bound the encoded transport to 320KB base64; if JPEG compression is insufficient,
    // fail closed rather than emit a truncated/corrupt image.
    var encoded: Data?
    for quality in [0.75, 0.55, 0.35, 0.2] {
        let buffer = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(buffer, UTType.jpeg.identifier as CFString, 1, nil) else { break }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { break }
        if buffer.length <= WindowCaptureLimits.jpegBytes { encoded = buffer as Data; break }
    }
    guard let encoded else { throw ControlError.refuse("screen-image-too-large") }
    return (["mediaType": "image/jpeg", "data": encoded.base64EncodedString(),
             "width": image.width, "height": image.height,
             "windowWidth": pointSize.width, "windowHeight": pointSize.height], axFrame)
}

extension TargetSession {
    /// Captures only the already bound window. The caller must independently verify that the
    /// person granted screen-image access for this grant; this method never requests TCC access.
    public func capture(snapshotId: String, screenAccessApproved: Bool) async throws -> [String: Any] {
        guard screenAccessApproved else { throw ControlError.refuse("screen-consent-required") }
        guard CGPreflightScreenCaptureAccess() else { throw ControlError.refuse("screen-permission-required") }
        guard snapshotId == snapshot, Date().timeIntervalSince(observedAt) <= 15 else { throw ControlError.refuse("stale-observation") }
        capturedFrame = nil
        let driver = NativeAXDriver(pid: target.pid, windowID: target.windowId)
        let captured = try await captureWindow(windowId: target.windowId, pid: target.pid, checks: WindowCaptureChecks(
            validate: { try self.validate() },
            observationCurrent: { snapshotId == self.snapshot && Date().timeIntervalSince(self.observedAt) <= 15 },
            humanState: { self.humanState() },
            windowFrame: { (try? driver.window()).flatMap { driver.allowsActions(in: $0) ? driver.frame(of: $0) : nil } }), source: ScreenCaptureKitWindows())
        capturedFrame = captured.frame
        return captured.payload
    }
}
