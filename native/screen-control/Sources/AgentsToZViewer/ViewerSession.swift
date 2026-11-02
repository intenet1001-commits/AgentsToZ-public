#if os(macOS)
import AppKit
import ScreenControlCore

// One session with a Mac B (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.1, 6.4–6.6, 12절). It shows B's pictures,
// tells the person what B said beside them, and sends to B only through the functions below that take a `HumanProof`
// (SR-26, SR-29): input from this Mac's hardware, the toolbar, the locked-Mac entry and 「이 Mac에서 삭제」. The one
// exception, `releaseHeld`, only lets go on B of keys and buttons such a function pressed there. What the session
// decides lives in `ViewerSessionModel` (ScreenControlCore), where the checks reach it. It ends at once on this Mac's
// lock, sleep, user switch, window close or quit, and never reconnects by itself.

@MainActor
final class ViewerSession {
    enum Ending {
        /// B closed the session or the stream failed: say why, from B's signed reason when it named one.
        case byMac
        /// The person ended it here: the window, ⌃⌥⌘, or 「끊기」.
        case here
        /// This Mac locked, slept or switched users (DESIGN 5.1 세션 경비).
        case guardTripped
    }

    let target: ViewerTarget
    let path: ScreenTargetPath
    private let viewer: ScreenViewer
    private let ledger: ViewerTargetsLedger
    let commonRegistration: Bool
    private(set) var model: ViewerSessionModel
    private var tasks: [Task<Void, Never>] = []
    private var ended = false

    /// The window shows what changed.
    var changed: () -> Void = {}
    /// One picture for the display layer; a keyframe is asked for by the caller when the layer failed.
    var picture: (ScreenPicture) -> Void = { _ in }
    /// The session is over; the text says why.
    var finished: (String) -> Void = { _ in }

    init(target: ViewerTarget, connected: ScreenTargetConnector.Connected, ledger: ViewerTargetsLedger, commonRegistration: Bool = false) {
        self.target = target
        path = connected.path
        viewer = connected.viewer
        self.ledger = ledger; self.commonRegistration = commonRegistration
        model = ViewerSessionModel(path: connected.path, started: .now)
    }

