#if os(macOS)
import AppKit
import AVFoundation
import ScreenControlCore

// The session window (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.1): B's picture in an AVSampleBufferDisplayLayer,
// a toolbar above it and a band below it, outside the picture, for what B said (SR-15) and what this Mac limits. The
// window is always left out of screen capture by other apps here (`sharingType = .none`, SR-23, S-M2). Closing it ends
// the session.
//
// While B's picture is on screen, this Mac's display does not dim or sleep from idleness (a ProcessInfo activity with
// `.idleDisplaySleepDisabled`), so watching without touching A does not end the session through A's display sleep or
// the lock that follows it (DESIGN 0절: a connection lasts until B's limit). A's lock, system sleep, a display put to
// sleep on purpose and a user switch still end it at once (ViewerApp.swift). Unattended, A stays awake at most until B's
// limit ends the session: 60 minutes from the start for view, 60 minutes without input for control. A hidden or
// minimised window holds nothing awake.

/// B's picture, decoded in hardware, letterboxed into the view.
@MainActor
final class VideoView: NSView {
    let displayLayer = AVSampleBufferDisplayLayer()
    private(set) var videoSize: CGSize?

    override init(frame: NSRect) {
        super.init(frame: frame)
        displayLayer.videoGravity = .resizeAspect
        displayLayer.backgroundColor = NSColor.black.cgColor
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func makeBackingLayer() -> CALayer { displayLayer }

    /// Where the picture is drawn, in this view's coordinates.
    var videoRect: CGRect {
        guard let size = videoSize, size.width > 0, size.height > 0, bounds.width > 0, bounds.height > 0 else { return .zero }
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        let width = size.width * scale, height = size.height * scale
        return CGRect(x: (bounds.width - width) / 2, y: (bounds.height - height) / 2, width: width, height: height)
    }

    /// Shows one picture; returns false when the layer failed and needs a keyframe to start again.
    func show(_ picture: ScreenPicture) -> Bool {
        if let format = CMSampleBufferGetFormatDescription(picture.sample) {
            let size = CMVideoFormatDescriptionGetDimensions(format)
            videoSize = CGSize(width: Int(size.width), height: Int(size.height))
        }
        let renderer = displayLayer.sampleBufferRenderer
        if renderer.status == .failed {
            renderer.flush()
            return false
        }
        renderer.enqueue(picture.sample)
        return true
    }
}

@MainActor
final class SessionWindowController: NSObject, NSWindowDelegate {
    let window: NSWindow
    let session: ViewerSession
    private let video = VideoView()
    private let band = NSTextField(wrappingLabelWithString: "")
    private let offerLabel = NSTextField(wrappingLabelWithString: "")
    private let entry = SecureEntryView()
    private let entryNote = NSTextField(wrappingLabelWithString: "")
    private var offerRow = NSStackView()
    /// The entry's label, field and 「보내기」: shown together or not at all.
    private var entryControls = NSStackView()
    private var entryRow = NSStackView()
    private var awake: NSObjectProtocol?
    private var occlusionObserver: NSObjectProtocol?
    private var inputButtons: [NSButton] = []
    private var pauseButton: NSButton?
    private var forwarder: InputForwarder?
    private var closing = false
    /// The window closed or the session ended; the list takes over.
    var closed: (String) -> Void = { _ in }

