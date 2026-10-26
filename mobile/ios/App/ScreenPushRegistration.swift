import CryptoKit
import Foundation
import LocalAuthentication
import Observation
import ScreenControlCore
import Security
import UIKit
import UserNotifications

// Notifications and remote stop on the phone (DESIGN 「알림·원격 차단」). OFF unless the build sets
// AGENTSTOZ_SCREEN_PUSH_URL (Info.plist `AgentsToZScreenPushURL`) and signs with
// App/AgentsToZMobile.push.entitlements: without the URL the app never asks for notification permission, never
// registers with APNs and shows no remote-stop actions. ScreenControlCore/PushCommands.swift has the trust reasoning.

enum ScreenPushConfig {
    static let endpoint = PushEndpoint(Bundle.main.object(forInfoDictionaryKey: "AgentsToZScreenPushURL") as? String)
    static var isEnabled: Bool { endpoint != nil }
    static var client: ScreenPushClient { ScreenPushClient(endpoint: endpoint) }
    /// The APNs topic: this app's bundle ID (TestFlight and development installs differ).
    static var topic: String { Bundle.main.bundleIdentifier ?? "" }

    /// Which APNs the token belongs to. A development-signed install carries its provisioning profile, which says
    /// `aps-environment` development; TestFlight and App Store installs carry none and use production.
    static var environment: PushRegistration.Environment {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else { return .production }
        let text = String(decoding: data, as: UTF8.self).replacingOccurrences(of: "\t", with: "").replacingOccurrences(of: "\n", with: "")
        return text.contains("<key>aps-environment</key><string>development</string>") ? .sandbox : .production
    }
}

/// The APNs token each Mac was told to push to, in this device's keychain only. Holding it is what lets this device
/// stop those pushes again without Face ID.
enum ScreenPushTokens {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.intenet.agentstoz.mobile.screen-push",
         kSecAttrAccount as String: "tokens",
         kSecAttrSynchronizable as String: false]
    }

    /// Mac ID (hex fingerprint) → token.
    static func load() -> [String: Data] {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return [:] }
        return (try? JSONDecoder().decode([String: Data].self, from: data)) ?? [:]
    }

    static func save(_ tokens: [String: Data]) {
        SecItemDelete(query as CFDictionary)
        guard !tokens.isEmpty, let data = try? JSONEncoder().encode(tokens) else { return }
        var request = query
        request[kSecValueData as String] = data
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(request as CFDictionary, nil)
    }
}

/// A notification the person tapped, whose event the pinned Mac signed.
struct TappedScreenEvent: Identifiable {
    let id = UUID()
    let mac: SavedScreenMac
    let event: ScreenEvent
}

/// One remote stop to send: from the Mac row's menu (asks to confirm first) or from a tapped notification (the
/// person already chose there).
struct ScreenRemoteStopRequest: Identifiable {
    let id = UUID()
    let mac: SavedScreenMac
    let action: RemoteStopAction
    var confirmed = false
}

enum RemoteStopPhase: Equatable {
    case approving, sending, waiting
    case answered(RemoteCommandOutcome)
    case noAnswer
    case failed(String)

    var isFinished: Bool {
        switch self { case .answered, .noAnswer, .failed: true; default: false }
    }
}

@MainActor @Observable
final class ScreenPushCenter {
    static let shared = ScreenPushCenter()

    /// How long the phone waits for the Mac's answer. The Mac polls every 30 seconds while screen control is on.
    static let answerWait: Duration = .seconds(75)

    /// Mac IDs this device asked to be told about.
    private(set) var subscribed: Set<String> = Set(ScreenPushTokens.load().keys)
    /// Mac IDs whose registration names an older APNs token: notifications stop until the person turns them on again.
    private(set) var stale: Set<String> = []
    var tapped: TappedScreenEvent?

    @ObservationIgnored private var token: Data?
    @ObservationIgnored private var waiters: [CheckedContinuation<Data, Error>] = []

    // MARK: APNs token (ScreenPushAppDelegate)

    func received(token: Data) {
        self.token = token
        stale = Set(ScreenPushTokens.load().filter { $0.value != token }.keys)
        let waiting = waiters
        waiters = []
        waiting.forEach { $0.resume(returning: token) }
    }

    func failed(_ error: Error) {
        let waiting = waiters
        waiters = []
        waiting.forEach { $0.resume(throwing: error) }
    }

