#if os(macOS)
import AppKit
import ScreenControlCore

// AgentsToZ Viewer's application (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.1). It has no entry point but a person
// opening it: no URL types, documents, Services, AppleScript or XPC, and it reads no command-line argument (SR-32). A
// session ends at once when this Mac locks, sleeps or switches users, and nothing reconnects by itself.

@MainActor
final class ViewerAppDelegate: NSObject, NSApplicationDelegate {
    private var list: TargetListController?
    private let community = ViewerCommunityAccount()
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = Self.mainMenu()
        let list = TargetListController(ledger: ViewerTargetsLedger(backend: KeychainTargets()), communityAccount: community)
        self.list = list
        HumanActions.shared.refused = { [weak self] reason in self?.tellNotInFront(reason) }
        watchSessionGuards()
        list.show()
        // LaunchServices' activate choice is respected; Screen may prepare only the signed directory in the background.
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows:Bool)->Bool {list?.show();return false}

    func applicationWillTerminate(_ notification: Notification) {
        community.stop()
        list?.active?.session.end(.here)
        for (center, observer) in observers { center.removeObserver(observer) }
    }

    /// A control ran by anything but this Mac's hardware: say so where the person looks.
    private func tellNotInFront(_ reason: ScreenInputRefusal) {
        if let active = list?.active, active.window.window.isKeyWindow {
            active.window.showNotInFront()
        } else {
            list?.tellNotInFront(reason)
        }
    }

    /// This Mac's lock, sleep and fast user switch end the session, and call off a connection still in progress
    /// (DESIGN 5.1 세션 경비). The display going to sleep counts as sleep; while B's picture is on screen it does not
    /// sleep from idleness (SessionWindow.swift), so only a display put to sleep on purpose, or a hidden window left
    /// alone, ends the session that way.
    private func watchSessionGuards() {
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification,
                     NSWorkspace.sessionDidResignActiveNotification] {
            observers.append((workspace, workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.list?.guardTripped() }
            }))
        }
        let distributed = DistributedNotificationCenter.default()
        observers.append((distributed, distributed.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil,
                                                               queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.list?.guardTripped() }
        }))
    }

    /// Quit and Close only: both end a session, which needs no proof (DESIGN 10절: lowering is immediate from anywhere).
    private static func mainMenu() -> NSMenu {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "AgentsToZ Viewer")
        appMenu.addItem(NSMenuItem(title: "AgentsToZ Viewer 끝내기", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "윈도우")
        windowMenu.addItem(NSMenuItem(title: "닫기", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        return menu
    }
}
#endif
