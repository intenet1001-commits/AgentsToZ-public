#if os(macOS)
import AppKit
import ScreenControlCore

// The Viewer's main window (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.1): the Macs this Mac may connect to, each with
// its route, what B last said it grants, whether B confirmed the registration, and the four fingerprint digits to compare
// with B's own list. Enrollment and connection use HumanButton. Read-only discovery and opening an enrollment guide
// use PresentationButton; those actions cannot make a HumanProof or start a session.

@MainActor
final class TargetListController: NSObject {
    let window: NSWindow
    private let ledger: ViewerTargetsLedger
    private let communityAccount: ViewerCommunityAccount?
    private var communitySheet: ViewerCommunitySheet?
    private var communityRouteSheet: CommunityRouteSheet?
    private let communityDirectory: () throws -> ViewerCommunityDirectory
    private let rows = NSStackView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private let communityRows = NSStackView()
    /// The 「연결」 in progress (biometric approval, path, key exchange), if any: one at a time.
    private var connecting: (id: String, ticket: Int, task: Task<Void, Never>)?
    /// Moves on every connection started and every one called off; a connection opens a window only while it still holds
    /// the ticket it started with, so one that finished after this Mac locked or slept, or after its Mac was removed here,
    /// closes instead.
    private var ticket = 0
    /// The session in progress, if any: one at a time.
    private(set) var active: (session: ViewerSession, window: SessionWindowController)?
    /// The 「Mac 추가」 sheet while it is open.
    private var pairing: PairingSheetController?

