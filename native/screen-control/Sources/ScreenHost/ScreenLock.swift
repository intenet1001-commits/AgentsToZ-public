#if os(macOS)
import CoreGraphics
import Foundation
import os

/// Whether this Mac's screen is locked, as the system reports it (DESIGN 「잠김 상태 배너」). A version-2 phone shows it
/// outside the picture, so a lock screen some process draws on the Mac is not taken for the real one. Reads the login
/// session's state and listens for the system's lock and unlock announcements; no permission is needed.
public enum ScreenLock {
    /// Locked now; nil when there is no login session to ask (no one logged in at the console).
    public static var isLocked: Bool? {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
        return (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
    }

    /// The state now when it is known, then each change the system announces, until the consumer stops reading.
    public static func states() -> AsyncStream<Bool> {
        AsyncStream(bufferingPolicy: .bufferingNewest(4)) { continuation in
            let center = DistributedNotificationCenter.default()
            let observers = [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)].map { name, locked in
                center.addObserver(forName: Notification.Name(name), object: nil, queue: nil) { _ in continuation.yield(locked) }
            }
            let held = OSAllocatedUnfairLock(uncheckedState: observers)
            continuation.onTermination = { _ in
                held.withLockUnchecked { observers in
                    observers.forEach { DistributedNotificationCenter.default().removeObserver($0) }
                    observers.removeAll()
                }
            }
            if let now = isLocked { continuation.yield(now) }
        }
    }
}
#endif
