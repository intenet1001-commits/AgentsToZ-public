// Emulator e2e fixture only (scripts/emulator-e2e/screenFixtureHost.ts compiles it; no Package.swift target, no app
// bundle). Shared by the fixture Screen host and the macOS stand-in viewer the selfcheck connects with.
import CryptoKit
import Darwin
import Foundation
import os
import ScreenControlCore

/// A transcript signer with an in-memory software key. The fixture Mac signs with one; the stand-in phone with another.
/// No Secure Enclave, no keychain, no LocalAuthentication: the key lives and dies with the process.
struct SoftwareTranscriptSigner: TranscriptSigner {
    let key: P256.Signing.PrivateKey
    var publicKey: P256.Signing.PublicKey { key.publicKey }

    init(key: P256.Signing.PrivateKey = P256.Signing.PrivateKey()) { self.key = key }

    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for: data) }
}

enum FixtureEncoding {
    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    static func data(hex: String) -> Data? {
        guard hex.count % 2 == 0 else { return nil }
        var out = Data(capacity: hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
            out.append(byte)
            index = next
        }
        return out
    }

    /// The fingerprint the phone pins and the registry keys a device by.
    static func fingerprint(_ key: P256.Signing.PublicKey) -> Data { ScreenControlIdentity.fingerprint(of: key) }

    static func milliseconds() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
}

/// One JSON object per line, sorted keys. Every value is built here from fixture data, never from a phone's bytes
/// except the decoded input events the host records on purpose.
enum FixtureJSON {
    static func line(_ object: [String: Any]) -> Data {
        let body = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]))
            ?? Data(#"{"event":"unencodable"}"#.utf8)
        return body + Data([0x0a])
    }

    /// Writes straight to the file descriptor: `print` buffers when stdout is a pipe, and the harness reads line by line.
    static func emit(_ object: [String: Any]) {
        FileHandle.standardOutput.write(line(object))
    }

    static func read(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw FixtureFailure("not a JSON object: \(path)") }
        return object
    }

    /// Owner-only, replaced in one rename, so a reader never sees half a file.
    static func writeFile(_ object: [String: Any], to path: String) throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
        let temporary = path + ".partial-\(getpid())"
        try FixtureFile.write(data, to: temporary, flags: O_CREAT | O_TRUNC)
        guard rename(temporary, path) == 0 else { throw FixtureFailure("could not rename \(temporary): errno \(errno)") }
    }
}

/// Plain POSIX files. Foundation's `createFile` and atomic writes go through a system temporary folder, which the
/// fixture's sandbox does not let it write: every file here is made where it is named, owner-only.
enum FixtureFile {
    static func write(_ data: Data, to path: String, flags: Int32) throws {
        let descriptor = open(path, O_WRONLY | O_CLOEXEC | O_NOFOLLOW | flags, 0o600)
        guard descriptor >= 0 else { throw FixtureFailure("could not open \(path): errno \(errno)") }
        defer { close(descriptor) }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                guard written > 0 else { throw FixtureFailure("could not write \(path): errno \(errno)") }
                offset += written
            }
        }
    }

    static func makeDirectory(_ path: String) throws {
        guard mkdir(path, 0o700) == 0 || errno == EEXIST else { throw FixtureFailure("could not create \(path): errno \(errno)") }
    }
}

/// Appends JSON lines to an owner-only file.
final class JSONLWriter: Sendable {
    private let handle: OSAllocatedUnfairLock<FileHandle?>
    private let sequence = OSAllocatedUnfairLock(initialState: 0)

