#if os(macOS)
import Foundation
import ScreenControlCore

// B's 「다른 Mac에서 이 Mac 보기」 section, as the menu and the status window show it (docs/design/mac-to-mac-2026-11-01
// 5.2, 6.5, 6.6, 9절, 12절, SR-19, SR-21, SR-27, SR-29, SR-30): the 「다른 Mac 연결 허용」 switch, 「다른 Mac 추가…」,
// the controllers (name, model, key fingerprint, genuine Viewer, grant, dates), the Mac watching now, the push gate's
// line, 「켜 두기」, the quit buttons and the last 64 history entries. Pure: built from a copy of ScreenService's state, so
// checks read every line and button without a window, a keychain or a click. AgentsToZScreen/ControllerSection.swift
// draws it.
//
// Raising what another Mac may do (the switch on, view → control, keeping on) runs only from a control whose click
// `ScreenInputOrigin.humanClick` passed, and only then asks for Touch ID or a paired Watch (`ControllerSectionGate`).
// The menu bar's items cannot be checked that way (there is no control to be inside of), so a raising item there only
// opens the status window. Lowering acts at once, whatever pressed it. One language, Korean, as everywhere in Screen.

/// What the section is built from: ScreenService's state, copied (`ScreenService.controllerSectionState`).
public struct ControllerSectionState: Equatable, Sendable {
    /// The Mac controller holding the screen now.
    public struct Watching: Equatable, Sendable {
        public var id: String
        public var name: String
        public var canControl: Bool
        /// Why a controller granted control only watches (ScreenService.Session.viewOnlyCause).
        public var viewOnlyCause: ControllerViewOnlyCause?
        public init(id: String, name: String, canControl: Bool, viewOnlyCause: ControllerViewOnlyCause? = nil) {
            self.id = id; self.name = name; self.canControl = canControl; self.viewOnlyCause = viewOnlyCause
        }
    }

    /// Screen control listens now (`ScreenService.isOn`): a controller reaches this Mac only then.
    public var listening: Bool
    public var allowMacControllers: Bool
    public var controllers: [RegisteredController]
    /// A phone holds the screen: 「다른 Mac 추가…」 waits (its window would close at once, SR-37).
    public var phoneWatching: Bool
    /// The Mac controller holding the screen; nil for none or a phone.
    public var watching: Watching?
    /// Oldest first, as the log keeps it.
    public var history: [ControllerLogEntry]
    public var historyUnsaved: Bool
    public var historyUnread: Bool
    /// The push gate (DESIGN 9절).
    public var pushLive: Bool
    /// This build offers 「조작」 (S-M3).
    public var controlOffered: Bool
    public var keepOn: KeepOnSetting?
    public var keepOnOffered: Bool
    public var keepOnNotice: String?
    /// The network this Mac is on now, as last read (`ScreenService.presentNetwork`), to tell whether keeping on saved it
    /// already. Nil when it could not be told apart: that is never taken for a saved one.
    public var network: NetworkIdentity?
    public var now: Date

    public init(listening: Bool = false, allowMacControllers: Bool = false, controllers: [RegisteredController] = [],
                phoneWatching: Bool = false, watching: Watching? = nil, history: [ControllerLogEntry] = [],
                historyUnsaved: Bool = false, historyUnread: Bool = false, pushLive: Bool = false, controlOffered: Bool = false,
                keepOn: KeepOnSetting? = nil, keepOnOffered: Bool = false, keepOnNotice: String? = nil,
                network: NetworkIdentity? = nil, now: Date = Date()) {
        self.listening = listening; self.allowMacControllers = allowMacControllers; self.controllers = controllers
        self.phoneWatching = phoneWatching; self.watching = watching; self.history = history
        self.historyUnsaved = historyUnsaved; self.historyUnread = historyUnread; self.pushLive = pushLive
        self.controlOffered = controlOffered; self.keepOn = keepOn; self.keepOnOffered = keepOnOffered
        self.keepOnNotice = keepOnNotice; self.network = network; self.now = now
    }
}

/// What the person may do in the section. `raises` says which ones need a hardware click and then Touch ID or a Watch.
public enum ControllerSectionAction: Equatable, Sendable {
    /// 「다른 Mac 연결 허용」 on (raising) or off.
    case allow(Bool)
    /// A controller's grant: `.control` raises, `.view` lowers.
    case grant(id: String, ScreenControllerGrant)
    /// 「삭제」: never asks.
    case remove(id: String)
    /// 「끊기」 for the Mac watching now.
    case disconnect
    /// 「켜 두기」 on (raising; on a network it has not saved, it adds that one) or off.
    case keepOn(Bool)
    /// 「다른 Mac 추가…」: shows the window only. Opening its 120-second listener is the window's own hardware-click button
    /// (ScreenControllerPairing.open), and approving there asks again, so showing it raises nothing.
    case showPairingWindow

