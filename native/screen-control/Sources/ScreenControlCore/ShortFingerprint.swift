import CryptoKit
import Foundation

// The four characters both Macs show for a controller key (docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.3, SR-20):
// the Screen's controller list on one Mac, the Viewer's target list on the other. It lives in the shared core because
// the Viewer links ScreenControlCore only (SR-32): one rule, so the two lists can never spell the same key differently.
//
// Four hex characters are 16 bits. They let the person see that both lists name the same registration; they are no
// defence against a key made to match them, which takes about 65,000 tries. The codes of the pairing are that defence.

extension ScreenControlIdentity {
    /// The first two bytes of the key's fingerprint (`fingerprint(of:)`) in lowercase hex.
    public static func shortFingerprint(of key: P256.Signing.PublicKey) -> String { shortFingerprint(fingerprint(of: key)) }

    /// The same four characters from a fingerprint already at hand: a stored row's ID bytes or a key exchange's.
    public static func shortFingerprint(_ fingerprint: Data) -> String {
        fingerprint.prefix(2).map { String(format: "%02x", $0) }.joined()
    }
}