    private func deviceToken() async throws -> Data {
        if let token { return token }
        let timeout = Task { [weak self] in
            try await Task.sleep(for: .seconds(20))
            self?.failed(URLError(.timedOut))
        }
        defer { timeout.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            waiters.append(continuation)
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    // MARK: Notifications

    /// 「알림 받기」: permission, the token, then Face ID to sign the registration with this device's key for that Mac.
    /// Returns what to tell the person.
    func subscribe(_ mac: SavedScreenMac) async -> String {
        guard ScreenPushConfig.isEnabled, let pinned = mac.pinned else { return "알림을 켤 수 없는 앱입니다." }
        do {
            guard try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) else {
                return "설정 앱 → AgentsToZ → 알림에서 알림을 허용한 뒤 다시 눌러 주세요."
            }
            let token = try await deviceToken()
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: mac.deviceKey,
                                                                reason: "\(mac.macName) 화면 제어 알림을 받습니다")
            let registration = try PushRegistration(mac: pinned, deviceKey: signer.publicKey, token: token,
                                                    environment: ScreenPushConfig.environment, topic: ScreenPushConfig.topic)
            try await ScreenPushConfig.client.register(registration, signer: signer)
            var tokens = ScreenPushTokens.load()
            tokens[mac.pushKey] = token
            ScreenPushTokens.save(tokens)
            subscribed.insert(mac.pushKey)
            stale.remove(mac.pushKey)
            return "\(mac.macName)에 다른 기기가 연결하거나 새 기기가 등록되면 알려 드립니다."
        } catch {
            return "알림을 켜지 못했습니다: \(Self.describe(error))"
        }
    }

    /// 「알림 끄기」, or the Mac deleted from this device: the token is the authority, so no Face ID.
    @discardableResult
    func unsubscribe(_ mac: SavedScreenMac) async -> String {
        var tokens = ScreenPushTokens.load()
        guard let token = tokens[mac.pushKey] else { return "알림이 이미 꺼져 있습니다." }
        let deviceID = mac.deviceID
        tokens[mac.pushKey] = nil
        ScreenPushTokens.save(tokens)
        subscribed.remove(mac.pushKey)
        stale.remove(mac.pushKey)
        guard let pinned = mac.pinned, let deviceID else { return "알림을 껐습니다." }
        do {
            try await ScreenPushConfig.client.unregister(macFingerprint: pinned.fingerprint, deviceID: deviceID, token: token)
            return "알림을 껐습니다."
        } catch {
            return "이 기기에서는 알림을 껐습니다. 서버에 알리지 못해 알림이 한동안 더 올 수 있습니다."
        }
    }

    /// A tapped notification: offered as a remote stop only when the Mac this device pinned signed its event.
    func tapped(_ userInfo: [AnyHashable: Any]) {
        guard let screen = userInfo["screen"] as? [String: Any], let m = screen["m"] as? String, let s = screen["s"] as? String,
              let message = Data(base64Encoded: m), let signature = Data(base64Encoded: s),
              let claimed = try? ScreenEvent.decode(message) else { return }
        let signed = SignedPushMessage(message: message, signature: signature)
        let macID = claimed.macFingerprint.map { String(format: "%02x", $0) }.joined()
        // The registration the event was sent to, when this device holds more than one for that Mac.
        let candidates = ScreenMacStore.load().filter { $0.id == macID }
        let addressed = candidates.first { mac in mac.deviceID.map { claimed.recipients.contains($0) } ?? false }
        guard let mac = addressed ?? candidates.first, let pinned = mac.pinned,
              let event = ScreenEvent.open(signed, mac: pinned) else { return }
        tapped = TappedScreenEvent(mac: mac, event: event)
    }

    // MARK: Remote stop

