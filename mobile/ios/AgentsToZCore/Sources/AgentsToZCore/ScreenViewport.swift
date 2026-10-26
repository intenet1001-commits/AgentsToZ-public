import CoreGraphics
import Foundation

// The gesture math of the Mac screen viewer (DESIGN 「screen-control」 S2 입력 모드), kept free of UIKit so it is
// checked without a device. A Mac position is a fraction 0...1 of the picture on each axis — what
// `InputEvent.pointerMove` carries; the Mac ends the session on anything outside it, so every result here stays in.

/// Where the Mac's picture sits on the phone: fitted inside the view (letterboxed), zoomed 1x...4x and panned.
/// `bounds` is the view in points, `videoSize` the stream's pixel size.
public struct ScreenViewport: Equatable, Sendable {
    public static let minimumZoom: CGFloat = 1
    public static let maximumZoom: CGFloat = 4

    public private(set) var bounds: CGSize
    public private(set) var videoSize: CGSize
    public private(set) var zoom: CGFloat = 1
    /// How far the zoomed content is moved from centred, in view points.
    public private(set) var offset = CGPoint.zero

    public init(bounds: CGSize = .zero, videoSize: CGSize = .zero) {
        self.bounds = bounds
        self.videoSize = videoSize
        clamp()
    }

    public var isZoomed: Bool { zoom > Self.minimumZoom + 0.001 }

    /// The frame for the display layer: the view scaled about its centre, then moved by the pan. The layer fits the
    /// picture inside it, so the picture lands exactly on `pictureRect`.
    public var contentFrame: CGRect {
        CGRect(x: bounds.width / 2 * (1 - zoom) + offset.x, y: bounds.height / 2 * (1 - zoom) + offset.y,
               width: bounds.width * zoom, height: bounds.height * zoom)
    }

    /// The picture on screen, letterbox excluded. Empty before the first picture.
    public var pictureRect: CGRect {
        guard hasPicture else { return .zero }
        return Self.aspectFit(videoSize, in: contentFrame)
    }

    /// Mac picture pixels per view point at this zoom: how far a finger movement goes on the Mac.
    public var pixelsPerPoint: CGFloat {
        let rect = pictureRect
        return rect.width > 0 ? videoSize.width / rect.width : 1
    }

    /// A view point as a Mac position. On the letterbox it is nil, or the nearest edge when `clamped` (a drag that
    /// strays past the picture keeps going along its edge).
    public func macPoint(at location: CGPoint, clamped: Bool = false) -> CGPoint? {
        let rect = pictureRect
        guard rect.width > 0, rect.height > 0, location.x.isFinite, location.y.isFinite else { return nil }
        let point = CGPoint(x: (location.x - rect.minX) / rect.width, y: (location.y - rect.minY) / rect.height)
        if clamped { return point.clampedToUnit }
        return (0...1).contains(point.x) && (0...1).contains(point.y) ? point : nil
    }

    /// Where a Mac position shows on screen; off screen when zoomed away from it.
    public func viewPoint(for mac: CGPoint) -> CGPoint {
        let rect = pictureRect
        return CGPoint(x: rect.minX + mac.x * rect.width, y: rect.minY + mac.y * rect.height)
    }

    /// A new view size (rotation) or picture size (the Mac changed resolution); the zoom and pan stay where they can.
    public mutating func resize(bounds: CGSize, videoSize: CGSize) {
        guard bounds != self.bounds || videoSize != self.videoSize else { return }
        self.bounds = bounds
        self.videoSize = videoSize
        clamp()
    }

    /// Pinch: zoom by `scale` within 1x...4x, keeping the content under `anchor` under it.
    public mutating func zoom(by scale: CGFloat, around anchor: CGPoint) {
        guard scale.isFinite, scale > 0, anchor.x.isFinite, anchor.y.isFinite else { return }
        let newZoom = min(max(zoom * scale, Self.minimumZoom), Self.maximumZoom)
        let centre = CGPoint(x: bounds.width / 2, y: bounds.height / 2)
        // The unzoomed point under the anchor, relative to the centre.
        let x = (anchor.x - centre.x - offset.x) / zoom, y = (anchor.y - centre.y - offset.y) / zoom
        offset = CGPoint(x: anchor.x - centre.x - x * newZoom, y: anchor.y - centre.y - y * newZoom)
        zoom = newZoom
        clamp()
    }