    /// Whether this widens what another Mac may do, or when this Mac listens (SR-29, 10절 원칙).
    public var raises: Bool {
        switch self {
        case .allow(let on), .keepOn(let on): on
        case .grant(_, let grant): grant == .control
        case .remove, .disconnect, .showPairingWindow: false
        }
    }
}

/// What ran an action.
public enum ControllerSectionTrigger: Equatable, Sendable {
    /// A control that judged the click that ran it: `ScreenInputOrigin.humanClick`, nil when it was the person's.
    case click(ScreenInputRefusal?)
    /// Anything that judged nothing: a menu item, a plain button, a key. Lowering only.
    case unchecked
}

/// SR-29 for the section: a raising action runs only from a control whose click was the person's at this Mac.
public enum ControllerSectionGate {
    /// Nil when `action` may go on (and, raising, ask for Touch ID or a Watch next); otherwise what to tell the person.
    public static func refusal(for action: ControllerSectionAction, by trigger: ControllerSectionTrigger) -> String? {
        guard action.raises else { return nil }
        return trigger == .click(nil) ? nil : ScreenInputOriginText.notInFront
    }
}

/// The section as shown. Every text is final; dates stay dates for the view to format in the person's locale.
public struct ControllerSectionModel: Equatable, Sendable {
    public static let title = "다른 Mac에서 이 Mac 보기"
    /// The proof every raising button asks for (5.2, F7: never the password).
    static let proof = "Touch ID 또는 Apple Watch"
    /// What a raising menu item says it does: it opens the status window, where the button checks the click.
    static let inStatusWindow = "… (상태 창에서)"
    /// What 「켜 둔 채 끝내기」 adds: `ScreenService.keepOnQuitNotice`, which a check keeps equal (that one is main-actor bound).
    static let keepOnQuitNotice = "다음 로그인 때 이 네트워크에서 다시 켜집니다."

    /// One thing the person may press.
    public struct Choice: Equatable, Sendable {
        public let action: ControllerSectionAction
        /// The status window's button: a hardware-click button when `action` raises.
        public let title: String
        /// The menu's item. A raising one only opens the status window.
        public let menuTitle: String
        public let enabled: Bool

        init(_ action: ControllerSectionAction, _ title: String, menu: String? = nil, enabled: Bool = true) {
            self.action = action
            self.title = title
            menuTitle = action.raises ? (menu ?? title) + ControllerSectionModel.inStatusWindow : (menu ?? title)
            self.enabled = enabled
        }
    }

    public struct Allow: Equatable, Sendable {
        public let isOn: Bool
        public let status: String
        public let choice: Choice
        public let detail: String?
    }

    public struct Add: Equatable, Sendable {
        public let choice: Choice
        public let disabledReason: String?
    }

