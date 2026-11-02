#if os(macOS)
import Foundation
import ScreenControlCore

// 「재시작·업데이트 뒤에도 켜 두기 · 이 네트워크에서」 (docs/design/mac-to-mac-2026-11-01 D-2, 7.3 「power」, SR-27).
//
// Off by default. The person at this Mac turns it on behind Touch ID or a paired Watch, only while the push gate is open
// (ReleaseGate.keepOnOffered), and it names the network the Mac was on then; the same proof adds another network. When
// AgentsToZ Screen opens again (a login, an update, a restart) it turns screen control on by itself only on a network it
// saved; on any other it waits and says why. Every way of turning off releases it: the menu's 끄기, 「끄고 끝내기」 (the
// quit menu's default), a phone's 끄기, a remote turnOff, and a stop because something could not be saved. 「켜 둔 채
// 끝내기」 and the app being quit from outside (an update) keep it.
//
// Releasing it saves keepOn off first. When even that cannot be saved, a hold file is written: while it is there nothing
// turns on by itself; only turning on at this Mac behind its proof removes it. The same user can make the file too, which
// only ever keeps Screen off (the closed side). A setting this build cannot read is off.

/// The saved setting while it is on.
public struct KeepOnSetting: Equatable, Sendable {
    /// The most networks one setting names: a home, an office, a few more.
    public static let maxNetworks = 8

    public var since: Date
    /// The networks it may turn on by itself on, as approved networks tell them apart (NetworkIdentity).
    public var networks: [NetworkIdentity]

    public init(since: Date, networks: [NetworkIdentity]) {
        self.since = since
        self.networks = Array(networks.prefix(Self.maxNetworks))
    }

    /// The setting once the person turned it on (again) at this Mac on `network`: kept networks stay, this one joins them;
    /// a full list gives way to the newest. `since` is the first time it was turned on.
    public static func turningOn(_ current: KeepOnSetting?, network: NetworkIdentity, at date: Date) -> KeepOnSetting {
        var networks = current?.networks.filter { $0 != network } ?? []
        networks.append(network)
        return KeepOnSetting(since: current?.since ?? date, networks: Array(networks.suffix(maxNetworks)))
    }
}

/// What AgentsToZ Screen does about keeping on, at launch and whenever the network changes while it turned itself on.
public enum KeepOnDecision: Equatable, Sendable {
    /// Not kept on, or held: the person turns it on.
    case stayOff
    /// On, and listening here: a saved network.
    case listen
    /// On, but not listening: this network is not one it saved (or cannot be told apart).
    case wait
}

public enum KeepOn {
    /// At launch: on by itself only when kept on, not held, and on a saved network.
    public static func atLaunch(_ setting: KeepOnSetting?, held: Bool, network: NetworkIdentity?) -> KeepOnDecision {
        guard let setting, !held else { return .stayOff }
        return follow(setting, network: network)
    }

    /// While on by itself: listen on a saved network, wait anywhere else.
    public static func follow(_ setting: KeepOnSetting, network: NetworkIdentity?) -> KeepOnDecision {
        guard let network, setting.networks.contains(network) else { return .wait }
        return .listen
    }

    /// How releasing went.
    public enum Release: Equatable, Sendable {
        /// keepOn is saved off.
        case cleared
        /// It could not be saved off; the hold file keeps it from turning on by itself.
        case held
        /// Neither could be saved: the next launch may turn on by itself. Said to the person.
        case failed
    }

    /// Saves keepOn off first; when that fails, writes the hold file.
    public static func release(clear: () throws -> Void, hold: () throws -> Void) -> Release {
        do {
            try clear()
            return .cleared
        } catch {
            do {
                try hold()
                return .held
            } catch {
                return .failed
            }
        }
    }
}

extension ScreenStore {
    static let powerAccount = "power"
    static let powerFormat = 1

    /// The kept-on setting; nil while off. A document this build does not know, one that is damaged, or one with no
    /// network it could match is off: keeping on is never guessed. The second value says the item could not be read.
    func keepOn() -> (setting: KeepOnSetting?, unreadable: Bool) {
        let data: Data?
        do { data = try read(Self.powerAccount) } catch { return (nil, true) }
        guard let data else { return (nil, false) }
        return (Self.decodeKeepOn(data), false)
    }

    static func decodeKeepOn(_ data: Data) -> KeepOnSetting? {
        guard let document = try? JSONDecoder().decode(PowerDocument.self, from: data), document.format == powerFormat,
              document.keepOn, let since = document.since else { return nil }
        let networks = (document.networks ?? []).compactMap(\.identity)
        guard !networks.isEmpty else { return nil }
        return KeepOnSetting(since: since, networks: networks)
    }

    /// Saves the setting, or keepOn off for nil.
    func saveKeepOn(_ setting: KeepOnSetting?) throws {
        try write(Self.powerAccount, try Self.encodeKeepOn(setting))
    }

    static func encodeKeepOn(_ setting: KeepOnSetting?) throws -> Data {
        try JSONEncoder().encode(PowerDocument(format: powerFormat, keepOn: setting != nil, since: setting?.since,
                                               networks: setting?.networks.map(StoredNetwork.init)))
    }

    private struct PowerDocument: Codable {
        let format: Int
        let keepOn: Bool
        let since: Date?
        let networks: [StoredNetwork]?
    }

    /// One saved network; one that names no particular router reads as nothing, and the others stay.
    private struct StoredNetwork: Codable {
        let identity: NetworkIdentity?
        init(_ identity: NetworkIdentity) { self.identity = identity }
        init(from decoder: Decoder) throws { identity = try? NetworkIdentity(from: decoder) }
        func encode(to encoder: Encoder) throws { try identity?.encode(to: encoder) }
    }
}

/// `~/Library/Application Support/AgentsToZ Screen/power-hold` (DESIGN 7.3): while it exists, nothing turns screen control on
/// by itself.
public enum PowerHold {
    public static var url: URL { ScreenStatusFile.url.deletingLastPathComponent().appending(path: "power-hold") }

    public static func isHeld(at url: URL = url) -> Bool { FileManager.default.fileExists(atPath: url.path) }

    public static func hold(at url: URL = url) throws {
        let folder = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard FileManager.default.createFile(atPath: url.path, contents: Data("hold\n".utf8), attributes: [.posixPermissions: 0o600])
        else { throw CocoaError(.fileWriteUnknown) }
    }

    /// Only after the person turned screen control on at this Mac behind its proof.
    public static func release(at url: URL = url) {
        try? FileManager.default.removeItem(at: url)
    }
}
#endif
