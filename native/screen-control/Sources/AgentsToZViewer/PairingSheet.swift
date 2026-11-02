#if os(macOS)
import AppKit
import Foundation
import ScreenControlCore

// A's 「Mac 추가」 sheet in AgentsToZ Viewer (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.1, 6.3, SR-20, SR-29, D-6).
// The person picks B's window by the number B shows; A makes a Secure Enclave key for that B alone (biometry, or a paired
// Apple Watch per D-6), shows code ① with the key's four characters, takes code ② from this Mac's keyboard only, and
// signs P6 with the key's first use. A wrong code ②, a refusal or any failure drops the key: it never reaches storage.
//
// Choosing an enrollment uses `HumanButton`, so `HumanActions` judges the click (an accessibility action
// or a remote desktop click only shows why it did nothing), and code ②'s field takes hardware key-downs alone
// (`ControllerPairingCodeEntry`): it has no settable value. The list (TargetList.swift) presents the sheet and stores the
// row `onPaired` hands it, with the proof of the click that picked B's window.

/// What the sheet reaches outside itself; `live` is the app's.
struct PairingSheetDependencies {
    var makeKey: () throws -> ControllerKeyMaterial
    /// App Attest for K_A's registration (S-K2). nil in a build without it, which B accepts while its switch is off.
    var attest: @Sendable (Data) async throws -> ControllerPairingAttestation?
    var name: () -> String
    var model: () -> String
    var makeDiscovery: () -> PairingDiscoverySession = PairingDiscoverySession.live
    var discoveryTimeout: Duration = .seconds(12)

    static var live: PairingSheetDependencies {
        PairingSheetDependencies(makeKey: ControllerKeyFactory.make, attest: { _ in nil }, name: ViewerMac.name, model: ViewerMac.model)
    }
}

/// Discovery only; isolated UI tests supply a stream without opening the network.
struct PairingDiscoverySession {
    var listings: AsyncStream<[ControllerPairingWindowListing]>
    var start: () -> Void
    var stop: () -> Void

    static func live() -> Self {
        let browser = ControllerPairingBrowser()
        return Self(listings: browser.listings, start: { browser.start() }, stop: { browser.stop() })
    }
}

enum ViewerMac {
    /// This Mac's name for B's window and list: the computer name when B can show it, else 「Mac」.
    static func name() -> String {
        let name = Host.current().localizedName ?? "Mac"
        return RegistrationInvite.isShowableName(name) ? name : "Mac"
    }

    /// The hardware model (`hw.model`, such as 「Mac15,7」), at most 32 bytes.
    static func model() -> String {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 1 else { return "Mac" }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &bytes, &size, nil, 0) == 0 else { return "Mac" }
        let model = String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        return (1...ControllerPairingProtocol.maxModelBytes).contains(model.utf8.count) ? model : "Mac"
    }
}

@MainActor
final class PairingSheetModel {
    enum SearchState: Equatable { case idle, searching, finished }
    private(set) var searchState: SearchState = .idle {
        didSet { if searchState != oldValue, phase == .browsing { phaseChanged() } }
    }
    enum Phase: Equatable {
        /// The windows open nearby: 「B 창과 같은 번호를 고르세요」.
        case browsing
        case connecting(ControllerPairingWindowListing)
        /// Code ① for the person to type at B, with K_A's four characters.
        case showingCode(code: String, fingerprint: String, listing: ControllerPairingWindowListing)
        /// B approved: code ② from this Mac's keyboard.
        case enteringHostCode(grant: ControllerPairingGrant, fingerprint: String, listing: ControllerPairingWindowListing)
        /// `storeFailure` says the row could not be kept here although B stored this Mac.
        case paired(state: ControllerPairingResult.State, hostName: String, hostFingerprint: String, controllerFingerprint: String,
                    storeFailure: String?)
        case failed(ControllerPairingNotice)
    }

