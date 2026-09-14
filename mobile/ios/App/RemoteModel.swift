import Foundation
import SwiftUI
import AgentsToZCore

@MainActor final class RemoteModel: ObservableObject {
    @Published private(set) var snapshot: RemoteSnapshot?
    @Published private(set) var busy = false
    @Published private(set) var checkedAt: Date?
    @Published var notice: String?
    private let client = LANClient(store: KeychainSessionStore())
    private var revision = UUID()
    /// The host we last paired with, so a return from background knows what to resume.
    @Published private(set) var resumableOrigin: String?

    func connect(_ pairing: LANPairing) async {
        guard !busy else { return }
        revision = UUID()
        let current = revision
        busy = true; notice = nil
        defer { if revision == current { busy = false } }
        do {
            let result = try await client.connect(pairing)
            if revision == current {
                snapshot = result; checkedAt = Date(); resumableOrigin = pairing.origin
                UserDefaults.standard.set(pairing.origin, forKey: Self.originKey)
            }
        } catch { if revision == current { snapshot = nil; notice = message(error) } }
    }

    /// Come back to the Mac we already paired with. The QR is single use, so before this a screen
    /// lock cost a walk to the Mac; the host keeps the session for 30 days precisely for this.
    func resume() async {
        guard !busy, snapshot == nil, let origin = resumableOrigin ?? storedOrigin() else { return }
        revision = UUID()
        let current = revision
        busy = true
        defer { if revision == current { busy = false } }
        do {
            let result = try await client.resume(origin: origin)
            if revision == current { snapshot = result; checkedAt = Date(); resumableOrigin = origin; notice = nil }
        } catch {
            guard revision == current else { return }
            // Only say something when the session is genuinely over. A Mac that is asleep or off
            // this network will work later, and an error banner on every app switch is noise.
            if let failure = error as? RemoteFailure, failure.endsStoredSession {
                resumableOrigin = nil
                UserDefaults.standard.removeObject(forKey: Self.originKey)
                notice = failure.errorDescription
            }
        }
    }

    private static let originKey = "agentstoz.lan.origin"
    private func storedOrigin() -> String? {
        let value = UserDefaults.standard.string(forKey: Self.originKey)
        // The address is not a secret, but it decides where the app will connect: only accept one
        // that still parses as a private LAN origin.
        guard let value, LANClient.resumableOrigin(value) else { return nil }
        return value
    }

    func refresh(loadMore: Bool = false) async {
        guard !busy, snapshot != nil else { return }
        let current = revision
        busy = true
        defer { if revision == current { busy = false } }
        do {
            let result = try await client.refresh(loadMore: loadMore)
            if revision == current { snapshot = result; checkedAt = Date() }
        } catch { if revision == current { snapshot = keepList(error) ? snapshot : nil; notice = message(error) } }
    }

    func perform(_ action: ProjectAction, project: RemoteProject) async {
        guard !busy else { return }
        let current = revision
        busy = true; notice = nil
        defer { if revision == current { busy = false } }
        do {
            try await client.perform(action, controlID: project.id)
            let result = try await client.refresh()
            if revision == current { snapshot = result; checkedAt = Date(); notice = "\(project.name): \(action.label) 요청을 처리했습니다." }
        } catch { if revision == current { snapshot = keepList(error) ? snapshot : nil; notice = message(error) } }
    }

    /// Leaving the foreground is not leaving the session. The socket goes; the right to come back
    /// stays, which is the whole point of the host keeping a session across a plain close.
    func suspend() async {
        revision = UUID()
        let current = revision
        snapshot = nil; checkedAt = nil
        await client.suspend()
        if revision == current { busy = false }
    }

    /// The user ending it on purpose. Tells the host with session.end so the Mac stops listing a
    /// phone that has gone, and forgets the token so the next launch does not try to resume.
    func disconnect() async {
        revision = UUID()
        let current = revision
        busy = true; snapshot = nil; checkedAt = nil
        await client.disconnect()
        if revision == current {
            busy = false
            resumableOrigin = nil
            UserDefaults.standard.removeObject(forKey: Self.originKey)
            notice = "연결을 종료했습니다. 다시 사용하려면 Mac에서 새 QR을 만들어 주세요."
        }
    }

    /// A host refusal leaves a working connection. Clearing the list would send the user back to
    /// the QR screen for something as ordinary as being asked to slow down.
    private func keepList(_ error: Error) -> Bool { (error as? RemoteFailure)?.keepsSession ?? false }

    private func message(_ error: Error) -> String {
        (error as? RemoteFailure)?.errorDescription ?? "연결 상태를 확인해 주세요."
    }
}
