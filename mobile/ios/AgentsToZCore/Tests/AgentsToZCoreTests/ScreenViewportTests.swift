import CoreGraphics
import Foundation
#if !CORE_CHECKS
@testable import AgentsToZCore
#endif

/// The Mac screen viewer's gesture math (`ScreenViewport.swift`). The Mac ends a session on a pointer outside 0...1
/// or a scroll over its limit, so the bounds here are the session's, not cosmetics.
struct ScreenViewportChecks {
    /// iPhone portrait showing a 1720×720 Mac picture: letterboxed above and below.
    private let phone = CGSize(width: 390, height: 844)
    private let mac = CGSize(width: 1720, height: 720)

    func runAll() throws {
        try testLetterboxMappingAtOneX()
        try testPinchKeepsTheContentUnderTheFingers()
        try testZoomStaysBetweenOneAndFourX()
        try testPanNeverShowsMoreThanTheLetterbox()
        try testEveryZoomAndPanMapsBackExactly()
        try testTrackpadFollowKeepsTheCursorOnScreen()
        try testRotationKeepsThePictureCovering()
        try testTrackpadAccelerationStaysInBounds()
        try testScrollFollowsTheFingersInWholePixelsWithinTheLimit()
        try testMomentumDecaysTheSameAtAnyFrameRate()
        try testTwoFingerGestureIsZoomOrScrollNotBoth()
        try testDoubleTapReusesTheFirstTapsPosition()
        try testQuickTapOnTheNextTargetClicksThere()
        try testPacerKeepsMotionUnderTheMacRateLimit()
        try testTypedTextPiecesAreWhatTheMacAccepts()
    }

    func testLetterboxMappingAtOneX() throws {
        let viewport = ScreenViewport(bounds: phone, videoSize: mac)
        let picture = viewport.pictureRect
        try checkClose(picture.width, 390)
        try checkClose(picture.height, 390 * 720 / 1720)
        try checkClose(picture.midY, 422)
        try checkClose(viewport.pixelsPerPoint, 1720 / 390)
        try checkPoint(viewport.macPoint(at: CGPoint(x: 195, y: 422)), CGPoint(x: 0.5, y: 0.5))
        try checkPoint(viewport.macPoint(at: CGPoint(x: picture.minX, y: picture.minY)), .zero)
        try checkPoint(viewport.macPoint(at: CGPoint(x: picture.maxX, y: picture.maxY), clamped: true), CGPoint(x: 1, y: 1))
        // The letterbox is not the Mac: a tap there does nothing, a drag that strays there runs along the edge.
        try checkTrue(viewport.macPoint(at: CGPoint(x: 195, y: 20)) == nil)
        try checkTrue(viewport.macPoint(at: CGPoint(x: 195, y: 830)) == nil)
        try checkPoint(viewport.macPoint(at: CGPoint(x: 100, y: 20), clamped: true), CGPoint(x: 100.0 / 390, y: 0))
        try checkTrue(viewport.macPoint(at: CGPoint(x: CGFloat.nan, y: 422)) == nil)
        // Before the first picture there is nothing to map onto.
        try checkTrue(ScreenViewport(bounds: phone).macPoint(at: CGPoint(x: 195, y: 422)) == nil)
        try checkFalse(viewport.isZoomed)
    }

    func testPinchKeepsTheContentUnderTheFingers() throws {
        // Landscape, pinching off-centre where no edge stops the pan.
        var viewport = ScreenViewport(bounds: CGSize(width: 844, height: 390), videoSize: mac)
        let anchor = CGPoint(x: 600, y: 200)
        let before = try unwrap(viewport.macPoint(at: anchor))
        viewport.zoom(by: 2, around: anchor)
        try checkClose(viewport.zoom, 2)
        try checkPoint(viewport.macPoint(at: anchor), before)
        viewport.zoom(by: 1.5, around: anchor)
        try checkPoint(viewport.macPoint(at: anchor), before)
        // Zooming in makes a finger movement finer on the Mac.
        try checkClose(viewport.pixelsPerPoint, 1720 / (844 * 3))
    }