    public struct Row: Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        /// The name it enrolled with, when the person renamed it here.
        public let enrolledName: String?
        public let model: String?
        /// 「키 지문 abcd」: the four characters A's list shows for the same key (SR-20).
        public let fingerprint: String
        public let genuine: String
        public let genuineConfirmed: Bool
        public let grant: String
        /// That it is the Mac watching, or why it cannot connect now; nil when nothing stands in the way.
        public let status: String?
        public let watching: Bool
        public let expired: Bool
        public let registeredAt: Date
        public let lastConnectedAt: Date?
        public let expiresAt: Date
        /// Raise to control (only where this build offers it) or lower to view; nil when there is nothing to change.
        public let grantChoice: Choice?
        public let remove: Choice
    }

    public struct Watching: Equatable, Sendable {
        public let id: String
        /// 「지금 보는 Mac: ‘이름’ · 조작 가능/보기만」.
        public let line: String
        /// Why it only watches.
        public let reason: String?
        public let disconnect: Choice
    }

    public struct Push: Equatable, Sendable {
        public let live: Bool
        public let line: String
        public let detail: String?
    }

    public struct KeepOn: Equatable, Sendable {
        public let isOn: Bool
        public let status: String
        public let detail: String?
        /// Off while on; on (raising) while off, enabled only while it is offered and screen control listens.
        public let primary: Choice
        /// While on: add the network the Mac listens on now (raising), when keeping on has not saved it.
        public let addNetwork: Choice?
        public let notice: String?
    }

    public struct Quit: Equatable, Sendable {
        /// The default: lets keeping on go (`ScreenService.quit()`).
        public let primaryTitle: String
        /// Only while kept on: quits and keeps it (`quit(keepingOn: true)`), its title saying what follows.
        public let keepingOnTitle: String?
    }

    public struct HistoryLine: Equatable, Sendable {
        public let at: Date
        public let text: String
    }

    public struct History: Equatable, Sendable {
        /// Newest first, at most `ControllerLog.capacity`.
        public let lines: [HistoryLine]
        public let title: String
        public let empty: String?
        public let problem: String?
    }

    public let allow: Allow
    public let add: Add
    public let rows: [Row]
    public let watching: Watching?
    public let push: Push
    /// Nil while it is neither offered nor on: hidden (SR-27).
    public let keepOn: KeepOn?
    public let quit: Quit
    public let history: History

    public init(_ state: ControllerSectionState) {
        allow = Self.allow(state)
        let busy = state.watching != nil || state.phoneWatching
        add = Add(choice: Choice(.showPairingWindow, "다른 Mac 추가…", enabled: !busy),
                  disabledReason: busy ? "화면 연결이 있는 동안에는 추가할 수 없습니다" : nil)
        rows = state.controllers.map { Self.row($0, state) }
        watching = state.watching.map(Self.watching)
        push = state.pushLive
            ? Push(live: true, line: "알림·원격 차단: 연결됨", detail: nil)
            : Push(live: false, line: "알림·원격 차단: 확인 전",
                   detail: "폰에 알림과 원격 차단이 닿는 것을 확인하기 전에는 조작 권한, 켜 두기, 정품 확인이 안 된 Mac의 연결을 열지 않습니다.")
        keepOn = Self.keepOn(state)
        quit = state.keepOn == nil
            ? Quit(primaryTitle: "AgentsToZ Screen 종료", keepingOnTitle: nil)
            : Quit(primaryTitle: "끄고 끝내기", keepingOnTitle: "켜 둔 채 끝내기 · \(Self.keepOnQuitNotice)")
        history = Self.history(state)
    }

    // MARK: Parts

    private static func allow(_ state: ControllerSectionState) -> Allow {
        guard state.allowMacControllers else {
            return Allow(isOn: false, status: "다른 Mac 연결 허용: 꺼짐",
                         choice: Choice(.allow(true), "켜기 (\(proof))", menu: "다른 Mac 연결 허용 켜기"),
                         detail: "이 Mac 앞에서 직접 눌러 켭니다. 원격 데스크톱이나 다른 프로그램의 클릭은 받지 않습니다. 끄면 추가한 Mac은 남고 연결만 막습니다.")
        }
        let detail: String? = if !state.listening {
            "화면 제어가 켜져 있지 않아 지금은 연결을 받지 않습니다."
        } else if state.controllers.isEmpty {
            "아직 추가한 Mac이 없습니다. 「다른 Mac 추가…」로 추가하세요."
        } else {
            nil
        }
        return Allow(isOn: true, status: "다른 Mac 연결 허용: 켜짐", choice: Choice(.allow(false), "끄기", menu: "다른 Mac 연결 허용 끄기"),
                     detail: detail)
    }

    private static func row(_ controller: RegisteredController, _ state: ControllerSectionState) -> Row {
        let watching = state.watching?.id == controller.id
        let expired = controller.isExpired(at: state.now)
        let status: String? = if watching {
            "지금 보는 중"
        } else if expired {
            "90일 동안 쓰지 않아 만료되었습니다. 다시 추가하세요."
        } else if !state.allowMacControllers {
            "다른 Mac 연결 허용이 꺼져 있어 연결할 수 없습니다"
        } else if !ReleaseGate.admitsController(bindsGenuineViewer: controller.bindsGenuineViewer, pushLive: state.pushLive) {
            "알림 연결 확인 전이라 받지 않음"  // DESIGN 9절: an unbound registration waits for the push gate
        } else {
            nil
        }
        let genuine = controller.bindsGenuineViewer ? "정품 AgentsToZ Viewer: 확인됨"
            : controller.enrollment.method == .phoneBroker ? "정품 AgentsToZ Viewer: 확인할 수 없음 (폰으로 등록)"
            : "정품 AgentsToZ Viewer: 확인할 수 없음"
        let grant: String
        let grantChoice: Choice?
        switch controller.grant {
        case .view:
            grant = "권한: 보기"
            grantChoice = state.controlOffered ? Choice(.grant(id: controller.id, .control), "조작 허용 (\(proof))", menu: "조작 허용") : nil
        case .control:
            grant = if !state.controlOffered {
                "권한: 조작 · 이 빌드에서는 보기만 됩니다"
            } else if !state.pushLive {
                "권한: 조작 · 알림·원격 차단 연결 확인 전이라 보기만 됩니다"
            } else {
                "권한: 조작"
            }
            grantChoice = Choice(.grant(id: controller.id, .view), "보기로 낮추기")
        }
        let showsEnrolledName = controller.alias != nil && RegistrationInvite.isShowableName(controller.name)
            && controller.name != controller.displayName
        return Row(id: controller.id, name: controller.displayName, enrolledName: showsEnrolledName ? controller.name : nil,
                   model: controller.showableModel, fingerprint: "키 지문 \(controller.keyFingerprint)", genuine: genuine,
                   genuineConfirmed: controller.bindsGenuineViewer, grant: grant, status: status, watching: watching,
                   expired: expired, registeredAt: controller.registeredAt, lastConnectedAt: controller.lastConnectedAt,
                   expiresAt: controller.expiresAt, grantChoice: grantChoice,
                   remove: Choice(.remove(id: controller.id), watching ? "삭제하고 끊기" : "삭제"))
    }

    private static func watching(_ watching: ControllerSectionState.Watching) -> Watching {
        let reason: String? = switch watching.viewOnlyCause {
        case .build?: "이 빌드에서는 다른 Mac에 조작을 열지 않아 보기만 됩니다."
        case .notifications?: "알림·원격 차단 연결 확인 전이라 보기만 됩니다."
        case .inputProtection?: "이 Mac의 입력 우선 보호 권한(손쉬운 사용·입력 모니터링)이 없어 보기만 됩니다."
        case nil: watching.canControl ? nil : "권한이 보기라서 보기만 됩니다."
        }
        return Watching(id: watching.id, line: "지금 보는 Mac: ‘\(watching.name)’ · \(watching.canControl ? "조작 가능" : "보기만")",
                        reason: reason, disconnect: Choice(.disconnect, "끊기"))
    }

    private static func keepOn(_ state: ControllerSectionState) -> KeepOn? {
        if let setting = state.keepOn {
            // A network this Mac cannot tell apart is not a saved one: pressing says it cannot be kept (enableKeepOn).
            let saved = state.network.map { setting.networks.contains($0) } ?? false
            let add = state.keepOnOffered && state.listening && !saved
            return KeepOn(isOn: true, status: "재시작·업데이트 뒤에도 켜 두기: 켜짐",
                          detail: "저장한 네트워크 \(setting.networks.count)곳에서만 스스로 켜집니다. 다른 네트워크에서는 기다립니다.",
                          primary: Choice(.keepOn(false), "켜 두기 끄기"),
                          addNetwork: add ? Choice(.keepOn(true), "이 네트워크도 켜 두기 (\(proof))", menu: "이 네트워크도 켜 두기") : nil,
                          notice: state.keepOnNotice)
        }
        guard state.keepOnOffered || state.keepOnNotice != nil else { return nil }
        let enabled = state.keepOnOffered && state.listening
        return KeepOn(isOn: false, status: "재시작·업데이트 뒤에도 켜 두기 · 이 네트워크에서",
                      detail: !state.keepOnOffered ? nil
                          : enabled ? "켜 두면 이 Mac이 다시 시작되거나 업데이트돼도 이 네트워크에서 스스로 화면 제어를 켭니다."
                          : "화면 제어를 켠 뒤에 켤 수 있습니다.",
                      primary: Choice(.keepOn(true), "켜 두기 (\(proof))", menu: "켜 두기", enabled: enabled),
                      addNetwork: nil, notice: state.keepOnNotice)
    }

    private static func history(_ state: ControllerSectionState) -> History {
        let lines = state.history.suffix(ControllerLog.capacity).reversed().map { HistoryLine(at: $0.at, text: text(of: $0)) }
        let problem: String? = if state.historyUnread {
            "저장된 기록을 읽지 못했습니다. 이 Mac을 잠금 해제하면 다음 기록 때 다시 읽습니다."
        } else if state.historyUnsaved {
            "마지막 기록을 저장하지 못했습니다. 이 화면에는 남아 있습니다."
        } else {
            nil
        }
        return History(lines: lines, title: "최근 기록 (\(lines.count)/\(ControllerLog.capacity))",
                       empty: lines.isEmpty ? "기록 없음" : nil, problem: problem)
    }

    /// One history line without its time: 「‘이름’ · 무엇 (어떻게)」. Only fixed words: a reason this build does not know
    /// is left out rather than shown as it was stored.
    static func text(of entry: ControllerLogEntry) -> String {
        let what: String = switch entry.event {
        case .paired: "추가됨" + (grantWord(entry.reason).map { " · 권한 \($0)" } ?? "")
        case .grantChanged: "권한 변경" + (grantWord(entry.reason).map { " → \($0)" } ?? "")
        case .removed: "이 Mac에서 삭제"
        case .connected: "연결"
        case .ended: "끝남" + (endingWord(entry.reason).map { " · \($0)" } ?? "")
        case .refused:
            pairingWord(entry.reason).map { "등록 거절 · " + $0 } ?? "거절" + (endingWord(entry.reason).map { " · \($0)" } ?? "")
        case .unenrolled: "그 Mac에서 스스로 등록 해제"
        }
        let route: String? = switch entry.route {
        case .nearby?: "근거리"
        case .connector?: "인터넷(Cloudflare)"
        case nil: nil
        }
        return "‘\(entry.name)’ · \(what)" + (route.map { " (\($0))" } ?? "")
    }

    static func grantWord(_ reason: String?) -> String? {
        switch reason {
        case ScreenControllerGrant.view.rawValue?: "보기"
        case ScreenControllerGrant.control.rawValue?: "조작"
        default: nil
        }
    }

    /// The words for a pairing the 「다른 Mac 추가」 window ended without a row (`ScreenControllerPairingRefusal`).
    static func pairingWord(_ reason: String?) -> String? {
        switch reason.flatMap(ScreenControllerPairingRefusal.init(rawValue:)) {
        case .refusedAtMac?: "이 Mac에서 거절"
        case .windowClosed?: "등록 창을 닫음"
        case .sessionStarted?: "화면 연결이 시작됨"
        case .codeMismatch?: "숫자 불일치"
        case .registryUnreadable?: "등록 목록을 읽지 못함"
        case .registeredAsPhone?: "폰으로 등록된 키"
        case .disconnected?: "연결이 끊기거나 결정 기한이 지남"
        case .untrustedViewer?: "정품 AgentsToZ Viewer를 확인하지 못함"
        case .badSignature?: "확인 서명이 맞지 않음"
        case .expired?: "결정 기한(180초)이 지남"
        case .notAReplacement?: "바꿀 항목이 맞지 않음"
        case nil: nil
        }
    }

    /// The words for `ControllerLogEntry.reason(_:)`.
    static func endingWord(_ reason: String?) -> String? {
        switch reason {
        case "left"?: "연결이 끊김"
        case "idle"?: "오래 쓰지 않음"
        case "timeLimit"?: "시간 한도"
        case "endedAtMac"?: "이 Mac에서 끊음"
        case "turnedOff"?: "화면 제어 끔"
        case "revoked"?: "등록 삭제"
        case "replaced"?: "같은 Mac이 다시 연결"
        case "turnedOffFromDevice"?: "폰에서 화면 제어 끔"
        case "takenOver"?: "등록된 폰이 이어받음"
        case "busy"?: "다른 연결 중"
        case "captureUnavailable"?: "화면 기록 권한 없음"
        default: nil
        }
    }
}

extension ScreenService {
    /// What the 「다른 Mac에서 이 Mac 보기」 section is built from, now.
    public func controllerSectionState(now: Date = Date()) -> ControllerSectionState {
        let watching = session.flatMap { session -> ControllerSectionState.Watching? in
            guard session.peerClass == .controller else { return nil }
            return .init(id: session.deviceID, name: session.deviceName, canControl: session.canControl, viewOnlyCause: session.viewOnlyCause)
        }
        return ControllerSectionState(
            listening: isOn, allowMacControllers: macControllers.allowMacControllers, controllers: controllers,
            phoneWatching: session?.peerClass == .phone, watching: watching, history: controllerHistory,
            historyUnsaved: controllerHistoryUnsaved, historyUnread: controllerHistoryUnread, pushLive: pushLive,
            controlOffered: controlChoiceOffered, keepOn: keepOn, keepOnOffered: keepOnOffered, keepOnNotice: keepOnNotice,
            network: presentNetwork, now: now)
    }
}
#endif
