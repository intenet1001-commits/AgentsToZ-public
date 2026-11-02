#if os(macOS)
import CryptoKit
import Foundation
import os
// Testable only to make an `AppAttestation`: outside the core, nothing but a verifier makes one (finding 3).
@testable import ScreenControlCore
@testable import ScreenHost
import XCTest

/// The store's items in memory, so these tests never reach the person's keychain.
private final class StoreItems: ScreenStoreItems {
    let items = OSAllocatedUnfairLock(initialState: [String: Data]())
    func read(_ account: String) throws -> Data? { items.withLock { $0[account] } }
    func write(_ account: String, _ data: Data) throws { items.withLock { $0[account] = data } }
}

/// The controllers item in format 2 (docs/design/mac-to-mac-2026-11-01/DESIGN.md 7.3): how each controller was enrolled,
/// format 1 moved to it as phone-brokered and attested, anything unknown failing closed, and one key never in both the
/// phones and the controllers (SR-22).
final class ControllerStoreTests: XCTestCase {
    /// The controllers item exactly as the format 1 build wrote it (captured from its encoder at d093fa88): keys made
    /// from 32 bytes of 0x11 and 0x22, brokered by App Attest keys of 0x03 and 0x04.
    private static let formatOneItem = #"{"allowMacControllers":true,"format":1,"controllers":[{"grant":"control","name":"1호 MacBook Pro","brokerAttestationKeyID":"AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=","id":"2bad0fd610d99eae443e932a26142bca1e5fa995b4518452827e78ef1f317ff0","lastConnectedAt":815192800,"publicKey":"BAIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtGUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5Q=","model":"Mac16,7","registeredAt":814692800},{"grant":"view","name":"3호 MacBook Air","brokerAttestationKeyID":"BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=","id":"6fc66a90486171ca69b512be185d66a763a68ff2d34cda639e78cff9e98caeab","publicKey":"BNZak5d8qj0bCBhS\/1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc\/3bZ1XwW9UHw8Uz\/OnJEoU=","model":"Mac15,12","registeredAt":814792800}]}"#

    private static let keyID = Data(repeating: 0xA1, count: 32)
    private let enrolledAt = Date(timeIntervalSince1970: 1_793_000_000)
    private let day: TimeInterval = 24 * 60 * 60

    private static func key(_ byte: UInt8) throws -> P256.Signing.PublicKey {
        try P256.Signing.PrivateKey(rawRepresentation: Data(repeating: byte, count: 32)).publicKey
    }

    private static func fingerprint(_ key: P256.Signing.PublicKey) -> Data { ScreenControlIdentity.fingerprint(of: key) }

    /// What a verifier hands the pairing once the Viewer's attestation checks out; only its key ID is stored.
    private static func attestation(_ keyID: Data = ControllerStoreTests.keyID) -> AppAttestation {
        AppAttestation(publicKey: P256.Signing.PrivateKey().publicKey, keyID: keyID, receipt: Data())
    }

    private func controller(_ key: P256.Signing.PublicKey, name: String = "1호 MacBook Pro", model: String = "Mac16,7",
                            grant: ScreenControllerGrant = .view, attestationKeyID: Data? = ControllerStoreTests.keyID) throws -> RegisteredController {
        RegisteredController(publicKey: key, name: name, model: model, grant: grant,
                             enrollment: try .directSAS(attestation: attestationKeyID.map { Self.attestation($0) }), at: enrolledAt)
    }

    private func record(_ key: P256.Signing.PublicKey, name: String = "iPhone") throws -> RegistrationRecord {
        try RegistrationRecord(macFingerprint: Data(repeating: 7, count: 32), codeID: Data(repeating: 9, count: RegistrationCode.idSize),
                               devicePublicKey: key, deviceName: name, deviceModel: "iPhone17,1")
    }

    private func phone(_ key: P256.Signing.PublicKey, at date: Date? = nil) throws -> RegisteredDevice {
        RegisteredDevice(record: try record(key), attestationKeyID: Data(repeating: 1, count: 32), at: date ?? enrolledAt)
    }

    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func rowsOf(_ document: [String: Any]) throws -> [[String: Any]] {
        try XCTUnwrap(document["controllers"] as? [[String: Any]])
    }

