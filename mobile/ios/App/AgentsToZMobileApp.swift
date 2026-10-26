import SwiftUI

@main struct AgentsToZMobileApp: App {
    // push hook: notifications and remote stop (ScreenPushRegistration.swift); does nothing without a push endpoint.
    @UIApplicationDelegateAdaptor(ScreenPushAppDelegate.self) private var screenPush

    var body: some Scene {
        WindowGroup { RemoteHomeView().screenPushTaps() } // push hook
    }
}