    func testZoomStaysBetweenOneAndFourX() throws {
        var viewport = ScreenViewport(bounds: phone, videoSize: mac)
        // About 1x–4x: further in, a phone shows too little of the Mac to find anything.
        viewport.zoom(by: 100, around: CGPoint(x: 195, y: 422))
        try checkClose(viewport.zoom, 4)
        viewport.zoom(by: 0.001, around: CGPoint(x: 10, y: 10))
        try checkClose(viewport.zoom, 1)
        try checkPoint(viewport.offset, .zero)
        for bad in [CGFloat.nan, .infinity, 0, -2] {
            viewport.zoom(by: bad, around: CGPoint(x: 195, y: 422))
            try checkClose(viewport.zoom, 1)
        }
        viewport.zoom(by: 3, around: CGPoint(x: 195, y: 422))
        viewport.reset()
        try checkFalse(viewport.isZoomed)
        try checkEqual(viewport.pictureRect, ScreenViewport(bounds: phone, videoSize: mac).pictureRect)
    }

    func testPanNeverShowsMoreThanTheLetterbox() throws {
        // At 1x the whole picture shows; there is nowhere to pan.
        var viewport = ScreenViewport(bounds: phone, videoSize: mac)
        viewport.pan(by: CGPoint(x: 300, y: -300))
        try checkPoint(viewport.offset, .zero)
        viewport.zoom(by: 4, around: CGPoint(x: 195, y: 422))
        // 1560 wide on a 390-point screen: the picture always covers the width. 653 tall on 844: stays centred.
        viewport.pan(by: CGPoint(x: 10_000, y: 10_000))
        try checkClose(viewport.pictureRect.minX, 0)
        try checkClose(viewport.pictureRect.midY, 422)
        viewport.pan(by: CGPoint(x: -10_000, y: -10_000))
        try checkClose(viewport.pictureRect.maxX, 390)
        try checkClose(viewport.pictureRect.midY, 422)
        viewport.pan(by: CGPoint(x: CGFloat.nan, y: 0))
        try checkClose(viewport.pictureRect.maxX, 390)
    }

    func testEveryZoomAndPanMapsBackExactly() throws {
        var random = SeededRandom(seed: 0x5C4EE4)
        for bounds in [phone, CGSize(width: 844, height: 390), CGSize(width: 1024, height: 1366)] {
            var viewport = ScreenViewport(bounds: bounds, videoSize: mac)
            for _ in 0..<400 {
                let anchor = CGPoint(x: random.next(in: 0...bounds.width), y: random.next(in: 0...bounds.height))
                if random.next(in: 0...1) < 0.5 {
                    viewport.zoom(by: random.next(in: 0.6...1.7), around: anchor)
                } else {
                    viewport.pan(by: CGPoint(x: random.next(in: -400...400), y: random.next(in: -400...400)))
                }
                try checkTrue((ScreenViewport.minimumZoom...ScreenViewport.maximumZoom).contains(viewport.zoom))
                let picture = viewport.pictureRect
                // Wherever the picture is larger than the view it covers it; elsewhere it is centred.
                if picture.width > bounds.width + 0.001 {
                    try checkTrue(picture.minX <= 0.001 && picture.maxX >= bounds.width - 0.001)
                } else {
                    try checkClose(picture.midX, bounds.width / 2)
                }
                if picture.height > bounds.height + 0.001 {
                    try checkTrue(picture.minY <= 0.001 && picture.maxY >= bounds.height - 0.001)
                } else {
                    try checkClose(picture.midY, bounds.height / 2)
                }
                let target = CGPoint(x: random.next(in: 0...1), y: random.next(in: 0...1))
                try checkPoint(viewport.macPoint(at: viewport.viewPoint(for: target), clamped: true), target)
                // Any point on screen, clamped, is a position the Mac accepts.
                let anywhere = viewport.macPoint(at: anchor, clamped: true)
                try checkTrue(anywhere.map { (0...1).contains($0.x) && (0...1).contains($0.y) } ?? false)
            }
        }
    }