    private func isCorrupt(_ error: Error) -> Bool {
        if case ScreenStoreError.corrupt = error { return true }
        return false
    }

    // MARK: format 1 → 2

    func testFormatOneMovesToFormatTwoAsAPhoneBrokeredAttestedEnrollment() throws {
        let memory = StoreItems(), store = ScreenStore(items: memory)
        let stored = Data(Self.formatOneItem.utf8)
        try memory.write("controllers", stored)
        let first = try Self.key(0x11), second = try Self.key(0x22)

        var discarded = 0
        let loaded = try store.controllers { discarded = $0 }
        XCTAssertEqual(discarded, 0)
        XCTAssertTrue(loaded.allowMacControllers)
        XCTAssertEqual(loaded.controllers.map(\.id), ["2bad0fd610d99eae443e932a26142bca1e5fa995b4518452827e78ef1f317ff0",
                                                      "6fc66a90486171ca69b512be185d66a763a68ff2d34cda639e78cff9e98caeab"])
        XCTAssertEqual(loaded.controllers.map(\.id), [first, second].map { RegisteredController.hex(Self.fingerprint($0)) })
        XCTAssertEqual(loaded.controllers.map(\.publicKey), [first.x963Representation, second.x963Representation])
        XCTAssertEqual(loaded.controllers.map(\.name), ["1호 MacBook Pro", "3호 MacBook Air"])
        XCTAssertEqual(loaded.controllers.map(\.model), ["Mac16,7", "Mac15,12"])
        XCTAssertEqual(loaded.controllers.map(\.grant), [.control, .view])
        XCTAssertEqual(loaded.controllers.map(\.registeredAt), [Date(timeIntervalSince1970: 1_793_000_000), Date(timeIntervalSince1970: 1_793_100_000)])
        XCTAssertEqual(loaded.controllers.map(\.lastConnectedAt), [Date(timeIntervalSince1970: 1_793_500_000), nil])
        XCTAssertEqual(loaded.controllers.map(\.alias), [nil, nil])
        XCTAssertEqual(loaded.controllers.map(\.enrollment), [try .phoneBroker(brokerAttestationKeyID: Data(repeating: 3, count: 32)),
                                                              try .phoneBroker(brokerAttestationKeyID: Data(repeating: 4, count: 32))])
        for controller in loaded.controllers {
            XCTAssertEqual(controller.enrollment.method, .phoneBroker)
            XCTAssertTrue(controller.enrollment.attested, "format 1 rows were brokered under the phone's App Attest")
            XCTAssertFalse(controller.bindsGenuineViewer, "a phone's App Attest never showed whose key it carried: the push gate applies")
            XCTAssertNil(controller.enrollment.attestationKeyID)
        }
        XCTAssertEqual(loaded.grant(for: Self.fingerprint(first)), .control)
        XCTAssertEqual(loaded.keyEntries.map(\.id), [first, second].map(Self.fingerprint))
        XCTAssertEqual(memory.items.withLock { $0["controllers"] }, stored, "reading never writes")

        // The next save writes format 2, the broker's key inside the enrollment, and reads back the same.
        try store.saveControllers(loaded)
        let written = try XCTUnwrap(memory.items.withLock { $0["controllers"] })
        let document = try object(written)
        XCTAssertEqual(document["format"] as? Int, 2)
        let rows = try rowsOf(document)
        XCTAssertEqual(rows.count, 2)
        for (row, broker) in zip(rows, [Data(repeating: 3, count: 32), Data(repeating: 4, count: 32)]) {
            XCTAssertNil(row["brokerAttestationKeyID"], "the broker's key moved into the enrollment")
            let enrollment = try XCTUnwrap(row["enrollment"] as? [String: Any])
            XCTAssertEqual(Set(enrollment.keys), ["method", "attested", "brokerAttestationKeyID"])
            XCTAssertEqual(enrollment["method"] as? String, "phone-broker")
            XCTAssertEqual(enrollment["attested"] as? Bool, true)
            XCTAssertEqual(enrollment["brokerAttestationKeyID"] as? String, broker.base64EncodedString())
        }
        XCTAssertEqual(try store.controllers(), loaded)
    }

