import Foundation
import ApplicationServices

// Screen overlap is not ownership. Walk bounded AX ancestry and compare objects.
func belongsToWindow(_ element: UIElement, _ window: UIElement) -> Bool {
    if CFEqual(element.axElement, window.axElement) { return true }
    if let owner: AXUIElement = element.attributeOptional(kAXWindowAttribute) { return CFEqual(owner, window.axElement) }
    var cursor: UIElement? = element
    for _ in 0..<32 {
        guard let current = cursor else { return false }
        if CFEqual(current.axElement, window.axElement) { return true }
        if current.role == kAXWindowRole || current.role == kAXApplicationRole { return false }
        cursor = current.parent
    }
    return false
}

func isWritableMessageInput(_ element: UIElement) -> Bool {
    guard element.role == kAXTextAreaRole || element.role == kAXTextFieldRole else { return false }
    let enabled: Bool? = element.attributeOptional(kAXEnabledAttribute)
    guard enabled != false else { return false }
    var writable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(element.axElement, kAXValueAttribute as CFString, &writable) == .success && writable.boolValue
}
