// Human-run S-M3 diagnostic only. No Screen/Viewer session, event injection, capture, global monitor,
// keychain access, networking, TCC request, or automatic calibration change. Build alone never opens this window.
#if os(macOS)
import AppKit
import ScreenControlCore

@MainActor
final class ProbePad: NSView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("입력 출처 시험 영역")
        setAccessibilityHelp("기록 중 이 영역을 클릭한 뒤 안전한 키나 포인터 입력을 시험하세요.")
    }
    required init?(coder: NSCoder) { super.init(coder: coder) }
    override var acceptsFirstResponder: Bool { true }
    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self) }
    override func keyDown(with event: NSEvent) {} // Never interpret or retain typed characters.
    override func keyUp(with event: NSEvent) {}
    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill(); bounds.fill()
        ("시험 영역 · 여기를 클릭한 뒤 입력하세요" as NSString).draw(in: bounds.insetBy(dx: 16, dy: 20),
            withAttributes: [.font: NSFont.systemFont(ofSize: 16), .foregroundColor: NSColor.labelColor])
    }
}

@MainActor
final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var probe = InputOriginProbe()
    private var window: NSWindow?
    private var monitor: Any?
    private var collecting = false
    private var lastStatusAt = 0.0
    private let sources = NSPopUpButton(frame: .zero, pullsDown: false)
    private let status = NSTextField(wrappingLabelWithString: "출처를 고르고 기록 시작을 누르세요.")
    private let toggle = NSButton(title: "기록 시작", target: nil, action: nil)
    private let pad = ProbePad()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 620),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        self.window = window
        window.title = "AgentsToZ · 입력 출처 실측 준비"
        window.isReleasedWhenClosed = false
        let title = NSTextField(labelWithString: "S-M3 입력 출처 진단 · 권한 변경 없음")
        title.font = .boldSystemFont(ofSize: 19)
        let description = NSTextField(wrappingLabelWithString:
            "사람이 이 창에서 직접 시험합니다. PID·키보드 타입·소스 상태·입력 종류의 집계만 저장합니다. " +
            "입력 글자, 키 코드, 좌표, 화면은 저장하지 않습니다. 이 도구는 원격 연결이나 입력 전송을 하지 않습니다.")
        let labels = ["실제 키보드", "실제 마우스/트랙패드", "다른 프로세스 합성 입력", "AgentsToZ Screen 주입",
                      "Jump Desktop", "Apple 화면 공유", "가상 HID / 한글 중계 도구"]
        sources.addItems(withTitles: labels)
        let target = NSTextField(wrappingLabelWithString:
            "기록 중에는 이 창을 클릭하거나 안전한 키를 눌러 주세요. 다른 앱이나 창의 입력은 관찰하지 않습니다. " +
            "출처 표시는 시험자가 선택한 라벨이며 신원 증명이 아닙니다.")
        toggle.target = self; toggle.action = #selector(toggleRecording)
        let save = NSButton(title: "기록 중지 후 JSON 저장…", target: self, action: #selector(saveReport))
        let buttons = NSStackView(views: [toggle, save])
        buttons.orientation = .horizontal; buttons.spacing = 12
        let stack = NSStackView(views: [title, description, sources, target, pad, buttons, status])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
            pad.widthAnchor.constraint(equalTo: stack.widthAnchor), pad.heightAnchor.constraint(equalToConstant: 80),
            description.widthAnchor.constraint(equalTo: stack.widthAnchor),
            target.widthAnchor.constraint(equalTo: stack.widthAnchor), status.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged, .leftMouseDown,
            .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .scrollWheel]) { [weak self] event in
            nonisolated(unsafe) let event = event
            MainActor.assumeIsolated { self?.record(event) }
            return event
        }
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func record(_ event: NSEvent) {
        guard collecting, event.window === window, window?.isKeyWindow == true,
              InputOriginProbe.Source.allCases.indices.contains(sources.indexOfSelectedItem) else { return }
        // Configuration clicks must never be labelled as synthetic/remote samples. Observe only the dedicated pad.
        switch event.type {
        case .keyDown, .keyUp, .flagsChanged:
            guard window?.firstResponder === pad else { return }
        default:
            guard pad.bounds.contains(pad.convert(event.locationInWindow, from: nil)) else { return }
        }
        let source = InputOriginProbe.Source.allCases[sources.indexOfSelectedItem]
        let kind: ScreenInputEvent.Kind
        switch event.type {
        case .keyDown: kind = .keyDown
        case .keyUp: kind = .keyUp
        case .leftMouseDown: kind = .leftMouseDown
        case .leftMouseUp: kind = .leftMouseUp
        default: kind = .other
        }
        let sample = event.cgEvent.map {
            ScreenInputEvent(kind: kind, ageSeconds: 0,
                sourcePid: $0.getIntegerValueField(.eventSourceUnixProcessID),
                keyboardType: $0.getIntegerValueField(.keyboardEventKeyboardType),
                sourceState: $0.getIntegerValueField(.eventSourceStateID))
        }
        probe.record(source: source, event: sample)
        let now = ProcessInfo.processInfo.systemUptime
        if now - lastStatusAt >= 0.25 {
            lastStatusAt = now
            let report = probe.report
            let message = report.assessment == "ambiguous" ? "출처 구분 불가"
                : report.assessment == "incomplete" ? "표본 미완료" : "사람 검토 필요"
            status.stringValue = "집계 \(report.samples.reduce(0) { $0 + $1.count })건 · \(message) · 조작 허용 변경 없음"
        }
    }

    @objc private func toggleRecording() {
        collecting.toggle()
        sources.isEnabled = !collecting
        toggle.title = collecting ? "기록 중지" : "기록 시작"
        status.stringValue = collecting ? "선택한 출처를 시험하세요. 출처를 바꾸려면 먼저 중지하세요." : "중지했습니다. 다음 출처를 선택하거나 저장하세요."
    }

    @objc private func saveReport() {
        collecting = false; sources.isEnabled = true; toggle.title = "기록 시작"
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "agentstoz-sm3-input-metadata.json"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".agentstoz-input-probe-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            guard FileManager.default.createFile(atPath: temporary.path, contents: try encoder.encode(probe.report),
                                                 attributes: [.posixPermissions: 0o600]),
                  rename(temporary.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            status.stringValue = "진단 기록을 저장했습니다. 보정 승인·조작 허용·실기 통과를 뜻하지 않습니다."
        } catch { status.stringValue = "기록 저장 실패: 내보내기를 완료하지 못했습니다." }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        if let monitor { NSEvent.removeMonitor(monitor) }
    }
}

guard CommandLine.arguments.count == 1 else {
    FileHandle.standardError.write(Data("This human-run diagnostic accepts no command-line control options.\n".utf8))
    exit(2)
}
let delegate = ProbeDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.regular)
NSApplication.shared.run()
#endif