    func testFormatOneRowsKeepTheirOldRulesAndFailAlone() throws {
        var document = try object(Data(Self.formatOneItem.utf8))
        let rows = try rowsOf(document)
        var noBroker = rows[0]; noBroker["brokerAttestationKeyID"] = nil
        var shortBroker = rows[0]; shortBroker["brokerAttestationKeyID"] = Data(repeating: 3, count: 16).base64EncodedString()
        var wrongID = rows[0]; wrongID["id"] = String(repeating: "0", count: 64)
        var unknownGrant = rows[0]; unknownGrant["grant"] = "admin"
        // A format 2 row inside a format 1 item is read by format 1's rules, never as the other format.
        let formatTwoRow = try rowsOf(object(ScreenStore.encodeControllers(ScreenControllers(controllers: [try controller(Self.key(0x33))]))))[0]
        document["controllers"] = [noBroker, shortBroker, wrongID, unknownGrant, formatTwoRow, rows[1]]
        let loaded = try ScreenStore.decodeControllers(JSONSerialization.data(withJSONObject: document))
        XCTAssertEqual(loaded.controllers.controllers.map(\.name), ["3호 MacBook Air"])
        XCTAssertEqual(loaded.discardedCount, 5)

        // And a format 1 row inside a format 2 item is read by format 2's rules.
        var formatTwo = try object(ScreenStore.encodeControllers(ScreenControllers(allowMacControllers: true)))
        formatTwo["controllers"] = rows
        let misplaced = try ScreenStore.decodeControllers(JSONSerialization.data(withJSONObject: formatTwo))
        XCTAssertEqual(misplaced.controllers.controllers, [])
        XCTAssertEqual(misplaced.discardedCount, 2)
    }

    // MARK: format 2

    func testFormatTwoSpellsEachEnrollmentAsTheDesignDoes() throws {
        let attested = try controller(Self.key(0x11), grant: .control)
        var unattested = try controller(Self.key(0x22), name: "3호 MacBook Air", model: "Mac15,12", attestationKeyID: nil)
        unattested.alias = "사무실 맥"
        unattested.lastConnectedAt = enrolledAt.addingTimeInterval(3 * day)
        let brokered = try RegisteredController(record: record(Self.key(0x33), name: "2호 Mac mini"), brokerAttestationKeyID: Data(repeating: 3, count: 32),
                                                at: enrolledAt)
        let controllers = ScreenControllers(allowMacControllers: true, controllers: [attested, unattested, brokered])
        let data = try ScreenStore.encodeControllers(controllers)

        let document = try object(data)
        XCTAssertEqual(Set(document.keys), ["format", "allowMacControllers", "controllers"])
        XCTAssertEqual(document["format"] as? Int, 2)
        let rows = try rowsOf(document)
        let base: Set<String> = ["id", "publicKey", "name", "model", "grant", "enrollment", "registeredAt"]
        XCTAssertEqual(Set(rows[0].keys), base)
        XCTAssertEqual(Set(rows[1].keys), base.union(["alias", "lastConnectedAt"]))
        XCTAssertEqual(Set(rows[2].keys), base)
        let enrollments = try rows.map { try XCTUnwrap($0["enrollment"] as? [String: Any]) }
        XCTAssertEqual(enrollments.map { $0["method"] as? String }, ["direct-sas", "direct-sas", "phone-broker"])
        XCTAssertEqual(enrollments.map { $0["attested"] as? Bool }, [true, false, true])
        XCTAssertEqual(enrollments.map { Set($0.keys) }, [["method", "attested", "attestationKeyID"], ["method", "attested"],
                                                          ["method", "attested", "brokerAttestationKeyID"]])
        XCTAssertEqual(enrollments[0]["attestationKeyID"] as? String, Self.keyID.base64EncodedString())

        let loaded = try ScreenStore.decodeControllers(data)
        XCTAssertEqual(loaded.discardedCount, 0)
        XCTAssertEqual(loaded.controllers, controllers)
        XCTAssertEqual(loaded.controllers.controllers.map(\.enrollment.attested), [true, false, true])
        // Only the direct, attested row is bound to the genuine Viewer; the brokered one is attested yet not (DESIGN 9절).
        XCTAssertEqual(loaded.controllers.controllers.map(\.bindsGenuineViewer), [true, false, false])
        XCTAssertEqual(loaded.controllers.controllers.map(\.displayName), ["1호 MacBook Pro", "사무실 맥", "2호 Mac mini"])
        XCTAssertEqual(loaded.controllers.controller(for: Self.fingerprint(try Self.key(0x22)))?.enrollment.attested, false)
        XCTAssertEqual(loaded.controllers.controller(for: Self.fingerprint(try Self.key(0x11)))?.enrollment.attestationKeyID, Self.keyID)

        var off = loaded.controllers
        off.allowMacControllers = false
        XCTAssertNil(off.controller(for: Self.fingerprint(try Self.key(0x11))), "switch off: no controller answers")
        XCTAssertNil(off.grant(for: Self.fingerprint(try Self.key(0x11))))
    }

