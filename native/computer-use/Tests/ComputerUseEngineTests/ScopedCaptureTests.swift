import XCTest
import CoreGraphics
import ComputerUseApproval
import ComputerUseControlCore
@testable import ComputerUseEngine

@MainActor
private final class FakeScopedDisplays: ScopedDisplayCaptureSource {
    struct Catalog { let displays: [ScopedCaptureDisplay]; let applications: [ScopedCaptureApplication] }
    var value: Catalog
    var afterCatalog: (() -> Void)?
    var afterImage: (() -> Void)?
    var captured: [(UInt32, ScopedCaptureFilter, Int, Int)] = []
    init(value: Catalog) { self.value = value }
    func catalog() async throws -> Catalog { afterCatalog?(); return value }
    func displays(in catalog: Catalog) -> [ScopedCaptureDisplay] { catalog.displays }
    func applications(in catalog: Catalog) -> [ScopedCaptureApplication] { catalog.applications }
    func image(in catalog: Catalog, display: UInt32, filter: ScopedCaptureFilter, width: Int, height: Int) async throws -> CGImage {
        captured.append((display, filter, width, height)); afterImage?()
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()!
    }
}

@MainActor
private final class ScopedCaptureHarness {
    let display = ScopedDisplayGeometry(id: "display_left", nativeID: 55,
        frame: CGRect(x: -2560, y: -80, width: 2560, height: 1600), scale: 2, rotation: 0)
    let second = ScopedDisplayGeometry(id: "display_main", nativeID: 56,
        frame: CGRect(x: 0, y: 0, width: 1920, height: 1080), scale: 1, rotation: 0)
    let firstApp = ScopeApplicationIdentity(bundleId: "com.example.editor", teamId: "ABCDEFGHIJ",
        codeHash: String(repeating: "a", count: 40), pid: 100, processStart: "2000")
    let protectedApp = ScopeApplicationIdentity(bundleId: "com.apple.SecurityAgent", teamId: "ABCDEFGHIJ",
        codeHash: String(repeating: "b", count: 40), pid: 101, processStart: "2001")
    var valid = true, current = true, screen = true, overlaysAbsent = true
    var human = "stable"
    var layout: [ScopedDisplayGeometry] = []
    var identities: [Int32: ScopeApplicationIdentity] = [:]
    lazy var source = FakeScopedDisplays(value: .init(displays: [.init(id: 55, frame: display.frame), .init(id: 56, frame: second.frame)],
        applications: [.init(pid: 100, bundleId: firstApp.bundleId), .init(pid: 101, bundleId: protectedApp.bundleId)]))
    init() { layout = [display, second]; identities = [100: firstApp, 101: protectedApp] }
    var checks: ScopedCaptureChecks {
        ScopedCaptureChecks(validateGrant: { if !self.valid { throw ControlError.refuse("worker-halted") } },
            observationCurrent: { self.current }, humanEvidence: { self.human },
            protectedOverlaysAbsent: { self.overlaysAbsent }, displayLayout: { self.layout },
            resolveApplication: { pid, _ in guard let identity = self.identities[pid] else {
                throw ControlError.refuse("scope-app-unverifiable") }; return identity },
            isProtectedApplication: { $0.bundleId.hasPrefix("com.apple.SecurityAgent") })
    }
    func run(_ scope: ScopeApprovalScope = .desktop) async throws -> [String: Any] {
        try await captureScopedDisplay(scope: scope, displayID: display.id, layout: [display, second], checks: checks,
                                       screenPermission: { self.screen }, source: source)
    }
}

