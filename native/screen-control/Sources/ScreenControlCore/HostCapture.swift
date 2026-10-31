import CoreMedia
import CoreVideo
import Foundation

#if os(macOS)
// The Mac's capture as a session controls it (DESIGN 「여러 디스플레이」): which display the phone sees and whether the
// Mac's cursor is in the picture. ScreenCaptureKit stays in ScreenHost behind `DisplayCapturing`, so checks run the
// same logic against a stand-in.

/// A display as the capture names it: its CGDirectDisplayID and its size in points.
public struct CaptureDisplay: Sendable, Equatable {
    public let id: UInt32
    public let width: Int
    public let height: Int

    public init(id: UInt32, width: Int, height: Int) {
        self.id = id
        self.width = width
        self.height = height
    }
}

/// What a capture is asked for. Sizes are even: 4:2:0 needs them so.
public struct CaptureSettings: Sendable, Equatable {
    public var width: Int
    public var height: Int
    public var framesPerSecond: Int
    public var showsCursor: Bool

    public init(width: Int, height: Int, framesPerSecond: Int = 30, showsCursor: Bool = true) {
        self.width = width & ~1
        self.height = height & ~1
        self.framesPerSecond = framesPerSecond
        self.showsCursor = showsCursor
    }
}

/// How large the picture is next to the display.
public enum CaptureSizing: Sendable, Equatable {
    /// No wider than this many pixels and never larger than the display: the phone's default (DESIGN S0-4).
    case fitWidth(Int)
    /// This fraction of the display (the self-test).
    case scale(Double)

    public func size(of display: CaptureDisplay) -> (width: Int, height: Int) {
        let factor = switch self {
        case .fitWidth(let width): min(1, Double(width) / Double(max(1, display.width)))
        case .scale(let scale): scale
        }
        return (max(2, Int(Double(display.width) * factor)), max(2, Int(Double(display.height) * factor)))
    }
}

/// One captured picture.
public struct CapturedPicture: @unchecked Sendable {
    public let image: CVPixelBuffer
    public let time: CMTime
    /// When the display showed it (mach absolute time), for latency.
    public let displayTime: UInt64

    public init(image: CVPixelBuffer, time: CMTime, displayTime: UInt64) {
        self.image = image
        self.time = time
        self.displayTime = displayTime
    }
}

/// A display capture: ScreenCaptureKit on the Mac (ScreenHost), a stand-in in checks. One capture at a time.
public protocol DisplayCapturing: Sendable {
    /// The displays now, the main display first. Throws when there is none.
    func displays() async throws -> [CaptureDisplay]
    /// Starts capturing `display`; pictures go to `deliver` until `stop`.
    func start(_ display: CaptureDisplay, settings: CaptureSettings,
               deliver: @escaping @Sendable (CapturedPicture) -> Void) async throws
    /// Changes the running capture in place: the cursor, without a new stream or a new keyframe.
    func update(_ settings: CaptureSettings) async throws
    func stop() async
}

/// How many displays a session may choose between, and the one it shows, from 0.
public struct DisplayChoice: Sendable, Equatable {
    public let count: Int
    public let current: Int

    public init(count: Int, current: Int) {
        self.count = count
        self.current = current
    }
}

/// The capture as `VideoPump` controls it for a version-2 phone.
public protocol CaptureControl: Sendable {
    func choice() async -> DisplayChoice
    /// Shows display `index` of the Mac's list read again now. An index past the end, or the display already shown,
    /// changes nothing. Throws only when neither that display nor the one before can be captured.
    func select(_ index: Int) async throws -> DisplayChoice
    /// Shows the next display, after the last the first.
    func selectNext() async throws -> DisplayChoice
    /// Puts the Mac's cursor in the picture or leaves it out. Remembered for later displays.
    func setCursorVisible(_ visible: Bool) async throws
    func setVideoQuality(_ quality: ScreenVideoQuality) async throws
}

extension CaptureControl {
    public func setVideoQuality(_ quality: ScreenVideoQuality) async throws { throw HostCaptureError.unsupportedQuality }
}

public enum HostCaptureError: Error, Sendable {
    case noDisplay, unsupportedQuality
}

