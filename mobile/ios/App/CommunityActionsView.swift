import ScreenControlCore
import SwiftUI
import UIKit

/// Presentation never authenticates or launches work. Each operation is a person's explicit button action.
struct CommunityActionsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var actions = MobileCommunityActions()
    @State private var selectedPurpose = CommunityMobileControlPurpose.teams
    @State private var title = ""
@State private var goal = ""
@State private var task = ""
@State private var instruction = ""
@State private var evaluation = ""
    @State private var agentRequest = ""
@State private var browserValue = ""
    @State private var agent = "codex"
    @State private var model = ""
    @State private var provider = ""
    @State private var effort = ""
    @State private var cancelConfirmation = false
    private func human() { actions.humanAction(at:Date(),tick:.now) }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("사용할 기능",selection:$selectedPurpose) {
                        ForEach(CommunityMobileControlPurpose.allCases,id:\.self) { purpose in Text(purpose.title).tag(purpose) }
                    }.onChange(of:selectedPurpose) { _, next in Task { await actions.changePurpose(next) } }.disabled(actions.busy)
                    Text(actions.message).font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("communityActionsStatus")
                    Button("공통 인증으로 사용 시작 · 기기 목록",systemImage:"person.badge.key") { human(); Task { await actions.start() } }
                        .disabled(actions.busy).accessibilityIdentifier("communityActionsStart")
                    if !actions.permittedPurposes.contains(selectedPurpose) {
                        Text("공통 등록에서 이 기능을 먼저 선택하고 관리 기기의 승인을 받으세요.").font(.caption).foregroundStyle(.secondary)
                    }
                } footer: { Text("이 기기의 한 번 인증을 Mac·기능 전환에 함께 사용합니다. 실제 조작이 60분 없거나 기기를 잠그면 종료됩니다. 프로젝트·브라우저 대상은 각 Mac의 현재 허용 범위를 따릅니다.") }
                if !actions.targets.isEmpty {
                    Section("연결할 Mac") {
                        ForEach(actions.targets,id:\.body.deviceId) { target in
                            Button { human(); Task { await actions.connect(target.body.deviceId) } } label: {
                                HStack { Text(target.body.name); Spacer(); if actions.selectedTarget == target.body.deviceId && actions.connected { Image(systemName:"checkmark.circle.fill").foregroundStyle(.green) } }
                            }.disabled(actions.busy)
                        }
                    }
                }
                if actions.connected {
                    if actions.commands.isEmpty { Section { Text("이 Mac에서 아직 연결된 기능이 없습니다. Mac의 기능 허용 상태를 확인하세요.") } }
                    if !actions.choices.isEmpty {
                        Section(selectedPurpose == .teams ? "이 Mac이 허용한 프로젝트":"현재 허용된 대상") {
                            ForEach(actions.choices) { choice in
                                Button { human(); Task { await actions.choose(choice.id) } } label: {
                                    HStack { Text(choice.label); Spacer(); if actions.contextID == choice.id { Image(systemName:"checkmark") } }
                                }.disabled(actions.busy)
                            }
                            if actions.choicesHaveMore { Button("다음 대상 보기") { human(); Task { await actions.nextChoices() } }.disabled(actions.busy) }
                            if actions.choiceLimitReached { Text("이 화면에는 최대 200개까지 표시합니다.").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    if selectedPurpose == .teams { teams }
                    else if selectedPurpose == .agentSettings { settings }
                    else if selectedPurpose == .browser { browser }
                    else { agentActions }
                    if !actions.detail.isEmpty { Section("현재 상태") { Text(actions.detail).font(.subheadline).textSelection(.enabled) } }
                    Section { Button("연결 닫기") { human(); Task { await actions.disconnect() } }.disabled(actions.busy) }
                }
                if !actions.records.isEmpty {
                    Section("이 기기의 원래 작업 기록") {
                        ForEach(actions.records) { record in
                            VStack(alignment:.leading,spacing:8) {
                                Text(record.targetName).font(.headline)
                                Text(record.phase == .consumed ? "결과 수령 완료" : record.phase == .accepted ? "결과 저장됨 · 수령 확인 필요":"결과 확인 필요 · 다시 실행하지 않음").font(.caption).foregroundStyle(.secondary)
                                if record.phase == .consumed {
                                    if record.purpose == .teams || record.purpose == .agent { Button("원래 작업 열기") { human(); Task { await actions.openRecordedResult(record) } }.disabled(actions.busy) }
                                    Button("수령한 영수증 정리") { actions.forget(record) }.disabled(actions.busy)
                                }
                                else { Button("원래 작업 결과 조회") { human(); Task { await actions.recover(record) } }.disabled(actions.busy) }
                            }.padding(.vertical,4)
                        }
                    }
                }
            }
            .background(CommunityActionsHumanEvents { kind,date,tick in actions.humanEvent(kind:kind,at:date,tick:tick) })
            .navigationTitle("커뮤니티 기능")
            .toolbar { ToolbarItem(placement:.cancellationAction) { Button("닫기") { dismiss() } } }
            .onDisappear { Task { await actions.disconnect() } }
            .confirmationDialog("이 모바일에서 시작한 팀을 중지할까요?",isPresented:$cancelConfirmation,titleVisibility:.visible) {
                Button("팀 중지",role:.destructive) { human(); Task { await actions.cancelTeam() } }
            }
        }
    }
    private var agentActions: some View {
        Group { if actions.contextID != nil {
            Section("이 Mac의 OPS에 요청") {
                Text("Mac에서 구성한 현재 OPS가 처리합니다. 요청 접수와 실제 완료는 상태 조회로 구분합니다.").font(.caption).foregroundStyle(.secondary)
                TextField("요청할 작업",text:$agentRequest,axis:.vertical).lineLimit(3...8)
                Button("OPS에 요청 보내기") { human(); Task { await actions.submitAgent(agentRequest) } }.disabled(!actions.supports("submit",mode:"effect") || agentRequest.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                if actions.agentRef != nil { Button("원래 요청 상태 조회") { human(); Task { await actions.refreshSelection() } }.disabled(!actions.supports("status",mode:"query")) }
                ForEach(["result","evidence","message"],id:\.self) { field in
                    if let page = actions.agentPages[field] {
                        Text(field == "result" ? "결과":field == "evidence" ? "확인 근거":"안내").font(.headline)
                        Text(page.text).textSelection(.enabled)
                        if page.nextOffset != nil { Button("다음 내용 보기") { human(); Task { await actions.readAgent(field) } }.disabled(!actions.supports("read",mode:"query")) }
                    }
                }
            }
        } }
    }
    private var teams: some View {
        Group {
            if actions.contextID != nil && actions.supports("create",mode:"effect") {
                Section("새 팀 작업") {
                    TextField("팀 이름",text:$title)
                    TextField("팀 목표",text:$goal,axis:.vertical).lineLimit(2...5)
                    Picker("사용할 AI",selection:$agent) { Text("Codex").tag("codex"); Text("Claude").tag("claude"); Text("Hermes").tag("hermes"); Text("Antigravity").tag("agy") }
                    TextField("모델 · 비우면 해당 AI의 현재 기본값",text:$model).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if agent == "hermes" { TextField("공급자 · 비우면 현재 기본값",text:$provider).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    TextField("에포트 · 해당 AI가 지원하는 값",text:$effort).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("팀원에게 맡길 작업",text:$task,axis:.vertical).lineLimit(3...8)
                    Button("선택한 AI로 팀 작업 시작") { human(); Task { await actions.createTeam(title:title,goal:goal,agent:agent,model:model,provider:provider,effort:effort,task:task) } }
                        .disabled(title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || goal.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || task.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                }
            }
            if actions.teamRef != nil {
                Section("이 모바일이 시작한 팀") {
                    Button("팀 상태 조회") { human(); Task { await actions.refreshSelection() } }.disabled(!actions.supports("status",mode:"query"))
                    TextField("추가 지시",text:$instruction,axis:.vertical).lineLimit(2...6)
                    Button("팀에 지시 보내기") { human(); Task { await actions.instruct(instruction) } }.disabled(!actions.supports("instruct",mode:"effect") || instruction.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                    Button("팀 중지",role:.destructive) { cancelConfirmation = true }.disabled(!actions.supports("cancel",mode:"effect"))
                }
            }
        }
    }
    private var settings: some View {
        Group { if actions.contextID != nil {
            Section("CLI 에포트") {
                Text("Mac의 auto·recommend·off와 수동 고정 설정을 유지합니다. 모델·공급자·계정을 자동 교체하지 않습니다.").font(.caption).foregroundStyle(.secondary)
                Button("현재 정책 확인") { human(); Task { await actions.refreshSelection() } }.disabled(!actions.supports("status",mode:"query"))
                TextField("평가할 작업",text:$evaluation,axis:.vertical).lineLimit(3...8)
                Button("기존 정책으로 재평가") { human(); Task { await actions.evaluate(evaluation) } }.disabled(!actions.supports("evaluate",mode:"effect") || evaluation.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
        } }
    }
    private var browser: some View {
        Group { if actions.contextID != nil {
            Section("내장 브라우저") {
                Button("현재 페이지 확인") { human(); Task { await actions.refreshSelection() } }.disabled(!actions.supports("observe",mode:"query"))
                TextField("선택한 입력란에 채울 내용",text:$browserValue,axis:.vertical).lineLimit(1...5)
                ForEach(actions.elements) { element in
                    VStack(alignment:.leading,spacing:6) {
                        Text(element.name.isEmpty ? element.role:element.name)
                        if !element.options.isEmpty {
                            ForEach(element.options,id:\.self) { option in Button(option) { human(); Task { await actions.browser("select",element:element,value:option) } }.disabled(!actions.supports("select",mode:"effect")) }
                        } else if ["textbox","searchbox","combobox"].contains(element.role) {
                            Button("이 입력란 채우기") { human(); Task { await actions.browser("fill",element:element,value:browserValue) } }.disabled(!actions.supports("fill",mode:"effect") || browserValue.isEmpty)
                        } else { Button("이 요소 클릭") { human(); Task { await actions.browser("click",element:element,value:"") } }.disabled(!actions.supports("click",mode:"effect")) }
                    }
                }
            }
        } }
    }
}

/// Observes original UIKit events in this sheet's window. It never recognizes, prevents or synthesizes input.
private struct CommunityActionsHumanEvents: UIViewRepresentable {
    let observed: @MainActor (MobileCommunityUseSession.HumanActivity,Date,ContinuousClock.Instant) -> Void
    func makeUIView(context: Context) -> ObserverView { ObserverView(observed:observed) }
    func updateUIView(_ view: ObserverView,context: Context) {}
    static func dismantleUIView(_ view: ObserverView,coordinator: ()) { view.detach() }
    final class ObserverView: UIView {
        private let gesture: PassiveEvents
        private weak var installedWindow: UIWindow?
        init(observed: @escaping @MainActor (MobileCommunityUseSession.HumanActivity,Date,ContinuousClock.Instant) -> Void) {
            gesture = PassiveEvents(observed:observed); super.init(frame:.zero); isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { nil }
        override func didMoveToWindow() { super.didMoveToWindow(); detach(); if let window { window.addGestureRecognizer(gesture); installedWindow = window } }
        func detach() { installedWindow?.removeGestureRecognizer(gesture); installedWindow = nil }
    }
    final class PassiveEvents: UIGestureRecognizer, UIGestureRecognizerDelegate {
        private let observed: @MainActor (MobileCommunityUseSession.HumanActivity,Date,ContinuousClock.Instant) -> Void
        init(observed: @escaping @MainActor (MobileCommunityUseSession.HumanActivity,Date,ContinuousClock.Instant) -> Void) {
            self.observed = observed; super.init(target:nil,action:nil); delegate = self
            cancelsTouchesInView = false; delaysTouchesBegan = false; delaysTouchesEnded = false
        }
        private func emit(_ kind: MobileCommunityUseSession.HumanActivity,_ timestamp: TimeInterval) {
            let age = ProcessInfo.processInfo.systemUptime - timestamp
            guard age >= 0, age <= 55 else { return }
            let tick = ContinuousClock.now.advanced(by:.seconds(-age)), date = Date().addingTimeInterval(-age)
            observed(kind,date,tick)
        }
        override func touchesBegan(_ touches: Set<UITouch>,with event: UIEvent) { if let touch = touches.first { emit(.touch,touch.timestamp) } }
        override func touchesMoved(_ touches: Set<UITouch>,with event: UIEvent) { if let touch = touches.first { emit(.touch,touch.timestamp) } }
        override func touchesEnded(_ touches: Set<UITouch>,with event: UIEvent) { if let touch = touches.first { emit(.touch,touch.timestamp) }; state = .failed }
        override func touchesCancelled(_ touches: Set<UITouch>,with event: UIEvent) { state = .failed }
        override func pressesBegan(_ presses: Set<UIPress>,with event: UIPressesEvent) { if let press = presses.first(where:{ $0.key != nil }) { emit(.key,press.timestamp) }; state = .failed }
        override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
        override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
    }
}