    public mutating func pan(by translation: CGPoint) {
        guard translation.x.isFinite, translation.y.isFinite, translation != .zero else { return }
        offset.x += translation.x
        offset.y += translation.y
        clamp()
    }

    public mutating func reset() {
        zoom = Self.minimumZoom
        offset = .zero
    }

    /// Trackpad mode: moves the view the least needed to keep `mac` (the cursor) at least `margin` points inside it.
    /// Only while zoomed; at 1x the whole picture is on screen already.
    public mutating func follow(_ mac: CGPoint, margin: CGFloat) {
        guard isZoomed, hasPicture else { return }
        let point = viewPoint(for: mac)
        pan(by: CGPoint(x: Self.shift(point.x, span: bounds.width, margin: margin),
                        y: Self.shift(point.y, span: bounds.height, margin: margin)))
    }

    public static func aspectFit(_ size: CGSize, in rect: CGRect) -> CGRect {
        guard size.width > 0, size.height > 0 else { return .zero }
        let scale = min(rect.width / size.width, rect.height / size.height)
        let width = size.width * scale, height = size.height * scale
        return CGRect(x: rect.midX - width / 2, y: rect.midY - height / 2, width: width, height: height)
    }

    private var hasPicture: Bool {
        videoSize.width > 0 && videoSize.height > 0 && bounds.width > 0 && bounds.height > 0
    }

    /// The picture covers the view on an axis where it is larger than the view and is centred where it is not, so
    /// panning never shows more letterbox than fitting already does.
    private mutating func clamp() {
        guard bounds.width > 0, bounds.height > 0, zoom.isFinite, offset.x.isFinite, offset.y.isFinite else {
            reset()
            return
        }
        let rect = hasPicture ? pictureRect : contentFrame
        offset.x += Self.correction(start: rect.minX, length: rect.width, span: bounds.width)
        offset.y += Self.correction(start: rect.minY, length: rect.height, span: bounds.height)
    }

    private static func correction(start: CGFloat, length: CGFloat, span: CGFloat) -> CGFloat {
        if length <= span { return (span - length) / 2 - start }
        if start > 0 { return -start }
        if start + length < span { return span - (start + length) }
        return 0
    }

    private static func shift(_ position: CGFloat, span: CGFloat, margin: CGFloat) -> CGFloat {
        let inset = min(max(margin, 0), span / 2)
        if position < inset { return inset - position }
        if position > span - inset { return span - inset - position }
        return 0
    }
}

/// Speed-dependent gain: slow movements go 1:1 for precise pointing, quick ones further, never outside
/// `minimumGain...maximumGain`.
public struct PointerAcceleration: Equatable, Sendable {
    /// Points per second at and below which the gain is `minimumGain`.
    public var slowSpeed: CGFloat
    /// Points per second at and above which the gain is `maximumGain`.
    public var fastSpeed: CGFloat
    public var minimumGain: CGFloat
    public var maximumGain: CGFloat

    public init(slowSpeed: CGFloat, fastSpeed: CGFloat, minimumGain: CGFloat, maximumGain: CGFloat) {
        self.slowSpeed = slowSpeed
        self.fastSpeed = max(fastSpeed, slowSpeed + 1)
        self.minimumGain = minimumGain
        self.maximumGain = max(maximumGain, minimumGain)
    }

    /// The trackpad cursor: 1:1 when slow, up to 3x for a flick across the phone.
    public static let trackpad = PointerAcceleration(slowSpeed: 120, fastSpeed: 1200, minimumGain: 1, maximumGain: 3)
    /// Scrolling: content follows the fingers, a quick swipe goes up to twice as far.
    public static let scroll = PointerAcceleration(slowSpeed: 300, fastSpeed: 2400, minimumGain: 1, maximumGain: 2)

    public func gain(speed: CGFloat) -> CGFloat {
        guard speed.isFinite, speed > slowSpeed else { return minimumGain }
        let progress = min(1, (speed - slowSpeed) / (fastSpeed - slowSpeed))
        return minimumGain + (maximumGain - minimumGain) * progress
    }

