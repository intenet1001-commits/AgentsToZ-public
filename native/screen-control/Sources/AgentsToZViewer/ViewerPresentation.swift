#if os(macOS)
import AppKit

/// Opens read-only lists or an enrollment guide. It cannot make a HumanProof. Protected actions keep HumanButton.
@MainActor
final class PresentationButton: NSButton {
    private let handler: () -> Void
    init(title: String, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(frame: .zero)
        self.title = title
        bezelStyle = .rounded
        if title == "닫기" || title == "그만두기" { keyEquivalent = "\u{1b}" }
        target = self
        action = #selector(present(_:))
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }
    @objc private func present(_ sender: Any?) { handler() }
}
#endif
