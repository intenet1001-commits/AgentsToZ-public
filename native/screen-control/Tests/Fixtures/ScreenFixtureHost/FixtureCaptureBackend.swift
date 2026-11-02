// Emulator e2e fixture only. Compiled with Sources/ScreenHost/HostStreamer.swift into the fixture host executable, in
// place of Sources/ScreenHost/Capture.swift, which is never part of this build (scripts/emulator-e2e/screenFixtureHost.ts).
#if os(macOS)
import CoreMedia
import CoreVideo
import Darwin
import Dispatch
import Foundation
import os
import ScreenControlCore

/// Fixture-only answer for HostStreamer's default argument; no system permission is read or changed.
public enum ScreenRecordingPermission {
    case granted
    public static var current: ScreenRecordingPermission { .granted }
}

/// Only the marker used by the pure bar model; no event monitor is constructed or linked.
public enum LocalInputMonitor { static let injectionMarker: Int64 = 0x41545a }

/// What the fixture's displays look like, set by `main.swift` before the first session.
struct FixtureCaptureConfiguration: Sendable {
    var displays: [CaptureDisplay] = [CaptureDisplay(id: 1, width: 1920, height: 1080)]
    /// The most pictures a second the stand-in makes; the session's own frame rate can only lower it.
    var framesPerSecond = 30
}

/// What the stand-in did, for `frames.json`.
struct FixtureCaptureCounters: Sendable {
    var starts = 0, stops = 0, updates = 0
    /// Pictures handed to the session's pump (HostCapture), whether or not the pump took them.
    var delivered = 0
    var lastDisplay: UInt32?
    var lastWidth = 0, lastHeight = 0, lastFramesPerSecond = 0
    var showsCursor = true

    var json: [String: Any] {
        ["starts": starts, "stops": stops, "updates": updates, "delivered": delivered,
         "lastDisplay": lastDisplay.map { Int($0) as Any } ?? NSNull(), "lastWidth": lastWidth, "lastHeight": lastHeight,
         "lastFramesPerSecond": lastFramesPerSecond, "showsCursor": showsCursor]
    }
}

/// Stand-in for ScreenHost's ScreenCaptureKit backend, under the same name so that `HostStreamer`'s default argument
/// (`backend: any DisplayCapturing = ScreenCaptureBackend()`) builds unchanged and every session the fixture serves gets
/// this backend the way AgentsToZ Screen's sessions get the real one. It only paints `FixturePattern` into pixel buffers
/// on a timer: no ScreenCaptureKit, no CoreGraphics display or window access, no screen recording permission.
public final class ScreenCaptureBackend: DisplayCapturing, Sendable {
    static let configuration = OSAllocatedUnfairLock(initialState: FixtureCaptureConfiguration())
    static let counters = OSAllocatedUnfairLock(initialState: FixtureCaptureCounters())

    /// The running capture's timer. One capture at a time, like the real backend.
    private let running = OSAllocatedUnfairLock<DispatchSourceTimer?>(uncheckedState: nil)
    private let queue = DispatchQueue(label: "agentstoz.screen-fixture.capture")

    public init() {}

    public func displays() async throws -> [CaptureDisplay] {
        let list = Self.configuration.withLock { $0.displays }
        guard !list.isEmpty else { throw HostCaptureError.noDisplay }
        return list
    }

    public func start(_ display: CaptureDisplay, settings: CaptureSettings,
                      deliver: @escaping @Sendable (CapturedPicture) -> Void) async throws {
        let (known, ceiling) = Self.configuration.withLock { ($0.displays.contains(display), $0.framesPerSecond) }
        guard known else { throw HostCaptureError.noDisplay }
        let framesPerSecond = max(1, min(settings.framesPerSecond, ceiling))
        let painter = try SyntheticPictures(width: settings.width, height: settings.height, framesPerSecond: framesPerSecond)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / framesPerSecond), leeway: .milliseconds(2))
        timer.setEventHandler {
            guard let picture = painter.next() else { return }
            ScreenCaptureBackend.counters.withLock { $0.delivered += 1 }
            deliver(picture)
        }
        let replaced = running.withLockUnchecked { current -> DispatchSourceTimer? in
            defer { current = timer }
            return current
        }
        replaced?.cancel()
        Self.counters.withLock {
            $0.starts += 1
            $0.lastDisplay = display.id
            $0.lastWidth = settings.width
            $0.lastHeight = settings.height
            $0.lastFramesPerSecond = framesPerSecond
            $0.showsCursor = settings.showsCursor
        }
        timer.resume()
    }

    public func update(_ settings: CaptureSettings) async throws {
        Self.counters.withLock {
            $0.updates += 1
            $0.showsCursor = settings.showsCursor
        }
    }

    public func stop() async {
        let timer = running.withLockUnchecked { current -> DispatchSourceTimer? in
            defer { current = nil }
            return current
        }
        guard let timer else { return }
        timer.cancel()
        // The last tick may still be running on the queue; once this returns nothing more is delivered.
        queue.sync {}
        Self.counters.withLock { $0.stops += 1 }
    }
}

/// Pictures for one capture. Used from the capture queue only.
final class SyntheticPictures: @unchecked Sendable {
    private let pool: CVPixelBufferPool
    private let framesPerSecond: Int
    private var index: Int64 = 0

    init(width: Int, height: Int, framesPerSecond: Int) throws {
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var pool: CVPixelBufferPool?
        let status = CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
        guard status == kCVReturnSuccess, let pool else { throw FixtureFailure("pixel buffer pool: \(status)") }
        self.pool = pool
        self.framesPerSecond = framesPerSecond
    }

    func next() -> CapturedPicture? {
        var buffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let buffer else { return nil }
        FixturePattern.paint(buffer, frame: index)
        defer { index += 1 }
        return CapturedPicture(image: buffer, time: CMTime(value: index, timescale: CMTimeScale(framesPerSecond)),
                               displayTime: mach_absolute_time())
    }
}
#endif
