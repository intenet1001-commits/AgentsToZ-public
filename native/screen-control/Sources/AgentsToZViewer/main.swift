// AgentsToZ Viewer (`com.intenet.agentstozbycs.viewer`, Mac A): sees, and with B's grant controls, a registered Mac B
// (docs/design/mac-to-mac-2026-11-01/DESIGN.md 5.1). It links ScreenControlCore only, holds no TCC permission but local
// network, and never listens. A person opens it; nothing else can start or drive a session (SR-23): no arguments are
// read, and there is no URL, AppleScript, Services or XPC entry. scripts/build-screen-app.ts (wp-viewer-build) wraps it.
#if os(macOS)
import AppKit

let delegate = ViewerAppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.regular)
NSApplication.shared.run()
#endif
