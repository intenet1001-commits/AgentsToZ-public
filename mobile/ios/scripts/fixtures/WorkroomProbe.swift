// Test executable only. Compiled into a disposable simulator app by check-workroom.ts.
// Uses the shipped container + actual Mac-served DOM; no test hooks ship in the app.
import SwiftUI
import WebKit
import AgentsToZCore

@MainActor final class WorkroomProbe: ObservableObject {
    @Published var session: LANWorkroomSession?
    private var checks: [String] = []
    private var stage = "startup"
    private let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    private func report(_ current: String, done: Bool = false, failed: Bool = false) throws {
        stage = current
        let data = try JSONSerialization.data(withJSONObject: ["stage":current,"checks":checks,"done":done,"failed":failed])
        try data.write(to: documents.appendingPathComponent("result.json"), options: .atomic)
    }
    private func check(_ value: Bool, _ label: String) throws {
        guard value else { throw NSError(domain: "Fixture", code: 1) }
        checks.append(label)
    }
    private func pause() async throws { try await Task.sleep(for: .milliseconds(100)) }
    private func js(_ script: String) async throws -> Bool {
        guard let web = session?.webView, session?.ended == nil else { throw NSError(domain: "Fixture", code: 2) }
        return try await web.evaluateJavaScript(script) as? Bool ?? false
    }
    private func waitJS(_ script: String, label: String) async throws {
        try report(label)
        for _ in 0..<220 { if try await js(script) { return }; try await pause() }
        throw NSError(domain: "Fixture", code: 3)
    }
    private func command(_ expected: String) async throws -> [String:String] {
        for _ in 0..<240 {
            if let data = try? Data(contentsOf: documents.appendingPathComponent("command.json")),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String:String], parsed["stage"] == expected { return parsed }
            try await pause()
        }
        throw NSError(domain: "Fixture", code: 4)
    }
    func run() async {
        do {
            let data = try Data(contentsOf: Bundle.main.url(forResource: "bootstrap", withExtension: "json")!)
            let bootstrap = try JSONSerialization.jsonObject(with: data) as! [String:String]
            session = LANWorkroomSession(pairing: try LANPairing(scanned: bootstrap["pairingURL"]!))
            try await waitJS("Boolean(document.querySelector('#terminal-panel') && !document.querySelector('#terminal-panel').hidden)", label: "lan-connected")
            try check(try await js("location.hash === '' && document.querySelector('#terminal-project').options.length === 2"), "fragment-cleared-and-projects")
            try check(session!.webView!.configuration.websiteDataStore.isPersistent, "durable-origin-isolated-webview")
            session?.selectTab("workroom")
            _ = try await js("document.querySelector('#terminal-refresh').click(); true")
            try await waitJS("document.querySelector('#terminal-error').textContent.includes('허용')", label: "opt-in-required")
            try check(true, "terminal-denied-before-opt-in")
            try report("grant-request")
            _ = try await command("granted")
            _ = try await js("document.querySelector('#terminal-panel').scrollIntoView(); document.querySelector('#terminal-project').selectedIndex=1; document.querySelector('#terminal-project').dispatchEvent(new Event('change')); document.querySelector('#terminal-agent').value='claude'; document.querySelector('#terminal-start').click(); document.querySelector('#terminal-start').click(); true")
            try await waitJS("document.querySelector('#terminal-session').value !== '' && document.querySelector('.xterm-rows').textContent.includes('REMOTE_READY')", label: "terminal-started")
            try check(try await js("document.querySelector('#terminal-session').options.length === 2 && document.querySelector('#terminal-session').selectedOptions[0].text.includes('claude')"), "selected-agent-and-single-start")
            _ = try await js("document.querySelector('#terminal-line').value='keep this draft'; document.querySelector('#terminal-line').dispatchEvent(new Event('input')); document.querySelector('#terminal-remember').click(); true")
            try check(try await js("document.querySelector('#terminal-line').value === 'keep this draft'"), "existing-draft-preserved")
            _ = try await js("document.querySelector('#terminal-line').value=''; document.querySelector('#terminal-line').dispatchEvent(new Event('input')); document.querySelector('#terminal-remember').click(); document.querySelector('#terminal-remember').click(); true")
            try check(try await js("document.querySelector('#terminal-line').value.includes('remember-session') && !document.querySelector('#terminal-memory-guide').hidden"), "manual-memory-draft-only")
            try await Task.sleep(for: .milliseconds(500))
            try check(try await js("Math.abs((window.visualViewport?.scale || 1)-1) < 0.05 && document.documentElement.scrollWidth <= innerWidth+1"), "focused-draft-keeps-mobile-viewport")
            try report("memory-draft-ready")
            _ = try await command("draft-checked")
            _ = try await js("document.querySelector('#terminal-line').value='native-safe-fixture'; document.querySelector('#terminal-line').dispatchEvent(new Event('input')); document.querySelector('#terminal-send').click(); document.querySelector('#terminal-send').click(); true")
            // xterm intentionally defers painting an offscreen terminal. The iOS
            // keyboard moves this output below the viewport after editing the line.
            _ = try await js("document.activeElement?.blur(); document.querySelector('#terminal-screen').scrollIntoView(); true")
            session?.webView?.endEditing(true)
            try await waitJS("document.querySelector('.xterm-rows').textContent.includes('RESULT:native-safe-fixture')", label: "terminal-input-output")
            try check(try await js("document.querySelector('#terminal-line').value === ''"), "input-receipt-clears-sent-draft")
            _ = try await js("document.querySelector('#terminal-close').click(); document.querySelector('#terminal-close').click(); true")
            try await waitJS("document.querySelector('#terminal-session').value === '' && document.querySelector('#terminal-session').textContent.includes('exited')", label: "explicit-stop")
            try check(true, "explicit-stop-completed")
            _ = try await js("document.querySelector('#terminal-agent').value='codex'; document.querySelector('#terminal-start').click(); true")
            try await waitJS("document.querySelector('#terminal-session').value !== '' && document.querySelector('.xterm-rows').textContent.includes('REMOTE_READY')", label: "second-session")
            let foreign = try String(data: JSONSerialization.data(withJSONObject: [bootstrap["foreignURL"]!]), encoding: .utf8)!
            _ = try await js("localStorage.setItem('fixture-private-state','not persistent'); document.querySelector('#terminal-screen').scrollIntoView(); window.open(" + foreign + "[0]); true")
            _ = try await js("location.href=" + foreign + "[0]; true")
            try await Task.sleep(for: .milliseconds(350))
            try check(try await js("document.querySelector('#terminal-panel') !== null && location.pathname === '/remote/'"), "foreign-navigation-and-popup-blocked")
            _ = try await js("document.activeElement?.blur(); document.querySelector('#terminal-panel').scrollIntoView(); true")
            session?.webView?.endEditing(true)
            try await Task.sleep(for: .milliseconds(600))
            try check(try await js("Math.abs((window.visualViewport?.scale || 1)-1) < 0.05 && document.documentElement.scrollWidth <= innerWidth+1"), "blur-keeps-controls-in-mobile-viewport")
            let rememberedSession = try await session!.webView!.evaluateJavaScript("document.querySelector('#terminal-session').value") as! String
            let rememberedLiteral = String(data: try JSONSerialization.data(withJSONObject: [rememberedSession]), encoding: .utf8)!
            let originalWeb = session?.webView
            let originalOwner = session?.id
            session?.selectTab("projects")
            try check(try await js("document.body.dataset.workspaceTab === 'projects' && getComputedStyle(document.querySelector('#terminal-panel')).display === 'none'"), "native-project-tab-hides-terminal-without-teardown")
            session?.selectTab("workroom")
            try check(try await js("document.body.dataset.workspaceTab === 'workroom' && getComputedStyle(document.querySelector('#terminal-panel')).display !== 'none'"), "native-workroom-tab-restores-same-terminal")
            try check(session?.webView === originalWeb && session?.id == originalOwner, "iosRemoteWorkspace_tabSwitch_reusesOneConnection")
            try report("visible-workroom")
            _ = try await command("screenshot-taken")
            // Runner brings Settings forward and returns. The production hook must keep
            // the same document and owner, rather than demanding a consumed QR again.
            try check(session?.ended == nil && session?.webView === originalWeb, "background-retains-single-workspace")
            try check(try await js("localStorage.getItem('fixture-private-state') !== null"), "background-preserves-origin-store")
            let sameOrigin = session!.origin
            // Simulate process teardown without an explicit user disconnect/revocation.
            session?.end(.disconnected)
            session = LANWorkroomSession(resuming: sameOrigin)
            try await waitJS("document.querySelector('#connection')?.textContent === '연결됨'", label: "cold-resume-without-qr")
            try check(try await js("location.hash === '' && localStorage.getItem('fixture-private-state') !== null"), "cold-resume-retains-session-store-without-pair-token")
            try await waitJS("document.querySelector('#terminal-session')?.value === " + rememberedLiteral + "[0]", label: "cold-terminal-reattached")
            try check(try await js("document.querySelector('#terminal-project').selectedOptions[0].text.includes('Fixture project B') && document.querySelector('#terminal-agent').value === 'codex'"), "cold-resume-retains-exact-project-agent-and-existing-session")
            try report("resumed")
            _ = try await command("disconnect-now")
            await session?.disconnect()
            try check(session?.disconnectConfirmed == true, "native-disconnect-awaits-host-acknowledgement")
            try report("client-disconnected")
            let fresh = try await command("fresh-qr")
            session = LANWorkroomSession(pairing: try LANPairing(scanned: fresh["pairingURL"]!))
            try await waitJS("Boolean(document.querySelector('#terminal-panel') && !document.querySelector('#terminal-panel').hidden)", label: "fresh-reconnected")
            _ = try await js("document.querySelector('#terminal-refresh').click(); true")
            try await waitJS("document.querySelector('#terminal-error').textContent.includes('허용')", label: "fresh-opt-in-required")
            try check(true, "new-connection-cannot-reuse-old-opt-in")
            try report("revoke-request")
            _ = try await command("revoked")
            try await waitJS("document.querySelector('#connection').textContent === '연결 종료' && document.querySelector('#terminal-remember').disabled", label: "revoked-display")
            try check(true, "host-revocation-preserves-ended-display")
            session?.end(.disconnected)
            session = LANWorkroomSession(pairing: try LANPairing(scanned: bootstrap["redirectQR"]!))
            try report("redirect-check")
            for _ in 0..<100 { if session?.ended != nil { break }; try await pause() }
            try check(session?.ended != nil, "foreign-redirect-rejected")
            if let portalURL = bootstrap["portalURL"] {
                session?.end(.disconnected)
                session = LANWorkroomSession(internet: try InternetWorkroomAddress(scanned: portalURL))
                try await waitJS("document.querySelectorAll('.workspace-navigation button[data-workspace-tab]').length === 5", label: "portal-five-tabs")
                let portalWeb = session?.webView
                try check(try await js("window.agentstozNativeOAuth === true && Boolean(window.webkit.messageHandlers.agentstozOAuth)"), "portal-uses-native-auth-bridge")
                for tab in ["home", "projects", "workroom", "bookmarks", "records", "home"] {
                    session?.selectTab(tab)
                    try await waitJS("document.querySelector('main.remote-shell')?.dataset.workspaceTab === '" + tab + "'", label: "portal-tab-" + tab)
                    try check(session?.webView === portalWeb, "portal-" + tab + "-same-document")
                }
                _ = try await js("document.querySelector('.workspace-theme summary').click(); true")
                try check(try await js("document.querySelector('.workspace-theme').open"), "portal-theme-opens")
                _ = try await js("const b = document.querySelector('button[data-workspace-tab=bookmarks]'); b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch'})); b.click(); true")
                try await waitJS("!document.querySelector('.workspace-theme').open && document.querySelector('main.remote-shell').dataset.workspaceTab === 'bookmarks'", label: "portal-outside-closes-and-navigates")
                try check(try await js("!document.querySelector('[data-testid=remote-host-tabs]') && !document.querySelector('[data-testid=remote-portal-scan]')"), "portal-bookmarks-without-device-controls")
                try check(try await js("document.documentElement.scrollWidth <= innerWidth + 1"), "portal-fits-native-viewport")
                session?.selectTab("home")
                try await waitJS("document.querySelector('main.remote-shell').dataset.workspaceTab === 'home'", label: "portal-home-restored")
                try report("portal-visible")
                _ = try await command("portal-returned")
                try check(session?.webView === portalWeb && session?.ended == nil, "portal-background-keeps-workspace")
                let portalOrigin = session!.origin
                session?.end(.disconnected)
                session = LANWorkroomSession(resuming: portalOrigin)
                try await waitJS("document.querySelectorAll('.workspace-navigation button[data-workspace-tab]').length === 5", label: "portal-cold-reopen")
                try check(try await js("window.agentstozNativeOAuth === true && location.hash === ''"), "portal-cold-reopen-without-qr")
            }
            try report("complete", done: true)
        } catch {
            // Only fixed booleans; no errors, URLs, DOM content or QR values.
            if let web = session?.webView,
               let diagnostic = try? await web.evaluateJavaScript("JSON.stringify({selected:Boolean(document.querySelector('#terminal-session')?.value),hasError:Boolean(document.querySelector('#terminal-error')?.textContent),ready:Boolean(document.querySelector('.xterm-rows')?.textContent.includes('REMOTE_READY')),rows:Boolean(document.querySelector('.xterm-rows')),targetError:Boolean(document.querySelector('#terminal-error')?.textContent.includes('프로젝트'))})") as? String {
                try? Data(diagnostic.utf8).write(to: documents.appendingPathComponent("diagnostic.json"))
            }
            try? report(stage, done: true, failed: true)
        }
    }
}
@main struct WorkroomProbeApp: App {
    @StateObject private var probe = WorkroomProbe()
    var body: some Scene {
        WindowGroup {
            Group {
                if let session = probe.session { LANWorkroomView(session: session, onReconnect: {}, onDone: {}) }
                else { ProgressView("격리 워크룸 검증") }
            }.task { await probe.run() }
        }
    }
}