    /// Trackpad mode: the cursor after the finger moved `delta` points at `speed` points per second, over a picture
    /// shown `pictureSize` points large (zooming in makes the cursor finer). It stays on the picture.
    public func move(_ cursor: CGPoint, by delta: CGPoint, speed: CGFloat, pictureSize: CGSize) -> CGPoint {
        guard pictureSize.width > 0, pictureSize.height > 0, delta.x.isFinite, delta.y.isFinite else {
            return cursor.clampedToUnit
        }
        let gain = gain(speed: speed)
        return CGPoint(x: cursor.x + delta.x * gain / pictureSize.width,
                       y: cursor.y + delta.y * gain / pictureSize.height).clampedToUnit
    }
}

/// Two-finger drags as Mac scroll messages. Content follows the fingers (finger down → positive dy, the viewer's
/// existing convention), scaled from view points to Mac picture pixels, sent in whole pixels with the remainder
/// carried so slow scrolls are not lost to rounding, and never above the Mac's per-message limit (an over-limit
/// message is malformed there and ends the session).
public struct ScrollScaler: Equatable, Sendable {
    public let maximumDelta: Double
    public var acceleration = PointerAcceleration.scroll
    private var pending = CGPoint.zero

    public init(maximumDelta: Double = 4000) { self.maximumDelta = max(1, maximumDelta) }

    /// Adds a finger movement of `delta` view points at `speed` points per second.
    public mutating func add(_ delta: CGPoint, speed: CGFloat, pixelsPerPoint: CGFloat) {
        guard delta.x.isFinite, delta.y.isFinite, pixelsPerPoint.isFinite, pixelsPerPoint > 0 else { return }
        let scale = pixelsPerPoint * acceleration.gain(speed: speed)
        pending.x += delta.x * scale
        pending.y += delta.y * scale
    }

    /// The whole pixels to send now, or nil when there are none yet. What exceeds the limit is dropped, not queued:
    /// a scroll that keeps going after the fingers stop feels broken.
    public mutating func take() -> (dx: Double, dy: Double)? {
        let dx = Double(pending.x).rounded(.towardZero), dy = Double(pending.y).rounded(.towardZero)
        guard dx != 0 || dy != 0 else { return nil }
        pending.x -= CGFloat(dx)
        pending.y -= CGFloat(dy)
        return (min(max(dx, -maximumDelta), maximumDelta), min(max(dy, -maximumDelta), maximumDelta))
    }

    /// Whether no whole pixel is waiting (a fraction may be).
    public var isEmpty: Bool { abs(pending.x) < 1 && abs(pending.y) < 1 }

    public mutating func reset() { pending = .zero }
}

/// The glide after a two-finger flick, as on the phone's own lists: the release velocity decays exponentially until it
/// is slow, or for at most a few seconds. A new touch stops it.
public struct ScrollMomentum: Equatable, Sendable {
    /// Release speeds below this (points per second) do not glide.
    public static let startSpeed: CGFloat = 250
    public static let stopSpeed: CGFloat = 20
    /// The fraction of the velocity left after one second.
    public static let remainingPerSecond: CGFloat = 0.12
    public static let maximumDuration: Double = 2.5

    public private(set) var velocity: CGPoint
    private var elapsed: Double = 0

    public init?(velocity: CGPoint) {
        guard velocity.x.isFinite, velocity.y.isFinite, hypot(velocity.x, velocity.y) >= Self.startSpeed else { return nil }
        self.velocity = velocity
    }

    public var speed: CGFloat { hypot(velocity.x, velocity.y) }

    /// The distance in view points to scroll over the next `seconds`, or nil once the glide is over. A long gap
    /// (the app stalled) counts as at most a tenth of a second, so the glide never jumps.
    public mutating func step(_ seconds: Double) -> CGPoint? {
        guard seconds.isFinite, seconds > 0 else { return .zero }
        let dt = min(seconds, 0.1)
        elapsed += dt
        guard elapsed <= Self.maximumDuration, speed >= Self.stopSpeed else { return nil }
        let remaining = pow(Self.remainingPerSecond, CGFloat(dt))
        // The exact integral of v·r^t over dt, so the total does not depend on the frame rate.
        let travel = (remaining - 1) / log(Self.remainingPerSecond)
        let distance = CGPoint(x: velocity.x * travel, y: velocity.y * travel)
        velocity = CGPoint(x: velocity.x * remaining, y: velocity.y * remaining)
        return distance
    }
}

/// What a two-finger gesture means, decided once per gesture: the fingers spreading or closing zooms, moving together
/// scrolls. Until either is clear nothing happens, so a scroll does not start by zooming a little.
public enum TwoFingerIntent: Equatable, Sendable {
    case undecided, zoom, scroll

