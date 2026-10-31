// Local physical-device acceptance fixture. No network, account, clipboard or real project data.
import AppKit
import SystemConfiguration

final class FlippedDocument: NSView { override var isFlipped: Bool { true } }

@MainActor final class Fixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var field: NSTextField!
    private var summary: NSTextField!
    private var scroll: NSScrollView!
    private var clickCount = 0
    private var history: [[String: Any]] = []
    private var targets: [String: [Double]] = [:]
    private var targetViews: [String: NSView] = [:]
    private var display: NSScreen!
    private let receipt = URL(fileURLWithPath: "/tmp/agentstoz-physical-controls-events.json")

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.screens.first else { return }
        display = screen
        window = NSWindow(contentRect: screen.visibleFrame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.delegate = self
        window.title = "AgentsToZ 입력 실기 검사"
        window.level = .floating
        window.isMovable = false
        window.setFrame(screen.visibleFrame, display: true)
        let root = window.contentView!, size = root.bounds.size
        summary = NSTextField(labelWithString: "iPad에서 실제 클릭·한글 입력·상하좌우 스크롤을 검사합니다")
        summary.frame = NSRect(x: 40, y: size.height - 76, width: size.width - 80, height: 60)
        summary.font = .systemFont(ofSize: 24)
        root.addSubview(summary)
        let button = NSButton(title: "iPad 클릭 검사", target: self, action: #selector(clicked))
        button.frame = NSRect(x: 40, y: size.height - 165, width: 300, height: 70)
        button.font = .systemFont(ofSize: 26)
        root.addSubview(button)
        field = NSTextField(frame: NSRect(x: 40, y: size.height - 240, width: 700, height: 55))
        field.placeholderString = "iPad 텍스트 입력: 한글입력 ipad-OK"
        field.font = .systemFont(ofSize: 28)
        field.delegate = self
        root.addSubview(field)
        scroll = NSScrollView(frame: NSRect(x: 40, y: 40, width: size.width - 80, height: size.height - 330))
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let document = FlippedDocument(frame: NSRect(x: 0, y: 0, width: 5000, height: 4000))
        for y in 0..<12 {
            for x in 0..<10 {
                let label = NSTextField(labelWithString: "행 \(y) · 열 \(x)")
                label.frame = NSRect(x: x * 400 + 30, y: y * 280 + 30, width: 320, height: 180)
                label.font = .systemFont(ofSize: 38)
                label.drawsBackground = true
                label.backgroundColor = (x + y).isMultiple(of: 2) ? .systemTeal.withAlphaComponent(0.2) : .systemOrange.withAlphaComponent(0.2)
                document.addSubview(label)
            }
        }
        scroll.documentView = document
        root.addSubview(scroll)
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let menu = NSMenu()
        let item = NSMenuItem(title: "시험", action: nil, keyEquivalent: "")
        let submenu = NSMenu(title: "시험")
        let fit = NSMenuItem(title: "시험 창을 화면에 맞추기", action: #selector(fitToScreen), keyEquivalent: "0")
        fit.target = self
        submenu.addItem(fit)
        submenu.addItem(NSMenuItem(title: "시험 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        item.submenu = submenu
        menu.addItem(item)
        NSApp.mainMenu = menu
        targetViews = ["click": button, "text": field, "scroll": scroll]
        write("ready")
        // Show this owned test fixture once after launch preparation. Do not keep moving the window
        // or override subsequent user input. An app-only screenshot is not proof of desktop visibility.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.fitToScreen() }
    }

    @objc private func clicked() { clickCount += 1; write("click") }
    @objc private func fitToScreen() {
        window.setFrame(display.visibleFrame, display: true)
        NSApp.unhide(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        write("window-fit")
    }
    func windowDidMove(_ notification: Notification) { write("window-move") }
    func windowDidResize(_ notification: Notification) { write("window-resize") }
    func controlTextDidChange(_ notification: Notification) { write("text") }
    @objc private func scrolled() { write("scroll") }
    private func write(_ kind: String) {
        guard let screen = display, let scroll else { return }
        for (name, view) in targetViews {
            let point = window.convertPoint(toScreen: view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil))
            targets[name] = [(point.x - screen.frame.minX) / screen.frame.width,
                             1 - (point.y - screen.frame.minY) / screen.frame.height]
        }
        let origin = scroll.contentView.bounds.origin
        history.append(["kind": kind, "x": origin.x, "y": origin.y, "clicks": clickCount])
        history = Array(history.suffix(40))
        let data: [String: Any] = ["clicks": clickCount, "text": field.stringValue, "x": origin.x, "y": origin.y,
                                  "macName": (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? "Mac",
                                  "windowFrame": NSStringFromRect(window.frame),
                                  "screenFrame": NSStringFromRect(screen.frame),
                                  "visibleFrame": NSStringFromRect(screen.visibleFrame),
                                  "history": history, "targets": targets, "aspect": screen.frame.width / screen.frame.height]
        if let json = try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]) { try? json.write(to: receipt, options: .atomic) }
        summary.stringValue = "클릭 \(clickCount) · 입력: \(field.stringValue) · 스크롤 x=\(Int(origin.x)) y=\(Int(origin.y))"
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main struct FixtureMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let fixture = Fixture()
        app.setActivationPolicy(.regular)
        app.delegate = fixture
        app.run()
    }
}