    init(ledger: ViewerTargetsLedger, communityDirectory: @escaping () throws -> ViewerCommunityDirectory = ViewerCommunityReader.read, communityAccount: ViewerCommunityAccount? = nil) {
        self.ledger = ledger
        self.communityAccount = communityAccount
        self.communityDirectory = communityDirectory
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 520),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "AgentsToZ Viewer"
        window.isReleasedWhenClosed = false
        window.contentView = makeContent()
        window.center()
        ledger.load()
        communityAccount?.changed = { [weak self] in self?.communityChanged() }
        refresh()
    }

    private func makeContent() -> NSView {
        let title = NSTextField(labelWithString: "다른 Mac 화면 보기")
        title.font = .boldSystemFont(ofSize: 17)
        let note = NSTextField(wrappingLabelWithString:
            "등록한 Mac을 선택해 연결하세요. 공통 등록을 마친 Mac은 다시 인증하지 않습니다. 기존 직접 등록은 연결마다 기기 인증이 필요합니다.")
        note.textColor = .secondaryLabelColor
        let add = PresentationButton(title: "Mac 추가…") { [weak self] in self?.presentPairing() }
        let reload = PresentationButton(title: "커뮤니티 목록 새로 고침") { [weak self] in self?.refreshCommunity() }
        communityRows.orientation = .vertical
        communityRows.alignment = .leading
        communityRows.spacing = 10
        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 12
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        rows.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(rows)
        NSLayoutConstraint.activate([
            rows.leadingAnchor.constraint(equalTo: document.leadingAnchor),
            rows.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            rows.topAnchor.constraint(equalTo: document.topAnchor),
            rows.bottomAnchor.constraint(equalTo: document.bottomAnchor),
        ])
        scroll.documentView = document
        document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        status.textColor = .secondaryLabelColor
        let community = PresentationButton(title: "커뮤니티 기기 등록·승인…") { [weak self] in self?.presentCommunity() }
        let actions = NSStackView(views: [community, add, reload])
        let column = NSStackView(views: [title, note, scroll, status, actions])
        column.orientation = .vertical
        column.alignment = .leading
        column.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 280).isActive = true
        scroll.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -32).isActive = true
        note.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -32).isActive = true
        status.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -32).isActive = true
        return column
    }

    func show() { communityAccount?.resume(); refreshCommunity(); window.makeKeyAndOrderFront(nil) }

    func say(_ text: String) { status.stringValue = text }

    // MARK: Rows

    func refresh() {
        for view in rows.arrangedSubviews { rows.removeArrangedSubview(view); view.removeFromSuperview() }
        switch ledger.contents {
        case .unread:
            break
        case .unreadable(let reason):
            rows.addArrangedSubview(NSTextField(wrappingLabelWithString: "\(ScreenTargetText.storeUnreadable)\n\(reason)"))
        case .loaded(let decoded):
            if decoded.targets.isEmpty && communityAccount?.targets.isEmpty != false && communityAccount?.commonTargets.isEmpty != false {
                rows.addArrangedSubview(NSTextField(wrappingLabelWithString: "화면을 등록한 Mac이 없습니다. 아래 커뮤니티 기기를 확인하거나 「Mac 추가…」로 등록 안내를 여세요."))
            }
            let commonIDs = Set(communityAccount?.commonTargets.map(\.id) ?? [])
            for target in decoded.targets where !commonIDs.contains(target.id) { rows.addArrangedSubview(row(for: target)) }
            if decoded.dropped > 0 {
                rows.addArrangedSubview(NSTextField(wrappingLabelWithString: "손상된 항목 \(decoded.dropped)개는 읽지 못해 목록에서 뺐습니다"))
            }
        }
        if let account = communityAccount {
            let heading = NSTextField(labelWithString: "원격 접근에 등록된 커뮤니티 Mac")
            heading.font = .boldSystemFont(ofSize: 15); rows.addArrangedSubview(heading)
            rows.addArrangedSubview(NSTextField(wrappingLabelWithString: account.message))
            let commonIDs = Set(account.commonTargets.map(\.id))
            for target in account.commonTargets { rows.addArrangedSubview(row(for: target, community: true, common: true)) }
            let paired = Set(ledger.targets?.map(\.id) ?? [])
            for target in account.targets where account.unified?.hasEnrollmentPlan != true && !paired.contains(target.id) && !commonIDs.contains(target.id) { rows.addArrangedSubview(row(for: target, community: true)) }
        }
        let heading = NSTextField(labelWithString: "기존 커뮤니티 발견 정보")
        heading.font = .boldSystemFont(ofSize: 15)
        rows.addArrangedSubview(heading)
        rows.addArrangedSubview(communityRows)
        communityRows.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
        refreshCommunity()
    }

    /// Display-only hints: names are never matched to pinned targets and membership never supplies a grant or route.
    private func refreshCommunity() {
        for view in communityRows.arrangedSubviews { communityRows.removeArrangedSubview(view); view.removeFromSuperview() }
        guard let directory = try? communityDirectory() else {
            communityRows.addArrangedSubview(NSTextField(wrappingLabelWithString:
                "최신 커뮤니티 목록을 받지 못했습니다. AgentsToZ에서 커뮤니티 연결을 확인한 뒤 새로 고침하세요. 기존 등록 Mac에는 계속 연결할 수 있습니다."))
            return
        }
        guard directory.inside else {
            communityRows.addArrangedSubview(NSTextField(wrappingLabelWithString:
                "AgentsToZ의 「기기 간 대화」에서 커뮤니티에 참여하면 다른 기기가 여기에 표시됩니다."))
            return
        }
        if directory.devices.isEmpty {
            communityRows.addArrangedSubview(NSTextField(wrappingLabelWithString: "현재 커뮤니티에서 다른 기기를 찾지 못했습니다."))
        }
        for device in directory.devices {
            let name = NSTextField(labelWithString: ViewerCommunityText.deviceName(device.name))
            name.toolTip = device.name
            name.font = .boldSystemFont(ofSize: 14)
            let seen = ViewerCommunityText.lastResponse(device.lastSeenAt)
            let detail = NSTextField(wrappingLabelWithString: "\(seen) · 화면 연결 지원·등록은 별도 확인")
            detail.textColor = .secondaryLabelColor
            let register = PresentationButton(title: "화면 등록 안내…") { [weak self] in self?.presentPairing(communityName: device.name) }
            let row = NSStackView(views: [name, detail, register])
            row.orientation = .vertical
            row.alignment = .leading
            communityRows.addArrangedSubview(row)
        }
    }

    private func row(for target: ViewerTarget, community: Bool = false, common: Bool = false) -> NSView {
        let name = NSTextField(labelWithString: target.displayName)
        name.font = .boldSystemFont(ofSize: 14)
        let grant = switch target.grantLastHeard {
        case .control?: "조작 가능"
        case .view?: "보기만"
        case nil: "권한 확인 전"
        }
        let state = target.state == .confirmed ? "확인됨" : "확인 필요"
        let internet = target.privateNetwork.map { "인터넷 주소 \($0.address)" } ?? "인터넷 주소 없음"
        let details = NSTextField(labelWithString: common ? "공통 등록 · Cloudflare 인터넷 · 반복 인증 없음 · 키 지문 \(target.keyFingerprint4)" : "\(grant) · \(state) · 키 지문 \(target.keyFingerprint4) · \(internet)")
        details.textColor = .secondaryLabelColor

        let routes: [(ViewerTarget.Route, String)] = [(.auto, "자동"), (.nearby, "근거리만"), (.private, "인터넷만")]
        let routeButtons = routes.map { route, title in
            let button = HumanButton(title: target.route == route ? "✓ \(title)" : title) { [weak self] proof in
                self?.choose(route, for: target.id, proof)
            }
            return button as NSView
        }
        let connect = HumanButton(title: "연결") { [weak self] proof in self?.connect(target.id, proof) }
        let remove = HumanButton(title: "이 Mac에서 삭제", guarded: { false }) { [weak self] proof in self?.remove(target.id, proof) }
        let address = PresentationButton(title: "사설망 주소 설정…") { [weak self] in self?.editCommunityAddress(target) }
        let actions = NSStackView(views: common ? [connect] : (community ? routeButtons + [connect, address] : routeButtons + [connect, remove]))
        let row = NSStackView(views: [name, details, actions])
        row.orientation = .vertical
        row.alignment = .leading
        row.spacing = 4
        return row
    }

    // MARK: Actions (each ran from this Mac's hardware: HumanActions)

    private func stored(_ id: String) -> ViewerTarget? {
        communityAccount?.commonTargets.first { $0.id == id } ?? ledger.targets?.first { $0.id == id } ?? (communityAccount?.unified?.hasEnrollmentPlan == true ? nil : communityAccount?.targets.first { $0.id == id })
    }
    private func communityChanged() {
        if let pending = connecting, stored(pending.id) == nil { callOffConnecting("커뮤니티 등록 확인이 만료되어 연결을 중단했습니다.") }
        if let active, stored(active.session.target.id) == nil { active.session.end(.here, text: "커뮤니티 등록이 해제되었거나 연결 확인이 만료되었습니다.") }
        refresh()
    }
    private func presentCommunity() {
        guard communitySheet == nil, let account = communityAccount else { return }
        let sheet = ViewerCommunitySheet(account: account)
        sheet.closed = { [weak self] in self?.communitySheet = nil }
        communitySheet = sheet; sheet.begin(on: window)
        Task { await account.refresh() }
    }

    private func choose(_ route: ViewerTarget.Route, for id: String, _ proof: HumanProof) {
        guard communityAccount?.commonPeer(id) == nil, let target = stored(id) else { return }
        do {
            if ledger.targets?.contains(where: { $0.id == id }) == true { try ledger.replace(target.choosingRoute(route)) }
            else { try communityAccount?.saveRoute(for: target, address: target.privateNetwork, selection: route, proof) }
        } catch { say(ScreenTargetText.storeUnreadable) }
        refresh()
    }
    private func editCommunityAddress(_ target: ViewerTarget) {
        guard communityRouteSheet == nil, communityAccount?.commonPeer(target.id) == nil else { return }
        let sheet = CommunityRouteSheet(target: target) { [weak self] address, proof in
            guard let self, let account = self.communityAccount else { throw ScreenCommunityError.notConfigured }
            try account.saveRoute(for: target, address: address, proof)
        }
        sheet.closed = { [weak self] in self?.communityRouteSheet = nil }
        communityRouteSheet = sheet; sheet.begin(on: window)
    }

    private func connect(_ id: String, _ proof: HumanProof) {
        guard connecting == nil, active == nil, let target = stored(id) else { return }
        ticket &+= 1
        let mine = ticket
        let common = communityAccount?.commonPeer(id) != nil
        say(common ? "공통 기기 권한과 Cloudflare 경로를 확인하는 중…" : "생체 인증을 기다리는 중…")
        let task = Task { [weak self] in
            do {
                let connected: ScreenTargetConnector.Connected
                if common {
                    guard let account = self?.communityAccount, let unified = account.unified else { throw ScreenCommunityError.notConfigured }
                    let own = try await account.currentAuthorization()
                    guard let peer = account.commonPeer(id), peer.isCurrent() else { throw ScreenCommunityError.service("NOT_ENROLLED") }
                    let signer = try await account.operationSigner(for: .screenView)
                    connected = try await CommunityScreenConnector.connect(authority: unified.authority, own: own, target: peer, signer: signer,
                        ticketProvider: { [weak account] connectionID in
                            guard let account else { throw ScreenCommunityError.notConfigured }
                            return try await account.screenRelayTicket(connectionID: connectionID)
                        }, signerProvider: { [weak account] in
                            guard let account else { throw ScreenCommunityError.notConfigured }
                            return try await account.operationSigner(for: .screenView)
                        })
                } else {
                    connected = try await ViewerConnection.connect(target) { [weak self] phase in
                        await MainActor.run {
                            guard let self, self.ticket == mine else { return }
                            self.say(phase.progressMessage)
                        }
                    }
                }
                // Called off meanwhile (this Mac locked, slept or switched users; the Mac was removed here): B's session
                // closes at once and no window opens.
                guard let self, self.ticket == mine, !Task.isCancelled else {
                    await connected.viewer.close()
                    return
                }
                self.connecting = nil
                if self.stored(id) == nil {
                    await connected.viewer.close()
                    self.say(ScreenTargetText.removedHere)
                    return
                }
                var listUpdated = common || self.ledger.targets?.contains(where: { $0.id == id }) == false
                if !common, let current = self.ledger.targets?.first(where: { $0.id == id }) {
                    do {
                        try self.ledger.replace(current.after(connecting: .success(Date())))
                        listUpdated = true
                    } catch {}
                }
                self.refresh()
                self.open(connected, target: self.stored(id) ?? target, listUpdated: listUpdated, commonRegistration: common)
            } catch {
                let text = common ? "Cloudflare 화면 연결을 완료하지 못했습니다. 상대 Screen의 수신 상태와 커뮤니티 연결을 확인하세요." : await ViewerConnection.message(for: error, target: target)
                // A refusal changes nothing stored (ViewerTargets.swift): only the words. A connection called off has
                // said its own.
                guard let self, self.ticket == mine else { return }
                self.connecting = nil
                self.say(text)
            }
        }
        connecting = (id, mine, task)
    }

    /// Calls off the 「연결」 in progress, if any, and says `text`.
    private func callOffConnecting(_ text: String) {
        guard let pending = connecting else { return }
        connecting = nil
        ticket &+= 1
        pending.task.cancel()
        say(text)
    }

    private func open(_ connected: ScreenTargetConnector.Connected, target: ViewerTarget, listUpdated: Bool, commonRegistration: Bool = false) {
        let session = ViewerSession(target: target, connected: connected, ledger: ledger, commonRegistration: commonRegistration)
        let controller = SessionWindowController(session: session)
        controller.closed = { [weak self] text in
            self?.active = nil
            self?.ledger.load()
            self?.refresh()
            self?.say(text)
            self?.show()
        }
        active = (session, controller)
        let opened = connected.path.isNearby ? "근거리로 연결했습니다" : "인터넷 경로로 연결했습니다"
        say(listUpdated ? opened : opened + " · " + ScreenTargetText.listUpdateFailed)
        controller.show()
    }

    private func remove(_ id: String, _ proof: HumanProof) {
        guard communityAccount?.commonPeer(id) == nil, let target = stored(id) else { return }
        // A connection to this Mac still in progress never opens: it is not connected, so B is only told by its own list.
        if connecting?.id == id { callOffConnecting(ScreenTargetText.removedHere) }
        Task { [weak self] in
            guard let self else { return }
            var unenrolled = false
            if let active = self.active, active.session.target.id == id {
                unenrolled = await active.session.unenroll(proof: proof)
                active.session.end(.here, text: unenrolled ? ScreenTargetText.unenrolled : nil)
            }
            do {
                try self.ledger.remove(id: target.id)
                self.say(unenrolled ? ScreenTargetText.unenrolled : ScreenTargetText.removedHere)
            } catch {
                self.say(ScreenTargetText.storeUnreadable)
            }
            self.refresh()
        }
    }

    /// 「Mac 추가…」: the registration sheet (PairingSheet.swift, DESIGN 6.3). Not while connecting or in a session: B
    /// closes its registration window when a session starts (SR-37), and one thing at a time here.
    private func presentPairing(communityName: String? = nil) {
        guard pairing == nil, connecting == nil, active == nil else {
            say("열린 등록 창 또는 연결을 마친 뒤 Mac을 추가하세요."); return
        }
        let sheet = PairingSheetController(model: PairingSheetModel { [weak self] result, key, proof in
            guard let self else { return ScreenTargetText.storeUnreadable }
            return self.storePairing(result, key: key, proof)
        }, communityName: communityName)
        sheet.closed = { [weak self] in
            self?.pairing = nil
            self?.refresh()
        }
        pairing = sheet
        sheet.begin(on: window)
    }

    /// Keeps the Mac the sheet just paired with: a new row, or one that replaces the row for the same Mac (a new key;
    /// its saved address and route stay). `proof` is the hardware click that picked B's window. Returns why the row
    /// could not be kept, nil when it was.
    private func storePairing(_ result: ControllerPairingResult, key: ControllerKeyMaterial, _ proof: HumanProof) -> String? {
        do {
            let paired = try ViewerTarget(hostPublicKey: result.host.publicKey, name: result.hostName, controllerKeyBlob: key.blob,
                                          controllerPublicKey: key.signer.publicKey,
                                          state: result.state == .confirmed ? .confirmed : .needsCheck, pairedAt: Date())
            try ledger.update { targets in
                var row = paired
                if let previous = targets.first(where: { $0.id == paired.id }) {
                    if let address = previous.privateNetwork { row = row.savingAddress(address) }
                    row = row.choosingRoute(previous.route)
                }
                return targets.filter { $0.id != row.id } + [row]
            }
            say("‘\(ControllerPairingText.showable(result.hostName))’을(를) 추가했습니다")
            return nil
        } catch {
            say(ScreenTargetText.storeUnreadable)
            return "\(error)"
        }
    }

    /// A control ran by anything but this Mac's hardware while no session window has the keyboard: say so on the sheet
    /// when it is open, else on the list.
    func tellNotInFront(_ reason: ScreenInputRefusal = .notTheControl) {
        if communitySheet != nil { communityAccount?.inputRefused(reason) }
        else if let pairing { pairing.model.refused() } else { say(ScreenInputOriginText.notInFront) }
    }

    /// This Mac locked, slept or switched users: the session ends at once and is never resumed by itself, and a
    /// connection still in progress never opens.
    func guardTripped() {
        callOffConnecting(ScreenTargetText.connectGuardTripped)
        active?.session.end(.guardTripped)
        // A registration in progress ends too, and K_A with it: the person registers again in front of both Macs.
        pairing?.close()
    }
}

/// A document view whose rows start at the top.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
#endif