    func testDamagedRowsAreDiscardedAlone() throws {
        let kept = [try controller(Self.key(0x11)), try controller(Self.key(0x22), name: "3호 MacBook Air", model: "Mac15,12", attestationKeyID: nil)]
        var document = try object(ScreenStore.encodeControllers(ScreenControllers(allowMacControllers: true, controllers: kept)))
        let rows = try rowsOf(document)
        let keyID = Self.keyID.base64EncodedString()
        func enrolled(_ enrollment: [String: Any]) -> [String: Any] { var row = rows[0]; row["enrollment"] = enrollment; return row }
        func changed(_ field: String, _ value: Any?) -> [String: Any] { var row = rows[0]; row[field] = value; return row }

        let damaged: [(String, [String: Any])] = [
            ("unknown method", enrolled(["method": "qr", "attested": true, "attestationKeyID": keyID])),
            ("no method", enrolled(["attested": true, "attestationKeyID": keyID])),
            ("no attested", enrolled(["method": "direct-sas", "attestationKeyID": keyID])),
            ("attested not a Bool", enrolled(["method": "direct-sas", "attested": "true", "attestationKeyID": keyID])),
            ("attested without the key it verified", enrolled(["method": "direct-sas", "attested": true])),
            ("a verified key yet not attested", enrolled(["method": "direct-sas", "attested": false, "attestationKeyID": keyID])),
            ("a direct enrollment with a broker", enrolled(["method": "direct-sas", "attested": false, "brokerAttestationKeyID": keyID])),
            ("not an App Attest key ID", enrolled(["method": "direct-sas", "attested": true,
                                                   "attestationKeyID": Data(repeating: 1, count: 31).base64EncodedString()])),
            ("key ID not base64", enrolled(["method": "direct-sas", "attested": true, "attestationKeyID": "!!"])),
            ("brokered without the broker's key", enrolled(["method": "phone-broker", "attested": true])),
            ("brokered yet not attested", enrolled(["method": "phone-broker", "attested": false, "brokerAttestationKeyID": keyID])),
            ("brokered with a Viewer key", enrolled(["method": "phone-broker", "attested": true, "brokerAttestationKeyID": keyID,
                                                     "attestationKeyID": keyID])),
            ("broker key ID too long", enrolled(["method": "phone-broker", "attested": true,
                                                 "brokerAttestationKeyID": Data(repeating: 1, count: 33).base64EncodedString()])),
            ("no enrollment", changed("enrollment", nil)),
            ("enrollment not an object", changed("enrollment", "direct-sas")),
            ("unknown grant", changed("grant", "admin")),
            ("ID not the key's fingerprint", changed("id", String(repeating: "0", count: 64))),
            ("key that does not parse", changed("publicKey", Data(repeating: 4, count: 65).base64EncodedString())),
            ("no registration date", changed("registeredAt", nil)),
        ]
        for (reason, row) in damaged {
            document["controllers"] = [row]
            let alone = try ScreenStore.decodeControllers(JSONSerialization.data(withJSONObject: document))
            XCTAssertEqual(alone.controllers.controllers, [], reason)
            XCTAssertEqual(alone.discardedCount, 1, reason)
        }
        var list: [Any] = [rows[0]]
        list += damaged.map { $0.1 as Any }
        list += [rows[1], NSNull(), 42, "row"] as [Any]
        document["controllers"] = list
        let loaded = try ScreenStore.decodeControllers(JSONSerialization.data(withJSONObject: document))
        XCTAssertEqual(loaded.controllers.controllers, kept)
        XCTAssertEqual(loaded.discardedCount, damaged.count + 3)

        // An alias is display only: one this build would not let the person type shows the enrolled name instead of
        // costing the registration.
        let aliases: [Any] = ["a\u{202E}b", String(repeating: "가", count: 33), 42]
        for alias in aliases {
            document["controllers"] = [changed("alias", alias)]
            let odd = try ScreenStore.decodeControllers(JSONSerialization.data(withJSONObject: document))
            XCTAssertEqual(odd.discardedCount, 0)
            XCTAssertNil(odd.controllers.controllers.first?.alias)
            XCTAssertEqual(odd.controllers.controllers.first?.displayName, "1호 MacBook Pro")
        }
    }

