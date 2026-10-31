import AppKit
import QuartzCore

/// The control bar's look: a dark glass capsule with a status light, two lines of text and two pill buttons. While the
/// AI holds the Mac a light runs around the rim and the status light breathes; when the person holds it both rest in
/// green. ControlBar decides every word and every action; this view only draws them. It imports AppKit alone, so a
/// preview harness can render it without the rest of Control.
@MainActor
final class ControlBarView: NSView {
    enum Tone: Equatable { case agent, person }

    static let size = NSSize(width: 528, height: 52)

    enum Palette {
        static let violet = NSColor(srgbRed: 0.62, green: 0.48, blue: 1.0, alpha: 1)
        static let blue = NSColor(srgbRed: 0.36, green: 0.62, blue: 1.0, alpha: 1)
        static let pink = NSColor(srgbRed: 1.0, green: 0.45, blue: 0.82, alpha: 1)
        static let green = NSColor(srgbRed: 0.24, green: 0.86, blue: 0.58, alpha: 1)
        static let amber = NSColor(srgbRed: 1.0, green: 0.72, blue: 0.3, alpha: 1)
        static let stopRed = NSColor(srgbRed: 1.0, green: 0.33, blue: 0.33, alpha: 1)
    }

    /// A borderless pill. Its first click runs even though the bar's panel never becomes key, and it stays an NSButton, so
    /// the event that runs its action is the bar's own mouse-up (ControlBar.handBackRefusal reads that event).
    final class PillButton: NSButton {
        enum Style { case light, accent, quiet }
        var style: Style = .quiet { didSet { refresh() } }
        var label = "" { didSet { refresh() } }
        var symbol = "" { didSet { refresh() } }
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
                fill = Palette.violet.blended(withFraction: pressed ? 0.25 : hovering ? 0.12 : 0, of: .black) ?? Palette.violet
                ink = .white
            case .quiet:
                fill = hovering ? Palette.stopRed.withAlphaComponent(pressed ? 0.62 : 0.42)
                                : NSColor.white.withAlphaComponent(pressed ? 0.2 : 0.1)
                ink = NSColor.white.withAlphaComponent(0.92)
            }
            layer?.backgroundColor = fill.cgColor
            contentTintColor = ink
            let font = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
            attributedTitle = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: ink])
            image = symbol.isEmpty ? nil : NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 10.5, weight: .bold))
            setAccessibilityLabel(label)
            invalidateIntrinsicContentSize()
        }
    }

    /// The round light at the left: a glowing dot, plus a ring that breathes out of it while the AI holds the Mac.
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

        func show(running: Bool, motion: Bool) {
            runner.isHidden = !running
            edge.strokeColor = NSColor.white.withAlphaComponent(running ? 0.1 : 0.16).cgColor
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

    let primary = PillButton(frame: .zero)
    let stop = PillButton(frame: .zero)
    private let glass = NSVisualEffectView()
    private let rim = Rim(frame: .zero)
    private let light = StatusLight(frame: .zero)
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        appearance = NSAppearance(named: .darkAqua)

        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.maskImage = Self.capsuleMask(height: Self.size.height)
        glass.translatesAutoresizingMaskIntoConstraints = false

        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.textColor = NSColor.white.withAlphaComponent(0.96)
        detail.font = .systemFont(ofSize: 11.5)
        detail.lineBreakMode = .byTruncatingTail
        detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let words = NSStackView(views: [title, detail])
        words.orientation = .vertical
        words.alignment = .leading
        words.spacing = 1

        stop.style = .quiet
        stop.symbol = "stop.fill"

        let row = NSStackView(views: [light, words, NSView(), primary, stop])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.setCustomSpacing(10, after: light)
        row.edgeInsets = NSEdgeInsets(top: 0, left: 14, bottom: 0, right: 11)
        row.translatesAutoresizingMaskIntoConstraints = false

        for view in [glass, rim, row] as [NSView] { addSubview(view) }
        var pinned: [NSLayoutConstraint] = [
            light.widthAnchor.constraint(equalToConstant: 22), light.heightAnchor.constraint(equalToConstant: 22)]
        for view in [glass, rim, row] as [NSView] {
            pinned += [view.leadingAnchor.constraint(equalTo: leadingAnchor), view.trailingAnchor.constraint(equalTo: trailingAnchor),
                       view.topAnchor.constraint(equalTo: topAnchor), view.bottomAnchor.constraint(equalTo: bottomAnchor)]
        }
        NSLayoutConstraint.activate(pinned)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("AgentsToZ Control 제어 막대")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Draws one state. `notice` colours the second line as a warning (a refused hand-back).
    func show(tone: Tone, title: String, detail: String, notice: Bool, primary label: String) {
        let motion = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        self.title.stringValue = title
        self.detail.stringValue = detail
        self.detail.toolTip = detail
        self.detail.textColor = notice ? Palette.amber : NSColor.white.withAlphaComponent(0.6)
        light.show(tone == .agent ? Palette.violet : Palette.green, breathing: tone == .agent && motion)
        rim.show(running: tone == .agent, motion: motion)
        if primary.label != label { primary.label = label }
        let style: PillButton.Style = tone == .agent ? .light : .accent
        if primary.style != style { primary.style = style }
        let symbol = tone == .agent ? "hand.raised.fill" : "sparkles"
        if primary.symbol != symbol { primary.symbol = symbol }
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