final class ScopedCaptureTests: XCTestCase {
    @MainActor func testAppIncludesOnlyTheExactApprovedProcessAndPreservesNegativeDisplayOrigin() async throws {
        let h = ScopedCaptureHarness()
        let result = try await h.run(.application(h.firstApp))
        XCTAssertEqual(h.source.captured.first?.1, .include(pid: 100))
        XCTAssertEqual(result["displayId"] as? String, "display_left")
        XCTAssertEqual((result["originX"] as? CGFloat), -2560)
        XCTAssertEqual((result["originY"] as? CGFloat), -80)
        XCTAssertEqual(result["width"] as? Int, 1280); XCTAssertEqual(result["height"] as? Int, 800)
        let jpeg = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(result["data"] as? String)))
        XCTAssertLessThanOrEqual(jpeg.count, 240_000); XCTAssertEqual(Array(jpeg.prefix(2)), [0xff, 0xd8])
    }
    @MainActor func testDesktopFilterExcludesProtectedApplications() async throws {
        let h = ScopedCaptureHarness()
        _ = try await h.run()
        XCTAssertEqual(h.source.captured.first?.1, .excludeProtectedApplications(pids: [101]))
    }
    /// Measured 2026-10-30 (macOS 26.7): ScreenCaptureKit lists WindowServer with bundleIdentifier "", and every real
    /// capture refused while the menu bar was on screen. Only the resolver-proven compositor may have an empty bundle.
    @MainActor func testCatalogCompositorWithEmptyBundleIsRetainedButOtherEmptyBundlesRefuse() async throws {
        var h = ScopedCaptureHarness()
        h.identities[169] = ScopeApplicationIdentity(bundleId: "com.apple.WindowServer", teamId: "",
            codeHash: String(repeating: "d", count: 40), pid: 169, processStart: "1000")
        h.source.value = .init(displays: h.source.value.displays,
            applications: h.source.value.applications + [.init(pid: 169, bundleId: "")])
        _ = try await h.run()
        XCTAssertEqual(h.source.captured.last?.1, .excludeProtectedApplications(pids: [101]), "the menu bar stays in the image")
        _ = try await h.run(.application(h.firstApp))
        XCTAssertEqual(h.source.captured.last?.1, .include(pid: 100))

        h = ScopedCaptureHarness()
        h.identities[103] = ScopeApplicationIdentity(bundleId: "com.example.helper", teamId: "ABCDEFGHIJ",
            codeHash: String(repeating: "e", count: 40), pid: 103, processStart: "2003")
        h.source.value = .init(displays: h.source.value.displays,
            applications: h.source.value.applications + [.init(pid: 103, bundleId: "")])
        do { _ = try await h.run(); XCTFail("an unexplained empty bundle was accepted") }
        catch { XCTAssertEqual((error as? ControlError)?.code, "scope-app-unverifiable") }
        XCTAssertTrue(h.source.captured.isEmpty)
    }
    @MainActor func testNewProtectedApplicationDuringCaptureDiscardsImage() async {
        let h = ScopedCaptureHarness()
        h.source.afterImage = {
            let newProtected = ScopeApplicationIdentity(bundleId: "com.apple.SecurityAgentHelper", teamId: "ABCDEFGHIJ",
                codeHash: String(repeating: "c", count: 40), pid: 102, processStart: "2002")
            h.identities[102] = newProtected
            h.source.value = .init(displays: h.source.value.displays,
                applications: h.source.value.applications + [.init(pid: 102, bundleId: newProtected.bundleId)])
        }
        do { _ = try await h.run(); XCTFail("new protected application leaked in image") }
        catch { XCTAssertEqual((error as? ControlError)?.code, "protected-app-changed") }
        XCTAssertEqual(h.source.captured.count, 1, "the image was discarded after capture")
    }
    @MainActor func testRevocationAndHumanOrLayoutChangesAtEachAwaitReturnNoImage() async {
        for stage in ["catalog", "image"] {
            for cause in ["revoke", "snapshot", "human", "overlay", "layout", "identity"] {
                let h = ScopedCaptureHarness()
                let alter = {
                    switch cause {
                    case "revoke": h.valid = false
                    case "snapshot": h.current = false
                    case "human": h.human = "human-input"
                    case "overlay": h.overlaysAbsent = false
                    case "layout": h.layout.removeLast()
                    default: h.identities.removeValue(forKey: 100)
                    }
                }
                if stage == "catalog" { h.source.afterCatalog = alter } else { h.source.afterImage = alter }
                do { _ = try await h.run(); XCTFail("\(stage) \(cause) returned pixels") } catch {}
                if stage == "catalog" { XCTAssertTrue(h.source.captured.isEmpty, cause) }
            }
        }
    }
    @MainActor func testMissingPermissionProtectedAndChangedTargetsFailBeforePixels() async {
        var h = ScopedCaptureHarness(); h.screen = false
        do { _ = try await h.run(); XCTFail("missing screen permission") } catch {}
        XCTAssertTrue(h.source.captured.isEmpty)
        h = ScopedCaptureHarness()
        do { _ = try await h.run(.application(h.protectedApp)); XCTFail("protected app") } catch {}
        XCTAssertTrue(h.source.captured.isEmpty)
        h = ScopedCaptureHarness(); h.identities[100] = ScopeApplicationIdentity(bundleId: h.firstApp.bundleId,
            teamId: h.firstApp.teamId, codeHash: h.firstApp.codeHash, pid: 100, processStart: "2002")
        do { _ = try await h.run(.application(h.firstApp)); XCTFail("restarted app") } catch {}
        XCTAssertTrue(h.source.captured.isEmpty)
    }
}
