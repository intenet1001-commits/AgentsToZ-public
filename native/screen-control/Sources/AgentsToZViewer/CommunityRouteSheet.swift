#if os(macOS)
import AppKit
import ScreenControlCore

/// Opening is presentation only; saving still requires a fresh action from this Mac's own hardware.
@MainActor final class CommunityRouteSheet {
    let window: NSWindow
    private let field: NSTextField
    private let notice = NSTextField(wrappingLabelWithString: "")
    private let save: (ScreenPrivateNetworkRoute?, HumanProof) throws -> Void
    var closed: () -> Void = {}
    init(target: ViewerTarget, save: @escaping (ScreenPrivateNetworkRoute?, HumanProof) throws -> Void) {
        self.save = save; field = NSTextField(string: target.privateNetwork?.address ?? "")
        field.placeholderString = "예: 192.168.219.115"; field.setAccessibilityLabel("등록한 Mac의 사설 IPv4 주소")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 230), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "‘\(target.displayName)’ 사설망 주소"; window.isReleasedWhenClosed = false
        let description = NSTextField(wrappingLabelWithString: "Cloudflare에 등록된 이 Mac의 사설 IPv4를 입력하세요. 주소를 바꿔도 등록한 Mac의 키를 확인합니다. 비우면 주소를 지웁니다.")
        let submit = HumanButton(title: "주소 저장") { [weak self] proof in self?.submit(proof) }
        let cancel = PresentationButton(title: "취소") { [weak self] in self?.close() }
        let column = NSStackView(views: [description, field, notice, NSStackView(views: [submit, cancel])])
        column.orientation = .vertical; column.alignment = .leading; column.spacing = 12
        column.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        for view in [description, field, notice] { view.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -40).isActive = true }
        window.contentView = column
    }
    func begin(on parent: NSWindow) { parent.beginSheet(window) }
    func close() { window.sheetParent?.endSheet(window); window.orderOut(nil); closed() }
    private func submit(_ proof: HumanProof) {
        do {
            let raw = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            try save(raw.isEmpty ? nil : ScreenPrivateNetworkRoute(address: raw), proof); close()
        } catch { notice.stringValue = "올바른 사설 IPv4 주소와 현재 커뮤니티 등록을 확인해 주세요." }
    }
}
#endif