    func start() {
        let viewer = viewer
        tasks.append(Task { [weak self] in
            for await notice in viewer.notices {
                guard let self, !self.ended else { return }
                self.hear(notice)
            }
        })
        tasks.append(Task { [weak self] in
            do {
                for try await picture in viewer.pictures() {
                    guard let self, !self.ended else { return }
                    self.picture(picture)
                }
                self?.end(.byMac, text: ScreenTargetText.ended(viewer.endReason))
            } catch {
                self?.end(.byMac, text: ScreenTargetText.ended(viewer.endReason))
            }
        })
        tasks.append(Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, !self.ended else { return }
                // Read again every time: input that moved B's deadline later takes the warning down.
                if self.model.tick(at: .now) {
                    if self.model.limitWarningShown { NSSound.beep() }
                    self.changed()
                }
            }
        })
    }

    private func hear(_ notice: ScreenNotice) {
        // Only what B said in this signed session changes the stored row (ViewerTargets.swift); read it fresh, so a
        // grant heard never undoes an address saved meanwhile.
        if let updated = model.hear(notice, stored: storedTarget), !commonRegistration {
            do { try ledger.replace(updated) } catch { model.storeWriteFailed(ScreenTargetText.listUpdateFailed) }
        }
        if model.needsRelease { releaseHeld() }
        changed()
    }

    /// Whether the person's keyboard and pointer go to B now.
    var sendsInput: Bool { model.sendsInput }
    var pausedHere: Bool { model.pausedHere }
    var bandLines: [String] { model.bandLines }
    var addressOffer: ViewerAddressOffer { commonRegistration ? .none : model.addressOffer }
    var lockedEntry: ViewerLockedEntry { model.lockedEntry }
    var holdsAnyButton: Bool { !model.held.buttons.isEmpty }
    func holds(_ button: MouseButton) -> Bool { model.held.buttons.contains(button) }

    // MARK: Sending to B — each takes the proof that this Mac's person, with its hardware, did it.

    /// One input event the forwarder let through (`HumanActions.forwardProof`).
    func send(_ event: InputEvent, proof: HumanProof) {
        guard !ended, model.admit(event, at: .now) else { return }
        viewer.input(event)
    }

    /// A toolbar key combination such as ⌘Tab: pressed and released in order.
    func sendChord(_ keys: [UInt16], modifiers: KeyModifiers, proof: HumanProof) {
        guard !ended, model.sendsInput else { return }
        var events: [InputEvent] = []
        var held = KeyModifiers()
        for (code, modifier) in Self.modifierKeys where modifiers.contains(modifier) {
            held.insert(modifier)
            events.append(.key(code: code, isDown: true, modifiers: held))
        }
        for key in keys {
            events.append(.key(code: key, isDown: true, modifiers: held))
            events.append(.key(code: key, isDown: false, modifiers: held))
        }
        for (code, modifier) in Self.modifierKeys.reversed() where modifiers.contains(modifier) {
            held.remove(modifier)
            events.append(.key(code: code, isDown: false, modifiers: held))
        }
        for event in events where model.admit(event, at: .now) { viewer.input(event) }
    }

    /// Mission Control and the Spaces arrows (version-3 controls).
    func navigate(_ action: ScreenSpaceAction, proof: HumanProof) {
        guard !ended, model.admitControl(at: .now) else { return }
        try? viewer.desktopControl(.navigateSpace(action))
    }

    /// The locked-Mac entry (D-3, SR-28): one `textAndReturn` from the hardware-filled buffer, only while the entry is
    /// open (`ViewerSessionModel.lockedEntry`).
    func sendLockedEntry(_ buffer: inout ViewerSecureBuffer, proof: HumanProof) {
        guard !ended, let event = model.takeLockedEntry(&buffer, at: .now) else { return }
        viewer.input(event)
        changed()
    }

    /// 「이 Mac에서 삭제」 while connected: asks B once to remove this controller (DESIGN 6.6). Sent at most once; whatever
    /// B does, it is never sent again (SR-31).
    func unenroll(proof: HumanProof) async -> Bool {
        guard !ended, !commonRegistration else { return false }
        do {
            try await viewer.unenrollSelf()
            return true
        } catch {
            return false
        }
    }

    /// Lets go on B of every key and button this session pressed there (each through `send(_:proof:)` or `sendChord`),
    /// when input stops going to B: the window lost the keyboard focus, the person paused, or B or the gate closed it.
    /// It sends releases only, never a press, so it needs no proof of its own.
    func releaseHeld() {
        guard !ended else { return }
        for event in model.releaseHeld() { viewer.input(event) }
    }

    // MARK: Local choices

    /// 「입력 일시 정지」 / 「입력 재개」. Pausing lets go of what B holds and sends nothing new; resuming only lets the
    /// forwarder send again.
    func setPausedHere(_ paused: Bool, proof: HumanProof) {
        model.setPausedHere(paused)
        if model.needsRelease { releaseHeld() }
        changed()
    }

    /// 「주소 저장」: the person saves the address B named, with a hardware click (DESIGN 8절). A failed write keeps the
    /// offer and says so.
    func saveOfferedAddress(proof: HumanProof) {
        guard !commonRegistration, let route = model.offeredAddress else { return }
        do {
            try ledger.replace(storedTarget.savingAddress(route))
            model.addressSaved()
        } catch {
            model.storeWriteFailed(ScreenTargetText.addressSaveFailed)
        }
        changed()
    }

    func noteDroppedInput() {
        if model.noteDroppedInput() { changed() }
    }

    func requestKeyframe() { Task { [viewer] in try? await viewer.requestKeyframe() } }

    func end(_ ending: Ending, text: String? = nil) {
        guard !ended else { return }
        ended = true
        for task in tasks { task.cancel() }
        tasks.removeAll()
        Task { [viewer] in await viewer.close() }
        let message: String = switch ending {
        case .byMac: text ?? ScreenTargetText.ended(viewer.endReason)
        case .here: text ?? "연결을 끝냈습니다"
        case .guardTripped: text ?? ScreenTargetText.guardTripped
        }
        finished(message)
    }

    var isOver: Bool { ended }

    /// The row as stored now, or as connected when the list cannot be read.
    private var storedTarget: ViewerTarget { commonRegistration ? target : (ledger.targets?.first { $0.id == target.id } ?? target) }

    static let modifierKeys: [(UInt16, KeyModifiers)] = [(0x37, .command), (0x38, .shift), (0x3A, .option), (0x3B, .control)]
}
#endif
