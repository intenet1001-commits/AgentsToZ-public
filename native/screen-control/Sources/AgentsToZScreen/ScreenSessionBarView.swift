import AppKit
import QuartzCore
// The offscreen render check (scripts/check-screen-control.ts) compiles this file with ScreenSessionBarModel.swift alone,
// as one module; inside the app the model comes from ScreenHost.
#if canImport(ScreenHost)
import ScreenHost
#endif

/// The session bar's look, the Control bar's family (AgentsToZControl/ControlBarView.swift): a dark glass capsule with a
/// status light, the device's glyph, two lines of text and pill buttons. While the other side moves this Mac a light
/// runs around the rim and the status light breathes; while it only watches the light rests blue, while the person here
/// holds the Mac green, and amber when something needs a look. ScreenSessionBar decides every word and action through
/// `ScreenSessionBarText.present`; this view only draws a presentation. It imports AppKit and the pure model alone.
@MainActor
final class ScreenSessionBarView: NSView {
    static let size = NSSize(width: 660, height: 52)

    enum Palette {
        static let violet = NSColor(srgbRed: 0.62, green: 0.48, blue: 1.0, alpha: 1)
        static let blue = NSColor(srgbRed: 0.36, green: 0.62, blue: 1.0, alpha: 1)
        static let pink = NSColor(srgbRed: 1.0, green: 0.45, blue: 0.82, alpha: 1)
        static let green = NSColor(srgbRed: 0.24, green: 0.86, blue: 0.58, alpha: 1)
        static let amber = NSColor(srgbRed: 1.0, green: 0.72, blue: 0.3, alpha: 1)
        static let stopRed = NSColor(srgbRed: 1.0, green: 0.33, blue: 0.33, alpha: 1)
    }

    /// A borderless pill. Its first click runs even though the bar's panel never becomes key, and it stays an NSButton, so
    /// the event that runs its action is the bar's own mouse-up (ScreenSessionBar.handBackRefusal reads that event).
    final class PillButton: NSButton {
        enum Style { case light, accent, quiet, stop }
        var style: Style = .quiet { didSet { refresh() } }
        var label = "" { didSet { refresh() } }
        /// Lighter text after the label: the end-session key.
        var hint = "" { didSet { refresh() } }
        var symbol = "" { didSet { refresh() } }
        var barAction: ScreenSessionBarAction?
        /// True only while this pill tracks a mouse-down it received itself. AppKit sends the action from the mouse-up
        /// before `mouseDown` returns, so an action run any other way (an accessibility press, `performClick`) reads false
        /// even when the person's real click on another pill is still `NSApp.currentEvent` (SR-29: the mouse-up must be
        /// inside the control that ran).
        private(set) var tracksOwnMouseDown = false
        /// Called, instead of the action, when an accessibility press reaches a pill that needs a person at this Mac.
        var refusedAccessibilityPress: (() -> Void)?
        private var hovering = false
        private var pressed = false
        private var hoverArea: NSTrackingArea?

        override init(frame: NSRect) {
            super.init(frame: frame)
            isBordered = false
            wantsLayer = true
            layer?.cornerCurve = .continuous
            imagePosition = .imageLeading
            imageHugsTitle = true
            focusRingType = .none
            keyEquivalent = ""
            translatesAutoresizingMaskIntoConstraints = false
            setContentHuggingPriority(.required, for: .horizontal)
            setContentCompressionResistancePriority(.required, for: .horizontal)
            refresh()
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func mouseDown(with event: NSEvent) {
            tracksOwnMouseDown = true
            defer { tracksOwnMouseDown = false }
            super.mouseDown(with: event)
        }
        /// 「다시 넘기기」 gives input back, and an accessibility press (osascript `click button`, an AI's AXPress) carries no
        /// hardware click of its own: refused here, before any action runs (SR-29). The other pills only take input away
        /// and accept it.
        override func accessibilityPerformPress() -> Bool {
            guard barAction?.needsPersonAtMac != true else {
                refusedAccessibilityPress?()
                return false
            }
            return super.accessibilityPerformPress()
        }
        override var intrinsicContentSize: NSSize {
            let content = super.intrinsicContentSize
            return NSSize(width: ceil(content.width) + 24, height: 30)
        }
        override func layout() {
            super.layout()
            layer?.cornerRadius = bounds.height / 2
        }
        override func highlight(_ flag: Bool) {
            super.highlight(flag)
            pressed = flag
            refresh()
        }
        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let hoverArea { removeTrackingArea(hoverArea) }
            // The panel is never key, so the area has to be active whatever the key window is.
            let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                      owner: self, userInfo: nil)
            addTrackingArea(area)
            hoverArea = area
        }
        override func mouseEntered(with event: NSEvent) { hovering = true; refresh() }
        override func mouseExited(with event: NSEvent) { hovering = false; pressed = false; refresh() }

