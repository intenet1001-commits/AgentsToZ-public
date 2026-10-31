import Foundation

/// Signals required before reporting an explicit review-window request as visible and foregrounded.
/// The caller must obtain these from the OS after allowing activation to settle. A positive occlusion signal
/// means some of the window is visible; it is not proof that every pixel is unobstructed.
public struct ReviewPresentationEvidence {
    public let visible: Bool
    public let activeSpace: Bool
    public let keyWindow: Bool
    public let partiallyUnobscured: Bool
    public let applicationActive: Bool
    public let applicationFrontmost: Bool
    /// The window sits on the display holding the pointer (ReviewPlacement): every other signal can be true for a
    /// window on another display, which a person looking at this one never sees.
    public let onPointerScreen: Bool

    public init(visible: Bool, activeSpace: Bool, keyWindow: Bool, partiallyUnobscured: Bool,
                applicationActive: Bool, applicationFrontmost: Bool, onPointerScreen: Bool) {
        self.visible = visible
        self.activeSpace = activeSpace
        self.keyWindow = keyWindow
        self.partiallyUnobscured = partiallyUnobscured
        self.applicationActive = applicationActive
        self.applicationFrontmost = applicationFrontmost
        self.onPointerScreen = onPointerScreen
    }

    public var confirmed: Bool {
        visible && activeSpace && keyWindow && partiallyUnobscured && applicationActive && applicationFrontmost && onPointerScreen
    }
}

/// A rectangle in AppKit global coordinates (origin bottom-left), in points. Plain values keep this core Foundation only.
public struct ReviewRect: Equatable {
    public let x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }
    var midX: Double { x + width / 2 }
    var midY: Double { y + height / 2 }
    /// Edges included, so a pointer on a display's last row or column still belongs to it.
    func holds(x px: Double, y py: Double) -> Bool { px >= x && px <= x + width && py >= y && py <= y + height }
}
/// One display: its whole frame and the part outside the menu bar and Dock.
public struct ReviewScreen: Equatable {
    public let frame: ReviewRect
    public let visible: ReviewRect
    public init(frame: ReviewRect, visible: ReviewRect) { self.frame = frame; self.visible = visible }
}

/// The explicit request follows a click in the main app, so the pointer is on the display the person is looking at.
/// A review window centred on the main display, or left on another one earlier, is moved there before it is shown.
public enum ReviewPlacement {
    public static func screen(atX x: Double, y: Double, in screens: [ReviewScreen]) -> ReviewScreen? {
        screens.first { $0.frame.holds(x: x, y: y) }
    }
    /// Whether the window's centre is on the pointer's display. No display holding the pointer is never "on" it.
    public static func onPointerScreen(_ window: ReviewRect, screens: [ReviewScreen], pointerX: Double, pointerY: Double) -> Bool {
        guard let screen = screen(atX: pointerX, y: pointerY, in: screens) else { return false }
        return screen.frame.holds(x: window.midX, y: window.midY)
    }
    /// nil keeps the window where it is: already on the pointer's display (the person may have placed it), or no
    /// display holds the pointer. Otherwise it is centred in that display's visible frame, no larger than it.
    public static func frame(for window: ReviewRect, screens: [ReviewScreen], pointerX: Double, pointerY: Double) -> ReviewRect? {
        guard let screen = screen(atX: pointerX, y: pointerY, in: screens),
              !onPointerScreen(window, screens: screens, pointerX: pointerX, pointerY: pointerY) else { return nil }
        let width = min(window.width, screen.visible.width), height = min(window.height, screen.visible.height)
        return ReviewRect(x: (screen.visible.midX - width / 2).rounded(), y: (screen.visible.midY - height / 2).rounded(), width: width, height: height)
    }
}

public enum ReviewPresentationDecision: Equatable {
    case confirmed, wait, abort

    /// A foreground switch to an unrelated app or a dead original owner ends this passive check immediately.
    /// Missing foreground evidence remains unconfirmed and may be checked again within the caller's time bound.
    public static func assess(_ evidence: ReviewPresentationEvidence, ownerAlive: Bool, frontmost: Int32?,
                              ownerPID: Int32, controlPID: Int32) -> Self {
        guard ownerAlive else { return .abort }
        if let frontmost, frontmost != ownerPID && frontmost != controlPID { return .abort }
        return evidence.confirmed && frontmost == controlPID ? .confirmed : .wait
    }
}

public extension ControlResponse {
    /// Older helpers returned opened without checking foreground; this evidence bit distinguishes those replies.
    /// Call only after the explicit review request's OS evidence has been confirmed.
    static func confirmedReviewPresentation() -> Data {
        success(["opened": true, "visibilityConfirmed": true])
    }
}