    func testUnknownFormatsAndDocumentsFailClosed() throws {
        let memory = StoreItems(), store = ScreenStore(items: memory)
        var document = try object(ScreenStore.encodeControllers(ScreenControllers(allowMacControllers: true, controllers: [try controller(Self.key(0x11))])))
        var shapes: [(String, Data)] = []
        let formats: [Any] = [0, 3, -1, 99, "2", "1", 2.5, true, NSNull()]
        for format in formats {
            document["format"] = format
            shapes.append(("format \(format)", try JSONSerialization.data(withJSONObject: document)))
        }
        document["format"] = nil
        shapes.append(("no format", try JSONSerialization.data(withJSONObject: document)))
        document["format"] = 2
        var noSwitch = document; noSwitch["allowMacControllers"] = nil
        var noRows = document; noRows["controllers"] = nil
        var rowsNotAList = document; rowsNotAList["controllers"] = [:] as [String: Any]
        shapes += [("no switch", try JSONSerialization.data(withJSONObject: noSwitch)),
                   ("no rows", try JSONSerialization.data(withJSONObject: noRows)),
                   ("rows not a list", try JSONSerialization.data(withJSONObject: rowsNotAList)),
                   ("a phone list", try JSONEncoder().encode([try phone(Self.key(0x11))])),
                   ("empty", Data()), ("null", Data("null".utf8)), ("list", Data("[]".utf8)), ("cut", Data("{\"format\":2".utf8))]
        for (reason, data) in shapes {
            XCTAssertThrowsError(try ScreenStore.decodeControllers(data), reason)
            try memory.write("controllers", data)
            XCTAssertThrowsError(try store.controllers(), reason) { XCTAssertTrue(self.isCorrupt($0), reason) }
            XCTAssertEqual(memory.items.withLock { $0["controllers"] }, data, "reading a corrupt item does not write: \(reason)")
        }
    }

    func testKeyFingerprintIsTheSharedCoresFourCharacters() throws {
        // The Viewer links the shared core only (SR-32), so the rule is the core's and this list only uses it.
        let key = try Self.key(0x11)
        XCTAssertEqual(ScreenControlIdentity.shortFingerprint(of: key), "2bad")
        XCTAssertEqual(ScreenControlIdentity.shortFingerprint(Self.fingerprint(key)), "2bad")
        XCTAssertEqual(try controller(key).keyFingerprint, "2bad")
        XCTAssertEqual(RegisteredController.keyFingerprint(of: key), "2bad")
        // A stored row, format 1 or 2, shows the same four characters.
        let formatOne = try ScreenStore.decodeControllers(Data(Self.formatOneItem.utf8)).controllers.controllers
        XCTAssertEqual(formatOne.map(\.keyFingerprint), ["2bad", "6fc6"])
        let formatTwo = try ScreenStore.decodeControllers(ScreenStore.encodeControllers(ScreenControllers(controllers: [try controller(key)])))
        XCTAssertEqual(formatTwo.controllers.controllers.map(\.keyFingerprint), ["2bad"])
        for _ in 0..<32 {
            let key = P256.Signing.PrivateKey().publicKey, row = try controller(key)
            XCTAssertEqual(row.keyFingerprint, ScreenControlIdentity.shortFingerprint(of: key))
            XCTAssertEqual(row.keyFingerprint, RegisteredController.keyFingerprint(of: key))
            XCTAssertEqual(row.keyFingerprint, String(row.id.prefix(4)))
            XCTAssertEqual(row.keyFingerprint.count, 4)
            XCTAssertTrue(row.keyFingerprint.allSatisfy { "0123456789abcdef".contains($0) })
        }
    }

