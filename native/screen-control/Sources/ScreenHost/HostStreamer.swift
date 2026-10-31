#if os(macOS)
import Foundation
import ScreenControlCore

/// Streams the Mac's displays into one authenticated session and, given `input`, takes the phone's input. Capture starts
/// here, only after the key exchange (DESIGN 「4) 네트워크」), on the main display, and stops when the session ends. The
/// session keeps to `limits`, and `localInput` lets the person at the Mac take over (VideoPump). A version-2 phone may
/// also choose the display, hide the Mac's cursor in the picture, hear the lock state and turn screen control off.
public final class HostStreamer: Sendable {
    private let pump: VideoPump
    private let capture: HostCapture
    private let desktop: (any DesktopControlling)?
    private let pointerPosition: (@Sendable () -> ScreenPointerPosition?)?

    /// `onDisplay` hears each display the session shows before its capture starts: point input at it there.
    public init(connection: SecureConnection, backend: any DisplayCapturing = ScreenCaptureBackend(),
                sizing: CaptureSizing = .fitWidth(1920), framesPerSecond: Int = 30, bitRate: Int = 4_000_000,
                input: InputReceiver? = nil, onDisplay: @escaping @Sendable (CaptureDisplay) -> Void = { _ in },
                limits: SessionLimits = .standard, localInput: LocalInputProbe? = nil,
                observe: (@Sendable (CapturedPicture) -> Void)? = nil, desktop: (any DesktopControlling)? = nil,
                pointerPosition: (@Sendable () -> ScreenPointerPosition?)? = nil) {
        let pump = VideoPump(connection: connection, input: input, limits: limits, localInput: localInput)
        capture = HostCapture(backend: backend, pump: pump, sizing: sizing, framesPerSecond: framesPerSecond, bitRate: bitRate,
                              onDisplay: onDisplay, observe: observe)
        self.pump = pump
        self.desktop = desktop
        self.pointerPosition = pointerPosition
    }

    public var statistics: VideoPump.Statistics { pump.statistics }

    /// Why the Mac ended the session, once it has.
    public var endReason: SessionEndReason? { pump.endReason }

    /// Ends the session from the Mac: held keys and buttons are let go before this returns; the phone hears the
    /// reason in the returned task (VideoPump.end).
    @discardableResult
    public func end(_ reason: SessionEndReason) -> Task<Void, Never> { pump.end(reason) }

    /// `lockStates` makes the stream a version-2 phone hears the lock state from (`ScreenLock.states`); `turnOff` turns
    /// screen control off at the Mac when such a phone asks. A version-1 phone gets neither.
    public func run(lockStates: (@Sendable () -> AsyncStream<Bool>)? = nil, turnOff: (@Sendable () -> Void)? = nil) async throws {
        do {
            try await capture.start()
        } catch {
            // Nothing was captured or injected. Without this the phone kept an open connection and waited for a
            // picture that never came; now it hears that the Mac ended the session, and the connection closes.
            await capture.stop()
            await pump.end(.endedAtMac).value
            throw error
        }
        do {
            try await pump.run(features: SessionFeatures(lockStates: lockStates, capture: capture, turnOff: turnOff, desktop: desktop, reportsInputAvailability: true, pointerPosition: pointerPosition))
        } catch {
            await capture.stop()
            throw error
        }
        await capture.stop()
    }
}
#endif
