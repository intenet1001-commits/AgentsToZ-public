#if os(macOS)
import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import os
import ScreenCaptureKit
import ScreenControlCore

/// Screen recording permission as the system reports it. `notGranted` covers both "denied" and "never asked": the
/// preflight cannot tell them apart, so neither is ever shown as allowed (DESIGN S0-3).
public enum ScreenRecordingPermission: Sendable {
    case granted, notGranted

    public static var current: ScreenRecordingPermission { CGPreflightScreenCaptureAccess() ? .granted : .notGranted }

    /// Shows the system prompt the first time; afterwards the person enables it in System Settings.
    @discardableResult
    public static func request() -> ScreenRecordingPermission { CGRequestScreenCaptureAccess() ? .granted : .notGranted }
}

/// Apps whose windows the picture never shows (mac-to-mac DESIGN 「화면 루프」): AgentsToZ Viewer, so a Mac controller
/// watching this Mac never films its own picture back to itself or its offer QR to another phone, and two Macs that
/// watch each other never feed back. Matched by bundle identifier, which any app could also claim; that only hides
/// such an app from the picture, a thing an app on this Mac could already do with a window of its own.
public enum CaptureExclusion {
    public static let viewerBundleIdentifier = "com.intenet.agentstozbycs.viewer"

    /// The viewer itself and any helper inside its bundle (`<viewer>.<helper>`), ignoring case.
    public static func excludes(bundleIdentifier: String?) -> Bool {
        guard let identifier = bundleIdentifier?.lowercased() else { return false }
        return identifier == viewerBundleIdentifier || identifier.hasPrefix(viewerBundleIdentifier + ".")
    }

    /// Of the apps the system shares, those to leave out, in their order.
    public static func excluded<App>(_ apps: [App], bundleIdentifier: (App) -> String?) -> [App] {
        apps.filter { excludes(bundleIdentifier: bundleIdentifier($0)) }
    }

    /// The whole display without the excluded apps' windows, now and those they open later.
    static func filter(display: SCDisplay, excluding apps: [SCRunningApplication]) -> SCContentFilter {
        SCContentFilter(display: display, excludingApplications: apps, exceptingWindows: [])
    }
}

/// One display through ScreenCaptureKit, scaled to the size the phone needs (DESIGN S0-4: about half resolution).
public final class DisplayCapture: NSObject, SCStreamOutput, @unchecked Sendable {
    public struct Frame: @unchecked Sendable {
        public let image: CVPixelBuffer
        public let time: CMTime
        /// When the display showed it (mach absolute time), for latency.
        public let displayTime: UInt64
    }

    public struct Settings: Sendable {
        public var width: Int
        public var height: Int
        public var framesPerSecond = 30
        public var showsCursor = true

        public init(width: Int, height: Int) {
            // 4:2:0 needs even sizes.
            self.width = width & ~1
            self.height = height & ~1
        }
    }

    private let stream: SCStream
    private let display: SCDisplay
    private let queue = DispatchQueue(label: "agentstoz.screen-control.capture")
    private let onFrame: @Sendable (Frame) -> Void

    public static func mainDisplay() async throws -> SCDisplay {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw CaptureError.noDisplay
        }
        return display
    }

    /// `excluding`: the apps `CaptureExclusion` leaves out of the picture.
    public init(display: SCDisplay, excluding apps: [SCRunningApplication] = [], settings: Settings,
                onFrame: @escaping @Sendable (Frame) -> Void) throws {
        stream = SCStream(filter: CaptureExclusion.filter(display: display, excluding: apps), configuration: Self.configuration(settings),
                          delegate: nil)
        self.display = display
        self.onFrame = onFrame
        super.init()
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    }

    /// Leaves out an app that started after the stream did, in place: no new stream, no new keyframe.
    func exclude(_ apps: [SCRunningApplication]) async throws {
        try await stream.updateContentFilter(CaptureExclusion.filter(display: display, excluding: apps))
    }

    private static func configuration(_ settings: Settings) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = settings.width
        configuration.height = settings.height
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(settings.framesPerSecond))
        configuration.queueDepth = 4
        configuration.showsCursor = settings.showsCursor
        return configuration
    }

    public func start() async throws { try await stream.startCapture() }
    public func stop() async { try? await stream.stopCapture() }

    /// Changes the running stream in place: the cursor in the picture, without a new stream or a new keyframe.
    public func update(_ settings: Settings) async throws { try await stream.updateConfiguration(Self.configuration(settings)) }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        // Only complete frames carry a picture; idle and blank ones mean the screen did not change.
        guard type == .screen,
              let info = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let image = CMSampleBufferGetImageBuffer(sample) else { return }
        onFrame(Frame(image: image, time: CMSampleBufferGetPresentationTimeStamp(sample),
                      displayTime: info[.displayTime] as? UInt64 ?? mach_absolute_time()))
    }
}