    func testTrackpadFollowKeepsTheCursorOnScreen() throws {
        var viewport = ScreenViewport(bounds: phone, videoSize: mac)
        let unchanged = viewport
        viewport.follow(CGPoint(x: 0.99, y: 0.5), margin: 48)
        try checkEqual(viewport, unchanged)
        viewport.zoom(by: 3, around: CGPoint(x: 195, y: 422))
        for cursor in [CGPoint(x: 0.99, y: 0.5), CGPoint(x: 0.01, y: 0.02), CGPoint(x: 1, y: 1), CGPoint(x: 0, y: 0)] {
            viewport.follow(cursor, margin: 48)
            let point = viewport.viewPoint(for: cursor)
            // Within the margin unless the picture's own edge is closer (the cursor in the very corner).
            try checkTrue(point.x >= -0.001 && point.x <= phone.width + 0.001)
            try checkTrue(point.y >= -0.001 && point.y <= phone.height + 0.001)
            let picture = viewport.pictureRect
            try checkTrue(point.x >= min(48, point.x - picture.minX) - 0.001)
            try checkTrue(point.x <= max(phone.width - 48, phone.width - (picture.maxX - point.x)) + 0.001)
        }
        // A cursor already well inside does not move the view.
        viewport.follow(CGPoint(x: 0.5, y: 0.5), margin: 48)
        let settled = viewport
        viewport.follow(try unwrap(viewport.macPoint(at: CGPoint(x: 195, y: 422))), margin: 48)
        try checkEqual(viewport, settled)
    }

    func testRotationKeepsThePictureCovering() throws {
        var viewport = ScreenViewport(bounds: phone, videoSize: mac)
        viewport.zoom(by: 4, around: CGPoint(x: 380, y: 422))
        viewport.pan(by: CGPoint(x: -10_000, y: 0))
        viewport.resize(bounds: CGSize(width: 844, height: 390), videoSize: mac)
        try checkClose(viewport.zoom, 4)
        let picture = viewport.pictureRect
        try checkTrue(picture.minX <= 0.001 && picture.maxX >= 843.999)
        try checkTrue(picture.minY <= 0.001 && picture.maxY >= 389.999)
        // The Mac changing resolution re-fits the picture under the same zoom.
        viewport.resize(bounds: CGSize(width: 844, height: 390), videoSize: CGSize(width: 1512, height: 982))
        try checkClose(viewport.pictureRect.width / viewport.pictureRect.height, 1512 / 982)
    }

    func testTrackpadAccelerationStaysInBounds() throws {
        let acceleration = PointerAcceleration.trackpad
        try checkClose(acceleration.gain(speed: 0), 1)
        try checkClose(acceleration.gain(speed: 120), 1)
        try checkClose(acceleration.gain(speed: 1200), 3)
        for speed: CGFloat in [-50, .nan, .infinity, -.infinity, 1e12] {
            try checkTrue((1...3).contains(acceleration.gain(speed: speed)))
        }
        var previous: CGFloat = 0
        for speed in stride(from: CGFloat(0), through: 3000, by: 25) {
            let gain = acceleration.gain(speed: speed)
            try checkTrue(gain >= previous && (1...3).contains(gain))
            previous = gain
        }
        // Slow movement is 1:1 with the picture on screen; zooming in to twice the size halves the cursor's step.
        let middle = CGPoint(x: 0.5, y: 0.5)
        let step = acceleration.move(middle, by: CGPoint(x: 39, y: 0), speed: 50, pictureSize: CGSize(width: 390, height: 163))
        try checkClose(step.x, 0.6)
        let fine = acceleration.move(middle, by: CGPoint(x: 39, y: 0), speed: 50, pictureSize: CGSize(width: 780, height: 326))
        try checkClose(fine.x, 0.55)
        // It never leaves the picture, whatever the finger does.
        let far = acceleration.move(middle, by: CGPoint(x: 1e9, y: -1e9), speed: .infinity, pictureSize: CGSize(width: 390, height: 163))
        try checkPoint(far, CGPoint(x: 1, y: 0))
        try checkPoint(acceleration.move(CGPoint(x: 2, y: -1), by: CGPoint(x: CGFloat.nan, y: 0), speed: 0,
                                         pictureSize: CGSize(width: 390, height: 163)), CGPoint(x: 1, y: 0))
        try checkPoint(acceleration.move(middle, by: CGPoint(x: 10, y: 10), speed: 0, pictureSize: .zero), middle)
    }