    init(path: String?) throws {
        guard let path else {
            handle = OSAllocatedUnfairLock(uncheckedState: nil)
            return
        }
        let descriptor = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw FixtureFailure("could not create \(path): errno \(errno)") }
        handle = OSAllocatedUnfairLock(uncheckedState: FileHandle(fileDescriptor: descriptor, closeOnDealloc: true))
    }

    /// Adds `seq` and `t` (wall-clock milliseconds) and appends the line.
    func append(_ object: [String: Any]) {
        var object = object
        object["seq"] = sequence.withLock { value -> Int in
            value += 1
            return value
        }
        object["t"] = FixtureEncoding.milliseconds()
        let data = FixtureJSON.line(object)
        handle.withLockUnchecked { file in try? file?.write(contentsOf: data) }
    }

    func close() { handle.withLockUnchecked { file in try? file?.close(); file = nil } }
}

struct FixtureFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Input events as the host records them and the stand-in viewer lists what it sent, so the harness compares the two
/// files value for value. `textAndReturn` leaves out its ID: the host's compound path hears only the text.
enum FixtureInputJSON {
    static func object(_ event: InputEvent) -> [String: Any] {
        switch event {
        case let .pointerMove(x, y): ["kind": "pointerMove", "x": x, "y": y]
        case let .button(button, isDown): ["kind": "button", "button": name(button), "isDown": isDown]
        case let .scroll(dx, dy): ["kind": "scroll", "dx": dx, "dy": dy]
        case let .key(code, isDown, modifiers): ["kind": "key", "code": Int(code), "isDown": isDown, "modifiers": Int(modifiers.rawValue)]
        case let .text(text): ["kind": "text", "text": text]
        case let .textAndReturn(_, text): textAndReturn(text)
        }
    }

    static func textAndReturn(_ text: String) -> [String: Any] { ["kind": "textAndReturn", "text": text] }

    static func name(_ button: MouseButton) -> String {
        switch button {
        case .left: "left"
        case .right: "right"
        case .middle: "middle"
        }
    }
}

enum FixtureNames {
    static func endReason(_ reason: SessionEndReason) -> String {
        switch reason {
        case .idle: "idle"
        case .timeLimit: "timeLimit"
        case .endedAtMac: "endedAtMac"
        case .turnedOff: "turnedOff"
        case .revoked: "revoked"
        case .replaced: "replaced"
        case .turnedOffFromDevice: "turnedOffFromDevice"
        case .takenOver: "takenOver"
        case .busy: "busy"
        case .captureUnavailable: "captureUnavailable"
        }
    }

    static func endReason(named name: String) -> SessionEndReason? {
        SessionEndReason.allCases.first { endReason($0) == name }
    }

    static func availability(_ value: ScreenInputAvailability) -> String {
        switch value {
        case .ready: "ready"
        case .permissionsRequired: "permissionsRequired"
        case .secureInput: "secureInput"
        case .monitorUnavailable: "monitorUnavailable"
        case .localActivity: "localActivity"
        case .viewOnly: "viewOnly"
        case .notificationsUnconfirmed: "notificationsUnconfirmed"
        case .controlNotInThisBuild: "controlNotInThisBuild"
        }
    }

    static func textReturn(_ value: ScreenTextReturnResult) -> String {
        switch value {
        case .posted: "posted"
        case .blocked: "blocked"
        case .unknown: "unknown"
        }
    }
}

/// `--name value` pairs; a repeated name keeps every value.
struct FixtureArguments {
    private var values: [String: [String]] = [:]
    let positional: [String]

    init(_ arguments: [String]) throws {
        var positional: [String] = []
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            if argument.hasPrefix("--") {
                guard index + 1 < arguments.count else { throw FixtureFailure("missing value for \(argument)") }
                values[String(argument.dropFirst(2)), default: []].append(arguments[index + 1])
                index += 2
            } else {
                positional.append(argument)
                index += 1
            }
        }
        self.positional = positional
    }

    func value(_ name: String) -> String? { values[name]?.last }
    func all(_ name: String) -> [String] { values[name] ?? [] }
    func int(_ name: String, default fallback: Int) throws -> Int {
        guard let text = value(name) else { return fallback }
        guard let number = Int(text) else { throw FixtureFailure("--\(name) is not a number") }
        return number
    }
}
