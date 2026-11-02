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
    var closed: () -> Void = {}
    init(account: ViewerCommunityAccount) {
        self.account = account
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 620), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "AgentsToZ 커뮤니티 기기"
        window.isReleasedWhenClosed = false
        nameField.placeholderString = "예: 아젠투지 3호 (비워 두면 Mac 이름 사용)"
        nameField.setAccessibilityLabel("커뮤니티에서 사용할 이 Mac 이름")
        account.sheetChanged = { [weak self] in self?.render() }
        render()
    }
    func begin(on parent: NSWindow) { parent.beginSheet(window) }
    func close() {
        account.cancelAdministratorAction()
        account.sheetChanged = {}
        window.sheetParent?.endSheet(window); window.orderOut(nil); closed()
    }
    private func render() {
        let column = NSStackView()
        column.orientation = .vertical; column.alignment = .leading; column.spacing = 12
        column.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        let title = NSTextField(labelWithString: "커뮤니티에 한 번 등록하고 함께 연결")
        title.font = .boldSystemFont(ofSize: 18); column.addArrangedSubview(title)
        let message = NSTextField(wrappingLabelWithString: account.message); column.addArrangedSubview(message)
        if let removing = account.removing {
            column.addArrangedSubview(NSTextField(labelWithString: "‘\(removing.name)’ 등록 해제"))
            column.addArrangedSubview(NSTextField(wrappingLabelWithString: "기기 키 \(removing.registrationFingerprint)\n이 기기는 모든 커뮤니티 Mac에 접근할 수 없게 됩니다. 연결 중인 화면도 목록 갱신 또는 최대 90초 이내에 닫힙니다."))
            let revoke = HumanButton(title: "인증하고 이 기기 등록 해제") { [weak account] proof in Task { await account?.revoke(proof) } }
            revoke.isEnabled = !account.busy; column.addArrangedSubview(revoke)
            column.addArrangedSubview(PresentationButton(title: "취소") { [weak account] in account?.reviewRemoval(nil) })
        } else if let review = account.unified?.review {
            column.addArrangedSubview(NSTextField(labelWithString: review.plan.name))
            column.addArrangedSubview(NSTextField(wrappingLabelWithString: "선택한 기능을 함께 승인합니다. 관리자 권한 추가나 OS 권한 자동 승인은 포함되지 않습니다."))
            for capability in review.plan.capabilities { column.addArrangedSubview(NSTextField(labelWithString: "• \(capability.title)")) }
            let digest = NSTextField(wrappingLabelWithString: "등록 코드 \(CommunityEnrollmentCode.formatted(digest: review.digest) ?? "확인 불가") · 기기 키 \(review.plan.hostKey.prefix(16))…")
            digest.font = .monospacedSystemFont(ofSize: 12, weight: .regular); column.addArrangedSubview(digest)
            let confirmed = account.unified?.confirmation.isConfirmed(for: review) == true
            let comparison = PresentationButton(title: "상대 기기의 등록 코드와 같음을 확인했습니다") { [weak account] in account?.confirmUnifiedRegistration(digest: review.digest, confirmed: !confirmed) }
            comparison.setButtonType(.switch); comparison.state = confirmed ? .on : .off; comparison.isEnabled = !account.busy
            column.addArrangedSubview(comparison)
            let approve = HumanButton(title: "한 번 인증하고 선택한 기능 승인") { [weak account] proof in Task { await account?.approveUnified(proof, confirmedDigest: review.digest) } }
            approve.isEnabled = !account.busy && confirmed; column.addArrangedSubview(approve)
            column.addArrangedSubview(PresentationButton(title: "목록으로") { [weak account] in account?.dismissUnifiedReview() })
        } else if let review = account.review {
            let title = NSTextField(labelWithString: review.device.name); title.font = .boldSystemFont(ofSize: 16); column.addArrangedSubview(title)
            let scope = review.device.platform == "ios" ? "iPhone·iPad · 등록된 Mac에 연결하고 새 기기 등록을 승인" : "Mac · 화면 보기·조작 허용 요청"
            column.addArrangedSubview(NSTextField(wrappingLabelWithString: "\(scope)\n기기 키 \(review.fingerprint)\n본인이 참여시킨 기기인지 확인하세요."))
            let label = review.device.platform == "ios" ? "등록하고 모바일 승인 기기로 사용" : "이 기기 등록 승인"
            let approve = HumanButton(title: label) { [weak account] proof in Task { await account?.approve(proof) } }
            approve.isEnabled = !account.busy; column.addArrangedSubview(approve)
            column.addArrangedSubview(PresentationButton(title: "목록으로") { [weak account] in account?.dismissReview() })
        } else {
            if account.certificate == nil { column.addArrangedSubview(nameField) }
            if let code = account.unified?.registrationCode {
                let registration = NSTextField(wrappingLabelWithString: "이 기기의 등록 코드 \(code)\n관리 기기에 표시된 코드가 같은지 비교한 뒤 승인하세요. 이름만으로 승인하지 마세요.")
                registration.font = .monospacedSystemFont(ofSize: 14, weight: .medium); column.addArrangedSubview(registration)
            }
            let nameField = nameField
            let selectedTitle = NSTextField(labelWithString: "이 기기에서 사용할 기능")
            selectedTitle.font = .boldSystemFont(ofSize: 14); column.addArrangedSubview(selectedTitle)
            let all = PresentationButton(title: "전체 선택") { [weak account] in account?.selectAllFeatures() }
            all.isEnabled = !account.busy; column.addArrangedSubview(all)
            for capability in CommunityCapability.allCases {
                let selected = account.selectedCapabilities.contains(capability)
                let toggle = PresentationButton(title: "\(selected ? "☑" : "☐") \(capability.title)") { [weak account] in
                    account?.selectFeature(capability, selected: !selected)
                }
                toggle.setAccessibilityValue(selected ? "선택됨" : "선택 안 됨")
                toggle.isEnabled = !account.busy
                let status = NSTextField(wrappingLabelWithString: account.featureStatus(capability))
                status.font = .systemFont(ofSize: 11); status.textColor = .secondaryLabelColor
                let row = NSStackView(views: [toggle, status]); row.orientation = .horizontal; row.alignment = .centerY; row.spacing = 12
                toggle.widthAnchor.constraint(equalToConstant: 230).isActive = true
                column.addArrangedSubview(row)
                row.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -40).isActive = true
            }
            let request = PresentationButton(title: "선택한 기능 한 번에 등록 요청") { [weak account] in
                account?.requestedName = nameField.stringValue; Task { await account?.requestUnifiedMembership() }
            }
            request.isEnabled = account.supported && !account.busy && !account.selectedCapabilities.isEmpty; column.addArrangedSubview(request)
            for item in account.unified?.pending ?? [] {
                let review = PresentationButton(title: "\(item.name) · 기능 일괄 등록 검토") { [weak account] in Task { await account?.loadUnifiedReview(item.planId) } }
                review.isEnabled = !account.busy; column.addArrangedSubview(review)
            }
            if account.certificate == nil {
                let create = HumanButton(title: "첫 관리 Mac으로 커뮤니티 만들기") { [weak account] proof in account?.requestedName = nameField.stringValue; Task { await account?.createCommunity(proof) } }
                create.isEnabled = account.supported && !account.busy; column.addArrangedSubview(create)
            }
            for pending in account.pending {
                let review = PresentationButton(title: "\(pending.name) · 등록 요청 검토") { [weak account] in Task { await account?.loadReview(pending.id) } }
                review.isEnabled = !account.busy; column.addArrangedSubview(review)
            }
            if account.certificate?.member.admin == true, let directory = account.directory {
                for member in directory.members where member.enrollmentID != directory.selfEnrollmentID {
                    let remove = PresentationButton(title: "\(member.name) · 등록 해제…") { [weak account] in account?.reviewRemoval(member) }
                    remove.isEnabled = !account.busy; column.addArrangedSubview(remove)
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
                leave.isEnabled = !account.busy; column.addArrangedSubview(leave)
            }
            column.addArrangedSubview(NSTextField(wrappingLabelWithString: "기존 관리 기기에서 선택 목록을 한 번 승인합니다. 등록된 데스크톱은 정상 사용 때 다시 인증하지 않습니다. 화면 기록·손쉬운 사용 등 OS 권한은 이 Mac에서 준비해야 하며, 등록만으로 모든 기능이 실행되지는 않습니다."))
        }
        let refresh = PresentationButton(title: "등록 상태 새로 고침") { [weak account] in Task { await account?.refreshRegistration() } }
        refresh.isEnabled = !account.busy
        let close = PresentationButton(title: "닫기") { [weak self] in self?.close() }; close.keyEquivalent = "\u{1b}"
        column.addArrangedSubview(NSStackView(views: [refresh, close]))
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        let document = FlippedView(); document.translatesAutoresizingMaskIntoConstraints = false
        column.translatesAutoresizingMaskIntoConstraints = false; document.addSubview(column); scroll.documentView = document
        NSLayoutConstraint.activate([document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            column.leadingAnchor.constraint(equalTo: document.leadingAnchor), column.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            column.topAnchor.constraint(equalTo: document.topAnchor), column.bottomAnchor.constraint(equalTo: document.bottomAnchor)])
        for field in column.arrangedSubviews.compactMap({ $0 as? NSTextField }) {
            field.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -40).isActive = true
        }
        window.contentView = scroll
    }
}
#endif
