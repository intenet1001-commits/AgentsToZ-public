#if os(macOS)
import AppKit
import ScreenControlCore
import ScreenHost
import SwiftUI

// B's 「다른 Mac에서 이 Mac 보기」 in the menu bar and the status window (docs/design/mac-to-mac-2026-11-01 5.2, SR-19,
// SR-21, SR-27, SR-29, SR-30). What it says and which buttons it has come from `ControllerSectionModel` (ScreenHost),
// where the checks read them. Every press goes through `ControllerSectionActions.run`: the gate first, then the service.
// A raising button is a `HardwareButton`, which hands in the judgement of the click that ran it; the menu bar's items
// cannot be judged that way, so a raising item there only opens the status window. Lowering acts at once.

/// Every action of the section, after the gate (SR-29). The service asks for Touch ID or a paired Watch for the raising
/// ones (`ScreenAuthentication.raising`); nothing here asks for anything itself.
@MainActor
enum ControllerSectionActions {
    static func run(_ action: ControllerSectionAction, by trigger: ControllerSectionTrigger, service: ScreenService,
                    refused: (String) -> Void = { _ in }) {
        if let notice = ControllerSectionGate.refusal(for: action, by: trigger) { return refused(notice) }
        switch action {
        case .allow(let on): Task { await service.setAllowMacControllers(on) }
        case .grant(let id, let grant): Task { await service.setControllerGrant(id, to: grant) }
        case .remove(let id): service.removeController(id)
        case .disconnect: service.disconnect()
        case .keepOn(let on): if on { Task { await service.enableKeepOn() } } else { service.disableKeepOn() }
        case .showPairingWindow: ControllerPairingWindow.show()
        }
    }

    /// The menu's item for `choice`: a raising one opens the status window, where its button checks the click.
    static func fromMenu(_ choice: ControllerSectionModel.Choice, service: ScreenService) {
        guard !choice.action.raises else { return PanelWindows.showStatus() }
        run(choice.action, by: .unchecked, service: service)
    }

    /// Joins the 「다른 Mac 추가」 window and the service once, at launch: a stored controller becomes the service's at once
    /// (connectable, listed, logged, told to the phones), and a session starting closes the window before anything
    /// streams (SR-37).
    static func connect(_ service: ScreenService) {
        let pairing = ControllerPairingWindow.pairing
        pairing.onEvent = { [weak service] event in service?.controllerPairingEnded(event) }
        service.closeControllerPairing = { [weak pairing] in pairing?.sessionStarted() }
        // 「이 네트워크도 켜 두기」 follows the network this Mac is on (`ScreenService.presentNetwork`): read again when a menu
        // opens, and every 10 seconds while kept on and listening, since moving to another network tells nothing here.
        // The status window reads it when it comes to the front (ControllerStatusSection).
        _ = NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ControllerSectionActions.refreshNetwork() }
        }
        networkTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
            MainActor.assumeIsolated {
                let service = ScreenShared.service
                if service.keepOn != nil, service.isOn { ControllerSectionActions.refreshNetwork() }
            }
        }
    }

    private static var networkTimer: Timer?

    static func refreshNetwork() {
        Task { await ScreenShared.service.refreshPresentNetwork() }
    }
}

/// The section in the menu bar's menu.
struct ControllerMenuSection: View {
    let service: ScreenService

    var body: some View {
        let model = ControllerSectionModel(service.controllerSectionState())
        Text(ControllerSectionModel.title)
        Text(model.allow.status)
        item(model.allow.choice)
        item(model.add.choice)
        if let watching = model.watching {
            Text(watching.line)
            if let reason = watching.reason { Text(reason) }
            Button("\(watching.disconnect.menuTitle) (\(EndSessionHotKey.label))") { ControllerSectionActions.fromMenu(watching.disconnect, service: service) }
        }
        Menu("추가한 Mac (\(model.rows.count))") {
            if model.rows.isEmpty { Text("없음") }
            ForEach(model.rows) { row in
                Menu([row.name, row.model, row.fingerprint].compactMap { $0 }.joined(separator: " · ")) {
                    Text(row.genuine)
                    Text(row.grant)
                    if let status = row.status { Text(status) }
                    Text("등록 \(row.registeredAt.formatted(date: .abbreviated, time: .omitted))")
                    if let last = row.lastConnectedAt { Text("마지막 연결 \(last.formatted(date: .abbreviated, time: .shortened))") }
                    if !row.expired { Text("\(row.expiresAt.formatted(date: .abbreviated, time: .omitted))까지 연결하지 않으면 만료") }
                    if let grant = row.grantChoice { item(grant) }
                    item(row.remove)
                }
            }
        }
        Text(model.push.line)
        if let keepOn = model.keepOn {
            Text(keepOn.status)
            item(keepOn.primary)
            if let add = keepOn.addNetwork { item(add) }
            if let notice = keepOn.notice { Text(notice) }
        }
        Menu(model.history.title) {
            if let problem = model.history.problem { Text(problem) }
            if let empty = model.history.empty { Text(empty) }
            ForEach(Array(model.history.lines.enumerated()), id: \.offset) { _, line in
                Text("\(line.at.formatted(date: .abbreviated, time: .shortened)) · \(line.text)")
            }
        }
    }

    private func item(_ choice: ControllerSectionModel.Choice) -> some View {
        Button(choice.menuTitle) { ControllerSectionActions.fromMenu(choice, service: service) }
            .disabled(!choice.enabled)
    }
}

/// The section in the status window: the only place a raising button is.
struct ControllerStatusSection: View {
    let service: ScreenService
    @State private var notice: String?
    @State private var renaming: String?   // the controller whose name is being edited
    @State private var newName = ""
    @State private var renameProblem: String?
    @State private var historyShown = false
    @FocusState private var nameFieldFocused: Bool