    private(set) var phase: Phase = .browsing { didSet { if phase != oldValue { phaseChanged() } } }
    /// Shown while browsing only: a window appearing later never redraws a pairing in progress (code ②'s field keeps
    /// what was typed).
    private(set) var listings: [ControllerPairingWindowListing] = [] {
        didSet { if listings != oldValue, phase == .browsing { phaseChanged() } }
    }
    /// Why a control did nothing (not in front of this Mac).
    private(set) var notice: String? { didSet { noticeChanged() } }
    var phaseChanged: () -> Void = {}
    var noticeChanged: () -> Void = {}
    private let dependencies: PairingSheetDependencies
    /// Keeps the result and K_A in the Viewer's list (TargetList.swift), with the proof of the click that picked the
    /// window. Called once, only on success; returns why the row could not be kept, nil when it was.
    private let onPaired: (ControllerPairingResult, ControllerKeyMaterial, HumanProof) -> String?
    private var browser: PairingDiscoverySession?
    private var browsing: Task<Void, Never>?
    private var discoveryDeadline: Task<Void, Never>?
    private var discoveryGeneration = 0
    private var pairing: Task<Void, Never>?
    private var hostCode: CheckedContinuation<ControllerPairingCodeEntry.Submission?, Never>?
    /// The pairing in flight was given up (「그만두기」 or the sheet closed). A code ② prompt that has not shown yet then
    /// answers nil at once instead of appearing; both run on the main actor, so one of them always sees the other.
    private var gaveUp = false

    init(dependencies: PairingSheetDependencies = .live,
         onPaired: @escaping (ControllerPairingResult, ControllerKeyMaterial, HumanProof) -> String?) {
        self.dependencies = dependencies
        self.onPaired = onPaired
    }

    func startBrowsing() {
        guard phase == .browsing, browser == nil else { return }
        discoveryGeneration &+= 1
        let generation = discoveryGeneration
        listings = []
        searchState = .searching
        let browser = dependencies.makeDiscovery()
        self.browser = browser
        browser.start()
        browsing = Task { [weak self] in
            for await listings in browser.listings {
                guard !Task.isCancelled, let self, self.discoveryGeneration == generation else { return }
                self.listings = listings
            }
            guard !Task.isCancelled, let self, self.discoveryGeneration == generation else { return }
            self.stopDiscovery()
        }
        let timeout = dependencies.discoveryTimeout
        discoveryDeadline = Task { [weak self] in
            do { try await Task.sleep(for: timeout) } catch { return }
            guard !Task.isCancelled, let self, self.discoveryGeneration == generation else { return }
            self.stopDiscovery()
        }
    }

    private func stopDiscovery() {
        discoveryGeneration &+= 1
        discoveryDeadline?.cancel()
        discoveryDeadline = nil
        browser?.stop()
        browser = nil
        browsing?.cancel()
        browsing = nil
        if searchState == .searching { searchState = .finished }
    }

    func stop() {
        stopDiscovery()
        cancel()
    }

    /// 「이 창 고르기」, after the person compared the number with B's screen, from this Mac's hardware (`proof`).
    func pick(_ listing: ControllerPairingWindowListing, _ proof: HumanProof) {
        guard case .browsing = phase, pairing == nil else { return }
        notice = nil
        gaveUp = false
        phase = .connecting(listing)
        stopDiscovery()
        let dependencies = dependencies
        pairing = Task { [weak self] in
            do {
                // K_A lives only in this task until `onPaired`: any failure drops it, so the key is gone (6.3).
                let key = try dependencies.makeKey()
                let fingerprint = key.shortFingerprint
                let prompts = ControllerPairingPrompts(
                    attest: dependencies.attest,
                    showControllerCode: { [weak self] code, fingerprint in
                        await MainActor.run { self?.phase = .showingCode(code: code, fingerprint: fingerprint, listing: listing) }
                    },
                    enterHostCode: { [weak self] grant in
                        await withCheckedContinuation { continuation in
                            Task { @MainActor in
                                // Given up before this hop: answer nil now, so the field never shows and the task ends.
                                guard let self, !self.gaveUp else { return continuation.resume(returning: nil) }
                                self.hostCode = continuation
                                self.phase = .enteringHostCode(grant: grant, fingerprint: fingerprint, listing: listing)
                            }
                        }
                    })
                let result = try await ControllerPairingClient.pair(with: listing, signer: key.signer, name: dependencies.name(),
                                                                    model: dependencies.model(), prompts: prompts)
                guard let self else { return }
                let storeFailure = self.onPaired(result, key, proof)
                self.phase = .paired(state: result.state, hostName: result.hostName, hostFingerprint: result.hostShortFingerprint,
                                     controllerFingerprint: result.controllerShortFingerprint, storeFailure: storeFailure)
            } catch {
                // The core reports a cancelled pairing as `.cancelled` (「등록을 그만두었습니다」), not as B's window closing.
                self?.phase = .failed(ControllerPairingText.viewerNotice(for: error))
            }
            self?.pairing = nil
        }
    }

