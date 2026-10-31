#if !CORE_CHECKS
import ComputerUseControlCore
#endif
import Foundation
import CryptoKit

/// `.absent` means the AX server explicitly answered noValue/attributeUnsupported.
/// It is different from an SDK omitting an attribute or a failed AX request.
enum ExactAXString: Equatable {
    case value(String), absent, failed
}

@MainActor
protocol ExactAXDriver {
    associatedtype Element: Equatable
    func window() throws -> Element
    func belongs(_ element: Element, to window: Element) -> Bool
    func string(_ name: String, of element: Element) -> ExactAXString
    func enabled(_ element: Element) -> Bool
    func settable(_ element: Element) -> Bool
    func children(_ element: Element, limit: Int) -> (elements: [Element], truncated: Bool)
    /// Refuse attached sheets or an unreadable/modal target before any mutation.
    func allowsActions(in window: Element) -> Bool
    func supportsPress(_ element: Element) -> Bool
    /// Hit test in window-relative macOS points. Never searches by text or substitutes an element.
    func hitTest(x: Double, y: Double, window: Element) -> Element?
    func setValue(_ value: String, of element: Element) -> Bool
    func press(_ element: Element) -> Bool
}

/// A bounded, exact-window tree. IDs retain the original AX object, never a label/coordinate match.
/// Secure input is rejected before reading any title, description or value from that node/subtree.
@MainActor
final class ExactAXTree<Driver: ExactAXDriver> {
    struct Entry {
        let element: Driver.Element
        let ancestors: [Driver.Element]
        let role: String
        let subrole: ExactAXString
        let label: String
        let value: String
        let valueFingerprint: SHA256.Digest
        let enabled: Bool
        let settable: Bool
        var state: String { "\(role)\u{0}\(label)\u{0}\(valueFingerprint)\u{0}\(enabled)\u{0}\(settable)" }
    }
    let driver: Driver
    private var entries: [String: Entry] = [:]
    private var root: Driver.Element?
    private var coordinateHit: Driver.Element?
    private var observedState: [String] = []
    private let elementLimit: Int
    private let childLimit: Int
    private let depthLimit: Int
    private let now: () -> TimeInterval
    private let timeLimit: TimeInterval
    private let responseByteLimit: Int

    init(driver: Driver, elementLimit: Int = 500, childLimit: Int = 100, depthLimit: Int = 12,
         timeLimit: TimeInterval = 2, responseByteLimit: Int = ControlLimits.responseBytes - 16_384,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.driver = driver; self.elementLimit = elementLimit; self.childLimit = childLimit
        self.depthLimit = depthLimit; self.timeLimit = timeLimit; self.now = now
        self.responseByteLimit = max(0, responseByteLimit)
    }
    func clear() { entries.removeAll(); root = nil; coordinateHit = nil; observedState.removeAll() }
    /// Match the host's JavaScript UTF-16 lengths without splitting emoji or a combining sequence.
    private func boundedText(_ text: String, limit: Int) -> String {
        var result = "", units = 0
        for character in text {
            let part = String(character), count = part.utf16.count
            if count > limit - units { break }
            result += part; units += count
        }
        return result
    }

    private func security(_ element: Driver.Element, window: Driver.Element) -> (String, ExactAXString)? {
        guard driver.belongs(element, to: window), case let .value(role) = driver.string("AXRole", of: element),
              !role.isEmpty, !["AXSecureTextField", "AXSheet", "AXDialog", "AXSystemDialog", "AXAlert"].contains(role) else { return nil }
        let subrole = driver.string("AXSubrole", of: element)
        guard subrole != .failed, !["AXSecureTextField", "AXSheet", "AXDialog", "AXSystemDialog", "AXAlert"].contains(where: { subrole == .value($0) }),
              driver.belongs(element, to: window) else { return nil }
        return (role, subrole)
    }
    private func read(_ element: Driver.Element, window: Driver.Element, ancestors: [Driver.Element] = []) -> Entry? {
        guard let (role, subrole) = security(element, window: window) else { return nil }
        // Never enter menu/application-scoped or protected subtrees.
        guard !["AXMenu", "AXMenuBar", "AXMenuItem", "AXApplication"].contains(role) else { return nil }
        func text(_ attribute: String, limit: Int) -> String {
            if case let .value(value) = driver.string(attribute, of: element) { return boundedText(value, limit: limit) }
            return ""
        }
        let title = text("AXTitle", limit: 240)
        let label = title.isEmpty ? text("AXDescription", limit: 240) : title
        let canReadValue = ["AXTextField", "AXTextArea", "AXStaticText", "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXLink"].contains(role)
        var rawValue = ""
        if canReadValue, case let .value(value) = driver.string("AXValue", of: element) { rawValue = value }
        let fingerprint = SHA256.hash(data: Data(rawValue.utf8))
        let value = boundedText(rawValue, limit: 1000)
        let enabled = driver.enabled(element)
        let settable = ["AXTextField", "AXTextArea"].contains(role) && driver.settable(element)
        guard let after = security(element, window: window), after.0 == role, after.1 == subrole else { return nil }
        return Entry(element: element, ancestors: ancestors, role: role, subrole: subrole, label: label, value: value,
                     valueFingerprint: fingerprint, enabled: enabled, settable: settable)
    }

