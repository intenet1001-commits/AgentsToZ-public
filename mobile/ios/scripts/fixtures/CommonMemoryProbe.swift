import SwiftUI
import WebKit
import AgentsToZCore

@MainActor final class CommonMemoryProbe: ObservableObject {
    @Published var session: LANWorkroomSession?
    var keyboardShown = false
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    func report(_ stage: String, done: Bool = false) async throws {
        guard let web = session?.webView else { throw NSError(domain: "Probe", code: 1) }
        let geometry = try await web.evaluateJavaScript("JSON.stringify({width:innerWidth,height:innerHeight,scale:visualViewport?.scale,secure:isSecureContext,randomUUID:typeof crypto.randomUUID,subtle:typeof crypto.subtle,scrollWidth:document.documentElement.scrollWidth,inputSizes:Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=radio]),textarea,select')).filter(e=>e.getClientRects().length).map(e=>parseFloat(getComputedStyle(e).fontSize))})") as! String
        let value: [String: Any] = ["stage": stage, "done": done, "keyboardShown": keyboardShown, "geometry": geometry]
        try JSONSerialization.data(withJSONObject: value).write(to: documents.appendingPathComponent("common-result.json"), options: .atomic)
        if let window = web.window {
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            try image.pngData()?.write(to: documents.appendingPathComponent("common-" + stage + ".png"))
        }
    }
    func run() async {
        do {
            let data = try Data(contentsOf: Bundle.main.url(forResource: "bootstrap", withExtension: "json")!)
            let bootstrap = try JSONSerialization.jsonObject(with: data) as! [String: String]
            session = LANWorkroomSession(pairing: try LANPairing(scanned: bootstrap["pairingURL"]!))
            session?.webView?.isInspectable = true // This isolated fixture alone is inspected by Appium.
            for _ in 0..<300 {
                if let web = session?.webView, (try? await web.evaluateJavaScript("Boolean(document.querySelector('[data-testid=common-memory-panel]'))")) as? Bool == true { break }
                try await Task.sleep(for: .milliseconds(100))
            }
            try await report("ready")
            for _ in 0..<2400 {
                if FileManager.default.fileExists(atPath: documents.appendingPathComponent("common-done.json").path) { try await report("complete", done: true); return }
                try await report("running")
                try await Task.sleep(for: .seconds(1))
            }
            try await report("timeout")
        } catch {
            try? JSONSerialization.data(withJSONObject: ["stage": "failed", "failed": true, "error": String(describing: error)]).write(to: documents.appendingPathComponent("common-result.json"), options: .atomic)
        }
    }
}
@main struct CommonMemoryProbeApp: App {
    @StateObject var probe = CommonMemoryProbe()
    var body: some Scene { WindowGroup {
        Group { if let session = probe.session { LANWorkroomView(session: session, onReconnect: {}, onDone: {}) } else { Text("공통기억 실기 시험 준비") } }
            .task { await probe.run() }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in probe.keyboardShown = true }
    } }
}
