#if os(macOS)
import AppKit
import ScreenControlCore

/// Bounded, presentation-only controls. Only the explicit enable/approve handlers request a protected-key signature.
@MainActor final class ViewerOwnerRecoverySection:ViewerCommunityStableBody {
    func render(_ account:ViewerCommunityAccount) {
        guard let owner=account.ownerRecovery else {return}
        let key=[owner.status,String(owner.busy),String(describing:owner.targetEnabled),owner.targetStatus?.delegation.map{String($0.body.revision)} ?? "",owner.records.map{$0.reviewBinding}.joined(separator:"|"),owner.targets.map{$0.body.enrollmentId+$0.body.name}.joined(separator:"|"),owner.own?.body.enrollmentId ?? ""].joined(separator:"\n")
        guard beginUpdate(key:key) else {return}
        let title=NSTextField(labelWithString:"다른 승인 Mac에서 입력 보류 해제");title.font = .boldSystemFont(ofSize:14);addArrangedSubview(title)
        let scope=NSTextField(wrappingLabelWithString:"이 Mac의 명시 위임이 있을 때만 사용합니다. 다른 현재 승인 Mac에서 요청마다 생체 확인하며, Screen 켜기·수신 보류·OS 권한·등록 관리 권한은 대신 승인하지 않습니다.");addArrangedSubview(scope)
        let state=NSTextField(wrappingLabelWithString:owner.status);addArrangedSubview(state)
        if owner.targetStatus != nil {
            let text=owner.targetEnabled==true ? "이 Mac의 입력 보류 해제 위임 · 켜짐":"이 Mac의 입력 보류 해제 위임 · 별도 선택 필요"
            addArrangedSubview(NSTextField(labelWithString:text))
            if owner.targetEnabled != true {
                let enable=PresentationButton(title:"이 Mac의 위임 켜기 · 생체 확인…"){[weak account] in Task{await account?.enableInputDelegation()}}
                enable.isEnabled = !owner.busy && !account.busy;addArrangedSubview(enable)
            }
            let disable=PresentationButton(title:"이 Mac의 위임 끄기"){[weak account] in Task{await account?.disableInputDelegation()}}
            disable.isEnabled = !owner.busy && !account.busy;addArrangedSubview(disable)
        }
        if owner.own?.body.capabilities.contains(.screenView)==true,owner.own?.body.capabilities.contains(.desktopTrust)==true {
            for target in owner.targets {
                let request=PresentationButton(title:"\(target.body.name) · 입력 보류 해제 요청"){[weak account] in Task{await account?.requestInputRecovery(target.body.enrollmentId)}}
                request.isEnabled = !owner.busy && !account.busy;addArrangedSubview(request)
            }
        }
        for record in owner.records {
            let b=record.body,name=owner.targets.first(where:{$0.body.enrollmentId==b.targetEnrollmentId})?.body.name ?? "등록된 대상 Mac"
            let phase:String=switch b.state {case .waitingHost:"대상 상태 확인 대기";case .ready:"요청별 생체 승인 검토";case .approved:"승인 제출됨 · 실제 적용 대기";case .applied:"대상 Mac의 적용 영수증 확인";case .refused:"대상이 적용 거절";case .superseded:"대상 상태 변경 · 이전 승인 적용 안 함";case .expired:"요청 만료 · 자동 재실행 없음"}
            let info=NSTextField(wrappingLabelWithString:"\(name) · \(phase)\n입력 보류만 해제 · 만료 \(Date(timeIntervalSince1970:Double(b.expiresAt)/1000).formatted(date:.omitted,time:.standard))");addArrangedSubview(info)
            if b.state == .ready {
                let approve=PresentationButton(title:"생체 확인 후 ‘\(name)’ 입력 보류 해제 위임 승인…"){[weak account] in Task{await account?.approveInputRecovery(b.requestId)}}
                approve.isEnabled = !owner.busy && !account.busy && b.expiresAt>Int64(Date().timeIntervalSince1970*1000);addArrangedSubview(approve)
            }
        }
        for text in arrangedSubviews.compactMap({$0 as? NSTextField}) {text.widthAnchor.constraint(equalTo:widthAnchor).isActive=true}
    }
}
#endif