    /// A spread change of a tenth (either way) zooms.
    public static let zoomThreshold: CGFloat = 0.1
    /// Points the fingers' centre travels before it is a scroll.
    public static let scrollThreshold: CGFloat = 14

    /// `scale` is the pinch scale since the gesture began (1 = unchanged), `travel` how far the fingers' centre moved.
    public static func classify(scale: CGFloat, travel: CGFloat) -> TwoFingerIntent {
        if scale.isFinite, scale > 0, abs(log(scale)) >= log(1 + zoomThreshold) { return .zoom }
        if travel.isFinite, travel >= scrollThreshold { return .scroll }
        return .undecided
    }
}

/// Double-tapping on glass lands a few points apart, which the Mac (4 pixels of tolerance, at several Mac pixels per
/// phone point) would take as two single clicks. A tap soon after and near the first one reuses its Mac position —
/// near on the Mac as well as on the glass: at 1x on a phone 16 points are three Finder rows, and a quick tap on the
/// next row or the next calculator key has to click there, not double-click the first one.
public struct TapSnap: Sendable {
    public var interval: Double = 0.5
    /// In view points.
    public var radius: CGFloat = 16
    /// In Mac picture pixels (about Mac points: the picture is never larger than the display's point size), the
    /// furthest a snap moves a click. A third of a 24-point list row, so it never reaches the middle of the next row.
    /// Zoomed out on a phone that is under two points on the glass, so a double click there wants zooming in, or the
    /// trackpad mode, whose taps all land on the cursor.
    public var macRadius: CGFloat = 8
    /// The first tap of a run. Later taps are measured from it, not from the tap before, so a run of quick taps cannot
    /// creep down a list.
    private var last: (location: CGPoint, mac: CGPoint, time: Double)?

    public init() {}

    /// The Mac position to click for a tap at `location` (view points) that maps to `mac`, at `time` seconds, on a
    /// picture `pictureSize` Mac pixels large.
    public mutating func position(for mac: CGPoint, at location: CGPoint, time: Double, pictureSize: CGSize) -> CGPoint {
        if let last, time - last.time >= 0, time - last.time <= interval,
           pictureSize.width > 0, pictureSize.height > 0,
           hypot(location.x - last.location.x, location.y - last.location.y) <= radius,
           hypot((mac.x - last.mac.x) * pictureSize.width, (mac.y - last.mac.y) * pictureSize.height) <= macRadius {
            self.last = (last.location, last.mac, time)
            return last.mac
        }
        last = (location, mac, time)
        return mac
    }

    public mutating func reset() { last = nil }
}

/// Coalesces pointer moves and scrolls to one of each per interval (60 a second by default) so a 120 Hz display can
/// never approach the Mac's input rate limit, whose excess it silently drops. Clicks and keys are not paced.
public struct MotionPacer: Equatable, Sendable {
    public let interval: Double
    /// Display ticks jitter; a tick this much early still counts.
    public var tolerance: Double = 0.002
    private var last: Double?

    public init(perSecond: Double = 60) { interval = 1 / max(1, perSecond) }

    public mutating func ready(at time: Double) -> Bool {
        if let last, time - last < interval - tolerance, time >= last { return false }
        last = time
        return true
    }
}

/// Text for the Mac's Unicode typing: control characters dropped (the Mac ends the session on them) and the rest in
/// pieces of at most `maxBytes` UTF-8 bytes, split between characters. A single character larger than a piece is left
/// out rather than sent malformed.
public enum ScreenTextPieces {
    public static func pieces(of text: String, maxBytes: Int) -> [String] {
        var pieces: [String] = [], piece = ""
        for character in text {
            guard !character.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) else { continue }
            let size = String(character).utf8.count
            guard size <= maxBytes else { continue }
            if piece.utf8.count + size > maxBytes {
                pieces.append(piece)
                piece = ""
            }
            piece.append(character)
        }
        if !piece.isEmpty { pieces.append(piece) }
        return pieces
    }
}

extension CGPoint {
    /// Inside 0...1 on both axes; not-a-number goes to the middle.
    public var clampedToUnit: CGPoint {
        func unit(_ value: CGFloat) -> CGFloat { value.isNaN ? 0.5 : min(max(value, 0), 1) }
        return CGPoint(x: unit(x), y: unit(y))
    }
}