    /// Face ID, then the signed command to the relay, then the Mac's signed answer for up to `answerWait`.
    func send(_ action: RemoteStopAction, to mac: SavedScreenMac, phase: @MainActor (RemoteStopPhase) -> Void) async {
        guard ScreenPushConfig.isEnabled, let pinned = mac.pinned else { return phase(.failed("원격 차단을 쓸 수 없는 앱입니다.")) }
        do {
            phase(.approving)
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: mac.deviceKey,
                                                                reason: "\(mac.macName)에 「\(Self.title(of: action))」을 보냅니다")
            phase(.sending)
            let command = try RemoteCommand(mac: pinned, deviceKey: signer.publicKey, action: action)
            try await ScreenPushConfig.client.send(command, signer: signer)
            phase(.waiting)
            let deadline = ContinuousClock.now + Self.answerWait
            while ContinuousClock.now < deadline {
                try await Task.sleep(for: .seconds(3))
                if let outcome = try? await ScreenPushConfig.client.result(of: command.id, mac: pinned) {
                    return phase(.answered(outcome))
                }
            }
            phase(.noAnswer)
        } catch is CancellationError {
            phase(.noAnswer)
        } catch {
            phase(.failed(Self.describe(error)))
        }
    }

    static func title(of action: RemoteStopAction) -> String {
        switch action {
        case .endSession: "지금 끊기"
        case .revokeConnected, .revokeDevice: "이 기기 해지"
        case .turnOff: "화면 제어 전체 끄기"
        }
    }

    static func message(_ phase: RemoteStopPhase, action: RemoteStopAction) -> String {
        switch phase {
        case .approving: "Face ID로 승인해 주세요."
        case .sending: "보내는 중…"
        case .waiting: "Mac의 답을 기다리는 중… Mac은 화면 제어가 켜져 있는 동안 30초마다 확인합니다."
        case .answered(.applied):
            switch action {
            case .endSession: "Mac이 연결을 끊었습니다."
            case .revokeConnected, .revokeDevice: "Mac이 그 기기의 등록을 해지했습니다."
            case .turnOff: "Mac이 화면 제어를 껐습니다. 다시 켜려면 Mac에서 직접 켜 주세요."
            }
        case .answered(.nothingToDo):
            switch action {
            case .endSession, .revokeConnected: "끊을 연결이 없었습니다."
            case .revokeDevice: "그 기기는 이미 등록되어 있지 않습니다."
            case .turnOff: "화면 제어가 이미 꺼져 있습니다."
            }
        case .answered(.superseded): "보낸 뒤 Mac에서 새로 연결하거나 켠 일이 있어, Mac이 그대로 두었습니다."
        case .answered(.refused): "Mac이 이 요청을 받지 않았습니다. 이 기기 등록이 해지되었거나 오래되었을 수 있습니다."
        case .noAnswer: "아직 Mac의 답이 없습니다. Mac이 잠자기 중이거나 화면 제어가 꺼져 있으면 답하지 못합니다. 끊기는 10분, 해지·끄기는 7일 안에 Mac이 켜지면 처리됩니다."
        case .failed(let reason): "보내지 못했습니다: \(reason)"
        }
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case PushClientError.rejected(_, "rate_limited"): "잠시 후 다시 시도해 주세요."
        case PushClientError.rejected(_, "not_registered"), PushClientError.rejected(_, "unknown_device"):
            "서버가 이 기기를 모릅니다. 먼저 「알림 받기」를 켜 주세요."
        case PushClientError.rejected(_, let code): "서버가 거절했습니다(\(code))."
        case PushClientError.unsignedResult: "Mac이 서명하지 않은 답이 와서 믿지 않았습니다."
        case PushClientError.malformedResponse: "서버 응답을 읽지 못했습니다."
        case let error as LAError where [.userCancel, .appCancel, .systemCancel].contains(error.code): "취소했습니다."
        default: error.localizedDescription
        }
    }
}

extension SavedScreenMac {
    /// This device's ID at that Mac (the fingerprint of its key), read from the Secure Enclave key blob without Face ID.
    var deviceID: Data? {
        (try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: deviceKey)).map { ScreenControlIdentity.fingerprint(of: $0.publicKey) }
    }

    /// Which notification registration this is: the Mac and this device's key for it (a device can hold two for one Mac).
    var pushKey: String { id + ":" + (deviceID?.map { String(format: "%02x", $0) }.joined() ?? "") }
}

/// Receives the APNs token and notification taps. Does nothing unless the build has a push endpoint.
@MainActor final class ScreenPushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard ScreenPushConfig.isEnabled else { return true }
        UNUserNotificationCenter.current().delegate = self
        // Only to notice a changed token; this shows no prompt, and a device that never subscribed registers nothing.
        if !ScreenPushTokens.load().isEmpty { application.registerForRemoteNotifications() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        ScreenPushCenter.shared.received(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        ScreenPushCenter.shared.failed(error)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification)
        async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        // Only the parts the event needs cross over: two base64 strings.
        guard let screen = userInfo["screen"] as? [String: Any], let m = screen["m"] as? String, let s = screen["s"] as? String else { return }
        await MainActor.run { ScreenPushCenter.shared.tapped(["screen": ["m": m, "s": s]]) }
    }
}