    private func scan(window: Driver.Element) -> (entries: [Entry], truncated: Bool) {
        let deadline = now() + timeLimit
        var pending: [(Driver.Element, [Driver.Element])] = [(window, [])], seen: [Driver.Element] = [], output: [Entry] = []
        var truncated = false
        while let (element, ancestors) = pending.popLast() {
            if now() >= deadline || seen.count >= elementLimit { truncated = true; break }
            if seen.contains(element) { continue }
            seen.append(element)
            guard let entry = read(element, window: window, ancestors: ancestors) else { truncated = true; continue }
            output.append(entry)
            if ancestors.count >= depthLimit { truncated = true; continue }
            let children = driver.children(element, limit: childLimit)
            truncated = truncated || children.truncated
            pending.append(contentsOf: children.elements.reversed().map { ($0, ancestors + [element]) })
        }
        return (output, truncated)
    }

    func observe() throws -> (elements: [[String: Any]], truncated: Bool) {
        clear()
        let window = try driver.window()
        guard driver.belongs(window, to: window), driver.allowsActions(in: window) else { throw ControlError("window-not-exact") }
        let result = scan(window: window)
        guard try driver.window() == window, driver.allowsActions(in: window) else { throw ControlError("window-not-exact") }
        root = window
        var rendered: [[String: Any]] = []
        var renderedBytes = 2, truncated = result.truncated
        for entry in result.entries {
            let id = "ax_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            let item: [String: Any] = ["id": id, "role": entry.role, "label": entry.label, "value": entry.value,
                                      "enabled": entry.enabled, "settable": entry.settable]
            let size = try JSONSerialization.data(withJSONObject: item).count + 1
            guard size <= responseByteLimit - renderedBytes else { truncated = true; continue }
            renderedBytes += size
            entries[id] = entry
            rendered.append(item)
        }
        observedState = result.entries.map(\.state)
        return (rendered, truncated)
    }

    /// The one observed object at a window-relative point, or `coordinate-unavailable`: a miss, an element outside the
    /// window or one this observation did not record exactly. Selecting dispatches nothing; `perform` acts. So every
    /// failure here, an unreadable window included, is a `notDispatched` refusal (never an unknown outcome).
    func coordinateElement(x: Double, y: Double) throws -> String {
        coordinateHit = nil
        guard x.isFinite, y.isFinite, x >= 0, y >= 0, let window = root else { throw ControlError.refuse("coordinate-unavailable") }
        let current: Driver.Element
        do { current = try driver.window() } catch {
            let failure = error as? ControlError
            throw ControlError.refuse(failure?.code ?? "window-not-exact", retryAfterMs: failure?.retryAfterMs)
        }
        guard current == window, let hit = driver.hitTest(x: x, y: y, window: window),
              driver.belongs(hit, to: window) else { throw ControlError.refuse("coordinate-unavailable") }
        let matches = entries.filter { $0.value.element == hit }
        guard matches.count == 1, let id = matches.first?.key else { throw ControlError.refuse("coordinate-unavailable") }
        guard let selected = entries[id] else { throw ControlError.refuse("coordinate-unavailable") }
        // A native button may expose its label/image as the hit object. Only climb the path recorded by
        // this observation, through passive roles, to its nearest actionable ancestor. Never text-match.
        var candidate = selected
        for ancestor in selected.ancestors.reversed() {
            if pressable(candidate), let selectedId = entries.first(where: { $0.value.element == candidate.element })?.key {
                coordinateHit = hit
                return selectedId
            }
            guard ["AXStaticText", "AXImage", "AXGroup"].contains(candidate.role),
                  let parent = entries.values.first(where: { $0.element == ancestor }),
                  liveEdge(child: candidate.element, parent: parent.element, window: window) else {
                throw ControlError.refuse("coordinate-unavailable")
            }
            candidate = parent
        }
        throw ControlError.refuse("coordinate-unavailable")
    }

    private func pressable(_ entry: Entry) -> Bool {
        entry.enabled && ["AXButton", "AXCheckBox", "AXRadioButton", "AXLink"].contains(entry.role)
            && driver.supportsPress(entry.element)
    }
    private func liveEdge(child: Driver.Element, parent: Driver.Element, window: Driver.Element) -> Bool {
        guard security(child, window: window) != nil, security(parent, window: window) != nil else { return false }
        let children = driver.children(parent, limit: childLimit)
        return !children.truncated && children.elements.filter { $0 == child }.count == 1
    }
    private func coordinateMatches(_ coordinate: (Double, Double)?, entry: Entry, window: Driver.Element,
                                   observed: [Entry], expectedHit: Driver.Element?) -> Bool {
        guard let coordinate else { return true }
        guard let hit = driver.hitTest(x: coordinate.0, y: coordinate.1, window: window),
              hit == expectedHit, let original = observed.first(where: { $0.element == hit }) else { return false }
        if hit == entry.element { return driver.belongs(hit, to: window) }
        var child = original
        for ancestor in original.ancestors.reversed() {
            guard ["AXStaticText", "AXImage", "AXGroup"].contains(child.role),
                  let fresh = read(child.element, window: window), fresh.state == child.state,
                  fresh.subrole == child.subrole,
                  let parent = observed.first(where: { $0.element == ancestor }),
                  liveEdge(child: child.element, parent: ancestor, window: window) else { return false }
            if ancestor == entry.element { return true }
            child = parent
        }
        return false
    }

    /// All refusals precede dispatch. From the first AX mutation onward, failure is uncertain.
    func perform(_ operation: String, element id: String, value: String?, coordinate: (Double, Double)? = nil, beforeDispatch: () throws -> Void) throws -> [String: String] {
        let entry = entries[id], window = root, oldState = observedState
        let observed = Array(entries.values), expectedHit = coordinateHit
        clear()
        let current: Entry
        do {
            guard let entry, let window, try driver.window() == window, driver.allowsActions(in: window),
                  coordinateMatches(coordinate, entry: entry, window: window, observed: observed, expectedHit: expectedHit),
                  let fresh = read(entry.element, window: window), fresh.enabled,
                  fresh.subrole == entry.subrole, fresh.state == entry.state else { throw ControlError.refuse("stale-observation") }
            current = fresh
            if operation == "set-value" {
                guard current.settable, let value, value.utf8.count <= ControlLimits.valueBytes else { throw ControlError.refuse("unsupported-action") }
            } else {
                guard operation == "press", value == nil,
                      ["AXButton", "AXCheckBox", "AXRadioButton", "AXLink"].contains(current.role), driver.supportsPress(entry.element) else {
                    throw ControlError.refuse("unsupported-action")
                }
            }
            try beforeDispatch()
            // Recheck state/permission on this exact object after host/human checks.
            guard driver.allowsActions(in: window), let last = read(entry.element, window: window), last.enabled,
                  coordinateMatches(coordinate, entry: entry, window: window, observed: observed, expectedHit: expectedHit),
                  last.subrole == entry.subrole, last.state == current.state,
                  (operation == "set-value" ? last.settable : driver.supportsPress(entry.element)),
                  try driver.window() == window else { throw ControlError.refuse("target-changed") }
        } catch {
            let failure = error as? ControlError
            throw ControlError.refuse(failure?.code ?? "target-changed", retryAfterMs: failure?.retryAfterMs)
        }
        // The preceding guard established both. From here, any error is an uncertain delivery.
        guard let entry, let window else { throw ControlError.refuse("stale-observation") }
        let accepted = operation == "set-value" ? driver.setValue(value!, of: entry.element) : driver.press(entry.element)
        guard accepted else { throw ControlError("native-operation-unconfirmed") }
        guard try driver.window() == window else { throw ControlError("native-operation-unconfirmed") }
        if operation == "set-value", let value, let after = read(entry.element, window: window),
           after.valueFingerprint == SHA256.hash(data: Data(value.utf8)) {
            return ["state": current.valueFingerprint == after.valueFingerprint ? "confirmed_no_change" : "confirmed_change"]
        }
        let after = scan(window: window)
        return ["state": !after.truncated && after.entries.map(\.state) != oldState ? "confirmed_change" : "dispatched_unverified"]
    }
}