    /// A name and model come from the other Mac (7.1 P1) and are kept as they came, but this Mac shows them only under
    /// the rule for a phone's (DESIGN 6.3 「이름 거르기」): otherwise 「이름 없는 Mac」 and no model. A push carries only a
    /// name like that, so an odd name can neither reorder itself on screen nor cost the person a notification.
    func testANameThisMacCannotShowReadsAsAnUnnamedMac() throws {
        let odd = ["a\u{202E}b", "a\u{200B}b", "line\nbreak", "", String(repeating: "가", count: 33), String(repeating: "a", count: 65),
                   "한".decomposedStringWithCanonicalMapping, "\u{FFFD}"]
        for (index, text) in odd.enumerated() {
            XCTAssertFalse(RegistrationInvite.isShowableName(text), "fixture \(index)")
            let key = try Self.key(UInt8(0x60 + index))
            let made = try controller(key, name: text, model: text)
            // A stored row reads the same: the name is no reason to discard it.
            var document = try object(ScreenStore.encodeControllers(ScreenControllers(controllers: [made])))
            var rows = try rowsOf(document)
            rows[0]["name"] = text; rows[0]["model"] = text
            document["controllers"] = rows
            let loaded = try ScreenStore.decodeControllers(JSONSerialization.data(withJSONObject: document))
            XCTAssertEqual(loaded.discardedCount, 0, "fixture \(index)")
            let stored = try XCTUnwrap(loaded.controllers.controllers.first)
            for row in [made, stored] {
                XCTAssertEqual(row.name, text, "kept as it came, for replacementCandidates")
                XCTAssertEqual(row.displayName, RegisteredController.unnamed, "fixture \(index)")
                XCTAssertNil(row.showableModel, "fixture \(index)")
            }
            // The person's alias still names it; one set some other way than `alias(from:)` is held to the same rule.
            var renamed = made
            renamed.alias = "사무실 맥"
            XCTAssertEqual(renamed.displayName, "사무실 맥")
            renamed.alias = text
            XCTAssertEqual(renamed.displayName, RegisteredController.unnamed)
        }
        XCTAssertTrue(RegistrationInvite.isShowableName(RegisteredController.unnamed))

        // A showable name and model show as they are; an alias set directly yet not showable falls back to the name.
        var plain = try controller(Self.key(0x11))
        XCTAssertEqual(plain.displayName, "1호 MacBook Pro")
        XCTAssertEqual(plain.showableModel, "Mac16,7")
        plain.alias = "a\u{202E}b"
        XCTAssertEqual(plain.displayName, "1호 MacBook Pro")
    }

    func testEnrollmentFieldsMustBelongToTheirMethod() throws {
        let direct = try ControllerEnrollment.directSAS(attestation: nil)
        XCTAssertEqual(direct.method, .directSAS)
        XCTAssertFalse(direct.attested)
        XCTAssertFalse(direct.bindsGenuineViewer)
        let attested = try ControllerEnrollment.directSAS(attestation: Self.attestation())
        XCTAssertTrue(attested.attested)
        XCTAssertTrue(attested.bindsGenuineViewer)
        XCTAssertEqual(attested.attestationKeyID, Self.keyID)
        XCTAssertNil(attested.brokerAttestationKeyID)
        let brokered = try ControllerEnrollment.phoneBroker(brokerAttestationKeyID: Self.keyID)
        XCTAssertEqual(brokered.method, .phoneBroker)
        XCTAssertTrue(brokered.attested)
        XCTAssertFalse(brokered.bindsGenuineViewer)
        XCTAssertNil(brokered.attestationKeyID)

        for bad in [Data(), Data(repeating: 1, count: 31), Data(repeating: 1, count: 33)] {
            XCTAssertThrowsError(try ControllerEnrollment.directSAS(attestation: Self.attestation(bad))) {
                XCTAssertEqual($0 as? ScreenControllerError, .inconsistentEnrollment)
            }
            XCTAssertThrowsError(try ControllerEnrollment.phoneBroker(brokerAttestationKeyID: bad))
            XCTAssertThrowsError(try RegisteredController(record: record(Self.key(0x11)), brokerAttestationKeyID: bad))
        }
    }

