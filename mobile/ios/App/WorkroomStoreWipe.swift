import Foundation
import WebKit

/// 「이 앱의 연결 정보 지우기」 deletes a workspace's WebKit store: the Supabase sign-in (localStorage) and the
/// relay pairing vault (IndexedDB). `WKWebsiteDataStore.remove(forIdentifier:)` refuses with "Data store is in
/// use" while a web view still holds the store — which is exactly when the button runs — and that error used to
/// be ignored, so nothing was deleted and reopening the same portal came back signed in and paired.
///
/// Measured on macOS WebKit 26 (same engine and API as iOS), w5-ios probe 2026-10-16:
/// - deleting every record of the live store works while the page is still open;
/// - removing the store succeeds about 0.1 s after the web view is released, and keeps failing while it is not.
/// So: clear the live store, release the web view, remove the store with a bounded retry, and report which of
/// those happened. Only Foundation and WebKit here, so the macOS probe compiles this very file.
@MainActor enum WorkroomStoreWipe {
    static let types = WKWebsiteDataStore.allWebsiteDataTypes()
    /// About 6.3 s in all.
    nonisolated static let retryDelays: [Duration] = [.zero, .milliseconds(100), .milliseconds(200), .milliseconds(400),
                                          .milliseconds(800), .milliseconds(1200), .milliseconds(1600), .milliseconds(2000)]

    /// Step 1, while the page may still be open. Returns how many records are left (0: everything was deleted).
    static func clearLive(_ store: WKWebsiteDataStore) async -> Int {
        await store.removeData(ofTypes: types, modifiedSince: .distantPast)
        return await store.dataRecords(ofTypes: types).count
    }

    /// Step 2, after the web view and every reference to its store are gone. `true` when the store was removed.
    static func remove(_ identifier: UUID, delays: [Duration] = retryDelays) async -> Bool {
        for delay in delays {
            if delay > .zero { try? await Task.sleep(for: delay) }
            do { try await WKWebsiteDataStore.remove(forIdentifier: identifier); return true } catch {}
        }
        return false
    }

    /// A store that could not be removed is removed at the next launch, before any workspace page exists; until then
    /// a connection to the same workspace uses a fresh in-memory store instead of reviving it.
    static let pendingKey = "agentstoz.workroom.pendingWipe"

    static func rememberPending(_ identifier: UUID, defaults: UserDefaults = .standard) {
        let pending = Set(defaults.stringArray(forKey: pendingKey) ?? []).union([identifier.uuidString])
        defaults.set(Array(pending).sorted().prefix(16).map { $0 }, forKey: pendingKey)
    }

    static func isPending(_ identifier: UUID, defaults: UserDefaults = .standard) -> Bool {
        (defaults.stringArray(forKey: pendingKey) ?? []).contains(identifier.uuidString)
    }

    static func purgePending(defaults: UserDefaults = .standard) async {
        for value in defaults.stringArray(forKey: pendingKey) ?? [] {
            guard let identifier = UUID(uuidString: value) else { forgetPending(value, defaults: defaults); continue }
            if await remove(identifier, delays: [.zero]) { forgetPending(value, defaults: defaults) }
        }
    }

    private static func forgetPending(_ value: String, defaults: UserDefaults) {
        let left = (defaults.stringArray(forKey: pendingKey) ?? []).filter { $0 != value }
        if left.isEmpty { defaults.removeObject(forKey: pendingKey) } else { defaults.set(left, forKey: pendingKey) }
    }
}