    var body: some View {
        let model = ControllerSectionModel(service.controllerSectionState())
        VStack(alignment: .leading, spacing: 8) {
            Text(ControllerSectionModel.title).font(.headline)
            HStack {
                Label(model.allow.status, systemImage: model.allow.isOn ? "checkmark.circle" : "xmark.circle")
                    .foregroundStyle(model.allow.isOn ? Color.green : Color.primary)
                Spacer()
                button(model.allow.choice)
            }
            if let detail = model.allow.detail { caption(detail) }
            HStack {
                button(model.add.choice)
                if let reason = model.add.disabledReason { caption(reason) }
            }
            Label(model.push.line, systemImage: model.push.live ? "bell.badge" : "bell.slash")
                .foregroundStyle(model.push.live ? Color.green : Color.orange)
            if let detail = model.push.detail { caption(detail) }
            if let watching = model.watching {
                Divider()
                Text(watching.line)
                if let reason = watching.reason { caption(reason) }
                HStack {
                    button(watching.disconnect)
                    caption("Mac 키보드에서 \(EndSessionHotKey.label)를 눌러도 바로 끊깁니다.")
                }
            }
            if !model.rows.isEmpty {
                Divider()
                ForEach(model.rows) { row in rowView(row) }
            }
            if let keepOn = model.keepOn {
                Divider()
                Label(keepOn.status, systemImage: keepOn.isOn ? "power.circle.fill" : "power.circle")
                if let detail = keepOn.detail { caption(detail) }
                HStack {
                    button(keepOn.primary)
                    if let add = keepOn.addNetwork { button(add) }
                }
                if let notice = keepOn.notice { Text(notice).font(.callout).foregroundStyle(.red) }
            }
            Divider()
            DisclosureGroup(isExpanded: $historyShown) {
                VStack(alignment: .leading, spacing: 2) {
                    if let problem = model.history.problem { Text(problem).font(.caption).foregroundStyle(.orange) }
                    if let empty = model.history.empty { caption(empty) }
                    ForEach(Array(model.history.lines.enumerated()), id: \.offset) { _, line in
                        Text("\(line.at.formatted(date: .abbreviated, time: .shortened)) · \(line.text)")
                            .font(.caption).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.top, 4)
            } label: {
                Text(model.history.title)
            }
            if let notice { Text(notice).font(.callout).foregroundStyle(.red) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The network this Mac is on, for 「이 네트워크도 켜 두기」: read as the window opens and comes to the front again.
        .task { await service.refreshPresentNetwork() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            ControllerSectionActions.refreshNetwork()
        }
    }

    @ViewBuilder private func rowView(_ row: ControllerSectionModel.Row) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text([row.name, row.model].compactMap { $0 }.joined(separator: " · "))
                    if let enrolled = row.enrolledName { caption("등록 이름: \(enrolled)") }
                    Text(row.fingerprint).font(.system(.caption, design: .monospaced))
                    Text(row.genuine).font(.caption).foregroundStyle(row.genuineConfirmed ? Color.secondary : Color.orange)
                    Text(row.grant).font(.caption)
                    if let status = row.status {
                        Text(status).font(.caption).foregroundStyle(row.watching ? Color.green : Color.orange)
                    }
                }
                Spacer()
                if renaming != row.id {
                    Button("이름 변경") { renaming = row.id; newName = row.name; renameProblem = nil }
                        .accessibilityLabel("\(row.name) 이름 변경")
                }
            }
            if renaming == row.id {
                HStack {
                    TextField("이 Mac에서 부를 이름", text: $newName)
                        .textFieldStyle(.roundedBorder)
                        .focused($nameFieldFocused)
                        .onAppear { nameFieldFocused = true }
                        .onSubmit { saveName(row.id) }
                    Button("저장") { saveName(row.id) }
                    Button("취소") { renaming = nil; renameProblem = nil }
                }
                Text(renameProblem ?? "이 Mac에서만 바뀝니다. 비우면 그 Mac이 등록한 이름으로 돌아갑니다.")
                    .font(.caption).foregroundStyle(renameProblem == nil ? Color.secondary : Color.red)
            }
            HStack {
                if let grant = row.grantChoice { button(grant) }
                button(row.remove, destructive: true)
            }
            caption("등록 \(row.registeredAt.formatted(date: .abbreviated, time: .shortened))"
                    + (row.lastConnectedAt.map { " · 마지막 연결 \($0.formatted(date: .abbreviated, time: .shortened))" } ?? "")
                    + (row.expired ? "" : " · \(row.expiresAt.formatted(date: .abbreviated, time: .omitted))까지 연결하지 않으면 만료"))
        }
        .padding(.vertical, 4)
    }

    /// A raising choice is a hardware-click button; any other a plain one (lowering needs no proof).
    @ViewBuilder private func button(_ choice: ControllerSectionModel.Choice, destructive: Bool = false) -> some View {
        if choice.action.raises {
            HardwareButton(title: choice.title, enabled: choice.enabled) { click in run(choice.action, by: .click(click)) }
                .fixedSize()
        } else {
            Button(choice.title, role: destructive ? .destructive : nil) { run(choice.action, by: .unchecked) }
                .disabled(!choice.enabled)
        }
    }

    private func run(_ action: ControllerSectionAction, by trigger: ControllerSectionTrigger) {
        notice = nil
        ControllerSectionActions.run(action, by: trigger, service: service) { notice = $0 }
    }

    private func saveName(_ id: String) {
        renameProblem = service.renameController(id, to: newName)
        if renameProblem == nil { renaming = nil }
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}
#endif