    // MARK: SR-22 and enrolling

    func testAPhoneKeyIsNeverEnrolledAsAController() throws {
        let shared = try Self.key(0x44), sharedFingerprint = Self.fingerprint(shared)
        let registered = try phone(shared)
        let empty = ScreenControllers()
        XCTAssertThrowsError(try empty.enrolling(try controller(shared), phones: [registered])) {
            XCTAssertEqual($0 as? ScreenControllerError, .registeredAsPhone)
        }

        // However long unused: an expired phone is still stored here.
        let expired = try phone(shared, at: enrolledAt.addingTimeInterval(-200 * day))
        XCTAssertTrue(expired.isExpired(at: enrolledAt))
        XCTAssertThrowsError(try empty.enrolling(try controller(shared), phones: [expired]))

        // A phone row counts by its stored ID and by its own key's fingerprint, so one whose two disagree still holds both.
        var mislabeled = try object(JSONEncoder().encode(registered))
        mislabeled["id"] = String(repeating: "0", count: 64)
        let byKey = try JSONDecoder().decode(RegisteredDevice.self, from: JSONSerialization.data(withJSONObject: mislabeled))
        var relabeled = try object(JSONEncoder().encode(try phone(Self.key(0x66))))
        relabeled["id"] = RegisteredController.hex(sharedFingerprint)
        let byID = try JSONDecoder().decode(RegisteredDevice.self, from: JSONSerialization.data(withJSONObject: relabeled))
        for phones in [[byKey], [byID]] {
            XCTAssertTrue(phones.holds(sharedFingerprint))
            XCTAssertThrowsError(try empty.enrolling(try controller(shared), phones: phones)) {
                XCTAssertEqual($0 as? ScreenControllerError, .registeredAsPhone)
            }
        }

        // Another key enrolls, and a phone registration of it would be refused whatever the switch.
        let other = try Self.key(0x55), otherFingerprint = Self.fingerprint(other)
        let enrolled = try empty.enrolling(try controller(other), phones: [registered])
        XCTAssertEqual(enrolled.controllers.map(\.id), [RegisteredController.hex(otherFingerprint)])
        XCTAssertTrue(enrolled.holds(otherFingerprint))
        XCTAssertFalse(enrolled.holds(sharedFingerprint))
        var off = enrolled
        off.allowMacControllers = false
        XCTAssertTrue(off.holds(otherFingerprint), "the switch hides a controller from connecting, not from SR-22")
        XCTAssertTrue([registered].holds(sharedFingerprint))
        XCTAssertFalse([registered].holds(otherFingerprint))
        XCTAssertFalse([RegisteredDevice]().holds(sharedFingerprint))

        // Only a store written some other way holds one key in both sets; the lookups can leave it out.
        XCTAssertEqual(enrolled.doublyRegistered(with: [registered]), [])
        let handMade = ScreenControllers(allowMacControllers: true, controllers: [try controller(shared), try controller(other)])
        XCTAssertEqual(handMade.doublyRegistered(with: [registered]), [sharedFingerprint])
        XCTAssertEqual(handMade.doublyRegistered(with: [byID]), [sharedFingerprint])
        XCTAssertEqual(handMade.doublyRegistered(with: []), [])
    }