public enum CaptureError: Error, Sendable {
    case noDisplay
}

/// ScreenCaptureKit behind `HostCapture` (DESIGN 「여러 디스플레이」): the displays the system shares, the main display
/// first and the rest from left to right, and one `DisplayCapture` at a time.
public final class ScreenCaptureBackend: DisplayCapturing, Sendable {
    private struct State {
        var shared: [UInt32: SCDisplay] = [:]
        var excluded: [SCRunningApplication] = []
        var running: DisplayCapture?
        var launches: NSObjectProtocol?
    }

    private let state = OSAllocatedUnfairLock(uncheckedState: State())

    public init() {
        // A viewer opened after the stream started is left out as soon as the system shares it (DESIGN 「화면 루프」).
        let launches = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification,
                                                                         object: nil, queue: nil) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            guard CaptureExclusion.excludes(bundleIdentifier: app?.bundleIdentifier) else { return }
            Task { try? await self?.refreshExclusions() }
        }
        state.withLockUnchecked { $0.launches = launches }
    }

    deinit {
        if let launches = state.withLockUnchecked({ $0.launches }) { NSWorkspace.shared.notificationCenter.removeObserver(launches) }
    }

    public func displays() async throws -> [CaptureDisplay] {
        // Every window, not only those on screen: a viewer that is hidden now is still left out when it shows again.
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let main = CGMainDisplayID()
        let sorted = content.displays.sorted {
            ($0.displayID == main ? 0 : 1, $0.frame.minX, $0.frame.minY, $0.displayID)
                < ($1.displayID == main ? 0 : 1, $1.frame.minX, $1.frame.minY, $1.displayID)
        }
        guard !sorted.isEmpty else { throw CaptureError.noDisplay }
        let excluded = CaptureExclusion.excluded(content.applications) { $0.bundleIdentifier }
        state.withLockUnchecked {
            $0.shared = Dictionary(uniqueKeysWithValues: sorted.map { ($0.displayID, $0) })
            $0.excluded = excluded
        }
        return sorted.map { CaptureDisplay(id: $0.displayID, width: $0.width, height: $0.height) }
    }

    /// Asks the system again which apps to leave out and changes the running stream's filter in place.
    func refreshExclusions() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let excluded = CaptureExclusion.excluded(content.applications) { $0.bundleIdentifier }
        let running = state.withLockUnchecked { state -> DisplayCapture? in
            state.excluded = excluded
            return state.running
        }
        try await running?.exclude(excluded)
    }

    public func start(_ display: CaptureDisplay, settings: CaptureSettings,
                      deliver: @escaping @Sendable (CapturedPicture) -> Void) async throws {
        let (shared, excluded) = state.withLockUnchecked { ($0.shared[display.id], $0.excluded) }
        guard let shared else { throw CaptureError.noDisplay }
        let capture = try DisplayCapture(display: shared, excluding: excluded, settings: Self.settings(settings)) { frame in
            deliver(CapturedPicture(image: frame.image, time: frame.time, displayTime: frame.displayTime))
        }
        try await capture.start()
        let (replaced, latest) = state.withLockUnchecked { state -> (DisplayCapture?, [SCRunningApplication]) in
            defer { state.running = capture }
            return (state.running, state.excluded)
        }
        // A viewer that launched while this stream was starting.
        if latest.map(\.processID) != excluded.map(\.processID) { try? await capture.exclude(latest) }
        await replaced?.stop()
    }

    public func update(_ settings: CaptureSettings) async throws {
        try await state.withLockUnchecked({ $0.running })?.update(Self.settings(settings))
    }

    public func stop() async {
        let running = state.withLockUnchecked { state -> DisplayCapture? in
            defer { state.running = nil }
            return state.running
        }
        await running?.stop()
    }

    private static func settings(_ settings: CaptureSettings) -> DisplayCapture.Settings {
        var converted = DisplayCapture.Settings(width: settings.width, height: settings.height)
        converted.framesPerSecond = settings.framesPerSecond
        converted.showsCursor = settings.showsCursor
        return converted
    }
}
#endif