    /// Code ② as the field submitted it from hardware key-downs, once.
    func submitHostCode(_ submission: ControllerPairingCodeEntry.Submission) {
        hostCode?.resume(returning: submission)
        hostCode = nil
    }

    /// 「그만두기」: nothing more is sent, K_A is dropped. Whatever the pairing is waiting for (B's decision, the code ②
    /// field, or the hop that is about to show it), it ends now.
    func cancel() {
        gaveUp = true
        hostCode?.resume(returning: nil)
        hostCode = nil
        pairing?.cancel()
    }

    /// 「다시 찾기」 after a failure.
    func again() {
        guard case .failed = phase else { return }
        stopDiscovery()
        listings = []
        searchState = .idle
        notice = nil
        phase = .browsing
    }

    /// A control or a key this Mac's hardware did not run.
    func refused() { notice = ScreenInputOriginText.notInFront }
}

/// Code ②'s field: hardware key-downs only (`ControllerPairingCodeEntry`). Not a text field, so an accessibility "set
/// value" or a paste reaches nothing; it shows the digits typed so far.
@MainActor
final class PairingCodeView: NSView {
    private var entry = ControllerPairingCodeEntry()
    var submit: (ControllerPairingCodeEntry.Submission) -> Void = { _ in }
    /// A key that did not come from this Mac's hardware.
    var refused: () -> Void = {}

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.cgColor
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel("B에 보이는 숫자 입력칸 · 이 Mac의 실제 키보드로만 입력됩니다")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override var acceptsFirstResponder: Bool { true }
    override var intrinsicContentSize: NSSize { NSSize(width: 240, height: 44) }

    override func becomeFirstResponder() -> Bool { needsDisplay = true; return true }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return true }
    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }

    override func keyDown(with event: NSEvent) {
        let key: ControllerPairingCodeEntry.Key
        switch event.keyCode {
        case 0x24, 0x4C: key = .submit
        case 0x33, 0x75: key = .delete
        default:
            guard let scalar = event.charactersIgnoringModifiers?.unicodeScalars.first, ("0"..."9").contains(scalar) else { return }
            key = .digit(UInt8(scalar.value - 48))
        }
        switch entry.key(key, event: ViewerEvent.read(event), ownPid: ViewerEvent.ownPid, screenPid: ViewerEvent.screenPid()) {
        case .submitted(let submission): submit(submission)
        case .ignored(.some): refused()
        case .ignored(nil), .changed: break
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let digits = entry.text.padding(toLength: ControllerPairingProtocol.codeDigits, withPad: "·", startingAt: 0)
        let text = NSAttributedString(string: digits, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 24, weight: .semibold), .foregroundColor: NSColor.labelColor, .kern: 6,
        ])
        let size = text.size()
        text.draw(at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2))
        layer?.borderColor = (window?.firstResponder === self ? NSColor.keyboardFocusIndicatorColor : NSColor.separatorColor).cgColor
    }
}

/// The sheet itself, attached to the list's window.
@MainActor
final class PairingSheetController {
    let window: NSWindow
    let model: PairingSheetModel
    /// Runs once the sheet has closed.
    var closed: () -> Void = {}
    private let column = NSStackView()
    private let phaseView = NSStackView()
    private let noticeLabel = NSTextField(wrappingLabelWithString: "")
    private let titleLabel = NSTextField(wrappingLabelWithString: "")
    private let communityName: String?
    private static let width: CGFloat = 520

