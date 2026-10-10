import SwiftUI
import AgentsToZCore

private struct RequestedAction: Identifiable {
    let id = UUID()
    let action: ProjectAction
    let project: RemoteProject
}

struct RemoteHomeView: View {
    @StateObject private var model = RemoteModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var scannedText = ""
    @State private var pairing: LANPairing?
    @State private var showScanner = false
    @State private var requestedAction: RequestedAction?
    @State private var workroom: LANWorkroomSession?
    @State private var browserAddress: InternetWorkroomAddress?
    @State private var scanAfterWorkroom = false
    /// A 「폰 연결 링크」 waiting for the user's confirmation (step ① data connection only).
    @State private var connectLink: PhoneConnectLink?
    /// A link that arrived while the workroom was open; reviewed once it has closed.
    @State private var linkAfterWorkroom: PhoneConnectLink?
    /// Photos shared into "AgentsToZ VOC" that no portal page has taken yet.
    @State private var pendingVocShares = 0

    var body: some View {
        NavigationStack {
            List {
                if let snapshot = model.snapshot {
                    projectSections(snapshot)
                } else {
                    onboardingSections
                }
                if model.snapshot != nil, let notice = model.notice {
                    Section { Text(notice).font(.subheadline).accessibilityIdentifier("connectionNotice") }
                }
                if pendingVocShares > 0 && workroom == nil {
                    Section {
                        Label("공유한 사진 \(pendingVocShares)건이 대기 중입니다 — Mac에 연결하면 VOC 작성 화면에 담깁니다.", systemImage: "photo.on.rectangle")
                            .font(.subheadline).accessibilityIdentifier("pendingVocShares")
                    }
                }
                if model.busy { ProgressView("확인 중") }
                appInfoSection
            }
            .navigationTitle("AgentsToZ")
            .refreshable { await model.refresh() }
            .toolbar {
                if model.snapshot != nil {
                    Button("새로고침", systemImage: "arrow.clockwise") { Task { await model.refresh() } }.disabled(model.busy)
                }
            }
            .sheet(isPresented: $showScanner) { QRScannerSheet { value in showScanner = false; review(value) } }
            .alert("같은 네트워크용 QR입니다", isPresented: Binding(get: { pairing != nil }, set: { if !$0 { pairing = nil } })) {
                if let selected = pairing {
                    Button("같은 네트워크에서 연결") {
                        pairing = nil
                        Task {
                            await model.disconnect()
                            guard scenePhase == .active else { return }
                            workroom = LANWorkroomSession(pairing: selected)
                        }
                    }

                }
                Button("취소", role: .cancel) { pairing = nil }
            } message: { Text((pairing?.origin ?? "") + "\n이 QR은 같은 개인 네트워크에서만 사용합니다. 5G·외부 Wi-Fi에서는 취소한 뒤 컴퓨터의 ‘외부 인터넷 연결’ QR을 스캔하세요.") }
            .confirmationDialog("이 개인 포털에 연결할까요?", isPresented: Binding(get: { browserAddress != nil }, set: { if !$0 { browserAddress = nil } })) {
                if let selected = browserAddress {
                    Button("내 작업 공간 열기") {
                        browserAddress = nil
                        Task {
                            await model.disconnect()
                            guard scenePhase == .active else { return }
                            workroom = LANWorkroomSession(internet: selected)
                        }
                    }
                }
                Button("취소", role: .cancel) { browserAddress = nil }
            } message: { Text((browserAddress?.origin ?? "") + "\n본인의 개인 포털인지 확인하세요. 현황과 북마크는 로그인 후 이용하고, 기기에서 실행하는 작업은 별도 연결 승인이 필요합니다." + qrReplacesLinkNotice(browserAddress)) }
            .confirmationDialog("이 폰 연결 링크를 적용할까요?", isPresented: Binding(get: { connectLink != nil }, set: { if !$0 { connectLink = nil } }), titleVisibility: .visible) {
                if let link = connectLink {
                    Button("데이터 연결 · \(link.supabaseHost)") { apply(link) }.accessibilityIdentifier("applyConnectLink")
                }
                Button("취소", role: .cancel) { connectLink = nil; resumeIfIdle() }
            } message: {
                Text(connectLink.map(connectLinkMessage) ?? "")
            }
            .fullScreenCover(item: $workroom, onDismiss: {
                refreshPendingVocShares()
                if scanAfterWorkroom { scanAfterWorkroom = false; showScanner = true }
                if let link = linkAfterWorkroom { linkAfterWorkroom = nil; connectLink = link }
            }) { session in
                LANWorkroomView(session: session, onReconnect: { session.end(.disconnected); scanAfterWorkroom = true; workroom = nil }, onDone: {
                    if session.disconnectConfirmed == false {
                        model.notice = "이 iPhone의 연결 정보는 지웠습니다. Mac의 연결 해제 응답은 확인하지 못했습니다. Mac에서 연결 상태를 확인할 수 있습니다."
                    }
                    workroom = nil
                })
            }
            .confirmationDialog("Mac에서 실행할 동작을 확인하세요", isPresented: Binding(get: { requestedAction != nil }, set: { if !$0 { requestedAction = nil } })) {
                if let request = requestedAction {
                    Button("\(request.project.name) · \(request.action.label)", role: request.action == .stop ? .destructive : nil) {
                        requestedAction = nil; Task { await model.perform(request.action, project: request.project) }
                    }
                }
                Button("취소", role: .cancel) { requestedAction = nil }
            }
            // 「폰 연결 링크」 tapped in KakaoTalk/Messages. Only the `agentstoz` scheme; the OAuth callback
            // scheme is consumed by ASWebAuthenticationSession and never arrives here.
            .onOpenURL { url in
                guard url.scheme == PhoneConnectLink.scheme else { return }
                guard let link = parseConnectLink(url.absoluteString) else { return }
                if let session = workroom {
                    // The confirmation cannot sit on top of the full-screen workroom; close it (the Mac
                    // session and this phone's stored sign-in stay) and review the link on the home screen.
                    linkAfterWorkroom = link; session.end(.disconnected); workroom = nil
                } else { connectLink = link }
            }
            .task(id: scenePhase) {
                if scenePhase == .background {
                    showScanner = false; pairing = nil; browserAddress = nil; scannedText = ""; requestedAction = nil; scanAfterWorkroom = false; connectLink = nil
                    workroom?.end(.background)
                    // Suspend, not disconnect. The socket goes and in-flight work is cancelled,
                    // but the session stays valid on the Mac and the token stays on this phone,
                    // so coming back does not need a new QR. Screen lock counts as background.
                    await model.suspend()
                    return
                }
                if scenePhase == .active {
                    refreshPendingVocShares()
                    if workroom == nil, connectLink == nil, linkAfterWorkroom == nil, let resumed = LANWorkroomSession.resumeSaved() {
                        workroom = resumed
                    }
                    // A restored WK workspace is the sole connection owner.
                    if workroom == nil { await model.resume() }
                    return
                }
            }
        }
    }

