#if os(macOS)
import AppKit
import Carbon
import CoreGraphics
import Foundation
import os
import ScreenControlCore

/// Session-scoped, after native authentication only. TIS runs on the main actor and acts on the user's current
/// keyboard source. No private Spaces API, synthetic focus clicks, clipboard or source IDs cross the wire.
@MainActor public final class DesktopController: DesktopControlling {
    private let input: InputReceiver?
    private let injector: InputInjector

    public init(input: InputReceiver?, injector: InputInjector) { self.input = input; self.injector = injector }

    public func keyboardState() async -> ScreenKeyboardState { snapshot() }

    public func keyboard(_ action: ScreenKeyboardAction) async -> (ScreenKeyboardState, ScreenControlResult) {
        guard ScreenLock.isLocked == false, InputInjector.isAllowed, let input else { return (snapshot(), .blocked) }
        var result = ScreenControlResult.unavailable
        let admitted = input.performControlInput {
            switch action {
            case .capsOff, .capsOn:
                injector.setRemoteCapsLock(action == .capsOn)
                result = .applied
            case .latin, .korean:
                let language: ScreenInputLanguage = action == .korean ? .korean : .latin
                // Select only an already enabled source; never enable/install a keyboard or change OS preferences.
                if let source = sources().first(where: { Self.language($0) == language }), TISSelectInputSource(source) == noErr {
                    result = snapshot().language == language ? .applied : .unavailable
                }
            }
        }
        return (snapshot(), admitted ? result : .blocked)
    }

    public func navigate(_ action: ScreenSpaceAction) async -> ScreenControlResult {
        guard ScreenLock.isLocked == false, InputInjector.isAllowed, let input else { return .blocked }
        let shortcut = action.shortcut
        let admitted = input.performControlInput {
            injector.inject(.key(code: shortcut.code, isDown: true, modifiers: shortcut.modifiers))
            injector.inject(.key(code: shortcut.code, isDown: false, modifiers: []))
        }
        // This acknowledges shortcut submission only. Disabled/custom shortcuts may do nothing; the UI says so.
        return admitted ? .applied : .blocked
    }

    public func spaceChanges() async -> AsyncStream<Bool> {
        AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let center = NSWorkspace.shared.notificationCenter
            let observer = center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: nil) { _ in
                continuation.yield(true)
            }
            let held = OSAllocatedUnfairLock(uncheckedState: Optional(observer))
            continuation.onTermination = { _ in
                held.withLockUnchecked { observer in
                    if let observer { center.removeObserver(observer) }
                    observer = nil
                }
            }
        }
    }

    private func snapshot() -> ScreenKeyboardState {
        let available = sources().map(Self.language)
        let current = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
        return ScreenKeyboardState(language: current.map(Self.language) ?? .other, capsLock: injector.remoteCapsLock,
                                   canSelectLatin: available.contains(.latin), canSelectKorean: available.contains(.korean))
    }

    private func sources() -> [TISInputSource] {
        let filter: [String: Any] = [kTISPropertyInputSourceCategory as String: kTISCategoryKeyboardInputSource!,
                                     kTISPropertyInputSourceIsEnabled as String: true,
                                     kTISPropertyInputSourceIsSelectCapable as String: true]
        return TISCreateInputSourceList(filter as CFDictionary, false)?.takeRetainedValue() as? [TISInputSource] ?? []
    }

    private static func property(_ source: TISInputSource, _ key: CFString) -> AnyObject? {
        guard let value = TISGetInputSourceProperty(source, key) else { return nil }
        return Unmanaged<AnyObject>.fromOpaque(value).takeUnretainedValue()
    }

    private static func language(_ source: TISInputSource) -> ScreenInputLanguage {
        let languages = property(source, kTISPropertyInputSourceLanguages) as? [String] ?? []
        if languages.contains(where: { $0 == "ko" || $0.hasPrefix("ko-") }) { return .korean }
        if property(source, kTISPropertyInputSourceIsASCIICapable) as? Bool == true { return .latin }
        return .other
    }
}
#endif