    init(model: PairingSheetModel, communityName: String? = nil) {
        self.model = model
        self.communityName = communityName.map(ViewerCommunityText.deviceName)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 240), styleMask: [.titled],
                          backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        titleLabel.font = .boldSystemFont(ofSize: 17)
        titleLabel.preferredMaxLayoutWidth = Self.width - 40
        phaseView.orientation = .vertical
        phaseView.alignment = .leading
        phaseView.spacing = 10
        noticeLabel.textColor = .systemRed
        noticeLabel.isHidden = true
        noticeLabel.preferredMaxLayoutWidth = Self.width - 40
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 14
        column.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        column.setViews([titleLabel, phaseView, noticeLabel], in: .leading)
        column.widthAnchor.constraint(equalToConstant: Self.width).isActive = true
        window.contentView = column
        model.phaseChanged = { [weak self] in self?.render() }
        model.noticeChanged = { [weak self] in self?.renderNotice() }
        render()
    }

    func begin(on parent: NSWindow) {
        parent.beginSheet(window)
    }

    /// 「닫기」, or the list closing it: the browse and any pairing in flight end, and K_A with it.
    func close() {
        model.stop()
        window.sheetParent?.endSheet(window)
        window.orderOut(nil)
        closed()
    }

    private func label(_ text: String, font: NSFont? = nil, secondary: Bool = false) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.preferredMaxLayoutWidth = Self.width - 40
        if let font { label.font = font }
        if secondary { label.textColor = .secondaryLabelColor }
        return label
    }

    private func button(_ title: String, _ handler: @escaping (HumanProof) -> Void) -> NSView {
        HumanButton(title: title, handler: handler)
    }

    private func row(_ views: [NSView]) -> NSStackView {
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.spacing = 8
        return row
    }

    private func waiting(_ text: String) -> NSView {
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        return row([spinner, label(text, secondary: true)])
    }

    private func windowChoices(_ listings: [ControllerPairingWindowListing]) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        for listing in listings {
            let name = label("‘\(listing.hostName)’ · 창 번호 \(listing.windowNumber)")
            name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            name.widthAnchor.constraint(lessThanOrEqualToConstant: Self.width - 160).isActive = true
            stack.addArrangedSubview(row([name, button("이 창 고르기") { [weak self] proof in self?.model.pick(listing, proof) }]))
        }
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            stack.topAnchor.constraint(equalTo: document.topAnchor), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
        ])
        scroll.documentView = document
        document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        scroll.widthAnchor.constraint(equalToConstant: Self.width - 40).isActive = true
        scroll.heightAnchor.constraint(equalToConstant: min(180, CGFloat(listings.count) * 44)).isActive = true
        return scroll
    }

    private func render() {
        for view in phaseView.arrangedSubviews { phaseView.removeArrangedSubview(view); view.removeFromSuperview() }
        let monospaced = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        var views: [NSView] = []
        var focus: NSView?
        titleLabel.stringValue = "Mac 화면 등록"
        switch model.phase {
        case .browsing:
            titleLabel.stringValue = communityName.map { "\($0) 등록 안내" } ?? "Mac 화면 등록 안내"
            views.append(label("먼저 상대 Mac에서 준비해 주세요", font: .boldSystemFont(ofSize: 14)))
            views.append(label("1. 상대 Mac에서 AgentsToZ Screen을 엽니다.\n2. 「다른 Mac 추가…」를 눌러 등록 창을 엽니다.\n3. 이 창에서 검색한 뒤, 상대 화면과 같은 창 번호를 고릅니다."))
            views.append(label("등록할 Mac 선택과 인증은 각 Mac에서 직접 해주세요.", secondary: true))
            views.append(label("「다른 Mac 추가…」가 없으면 상대 Mac의 AgentsToZ Screen 업데이트가 필요합니다.", secondary: true))
            let limit = label("처음 등록은 가까이 있는 두 Mac에서만 지원합니다. 멀리 있는 커뮤니티 Mac을 인터넷으로 처음 등록하는 기능은 아직 지원하지 않습니다.")
            limit.textColor = .labelColor
            views.append(limit)
            switch model.searchState {
            case .idle:
                views.append(label("상대 Mac의 등록 창을 연 뒤 아래 버튼을 누르세요.", secondary: true))
            case .searching:
                views.append(waiting("근처 등록 창 검색 중… · 최대 12초"))
            case .finished:
                if model.listings.isEmpty {
                    views.append(label("등록 창을 찾지 못했습니다", font: .boldSystemFont(ofSize: 13)))
                    views.append(label("두 Mac이 가까이 있는지, 상대 Mac의 등록 창이 열려 있는지 확인하세요. macOS의 로컬 네트워크 접근 허용도 확인할 수 있습니다.", secondary: true))
                }
            }
            if !model.listings.isEmpty {
                views.append(label("등록 창 \(model.listings.count)개 · 상대 화면과 같은 번호를 고르세요", font: .boldSystemFont(ofSize: 13)))
                views.append(windowChoices(model.listings))
            }
            if model.searchState != .searching {
                let search = PresentationButton(title: model.searchState == .idle ? "등록 창 찾기" : "다시 찾기") { [weak self] in
                    self?.model.startBrowsing()
                }
                if model.searchState == .idle { search.keyEquivalent = "\r" }
                views.append(search)
            }
            views.append(PresentationButton(title: "닫기") { [weak self] in self?.close() })
        case .connecting(let listing):
            views.append(waiting("‘\(listing.hostName)’ · 창 번호 \(listing.windowNumber)에 연결하는 중…"))
            views.append(PresentationButton(title: "그만두기") { [weak self] in self?.model.cancel() })
        case .showingCode(let code, let fingerprint, let listing):
            views.append(label("상대 Mac ‘\(listing.hostName)’에 이 숫자를 입력하세요", font: .boldSystemFont(ofSize: 13)))
            views.append(label(code, font: .monospacedDigitSystemFont(ofSize: 36, weight: .bold)))
            views.append(label("이 Mac의 키 지문 \(fingerprint) · 상대 화면의 키 지문과 비교하세요", font: monospaced))
            views.append(PresentationButton(title: "그만두기") { [weak self] in self?.model.cancel() })
        case .enteringHostCode(let grant, let fingerprint, let listing):
            views.append(label("상대 Mac ‘\(listing.hostName)’이 승인했습니다 (\(grant == .control ? "조작" : "보기")). 상대 화면의 숫자를 입력하세요",
                               font: .boldSystemFont(ofSize: 13)))
            let field = PairingCodeView()
            field.submit = { [weak self] submission in self?.model.submitHostCode(submission) }
            field.refused = { [weak self] in self?.model.refused() }
            views.append(field)
            focus = field
            views.append(label("한 번만 입력할 수 있습니다. 다음에 Touch ID(또는 Apple Watch)로 확인합니다 · 키 지문 \(fingerprint)",
                               secondary: true))
            views.append(PresentationButton(title: "그만두기") { [weak self] in self?.model.cancel() })
        case .paired(let state, let hostName, let hostFingerprint, let controllerFingerprint, let storeFailure):
            let shown = ControllerPairingText.showable(hostName)
            if let storeFailure {
                views.append(label("‘\(shown)’에는 이 Mac이 등록됐지만 이 Mac의 목록에 저장하지 못했습니다", font: .boldSystemFont(ofSize: 13)))
                views.append(label("상대 Mac의 목록에서 키 지문 \(controllerFingerprint) 항목을 지우고 다시 등록하세요 · \(storeFailure)"))
            } else {
                views.append(label("‘\(shown)’을(를) 추가했습니다 · \(state == .confirmed ? "확인됨" : ControllerPairingText.needsCheck)",
                                   font: .boldSystemFont(ofSize: 13)))
                views.append(label("상대 Mac의 목록에 같은 키 지문 \(controllerFingerprint)이(가) 있는지 확인하세요"))
            }
            views.append(label("상대 Mac의 키 지문 \(hostFingerprint)", font: monospaced, secondary: true))
            views.append(PresentationButton(title: "닫기") { [weak self] in self?.close() })
        case .failed(let notice):
            let text = label(notice.text)
            if notice.alarm {
                text.textColor = .white
                text.drawsBackground = true
                text.backgroundColor = .systemRed
            }
            views.append(text)
            views.append(row([PresentationButton(title: "다시 찾기") { [weak self] in self?.model.again() },
                              PresentationButton(title: "닫기") { [weak self] in self?.close() }]))
        }
        for view in views { phaseView.addArrangedSubview(view) }
        fit()
        if let focus { window.makeFirstResponder(focus) }
    }

    private func renderNotice() {
        noticeLabel.stringValue = model.notice ?? ""
        noticeLabel.isHidden = model.notice == nil
        fit()
    }

    private func fit() {
        column.layoutSubtreeIfNeeded()
        window.setContentSize(NSSize(width: Self.width, height: column.fittingSize.height))
    }
}
#endif