    @ViewBuilder private func projectSections(_ snapshot: RemoteSnapshot) -> some View {
        Section {
            Label(snapshot.hostName, systemImage: "desktopcomputer")
            Text("같은 Wi-Fi · 프로젝트 \(snapshot.projectCount)개").foregroundStyle(.secondary)
            if let checked = model.checkedAt { Text("마지막 확인 \(checked.formatted(date: .omitted, time: .standard))").font(.caption).foregroundStyle(.secondary) }
            Button("연결 해제", role: .destructive) {
                let origin = model.resumableOrigin
                Task {
                    await model.disconnect()
                    // The workroom keeps its own durable store for this Mac; ending
                    // on purpose has to clear that too, or the next connection would
                    // silently resume a session the user just ended.
                    if let origin { await LANWorkroomSession.forget(origin: origin) }
                }
            }
            Button("AI 워크룸 연결", systemImage: "terminal") { showScanner = true }
            Text("워크룸은 새 QR이 필요합니다. Mac에서 QR 새로 만들기를 누른 뒤 스캔하세요. 프로젝트 전용 연결의 QR은 재사용할 수 없습니다.").font(.caption).foregroundStyle(.secondary)
        }
        Section("프로젝트") {
            ForEach(snapshot.projects) { project in
                VStack(alignment: .leading, spacing: 10) {
                    Label(project.name, systemImage: project.kind == "worktree" ? "arrow.triangle.branch" : "folder")
                        .font(.headline)
                    Text([project.statusLabel, project.branch, project.port.map { "포트 \($0)" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.subheadline).foregroundStyle(.secondary)
                    if let alias = project.alias { Text(alias).font(.subheadline).foregroundStyle(.secondary) }
                    HStack {
                        ForEach(project.availableActions, id: \.rawValue) { action in
                            Button(action.label) { requestedAction = RequestedAction(action: action, project: project) }
                                .buttonStyle(.bordered).disabled(model.busy)
                        }
                    }
                }.padding(.vertical, 6)
            }
            if snapshot.nextPage != nil {
                Button("더 보기") { Task { await model.refresh(loadMore: true) } }.disabled(model.busy)
            }
            if snapshot.projects.isEmpty { Text("Mac에 표시할 프로젝트가 없습니다.").foregroundStyle(.secondary) }
        }
    }

    @ViewBuilder private var onboardingSections: some View {
        Section {
            Label("내 작업 공간", systemImage: "square.grid.2x2").font(.title2.bold())
            Text("컴퓨터에서 하던 일을 모바일에서 이어가세요.")
            Text("개인 포털에 로그인하면 프로젝트 현황과 공통 북마크를 볼 수 있습니다. 원격 작업은 작업 공간 안에서 기기를 등록한 뒤 시작합니다.").font(.subheadline).foregroundStyle(.secondary)
        }
        Section {
            TextField("https://내-개인-포털.example", text: $scannedText).accessibilityIdentifier("connectionAddress")
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .onChange(of: scannedText) { _, value in if value.utf8.count > 4096 { scannedText = ""; model.notice = "연결 주소가 너무 깁니다." } }
            Button("작업 공간 열기") { review(scannedText, addressField: true) }.disabled(scannedText.isEmpty || model.busy).accessibilityIdentifier("reviewConnectionAddress")
            if let notice = model.notice {
                Text(notice).font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("connectionNotice")
            }
        } header: {
            Text("개인 포털로 시작")
        } footer: {
            Text("웹에서 사용하던 HTTPS 포털 주소를 입력하세요. 다음 실행부터 같은 작업 공간으로 돌아옵니다.")
        }
        Section("QR로 연결") {
            Button("기기 연결 · QR 스캔", systemImage: "qrcode.viewfinder") { showScanner = true }.disabled(model.busy).accessibilityIdentifier("scanConnectionQR")
            Text("컴퓨터의 AgentsToZ에서 발급한 인터넷 연결 QR을 스캔하세요. 같은 Wi-Fi QR은 신뢰하는 개인 네트워크 안에서 직접 연결할 때 사용합니다.").font(.subheadline).foregroundStyle(.secondary)
            Button("연결 링크 붙여넣기", systemImage: "link") {
                if let link = parseConnectLink(UIPasteboard.general.string ?? "") { connectLink = link }
            }.disabled(model.busy).accessibilityIdentifier("pasteConnectLink")
            Text("Mac 앞이 아닐 때: Mac의 원격제어 창에서 복사한 「폰 연결 링크」를 카카오톡 「나와의 채팅」 등으로 받아 누르거나 복사해 여기에 붙여 넣으세요. 로그인하면 프로젝트 현황·북마크·기록을 볼 수 있습니다. Mac 제어는 나중에 Mac 앞에서 QR을 스캔하고 승인해야 합니다.").font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private var appInfoSection: some View {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        let channel = info["AgentsToZReleaseChannel"] as? String ?? "unknown"
        let commit = info["AgentsToZSourceCommit"] as? String ?? "unknown"
        let source = commit.count >= 8 ? String(commit.prefix(8)) : commit
        return Section("앱 정보") {
            LabeledContent("버전", value: "\(version) (\(build))")
            LabeledContent("빌드", value: "\(channel) · \(source)")
        }
    }

    private func refreshPendingVocShares() {
        guard let outbox = VocShareOutbox.shared() else { pendingVocShares = 0; return }
        Task {
            let count = await Task.detached(priority: .utility) { outbox.pending().count }.value
            pendingVocShares = count
        }
    }

    /// Step ① only: validate a 「폰 연결 링크」 (also found inside a pasted chat message).
    private func parseConnectLink(_ text: String) -> PhoneConnectLink? {
        guard let raw = PhoneConnectLink.extract(from: text) else {
            model.notice = "복사한 내용에서 AgentsToZ 폰 연결 링크를 찾지 못했습니다. Mac의 원격제어 창에서 「폰 연결 링크 복사」를 다시 눌러 주세요."
            return nil
        }
        guard let link = try? PhoneConnectLink(link: raw), link.bundledPortal != nil else {
            model.notice = "폰 연결 링크가 손상되었거나 이 앱이 지원하지 않는 형식입니다. Mac에서 링크를 다시 복사하거나 앱을 업데이트하세요."
            return nil
        }
        guard PortalSchemeHandler.isAvailable else {
            model.notice = "이 앱 빌드에는 내장 포털이 없어 연결 링크를 사용할 수 없습니다. Mac의 인터넷 연결 QR을 스캔하세요."
            return nil
        }
        return link
    }

    /// Names the Supabase host and the Mac: a link from someone else could point this phone at their
    /// project, where whatever is saved would go to them.
    private func connectLinkMessage(_ link: PhoneConnectLink) -> String {
        var lines = ["Supabase 프로젝트: \(link.supabaseHost)", "Mac: \(link.hostName)", "포털: \(link.portalHost)",
                     "본인이 자기 Mac에서 복사한 링크인지 확인하세요. 다른 사람의 링크라면 그 사람의 프로젝트에 로그인·저장하게 됩니다.",
                     "이 링크는 데이터 연결만 합니다. Mac 제어는 Mac 앞에서 QR을 스캔하고 6자리 코드를 승인해야 합니다."]
        if let saved = LANWorkroomSession.savedBundledConfig, saved.supabaseUrl != link.supabaseUrl {
            lines.append("지금 사용 중인 연결(\(saved.supabaseUrl.dropFirst("https://".count)))을 이 링크로 바꿉니다.")
        }
        return lines.joined(separator: "\n")
    }

    /// Step ④ of the contract: when a QR names another Supabase project than the one a link set up,
    /// the QR wins — say so before connecting.
    private func qrReplacesLinkNotice(_ address: InternetWorkroomAddress?) -> String {
        guard let next = address?.bundledPortal, let saved = LANWorkroomSession.savedBundledConfig,
              saved.supabaseUrl != next.supabaseUrl else { return "" }
        return "\n\n이 QR의 Supabase 프로젝트(\(next.supabaseUrl.dropFirst("https://".count)))가 링크로 연결한 프로젝트(\(saved.supabaseUrl.dropFirst("https://".count)))와 다릅니다. QR의 설정으로 바꾸며, 이 프로젝트에 다시 로그인해야 할 수 있습니다."
    }

    private func apply(_ link: PhoneConnectLink) {
        connectLink = nil
        Task {
            await model.disconnect()
            guard scenePhase == .active else { return }
            if let session = LANWorkroomSession(linked: link) { workroom = session }
            else { model.notice = "이 앱 빌드에서는 연결 링크를 열 수 없습니다." }
        }
    }

    /// Cancelling a link must not strand the phone on the home screen when it was already connected.
    private func resumeIfIdle() {
        if workroom == nil, scenePhase == .active, let resumed = LANWorkroomSession.resumeSaved() { workroom = resumed }
    }

    private func review(_ value: String, addressField: Bool = false) {
        scannedText = ""
        if value.contains(PhoneConnectLink.prefix) {
            if let link = parseConnectLink(value) { connectLink = link }
            return
        }
        do {
            if value.hasPrefix("https:") {
                browserAddress = try addressField ? InternetWorkroomAddress(portalInput: value) : InternetWorkroomAddress(scanned: value)
            }
            else { pairing = try LANPairing(scanned: value) }
        }
        catch {
            model.notice = value.hasPrefix("https:")
                ? "개인 포털의 HTTPS 주소 또는 컴퓨터의 인터넷 연결 QR을 확인해 주세요."
                : (error as? RemoteFailure)?.errorDescription ?? "QR을 확인해 주세요."
        }
    }
}