    func testEnrollingTurnsTheSwitchOnAndKeepsOneRowPerKey() throws {
        let first = try controller(Self.key(0x11)), second = try controller(Self.key(0x22), name: "3호 MacBook Air", model: "Mac15,12")
        var controllers = try ScreenControllers().enrolling(first, phones: [])
        XCTAssertTrue(controllers.allowMacControllers, "the approval says it turns the switch on")
        XCTAssertEqual(controllers.controllers, [first])
        controllers = try controllers.enrolling(second, phones: [])
        XCTAssertEqual(controllers.controllers, [first, second])

        // The same key again is the same registration: its row gives way, nobody else's does.
        let again = RegisteredController(publicKey: try Self.key(0x11), name: "1호 MacBook Pro", model: "Mac16,7", grant: .control,
                                         enrollment: try .directSAS(attestation: nil), at: enrolledAt.addingTimeInterval(day))
        controllers = try controllers.enrolling(again, phones: [])
        XCTAssertEqual(controllers.controllers, [second, again])

        var off = controllers
        off.allowMacControllers = false
        XCTAssertTrue(try off.enrolling(try controller(Self.key(0x33)), phones: []).allowMacControllers)

        let store = ScreenStore(items: StoreItems())
        try store.saveControllers(controllers)
        XCTAssertEqual(try store.controllers(), controllers)
    }

    func testReplacementCandidatesAreTheSameMacAndOnlyAChosenOneGoes() throws {
        let old = try controller(Self.key(0x11))
        var renamed = try controller(Self.key(0x22))
        renamed.alias = "사무실 맥"
        let otherModel = try controller(Self.key(0x33), model: "Mac15,12")
        let otherName = try controller(Self.key(0x44), name: "3호 MacBook Air")
        let controllers = ScreenControllers(allowMacControllers: true, controllers: [old, renamed, otherModel, otherName])

        // The same Mac's name in another spelling: decomposed Hangul, a doubled space, another letter case.
        let spelled = "1호  macbook PRO".decomposedStringWithCanonicalMapping
        XCTAssertNotEqual(Array(spelled.utf8), Array("1호 MacBook Pro".utf8))
        let newKey = try Self.key(0x55)
        let newcomer = RegisteredController(publicKey: newKey, name: spelled, model: "Mac16,7", enrollment: try .directSAS(attestation: nil),
                                            at: enrolledAt)
        XCTAssertEqual(controllers.replacementCandidates(name: newcomer.name, model: newcomer.model, excluding: Self.fingerprint(newKey)).map(\.id),
                       [old.id, renamed.id])
        XCTAssertEqual(controllers.replacementCandidates(name: "사무실 맥", model: "Mac16,7"), [], "an alias is never matched")
        XCTAssertEqual(controllers.replacementCandidates(name: old.name, model: old.model, excluding: Self.fingerprint(try Self.key(0x11))).map(\.id),
                       [renamed.id], "the key being enrolled is no candidate: it gives way anyway")

        // Off by default: nothing is replaced unless the person chose a row.
        XCTAssertEqual(try controllers.enrolling(newcomer, phones: []).controllers.map(\.id),
                       [old.id, renamed.id, otherModel.id, otherName.id, newcomer.id])
        XCTAssertEqual(try controllers.enrolling(newcomer, replacing: old.id, phones: []).controllers.map(\.id),
                       [renamed.id, otherModel.id, otherName.id, newcomer.id])
        for id in [otherModel.id, otherName.id, newcomer.id, String(repeating: "0", count: 64), ""] {
            XCTAssertThrowsError(try controllers.enrolling(newcomer, replacing: id, phones: [])) {
                XCTAssertEqual($0 as? ScreenControllerError, .notAReplacementCandidate, id)
            }
        }
        // A phone's key is refused before any row is replaced.
        XCTAssertThrowsError(try controllers.enrolling(newcomer, replacing: old.id, phones: [try phone(newKey)])) {
            XCTAssertEqual($0 as? ScreenControllerError, .registeredAsPhone)
        }
    }

    func testAliasFollowsThePhonesRule() throws {
        let row = try controller(Self.key(0x11))
        XCTAssertEqual(row.alias(from: "  사무실   맥 "), .name("사무실 맥"))
        XCTAssertEqual(row.alias(from: " 1호 MacBook Pro "), .clear, "the enrolled name itself is no rename")
        XCTAssertEqual(row.alias(from: "   "), .clear)
        XCTAssertEqual(row.alias(from: "a\u{202E}b"), .invalid)
        XCTAssertEqual(row.alias(from: String(repeating: "가", count: 33)), .invalid)
        XCTAssertEqual(row.displayName, "1호 MacBook Pro")
    }
}
#endif