/// One session's capture: the display it shows, the encoder that matches it, and where input lands. A display change
/// stops the capture, gives the pump a new encoder for the new size (its first frame is a keyframe with new parameter
/// sets; pictures still arriving from the old display are skipped), points input at the new display, then captures
/// again. If the new display cannot be captured, it goes back to the one before.
public actor HostCapture: CaptureControl {
    private let backend: any DisplayCapturing
    private let pump: VideoPump
    private var sizing: CaptureSizing
    private var framesPerSecond: Int
    private var bitRate: Int
    private let onDisplay: @Sendable (CaptureDisplay) -> Void
    private let observe: (@Sendable (CapturedPicture) -> Void)?
    private var displays: [CaptureDisplay] = []
    /// Index into `displays` of the display shown; nil before the first and after it went away.
    private var current: Int?
    private var settings: CaptureSettings?
    private var showsCursor = true
    private var stopped = false

    /// `onDisplay` hears each display before its capture starts: InputInjector maps the phone's pointer onto it.
    /// `observe` sees each picture the pump took (the self-test's measurements).
    public init(backend: any DisplayCapturing, pump: VideoPump, sizing: CaptureSizing = .fitWidth(1920),
                framesPerSecond: Int = 30, bitRate: Int = 4_000_000,
                onDisplay: @escaping @Sendable (CaptureDisplay) -> Void = { _ in },
                observe: (@Sendable (CapturedPicture) -> Void)? = nil) {
        self.backend = backend
        self.pump = pump
        self.sizing = sizing
        self.framesPerSecond = framesPerSecond
        self.bitRate = bitRate
        self.onDisplay = onDisplay
        self.observe = observe
    }

    /// Starts on the main display, the first the backend lists.
    public func start() async throws {
        displays = Array(try await backend.displays().prefix(ControlMessage.maxDisplays))
        guard !displays.isEmpty else { throw HostCaptureError.noDisplay }
        try await show(0)
    }

    public func choice() -> DisplayChoice { DisplayChoice(count: max(1, displays.count), current: current ?? 0) }

    public func select(_ index: Int) async throws -> DisplayChoice {
        await refresh()
        if displays.indices.contains(index), index != current { try await switchTo(index) }
        return choice()
    }

    public func selectNext() async throws -> DisplayChoice {
        await refresh()
        let next = ((current ?? -1) + 1) % max(1, displays.count)
        if next != current { try await switchTo(next) }
        return choice()
    }

    public func setCursorVisible(_ visible: Bool) async throws {
        showsCursor = visible
        guard var changed = settings, changed.showsCursor != visible, !stopped else { return }
        changed.showsCursor = visible
        try await backend.update(changed)
        settings = changed
    }

    public func stop() async {
        stopped = true
        await backend.stop()
    }

    public func setVideoQuality(_ quality: ScreenVideoQuality) async throws {
        guard !stopped, let current else { throw CancellationError() }
        let sizing = CaptureSizing.fitWidth(quality.maximumWidth)
        guard self.sizing != sizing || framesPerSecond != quality.framesPerSecond || bitRate != quality.bitRate else { return }
        let previous = (self.sizing, framesPerSecond, bitRate)
        self.sizing = sizing; framesPerSecond = quality.framesPerSecond; bitRate = quality.bitRate
        await backend.stop()
        do { try await show(current) }
        catch {
            self.sizing = previous.0; framesPerSecond = previous.1; bitRate = previous.2
            try? await show(current)
            throw error
        }
    }

    /// Reads the displays again (one may have come or gone), keeping the shown display's place by its ID. A list that
    /// cannot be read leaves the last one.
    private func refresh() async {
        guard let fresh = try? await backend.displays(), !fresh.isEmpty else { return }
        let shown = current.map { displays[$0] }
        displays = Array(fresh.prefix(ControlMessage.maxDisplays))
        current = shown.flatMap { shown in displays.firstIndex { $0.id == shown.id } }
    }

    private func switchTo(_ index: Int) async throws {
        let previous = current.map { displays[$0] }
        await backend.stop()
        do {
            try await show(index)
        } catch {
            current = nil
            guard let previous, let back = displays.firstIndex(of: previous) else { throw error }
            try await show(back)
        }
    }

    private func show(_ index: Int) async throws {
        guard !stopped else { throw CancellationError() }
        let display = displays[index]
        let size = sizing.size(of: display)
        let settings = CaptureSettings(width: size.width, height: size.height, framesPerSecond: framesPerSecond,
                                       showsCursor: showsCursor)
        var encoder = VideoEncoder.Settings(width: settings.width, height: settings.height)
        encoder.averageBitRate = bitRate
        encoder.framesPerSecond = framesPerSecond
        let generation = try pump.restartEncoder(encoder)
        onDisplay(display)
        try await backend.start(display, settings: settings) { [pump, observe] picture in
            if pump.offer(picture.image, at: picture.time, generation: generation) { observe?(picture) }
        }
        current = index
        self.settings = settings
        // Stopped while starting: nothing may keep capturing.
        if stopped {
            await backend.stop()
            throw CancellationError()
        }
    }
}
#endif