        private func refresh() {
            let fill: NSColor
            let ink: NSColor
            switch style {
            case .light:
                fill = NSColor.white.withAlphaComponent(pressed ? 0.72 : hovering ? 1.0 : 0.9)
                ink = NSColor.black.withAlphaComponent(0.86)
            case .accent:
                fill = Palette.green.blended(withFraction: pressed ? 0.3 : hovering ? 0.15 : 0.05, of: .black) ?? Palette.green
                ink = NSColor.black.withAlphaComponent(0.86)
            case .quiet:
                fill = NSColor.white.withAlphaComponent(pressed ? 0.24 : hovering ? 0.18 : 0.1)
                ink = NSColor.white.withAlphaComponent(0.92)
            case .stop:
                fill = hovering ? Palette.stopRed.withAlphaComponent(pressed ? 0.62 : 0.42)
                                : NSColor.white.withAlphaComponent(pressed ? 0.2 : 0.1)
                ink = NSColor.white.withAlphaComponent(0.92)
            }
            layer?.backgroundColor = fill.cgColor
            contentTintColor = ink
            let title = NSMutableAttributedString(string: label, attributes: [
                .font: NSFont.systemFont(ofSize: 12.5, weight: .semibold), .foregroundColor: ink])
            if !hint.isEmpty {
                title.append(NSAttributedString(string: "  " + hint, attributes: [
                    .font: NSFont.systemFont(ofSize: 11, weight: .regular), .foregroundColor: ink.withAlphaComponent(0.55)]))
            }
            attributedTitle = title
            image = symbol.isEmpty ? nil : NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 10.5, weight: .bold))
            setAccessibilityLabel(label)
            invalidateIntrinsicContentSize()
        }
    }

    /// The round light at the left: a glowing dot, plus a ring that breathes out of it while the other side moves this Mac.
    private final class StatusLight: NSView {
        private let core = CALayer()
        private let ring = CALayer()
        private static let dot: CGFloat = 10

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            layer?.masksToBounds = false
            for part in [ring, core] {
                part.cornerRadius = Self.dot / 2
                layer?.addSublayer(part)
            }
            core.shadowOffset = .zero
            core.shadowRadius = 5
            core.shadowOpacity = 0.95
            ring.opacity = 0
            translatesAutoresizingMaskIntoConstraints = false
            setAccessibilityElement(false)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func layout() {
            super.layout()
            let square = CGRect(x: bounds.midX - Self.dot / 2, y: bounds.midY - Self.dot / 2, width: Self.dot, height: Self.dot)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            core.frame = square
            ring.frame = square
            CATransaction.commit()
        }

        func show(_ color: NSColor, breathing: Bool) {
            core.backgroundColor = color.cgColor
            core.shadowColor = color.cgColor
            ring.backgroundColor = color.withAlphaComponent(0.55).cgColor
            if breathing {
                guard ring.animation(forKey: "breathe") == nil else { return }
                let grow = CABasicAnimation(keyPath: "transform.scale")
                grow.fromValue = 1
                grow.toValue = 2.6
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = 0.7
                fade.toValue = 0
                let breathe = CAAnimationGroup()
                breathe.animations = [grow, fade]
                breathe.duration = 1.8
                breathe.timingFunction = CAMediaTimingFunction(name: .easeOut)
                breathe.repeatCount = .infinity
                breathe.isRemovedOnCompletion = false
                ring.add(breathe, forKey: "breathe")
            } else {
                ring.removeAnimation(forKey: "breathe")
            }
        }
    }

    /// The tint, the glass rim and the light that runs around it. No subviews, so it may own its layers; it never takes a
    /// click (the background under it moves the panel).
    private final class Rim: NSView {
        private let tint = CAShapeLayer()
        private let edge = CAShapeLayer()
        private let runner = CALayer()
        private let runnerMask = CAShapeLayer()
        private let sweep = CAGradientLayer()

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            tint.fillColor = NSColor.black.withAlphaComponent(0.5).cgColor
            edge.fillColor = nil
            edge.strokeColor = NSColor.white.withAlphaComponent(0.16).cgColor
            edge.lineWidth = 1
            runnerMask.fillColor = nil
            runnerMask.strokeColor = NSColor.black.cgColor
            runnerMask.lineWidth = 1.6
            runner.mask = runnerMask
            sweep.type = .conic
            sweep.startPoint = CGPoint(x: 0.5, y: 0.5)
            sweep.endPoint = CGPoint(x: 0.5, y: 0)
            let clear = Palette.violet.withAlphaComponent(0).cgColor
            sweep.colors = [clear, Palette.violet.cgColor, Palette.pink.cgColor, clear, clear,
                            Palette.blue.cgColor, Palette.violet.cgColor, clear]
            sweep.locations = [0, 0.16, 0.3, 0.42, 0.5, 0.66, 0.8, 0.92]
            runner.addSublayer(sweep)
            for part in [tint, edge, runner] { layer?.addSublayer(part) }
            translatesAutoresizingMaskIntoConstraints = false
            setAccessibilityElement(false)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func layout() {
            super.layout()
            let radius = bounds.height / 2
            let outline = CGPath(roundedRect: bounds.insetBy(dx: 0.8, dy: 0.8), cornerWidth: radius - 0.8,
                                 cornerHeight: radius - 0.8, transform: nil)
            let side = hypot(bounds.width, bounds.height)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            tint.path = CGPath(roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: nil)
            edge.path = outline
            runner.frame = bounds
            runnerMask.frame = bounds
            runnerMask.path = outline
            sweep.bounds = CGRect(x: 0, y: 0, width: side, height: side)
            sweep.position = CGPoint(x: bounds.midX, y: bounds.midY)
            CATransaction.commit()
        }

        func show(running: Bool, motion: Bool, edgeColor: NSColor?) {
            runner.isHidden = !running
            edge.strokeColor = (edgeColor?.withAlphaComponent(0.42) ?? NSColor.white.withAlphaComponent(running ? 0.1 : 0.16)).cgColor
            if running && motion {
                guard sweep.animation(forKey: "run") == nil else { return }
                let turn = CABasicAnimation(keyPath: "transform.rotation.z")
                turn.fromValue = 0
                turn.toValue = -2 * Double.pi
                turn.duration = 3.6
                turn.repeatCount = .infinity
                turn.isRemovedOnCompletion = false
                sweep.add(turn, forKey: "run")
            } else {
                sweep.removeAnimation(forKey: "run")
            }
        }
    }

    /// One pill per action, shown or left out as the presentation says, in this order.
    let pills: [ScreenSessionBarAction: PillButton]
    private let glass = NSVisualEffectView()
    private let rim = Rim(frame: .zero)
    private let light = StatusLight(frame: .zero)
    private let glyph = NSImageView()
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private(set) var shown: ScreenSessionBarPresentation?

    override init(frame: NSRect) {
        var pills: [ScreenSessionBarAction: PillButton] = [:]
        for action in ScreenSessionBarAction.allCases {
            let pill = PillButton(frame: .zero)
            pill.barAction = action
            pill.label = action.label
            switch action {
            case .takeOver: pill.style = .light; pill.symbol = "hand.raised.fill"
            case .handBack: pill.style = .accent; pill.symbol = "arrow.uturn.backward"
                pill.toolTip = "이 Mac의 마우스나 트랙패드로 눌러야 다시 넘어갑니다"
            case .viewOnly: pill.style = .quiet; pill.symbol = "eye"
            case .end: pill.style = .stop; pill.symbol = "xmark"
            }
            pills[action] = pill
        }
        self.pills = pills
        super.init(frame: frame)
        appearance = NSAppearance(named: .darkAqua)

        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.maskImage = Self.capsuleMask(height: Self.size.height)
        glass.translatesAutoresizingMaskIntoConstraints = false

        glyph.imageScaling = .scaleProportionallyDown
        glyph.contentTintColor = NSColor.white.withAlphaComponent(0.82)
        glyph.translatesAutoresizingMaskIntoConstraints = false
        glyph.setAccessibilityElement(false)

        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.textColor = NSColor.white.withAlphaComponent(0.96)
        title.lineBreakMode = .byTruncatingTail
        detail.font = .systemFont(ofSize: 11.5)
        detail.lineBreakMode = .byTruncatingTail
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let words = NSStackView(views: [title, detail])
        words.orientation = .vertical
        words.alignment = .leading
        words.spacing = 1

        let ordered = ScreenSessionBarAction.allCases.compactMap { pills[$0] }
        let row = NSStackView(views: [light, glyph, words, NSView()] + ordered)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.setCustomSpacing(6, after: light)
        row.setCustomSpacing(9, after: glyph)
        row.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 11)
        row.translatesAutoresizingMaskIntoConstraints = false

        for view in [glass, rim, row] as [NSView] { addSubview(view) }
        var pinned: [NSLayoutConstraint] = [
            light.widthAnchor.constraint(equalToConstant: 22), light.heightAnchor.constraint(equalToConstant: 22),
            glyph.widthAnchor.constraint(equalToConstant: 18), glyph.heightAnchor.constraint(equalToConstant: 20)]
        for view in [glass, rim, row] as [NSView] {
            pinned += [view.leadingAnchor.constraint(equalTo: leadingAnchor), view.trailingAnchor.constraint(equalTo: trailingAnchor),
                       view.topAnchor.constraint(equalTo: topAnchor), view.bottomAnchor.constraint(equalTo: bottomAnchor)]
        }
        NSLayoutConstraint.activate(pinned)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("AgentsToZ Screen 세션 막대")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Draws one presentation.
    func show(_ presentation: ScreenSessionBarPresentation) {
        guard presentation != shown else { return }
        shown = presentation
        let motion = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        title.stringValue = presentation.title
        detail.stringValue = presentation.detail
        detail.toolTip = presentation.detail
        detail.textColor = presentation.notice ? Palette.amber : NSColor.white.withAlphaComponent(0.6)
        glyph.image = NSImage(systemSymbolName: presentation.symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .medium))
        let color: NSColor
        switch presentation.tone {
        case .controlling: color = Palette.violet
        case .watching: color = Palette.blue
        case .holding: color = Palette.green
        case .warning: color = Palette.amber
        }
        light.show(color, breathing: presentation.tone == .controlling && motion)
        rim.show(running: presentation.tone == .controlling, motion: motion,
                 edgeColor: presentation.tone == .warning ? Palette.amber : nil)
        for (action, pill) in pills {
            pill.isHidden = !presentation.actions.contains(action)
        }
        let end = pills[.end]
        if end?.hint != presentation.hotKey {
            end?.hint = presentation.hotKey
            end?.toolTip = "이 Mac에서 \(presentation.hotKey) 를 눌러도 끊깁니다"
        }
        setAccessibilityValue("\(presentation.title), \(presentation.detail)")
        needsLayout = true
    }

    /// The lines whose text does not fit where the bar laid them out (the render check fails on any).
    func overflowingText() -> [String] {
        layoutSubtreeIfNeeded()
        return [title, detail].compactMap { field in
            guard !field.stringValue.isEmpty, let cell = field.cell else { return nil }
            let needed = cell.cellSize(forBounds: NSRect(x: 0, y: 0, width: CGFloat.greatestFiniteMagnitude,
                                                         height: field.bounds.height)).width
            return needed > field.bounds.width + 0.5 ? field.stringValue : nil
        }
    }

    /// A stretchable capsule for the glass, so the blur itself has round ends (a layer corner radius does not clip it).
    private static func capsuleMask(height: CGFloat) -> NSImage {
        let radius = height / 2
        let image = NSImage(size: NSSize(width: height + 1, height: height), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        image.resizingMode = .stretch
        return image
    }
}
