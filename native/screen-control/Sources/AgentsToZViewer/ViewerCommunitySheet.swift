#if os(macOS)
import AppKit
import ScreenControlCore

/// Opens from an ordinary presentation button. A staging request grants nothing; only the explicit owner action
/// below invokes a biometric signer. There is no session start/input path in this sheet.
@MainActor
final class ViewerCommunitySheet {
    let window: NSWindow
    private let account: ViewerCommunityAccount
    private let nameField = NSTextField(string: "")
    private let root = NSStackView()
    private let messageField = NSTextField(wrappingLabelWithString: "")
    private let queue = NSStackView()
    private let ownerSection=ViewerOwnerRecoverySection()
    private let body = ViewerCommunityStableBody()
    private var queueKey = ""
    private var controls: [(NSControl, () -> Bool)] = []
    private var confirmationButton: NSButton?
    private func enabled(_ control: NSControl, when predicate: @escaping () -> Bool = { true }) {
        controls.append((control, predicate)); control.isEnabled = !account.busy && predicate()
    }
    var closed: () -> Void = {}
    init(account: ViewerCommunityAccount) {
        self.account = account
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 620), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "AgentsToZ 커뮤니티 기기"
        window.isReleasedWhenClosed = false
        nameField.placeholderString = "예: 아젠투지 3호 (비워 두면 Mac 이름 사용)"
        nameField.setAccessibilityLabel("커뮤니티에서 사용할 이 Mac 이름")
        root.orientation = .vertical; root.alignment = .leading; root.spacing = 12
        root.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        let title = NSTextField(labelWithString: "커뮤니티에 한 번 등록하고 함께 연결")
        title.font = .boldSystemFont(ofSize: 18); root.addArrangedSubview(title)
        root.addArrangedSubview(messageField)
        queue.orientation = .vertical; queue.alignment = .leading; queue.spacing = 8; root.addArrangedSubview(queue)
        ownerSection.orientation = .vertical;ownerSection.alignment = .leading;ownerSection.spacing=8;root.addArrangedSubview(ownerSection)
        body.orientation = .vertical; body.alignment = .leading; body.spacing = 12; root.addArrangedSubview(body)
        let refresh = PresentationButton(title: "등록 상태 새로 고침") { [weak account] in Task { await account?.refreshRegistration() } }
        let close = PresentationButton(title: "닫기") { [weak self] in self?.close() }; close.keyEquivalent = "\u{1b}"
        root.insertArrangedSubview(NSStackView(views: [refresh, close]), at: 2)
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        let document = FlippedView(); document.translatesAutoresizingMaskIntoConstraints = false
        root.translatesAutoresizingMaskIntoConstraints = false; document.addSubview(root); scroll.documentView = document
        NSLayoutConstraint.activate([document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            root.leadingAnchor.constraint(equalTo: document.leadingAnchor), root.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            root.topAnchor.constraint(equalTo: document.topAnchor), root.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            body.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -40), queue.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -40),
            ownerSection.widthAnchor.constraint(equalTo:root.widthAnchor,constant:-40),
            messageField.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -40)])
        window.contentView = scroll
        account.sheetChanged = { [weak self, weak account] in self?.render(); refresh.isEnabled = account?.busy != true }
        render()
    }
    func begin(on parent: NSWindow) { parent.beginSheet(window) }
    func close() {
        account.cancelAdministratorAction()
        account.sheetChanged = {}
        window.sheetParent?.endSheet(window); window.orderOut(nil); closed()
    }
    private func render() {
        messageField.stringValue = [account.message, account.unified?.registrationMessage ?? ""].filter { !$0.isEmpty }.joined(separator: "\n")
        renderQueue()
        ownerSection.render(account)
        for (control, condition) in controls { control.isEnabled = !account.busy && condition() }
        if let review = account.unified?.review { confirmationButton?.state = account.unified?.confirmation.isConfirmed(for: review) == true ? .on : .off }
        // Leases, queue polling and status text do not replace live form controls or their field editor.
        let reviewKey = account.unified?.review.map { "\($0.planId):\($0.digest):\($0.challenge):\($0.management?.digest ?? "normal")" } ?? ""
        let key = [reviewKey, account.review?.pendingID ?? "", account.removing?.enrollmentID ?? "",
            account.certificate?.member.enrollmentID ?? "", String(account.certificate?.member.admin == true),
            account.selectedCapabilities.map(\.rawValue).joined(separator: ","), account.unified?.registrationCode ?? "",
            account.directory?.members.map { "\($0.enrollmentID):\($0.keyEpoch)" }.joined(separator: ",") ?? "",
            CommunityCapability.allCases.map { account.featureStatus($0) }.joined(separator: "|")].joined(separator: "\n")
        guard body.beginUpdate(key: key) else { return }
        controls = []; confirmationButton = nil
        let column = body
        if let removing = account.removing {
            column.addArrangedSubview(NSTextField(labelWithString: "‘\(removing.name)’ 등록 해제"))
            column.addArrangedSubview(NSTextField(wrappingLabelWithString: "기기 키 \(removing.registrationFingerprint)\n이 기기는 모든 커뮤니티 Mac에 접근할 수 없게 됩니다. 연결 중인 화면도 목록 갱신 또는 최대 90초 이내에 닫힙니다."))
            let revoke = HumanButton(title: "인증하고 이 기기 등록 해제") { [weak account] proof in Task { await account?.revoke(proof) } }
            enabled(revoke); column.addArrangedSubview(revoke)
            column.addArrangedSubview(PresentationButton(title: "취소") { [weak account] in account?.reviewRemoval(nil) })
        } else if let review = account.unified?.review {
            column.addArrangedSubview(NSTextField(labelWithString: review.plan.name))
            column.addArrangedSubview(NSTextField(wrappingLabelWithString: review.management.map { $0.administrator ? "선택 기능과 함께 이 모바일에 새 기기 등록 승인·해제 역할을 부여합니다. 전체 기능 선택과 별도의 관리 권한입니다." : "선택 기능과 함께 이 모바일의 등록 승인 역할과 알림 구독을 해제합니다." } ?? "선택한 기능만 승인합니다. 기존 관리 역할을 보존하며 새 관리자나 OS 권한을 자동으로 추가하지 않습니다."))
            if review.plan.kind == .mobile {
                column.addArrangedSubview(NSTextField(wrappingLabelWithString: "관리 역할은 기본 변경하지 않습니다. 명시적으로 바꾸면 새 검토·등록 코드 확인 후 같은 생체 인증 한 번으로 승인합니다."))
                for choice in CommunityManagementChoice.allCases {
                    let button = PresentationButton(title: (account.unified?.managementChoice == choice ? "✓ " : "") + choice.title) { [weak account] in Task { await account?.loadUnifiedReview(review.planId, choice: choice) } }
                    enabled(button); column.addArrangedSubview(button)
                }
            }
            if review.plan.capabilities.contains(.desktopTrust) { column.addArrangedSubview(NSTextField(wrappingLabelWithString:"기기 신뢰 모드: 두 Mac이 함께 승인되면 등록 키와 선택한 권한으로 연결·조작합니다. 승인된 프로그램도 이 경로를 사용할 수 있으며, 매 클릭이 물리 사람 입력이라는 뜻은 아닙니다. 기존 보류·차단·OS 권한은 유지합니다.")) }
            if review.plan.capabilities.contains(.ownerDelegation) {column.addArrangedSubview(NSTextField(wrappingLabelWithString:"이 계획의 같은 생체 승인으로 대상 Mac의 최초 입력 보류 해제 위임도 준비합니다. 실제 해제는 다른 현재 승인 Mac의 요청별 생체 확인이 필요합니다. 대상에서 직접 꺼 둔 위임·Screen 켜기·OS 권한을 대신 바꾸지는 않습니다."))}
            for capability in review.plan.capabilities { column.addArrangedSubview(NSTextField(labelWithString: "• \(capability.title)")) }
            let digest = NSTextField(wrappingLabelWithString: "등록 코드 \(CommunityEnrollmentCode.formatted(digest: review.digest) ?? "확인 불가") · 기기 키 \(review.plan.hostKey.prefix(16))…")
            digest.font = .monospacedSystemFont(ofSize: 12, weight: .regular); column.addArrangedSubview(digest)
            let confirmed = account.unified?.confirmation.isConfirmed(for: review) == true
            let comparison = PresentationButton(title: "상대 기기의 등록 코드와 같음을 확인했습니다") { [weak account] in account?.confirmUnifiedRegistration(digest: review.digest, confirmed: account?.unified?.confirmation.isConfirmed(for: review) != true) }
            comparison.setButtonType(.switch); comparison.state = confirmed ? .on : .off; enabled(comparison); confirmationButton = comparison
            column.addArrangedSubview(comparison)
            let approve = HumanButton(title: review.management == nil ? "한 번 인증하고 선택한 기능 승인" : "한 번 인증하고 기능·관리 역할 승인") { [weak account] proof in Task { await account?.approveUnified(proof, confirmedDigest: review.digest) } }
            enabled(approve, when: { [weak account] in account?.unified?.confirmation.isConfirmed(for: review) == true }); column.addArrangedSubview(approve)
            column.addArrangedSubview(PresentationButton(title: "목록으로") { [weak account] in account?.dismissUnifiedReview() })
        } else if let review = account.review {
            let title = NSTextField(labelWithString: review.device.name); title.font = .boldSystemFont(ofSize: 16); column.addArrangedSubview(title)
            let scope = review.device.platform == "ios" ? "iPhone·iPad · 등록된 Mac에 연결하고 새 기기 등록을 승인" : "Mac · 화면 보기·조작 허용 요청"
            column.addArrangedSubview(NSTextField(wrappingLabelWithString: "\(scope)\n기기 키 \(review.fingerprint)\n본인이 참여시킨 기기인지 확인하세요."))
            let label = review.device.platform == "ios" ? "등록하고 모바일 승인 기기로 사용" : "이 기기 등록 승인"
            let approve = HumanButton(title: label) { [weak account] proof in Task { await account?.approve(proof) } }
            enabled(approve); column.addArrangedSubview(approve)
            column.addArrangedSubview(PresentationButton(title: "목록으로") { [weak account] in account?.dismissReview() })
        } else {
            if account.certificate == nil { column.addArrangedSubview(nameField) }
            if let code = account.unified?.registrationCode {
                let registration = NSTextField(wrappingLabelWithString: "이 기기의 등록 코드 \(code)\n관리 기기에 표시된 코드가 같은지 비교한 뒤 승인하세요. 이름만으로 승인하지 마세요.")
                if let expires = account.unified?.registrationExpiresAt { registration.stringValue += "\n코드 만료: " + Date(timeIntervalSince1970: Double(expires) / 1000).formatted(date: .omitted, time: .standard) }
                registration.font = .monospacedSystemFont(ofSize: 14, weight: .medium); column.addArrangedSubview(registration)
            }
            let nameField = nameField
            let selectedTitle = NSTextField(labelWithString: "이 기기에서 사용할 기능")
            selectedTitle.font = .boldSystemFont(ofSize: 14); column.addArrangedSubview(selectedTitle)
            let all = PresentationButton(title: "전체 선택") { [weak account] in account?.selectAllFeatures() }
            enabled(all); column.addArrangedSubview(all)
            for capability in CommunityCapability.allCases {
                let selected = account.selectedCapabilities.contains(capability)
                let toggle = PresentationButton(title: "\(selected ? "☑" : "☐") \(capability.title)") { [weak account] in
                    account?.selectFeature(capability, selected: !selected)
                }
                toggle.setAccessibilityValue(selected ? "선택됨" : "선택 안 됨")
                enabled(toggle,when:{ [weak account] in
                    guard let account else {return false}
                    if capability == .ownerDelegation {return [CommunityCapability.desktopTrust,.receiveView,.receiveControl].allSatisfy(account.selectedCapabilities.contains)}
                    return capability != .desktopTrust || account.selectedCapabilities.contains(.screenView) || account.selectedCapabilities.contains(.receiveView)
                })
                let status = NSTextField(wrappingLabelWithString: account.featureStatus(capability))
                status.font = .systemFont(ofSize: 11); status.textColor = .secondaryLabelColor
                let row = NSStackView(views: [toggle, status]); row.orientation = .horizontal; row.alignment = .centerY; row.spacing = 12
                toggle.widthAnchor.constraint(equalToConstant: 230).isActive = true
                column.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
            }
            column.addArrangedSubview(PresentationButton(title:"선택 변경 취소 · 기존 등록 유지") { [weak self,weak account] in account?.unified?.cancelSelectionChanges();self?.render() })
            column.addArrangedSubview(NSTextField(wrappingLabelWithString:"취소는 선택 편집만 되돌립니다. 이미 보낸 승인 요청은 원래 요청 번호로 결과를 계속 확인하며 자동 재전송하지 않습니다."))
            let request = PresentationButton(title: "선택한 기능 한 번에 등록 요청") { [weak account] in
                account?.requestedName = nameField.stringValue; Task { await account?.requestUnifiedMembership() }
            }
            enabled(request, when: { [weak account] in account?.supported == true && account?.selectedCapabilities.isEmpty == false }); column.addArrangedSubview(request)
            if account.certificate == nil {
                let create = HumanButton(title: "첫 관리 Mac으로 커뮤니티 만들기") { [weak account] proof in account?.requestedName = nameField.stringValue; Task { await account?.createCommunity(proof) } }
                enabled(create, when: { [weak account] in account?.supported == true }); column.addArrangedSubview(create)
            }
            if account.certificate?.member.admin == true, let directory = account.directory {
                for member in directory.members where member.enrollmentID != directory.selfEnrollmentID {
                    let remove = PresentationButton(title: "\(member.name) · 등록 해제…") { [weak account] in account?.reviewRemoval(member) }
                    enabled(remove); column.addArrangedSubview(remove)
                }
            }
            if account.certificate != nil {
                let leave = PresentationButton(title: "이 Mac 커뮤니티 등록 해제…") { [weak self, weak account] in
                    let alert = NSAlert(); alert.messageText = "이 Mac의 커뮤니티 원격 접근 등록을 해제할까요?"
                    alert.informativeText = "다시 참여하려면 기존 관리 기기의 새 승인이 필요합니다. 마지막 관리 기기는 먼저 다른 승인 기기를 등록해야 합니다."
                    alert.addButton(withTitle: "등록 해제"); alert.addButton(withTitle: "취소")
                    guard let self else { return }; alert.beginSheetModal(for: self.window) { response in
                        if response == .alertFirstButtonReturn { Task { await account?.leave() } }
                    }
                }
                enabled(leave); column.addArrangedSubview(leave)
            }
            column.addArrangedSubview(NSTextField(wrappingLabelWithString: "기존 관리 기기에서 선택 목록을 한 번 승인합니다. 등록된 데스크톱은 정상 사용 때 다시 인증하지 않습니다. 화면 기록·손쉬운 사용 등 OS 권한은 이 Mac에서 준비해야 하며, 등록만으로 모든 기능이 실행되지는 않습니다."))
        }
        for field in column.arrangedSubviews.compactMap({ $0 as? NSTextField }) {
            field.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
    }
    private func renderQueue() {
        let status = account.unified?.pendingStatus ?? (account.supported ? "등록 상태 조회 필요" : "커뮤니티 서비스 설정 필요")
        let key = [status, account.unified?.pending.map { $0.planId + $0.name }.joined() ?? "", account.pending.map { $0.id + $0.name }.joined(), String(account.busy)].joined(separator: "|")
        guard key != queueKey else { return }; queueKey = key
        for view in queue.arrangedSubviews { queue.removeArrangedSubview(view); view.removeFromSuperview() }
        let title = NSTextField(labelWithString: "관리 역할·승인 요청"); title.font = .boldSystemFont(ofSize: 14); queue.addArrangedSubview(title)
        let label = NSTextField(wrappingLabelWithString: status); queue.addArrangedSubview(label)
        if account.certificate?.member.admin == true {
            for item in account.unified?.pending ?? [] {
                let button = PresentationButton(title: "\(item.name) · 기능 등록 검토") { [weak account] in Task { await account?.loadUnifiedReview(item.planId) } }
                button.isEnabled = !account.busy; queue.addArrangedSubview(button)
            }
            for item in account.pending {
                let button = PresentationButton(title: "\(item.name) · 기존 등록 검토") { [weak account] in Task { await account?.loadReview(item.id) } }
                button.isEnabled = !account.busy; queue.addArrangedSubview(button)
            }
        }
        for field in queue.arrangedSubviews.compactMap({ $0 as? NSTextField }) { field.widthAnchor.constraint(equalTo: queue.widthAnchor).isActive = true }
    }
}
/// An unchanged semantic form keeps its controls, entered text, confirmation and focus during status polling.
@MainActor
class ViewerCommunityStableBody: NSStackView {
    private var currentKey: String?
    func beginUpdate(key: String) -> Bool {
        guard currentKey != key else { return false }; currentKey = key
        for view in arrangedSubviews { removeArrangedSubview(view); view.removeFromSuperview() }
        return true
    }
}
#endif