    func testScrollFollowsTheFingersInWholePixelsWithinTheLimit() throws {
        var scaler = ScrollScaler(maximumDelta: 4000)
        // Fingers moving down scroll the content down with them (positive dy), at the picture's scale.
        scaler.add(CGPoint(x: 0, y: 10), speed: 100, pixelsPerPoint: 4.4)
        let down = try unwrap(scaler.take())
        try checkEqual(down.dy, 44)
        try checkEqual(down.dx, 0)
        scaler.add(CGPoint(x: -10, y: 0), speed: 100, pixelsPerPoint: 1)
        try checkEqual(try unwrap(scaler.take()).dx, -10)
        // Slow scrolls are not lost to rounding: the remainder carries.
        scaler.reset()
        for _ in 0..<3 { scaler.add(CGPoint(x: 0, y: 0.3), speed: 10, pixelsPerPoint: 1) }
        try checkTrue(scaler.take() == nil)
        scaler.add(CGPoint(x: 0, y: 0.3), speed: 10, pixelsPerPoint: 1)
        try checkEqual(try unwrap(scaler.take()).dy, 1)
        // ...and what is left after a whole pixel goes out still counts.
        scaler.add(CGPoint(x: 0, y: 0.9), speed: 10, pixelsPerPoint: 1)
        try checkEqual(try unwrap(scaler.take()).dy, 1)
        // A quick swipe goes further, at most twice.
        scaler.reset()
        scaler.add(CGPoint(x: 0, y: 100), speed: 1e6, pixelsPerPoint: 1)
        try checkEqual(try unwrap(scaler.take()).dy, 200)
        // Never over the Mac's per-message limit, and never anything the Mac would reject.
        scaler.add(CGPoint(x: 1e7, y: -1e7), speed: 0, pixelsPerPoint: 10)
        let huge = try unwrap(scaler.take())
        try checkEqual(huge.dx, 4000)
        try checkEqual(huge.dy, -4000)
        try checkTrue(scaler.take() == nil)
        scaler.add(CGPoint(x: CGFloat.nan, y: 5), speed: 0, pixelsPerPoint: 1)
        scaler.add(CGPoint(x: 5, y: 5), speed: 0, pixelsPerPoint: .infinity)
        scaler.add(CGPoint(x: 5, y: 5), speed: 0, pixelsPerPoint: 0)
        try checkTrue(scaler.take() == nil)
        var random = SeededRandom(seed: 0xD15C0)
        for _ in 0..<500 {
            scaler.add(CGPoint(x: random.next(in: -900...900), y: random.next(in: -900...900)),
                       speed: random.next(in: 0...5000), pixelsPerPoint: random.next(in: 0.2...8))
            if let delta = scaler.take() {
                try checkTrue(delta.dx.isFinite && delta.dy.isFinite && abs(delta.dx) <= 4000 && abs(delta.dy) <= 4000)
                try checkEqual(delta.dx, delta.dx.rounded())
                try checkEqual(delta.dy, delta.dy.rounded())
            }
        }
    }

