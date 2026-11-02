import AppKit

// Renders the session bar offscreen for every state, as evidence and as a check (scripts/check-screen-control.ts).
// Compiled as one module with Sources/AgentsToZScreen/ScreenSessionBarView.swift and
// Sources/ScreenHost/ScreenSessionBarModel.swift, so it draws what the app draws: `ScreenSessionBarText.present` →
// `ScreenSessionBarView.show`. It never orders a window in (NSView.cacheDisplay draws the view where it is), never
// becomes a Dock app, and reads nothing of the Mac's sessions, keychain, screen or input.
// `render <output dir>` writes one PNG per state and `all.png`, and exits non-zero when a fixed line is cut off, a
// pill shows that the state does not offer (or hides one it does), an accessibility press runs 「다시 넘기기」, or a
// window exists.

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)

struct Case {
    let name: String
    let state: ScreenSessionBarState
    var notice: ScreenSessionBarNotice? = nil
    /// A 32-character name may be cut short in the first line; every fixed line must fit.
    var titleMayTruncate = false
}

func bar(_ access: ScreenSessionAccess, model: String = "iPhone16,2", name: String = "민수 폰", elapsed: TimeInterval = 12 * 60 + 30,
         limit: ScreenSessionLimit? = .init(kind: .idle, remaining: 48 * 60)) -> ScreenSessionBarState {
    ScreenSessionBarState(kind: ScreenDeviceKind(model: model), name: name, access: access, elapsed: elapsed, limit: limit, hotKey: "⌃⌥⌘.")
}

let cases: [Case] = [
    Case(name: "01-control-iphone", state: bar(.control(.flowing))),
    Case(name: "02-local-input-priority", state: bar(.control(.localActivity))),
    Case(name: "03-held-at-mac", state: bar(.control(.heldAtMac))),
    Case(name: "04-hand-back-refused", state: bar(.control(.heldAtMac)), notice: .handBackRefused(.otherProcess)),
    Case(name: "05-hand-back-remote-desktop", state: bar(.control(.heldAtMac)), notice: .handBackRefused(.remoteDesktop)),
    Case(name: "06-secure-input", state: bar(.control(.secureInput))),
    Case(name: "07-view-ipad", state: bar(.view(.session), model: "iPad14,1", name: "거실 패드")),
    Case(name: "08-view-lowered", state: bar(.view(.lowered), elapsed: 3 * 3600 + 5 * 60)),
    Case(name: "09-protection-lost", state: bar(.view(.protectionLost))),
    Case(name: "10-mac-controller", state: bar(.control(.flowing), model: "MacBookPro18,3", name: "사무실 MacBook Pro", elapsed: 48 * 60,
                                               limit: .init(kind: .maximum, remaining: 7 * 3600 + 12 * 60))),
    Case(name: "11-mac-controller-view", state: bar(.view(.session), model: "Mac14,2", name: "회의실", elapsed: 59 * 60,
                                                    limit: .init(kind: .maximum, remaining: 30))),
    Case(name: "12-long-name", state: bar(.control(.heldAtMac), name: String(repeating: "가", count: 32)), titleMayTruncate: true),
    Case(name: "13-hand-back-double-click", state: bar(.control(.heldAtMac)), notice: .handBackRefused(.repeatedClick)),
    Case(name: "14-reconnected-held", state: bar(.control(.heldAtMac), elapsed: 5)),
]

/// Records what a pill's action receives, as ScreenSessionBar's `pressed(_:)` would.
@MainActor final class Presses: NSObject {
    var actions: [(ScreenSessionBarAction?, Bool)] = []
    var refused = 0
    @objc func pressed(_ sender: ScreenSessionBarView.PillButton) { actions.append((sender.barAction, sender.tracksOwnMouseDown)) }
}