    init(session: ViewerSession) {
        self.session = session
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "\(session.target.displayName) — AgentsToZ Viewer"
        window.isReleasedWhenClosed = false
        window.sharingType = .none
        // Hover reaches B too (the forwarder's `.mouseMoved`).
        window.acceptsMouseMovedEvents = true
        window.delegate = self
        window.contentView = makeContent()
        window.center()

        let forwarder = InputForwarder(window: window, video: video, session: session)
        forwarder.entryHasFocus = { [weak self] in self.map { $0.window.firstResponder === $0.entry } ?? false }
        self.forwarder = forwarder
        entry.submit = { [weak self] proof in self?.sendEntry(proof) }
        entry.refused = { [weak self] _ in self?.showNotInFront() }

        session.changed = { [weak self] in self?.refresh() }
        session.picture = { [weak self] picture in
            guard let self else { return }
            if !self.video.show(picture) { self.session.requestKeyframe() }
        }
        session.finished = { [weak self] text in
            guard let self else { return }
            self.wrapUp()
            self.window.delegate = nil
            if !self.closing { self.closing = true; self.window.close() }
            self.closed(text)
        }
        occlusionObserver = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification,
                                                                   object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.followVisibility() }
        }
        refresh()
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        forwarder?.start()
        session.start()
        followVisibility()
    }

    /// Keeps this Mac's display from idle sleep while the picture is visible and the session runs; lets it go otherwise.
    private func followVisibility() {
        if !session.isOver, window.occlusionState.contains(.visible) {
            guard awake == nil else { return }
            awake = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleDisplaySleepDisabled],
                                                          reason: "AgentsToZ Viewer: B의 화면을 보는 중")
        } else if let awake {
            ProcessInfo.processInfo.endActivity(awake)
            self.awake = nil
        }
    }

    /// The session is over: nothing forwarded, the entry closed with Secure Event Input off, and A may sleep again.
    private func wrapUp() {
        forwarder?.stop()
        window.makeFirstResponder(nil)
        entry.endEntry()
        if let occlusionObserver { NotificationCenter.default.removeObserver(occlusionObserver) }
        occlusionObserver = nil
        if let awake { ProcessInfo.processInfo.endActivity(awake) }
        awake = nil
    }

    // MARK: Layout

    private func makeContent() -> NSView {
        let toolbar = NSStackView(views: [
            inputButton("⌘Tab",trusted:.chord([0x30],.command)) { [weak self] proof in self?.session.sendChord([0x30], modifiers: .command, proof: proof) },
            inputButton("⌘Space",trusted:.chord([0x31],.command)) { [weak self] proof in self?.session.sendChord([0x31], modifiers: .command, proof: proof) },
            inputButton("Mission Control",trusted:.navigate(.missionControl)) { [weak self] proof in self?.session.navigate(.missionControl, proof: proof) },
            inputButton("◀ Spaces",trusted:.navigate(.previous)) { [weak self] proof in self?.session.navigate(.previous, proof: proof) },
            inputButton("Spaces ▶",trusted:.navigate(.next)) { [weak self] proof in self?.session.navigate(.next, proof: proof) },
        ])
        let pause:NSButton
        if session.isTrustedDeviceSession {
            pause=PresentationButton(title:"입력 일시 정지") { [weak self] in guard let self else { return };self.session.performTrusted(.pause(!self.session.pausedHere)) }
        } else { pause = HumanButton(title: "입력 일시 정지", guarded: { [weak self] in self?.session.pausedHere ?? true }) { [weak self] proof in
            guard let self else { return }
            self.session.setPausedHere(!self.session.pausedHere, proof: proof)
        } }
        pauseButton = pause
        let end:NSButton = session.isTrustedDeviceSession ? PresentationButton(title:"끊기") { [weak self] in self?.session.end(.here) } : HumanButton(title: "끊기", guarded: { false }) { [weak self] _ in self?.session.end(.here) }
        toolbar.addView(pause, in: .trailing)
        toolbar.addView(end, in: .trailing)
        toolbar.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)

        let save = HumanButton(title: "주소 저장") { [weak self] proof in self?.session.saveOfferedAddress(proof: proof) }
        offerRow = NSStackView(views: [offerLabel, save])
        let send = HumanButton(title: "보내기") { [weak self] proof in self?.sendEntry(proof) }
        entryControls = NSStackView(views: [NSTextField(labelWithString: "B 잠금 암호"), entry, send])
        entryRow = NSStackView(views: [entryControls, entryNote])

        band.maximumNumberOfLines = 0
        let bandStack = NSStackView(views: [band, offerRow, entryRow])
        bandStack.orientation = .vertical
        bandStack.alignment = .leading
        bandStack.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        bandStack.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        video.translatesAutoresizingMaskIntoConstraints = false
        let column = NSStackView(views: [toolbar, video, bandStack])
        column.orientation = .vertical
        column.spacing = 0
        column.alignment = .width
        video.setContentHuggingPriority(.defaultLow, for: .vertical)
        video.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        return column
    }

    private func inputButton(_ title: String,trusted:ViewerSession.TrustedAction, _ handler: @escaping (HumanProof) -> Void) -> NSButton {
        let button:NSButton = session.isTrustedDeviceSession ? PresentationButton(title:title) { [weak self] in self?.session.performTrusted(trusted) } : HumanButton(title: title, handler: handler)
        inputButtons.append(button)
        return button
    }

    // MARK: State

    func refresh() {
        let sendsInput = session.sendsInput
        for button in inputButtons { button.isEnabled = sendsInput }
        pauseButton?.title = session.pausedHere ? "입력 재개" : "입력 일시 정지"
        band.stringValue = session.bandLines.joined(separator: "\n")

        switch session.addressOffer {
        case .none:
            offerRow.isHidden = true
        case .save(let route):
            offerRow.isHidden = false
            offerLabel.stringValue = "\(ScreenTargetText.addressSave) (\(route.address))"
        case .changed(let old, let new):
            offerRow.isHidden = false
            offerLabel.stringValue = "\(ScreenTargetText.addressChanged): \(old.address) → \(new.address)"
        }

        // The entry exists only while B itself says it is locked and control is allowed; otherwise the words alone say
        // why not, or warn that a lock screen in the picture may be fake while keys go to an unlocked B.
        let lockedEntry = session.lockedEntry
        entryRow.isHidden = lockedEntry == .hidden
        entryControls.isHidden = lockedEntry != .open
        entryNote.isHidden = lockedEntry == .open || lockedEntry == .hidden
        entryNote.stringValue = switch lockedEntry {
        case .unavailable: ScreenTargetText.lockedEntryUnavailable
        case .notLockedWarning: ScreenTargetText.notLockedWarning
        case .open, .hidden: ""
        }
        // A closed entry keeps nothing typed, focused or not.
        if lockedEntry != .open { entry.endEntry() }
    }

    private func sendEntry(_ proof: HumanProof) {
        entry.withBuffer { buffer in session.sendLockedEntry(&buffer, proof: proof) }
    }

    func showNotInFront() {
        band.stringValue = ([ScreenInputOriginText.notInFront] + session.bandLines).joined(separator: "\n")
    }

    // MARK: NSWindowDelegate

    func windowWillClose(_ notification: Notification) {
        closing = true
        wrapUp()
        session.end(.here)
    }
}
#endif