    func testMomentumDecaysTheSameAtAnyFrameRate() throws {
        try checkTrue(ScrollMomentum(velocity: CGPoint(x: 0, y: 200)) == nil)
        try checkTrue(ScrollMomentum(velocity: CGPoint(x: CGFloat.nan, y: 2000)) == nil)
        func glide(_ hertz: Double) throws -> (distance: CGPoint, seconds: Double) {
            var momentum = try unwrap(ScrollMomentum(velocity: CGPoint(x: 0, y: -1500)))
            var total = CGPoint.zero, seconds = 0.0
            while let step = momentum.step(1 / hertz) {
                total.x += step.x
                total.y += step.y
                seconds += 1 / hertz
                try checkTrue(step.y <= 0)
            }
            return (total, seconds)
        }
        let sixty = try glide(60), oneTwenty = try glide(120)
        try checkTrue(abs(sixty.distance.y - oneTwenty.distance.y) < abs(sixty.distance.y) * 0.01)
        // About v / ln(1 / 0.12) points, like a flicked list on the phone, and over within the time limit.
        try checkTrue(abs(sixty.distance.y + 1500 / log(1 / 0.12)) < 30)
        try checkTrue(sixty.seconds <= ScrollMomentum.maximumDuration + 0.02)
        try checkEqual(sixty.distance.x, 0)
        // A stall is one bounded step, not a jump.
        var stalled = try unwrap(ScrollMomentum(velocity: CGPoint(x: 0, y: 2000)))
        try checkTrue(try unwrap(stalled.step(5)).y <= 200)
    }

    func testTwoFingerGestureIsZoomOrScrollNotBoth() throws {
        try checkEqual(TwoFingerIntent.classify(scale: 1.12, travel: 0), .zoom)
        try checkEqual(TwoFingerIntent.classify(scale: 0.88, travel: 0), .zoom)
        try checkEqual(TwoFingerIntent.classify(scale: 1.15, travel: 30), .zoom)
        try checkEqual(TwoFingerIntent.classify(scale: 1.03, travel: 20), .scroll)
        try checkEqual(TwoFingerIntent.classify(scale: 1, travel: 14), .scroll)
        try checkEqual(TwoFingerIntent.classify(scale: 1.03, travel: 6), .undecided)
        try checkEqual(TwoFingerIntent.classify(scale: .nan, travel: .nan), .undecided)
        try checkEqual(TwoFingerIntent.classify(scale: 0, travel: 0), .undecided)
    }