/// An accessibility press (osascript `click button`, an AI's AXPress) never runs 「다시 넘기기」: the pill refuses it before
/// any action and reports it, while the pills that only take input away still run (SR-29, review F2). No window: the
/// press goes to the pill object.
@MainActor func accessibilityPressFailures() -> [String] {
    var failures: [String] = []
    let view = ScreenSessionBarView(frame: NSRect(origin: .zero, size: ScreenSessionBarView.size))
    let presses = Presses()
    for pill in view.pills.values {
        pill.target = presses
        pill.action = #selector(Presses.pressed(_:))
        pill.refusedAccessibilityPress = { presses.refused += 1 }
    }
    view.show(ScreenSessionBarText.present(bar(.control(.heldAtMac))))
    if view.pills[.handBack]?.accessibilityPerformPress() != false { failures.append("accessibility press: 다시 넘기기 accepted it") }
    if !presses.actions.isEmpty { failures.append("accessibility press: 다시 넘기기 ran its action") }
    if presses.refused != 1 { failures.append("accessibility press: 다시 넘기기 refusal not reported (\(presses.refused))") }
    _ = view.pills[.viewOnly]?.accessibilityPerformPress()
    if presses.actions.count != 1 || presses.actions.first?.0 != .viewOnly {
        failures.append("accessibility press: 보기만 did not run (\(presses.actions.map { $0.0?.rawValue ?? "-" }))")
    } else if presses.actions.first?.1 != false {
        failures.append("accessibility press: a pill read as tracking its own mouse-down without one")
    }
    if presses.refused != 1 { failures.append("accessibility press: 보기만 was refused") }
    return failures
}

let failures: [String] = MainActor.assumeIsolated {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.prohibited)
    try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    var failures: [String] = []
    var images: [(String, NSBitmapImageRep)] = []
    let pad: CGFloat = 14, scale: CGFloat = 2
    let size = ScreenSessionBarView.size
    for item in cases {
        let presentation = ScreenSessionBarText.present(item.state, notice: item.notice)
        let view = ScreenSessionBarView(frame: NSRect(origin: NSPoint(x: pad, y: pad), size: size))
        view.show(presentation)
        if view.shown != presentation { failures.append("\(item.name): the view did not take the presentation") }
        for action in ScreenSessionBarAction.allCases where (view.pills[action]?.isHidden ?? true) == presentation.actions.contains(action) {
            failures.append("\(item.name): \(action.rawValue) pill \(presentation.actions.contains(action) ? "hidden" : "shown")")
        }
        if view.pills[.end]?.hint != "⌃⌥⌘." { failures.append("\(item.name): the end pill lost the hot key") }
        // A backdrop like a desktop behind the glass, since nothing is behind an offscreen view.
        let frame = NSRect(x: 0, y: 0, width: size.width + pad * 2, height: size.height + pad * 2)
        let backdrop = NSView(frame: frame)
        backdrop.wantsLayer = true
        let gradient = CAGradientLayer()
        gradient.frame = frame
        gradient.colors = [NSColor(srgbRed: 0.23, green: 0.32, blue: 0.47, alpha: 1).cgColor,
                           NSColor(srgbRed: 0.55, green: 0.42, blue: 0.5, alpha: 1).cgColor]
        gradient.startPoint = CGPoint(x: 0, y: 0)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        backdrop.layer?.addSublayer(gradient)
        backdrop.addSubview(view)
        backdrop.layoutSubtreeIfNeeded()
        for line in view.overflowingText() where !(item.titleMayTruncate && line == presentation.title) {
            failures.append("\(item.name): cut off — \(line)")
        }
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(frame.width * scale), pixelsHigh: Int(frame.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
            failures.append("\(item.name): no bitmap"); continue
        }
        rep.size = frame.size
        backdrop.cacheDisplay(in: frame, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { failures.append("\(item.name): no PNG"); continue }
        do { try png.write(to: output.appending(path: "\(item.name).png")) } catch { failures.append("\(item.name): \(error)") }
        images.append((item.name, rep))
    }
    // One sheet with every state, top to bottom.
    if let first = images.first?.1 {
        let width = first.pixelsWide, height = first.pixelsHigh
        if let sheet = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height * images.count, bitsPerSample: 8,
                                        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                        bytesPerRow: 0, bitsPerPixel: 0),
           let context = NSGraphicsContext(bitmapImageRep: sheet) {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            for (index, image) in images.enumerated() {
                image.1.draw(in: NSRect(x: 0, y: height * (images.count - 1 - index), width: width, height: height))
            }
            NSGraphicsContext.restoreGraphicsState()
            try? sheet.representation(using: .png, properties: [:])?.write(to: output.appending(path: "all.png"))
        }
    }
    failures += accessibilityPressFailures()
    if !NSApp.windows.isEmpty { failures.append("a window was created: \(NSApp.windows.count)") }
    return failures
}

if !failures.isEmpty {
    FileHandle.standardError.write(Data((failures.joined(separator: "\n") + "\n").utf8))
    exit(1)
}
print("session bar: \(cases.count) states rendered offscreen, no fixed line cut off, accessibility press refused on 다시 넘기기, no window — \(output.path)")