    func testDoubleTapReusesTheFirstTapsPosition() throws {
        // Zoomed in 4x on a portrait iPhone: about 1.2 Mac pixels a phone point.
        let macSize = CGSize(width: 1920, height: 1200)
        var viewport = ScreenViewport(bounds: phone, videoSize: macSize)
        viewport.zoom(by: 4, around: CGPoint(x: 195, y: 422))
        var snap = TapSnap()
        let first = try tap(&snap, viewport, at: CGPoint(x: 195, y: 422), time: 10)
        try checkPoint(first, try unwrap(viewport.macPoint(at: CGPoint(x: 195, y: 422))))
        // The second tap of a double tap lands a few points off — further than the Mac's own 4 pixels — so it reuses
        // the first tap's Mac position and the Mac counts a double click.
        let second = try unwrap(viewport.macPoint(at: CGPoint(x: 199, y: 424)))
        try checkTrue(macDistance(second, first, on: macSize) > 4)
        try checkPoint(try tap(&snap, viewport, at: CGPoint(x: 199, y: 424), time: 10.25), first)
        // A third quick tap still counts (triple click selects a line).
        try checkPoint(try tap(&snap, viewport, at: CGPoint(x: 192, y: 425), time: 10.5), first)
        // Too late is a new click where the finger is.
        let late = CGPoint(x: 197, y: 422)
        try checkPoint(try tap(&snap, viewport, at: late, time: 11.2), try unwrap(viewport.macPoint(at: late)))
        // A run of quick taps a little further each time is measured from its first tap, so it cannot creep along.
        snap.reset()
        let start = try tap(&snap, viewport, at: CGPoint(x: 150, y: 422), time: 20)
        try checkPoint(try tap(&snap, viewport, at: CGPoint(x: 154, y: 422), time: 20.2), start)
        let creep = CGPoint(x: 158, y: 422)
        try checkPoint(try tap(&snap, viewport, at: creep, time: 20.4), try unwrap(viewport.macPoint(at: creep)))
        // Far on the glass is a new click even where the Mac picture is shown so large that it is near on the Mac —
        // also measured from the run's first tap, not the tap before.
        var tablet = ScreenViewport(bounds: CGSize(width: 1024, height: 1366), videoSize: CGSize(width: 1512, height: 982))
        tablet.zoom(by: 4, around: CGPoint(x: 512, y: 683))
        snap.reset()
        let near = try tap(&snap, tablet, at: CGPoint(x: 512, y: 683), time: 30)
        try checkPoint(try tap(&snap, tablet, at: CGPoint(x: 524, y: 683), time: 30.2), near)
        let far = CGPoint(x: 532, y: 683)
        try checkTrue(macDistance(try unwrap(tablet.macPoint(at: far)), near, on: tablet.videoSize) <= snap.macRadius)
        try checkPoint(try tap(&snap, tablet, at: far, time: 30.4), try unwrap(tablet.macPoint(at: far)))
        // Without a picture to measure on, nothing is snapped.
        snap.reset()
        let blind = CGPoint(x: 0.4, y: 0.4)
        try checkPoint(snap.position(for: blind, at: CGPoint(x: 100, y: 100), time: 40, pictureSize: .zero), blind)
        let blindAgain = CGPoint(x: 0.4001, y: 0.4)
        try checkPoint(snap.position(for: blindAgain, at: CGPoint(x: 101, y: 100), time: 40.2, pictureSize: .zero), blindAgain)
    }

    func testQuickTapOnTheNextTargetClicksThere() throws {
        // Portrait iPhone showing a 1920×1200 Mac at 1x: about 4.9 Mac pixels a phone point, so rows and keys a
        // few points apart on the glass are separate things on the Mac.
        let macSize = CGSize(width: 1920, height: 1200)
        let viewport = ScreenViewport(bounds: phone, videoSize: macSize)
        var snap = TapSnap()
        func tap(_ pixel: CGPoint, at time: Double) throws -> CGPoint {
            let location = viewport.viewPoint(for: CGPoint(x: pixel.x / macSize.width, y: pixel.y / macSize.height))
            let sent = try self.tap(&snap, viewport, at: location, time: time)
            return CGPoint(x: sent.x * macSize.width, y: sent.y * macSize.height)
        }
        // Finder: row A, then 0.3 s later the row below (24 Mac pixels, under 5 phone points). Snapped back to A,
        // the Mac would count a double click there and open A.
        try checkPoint(try tap(CGPoint(x: 900, y: 500), at: 20), CGPoint(x: 900, y: 500))
        try checkPoint(try tap(CGPoint(x: 900, y: 524), at: 20.3), CGPoint(x: 900, y: 524))
        // Calculator: '1' then '2' on the next key is "12", not "11".
        snap.reset()
        try checkPoint(try tap(CGPoint(x: 700, y: 800), at: 30), CGPoint(x: 700, y: 800))
        try checkPoint(try tap(CGPoint(x: 748, y: 800), at: 30.2), CGPoint(x: 748, y: 800))
        // Whatever the zoom, a snap never moves a click further on the Mac than `macRadius`.
        var random = SeededRandom(seed: 0x7A95)
        var zoomed = viewport
        for _ in 0..<400 {
            if random.next(in: 0...1) < 0.1 {
                zoomed.reset()
                zoomed.zoom(by: random.next(in: 1...4), around: CGPoint(x: random.next(in: 0...390), y: random.next(in: 0...844)))
            }
            let location = CGPoint(x: random.next(in: 0...390), y: random.next(in: 300...544))
            guard let mac = zoomed.macPoint(at: location) else { continue }
            let sent = try self.tap(&snap, zoomed, at: location, time: 50 + Double(random.next(in: 0...0.2)))
            try checkTrue(macDistance(sent, mac, on: macSize) <= snap.macRadius + 0.001)
        }
    }

    func testPacerKeepsMotionUnderTheMacRateLimit() throws {
        // The Mac admits 240 input events a second; a pointer move and a scroll at most 60 times each leave room for
        // clicks and keys even on a 120 Hz display.
        for hertz in [60.0, 120.0, 240.0] {
            var pacer = MotionPacer()
            var sent = 0
            var random = SeededRandom(seed: UInt64(hertz))
            for tick in 0..<Int(hertz * 10) {
                let jitter = Double(random.next(in: -0.0008...0.0008))
                if pacer.ready(at: 100 + Double(tick) / hertz + jitter) { sent += 1 }
            }
            try checkTrue(sent <= 601)
            // A 60 Hz display, jitter included, is not halved.
            if hertz == 60 { try checkTrue(sent >= 590) }
        }
    }

    func testTypedTextPiecesAreWhatTheMacAccepts() throws {
        try checkEqual(ScreenTextPieces.pieces(of: "", maxBytes: 256), [])
        try checkEqual(ScreenTextPieces.pieces(of: "a\nb\tc\u{7}", maxBytes: 256), ["abc"])
        let korean = String(repeating: "한글", count: 100) // 600 bytes
        let pieces = ScreenTextPieces.pieces(of: korean, maxBytes: 256)
        try checkEqual(pieces.joined(), korean)
        try checkTrue(pieces.allSatisfy { !$0.isEmpty && $0.utf8.count <= 256 })
        // A character no piece can hold is left out rather than sent malformed.
        let huge = "e" + String(repeating: "\u{301}", count: 200)
        try checkEqual(ScreenTextPieces.pieces(of: "a" + huge + "b", maxBytes: 256), ["ab"])
    }

    // MARK: helpers

    /// A tap as the viewer makes one: the touch mapped onto the Mac, then snapped.
    private func tap(_ snap: inout TapSnap, _ viewport: ScreenViewport, at location: CGPoint, time: Double) throws -> CGPoint {
        snap.position(for: try unwrap(viewport.macPoint(at: location)), at: location, time: time, pictureSize: viewport.videoSize)
    }

    /// In Mac picture pixels.
    private func macDistance(_ a: CGPoint, _ b: CGPoint, on size: CGSize) -> CGFloat {
        hypot((a.x - b.x) * size.width, (a.y - b.y) * size.height)
    }

    private func checkClose(_ actual: CGFloat, _ expected: CGFloat, tolerance: CGFloat = 0.0001, line: Int = #line) throws {
        if !(abs(actual - expected) <= tolerance) { throw CheckFailure.failed("Expected \(expected), got \(actual) (line \(line))") }
    }

    private func checkPoint(_ actual: CGPoint?, _ expected: CGPoint, line: Int = #line) throws {
        guard let actual else { throw CheckFailure.failed("Expected a point (line \(line))") }
        try checkClose(actual.x, expected.x, line: line)
        try checkClose(actual.y, expected.y, line: line)
    }

    private func unwrap<T>(_ value: T?, line: Int = #line) throws -> T {
        guard let value else { throw CheckFailure.failed("Unexpected nil (line \(line))") }
        return value
    }
}

/// Deterministic numbers for the property checks, so a failure reproduces.
struct SeededRandom {
    private var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }

    mutating func next(in range: ClosedRange<CGFloat>) -> CGFloat {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        let unit = CGFloat(state >> 11) / CGFloat(1 << 53)
        return range.lowerBound + (range.upperBound - range.lowerBound) * unit
    }
}

#if !CORE_CHECKS
import XCTest
final class ScreenViewportTests: XCTestCase {
    func testScreenViewerGestureMath() throws { try ScreenViewportChecks().runAll() }
}
#endif
