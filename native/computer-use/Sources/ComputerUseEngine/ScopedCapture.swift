import AppKit
import ComputerUseApproval
import ComputerUseControlCore
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// One real CG display bound to an observation's opaque display ID. Coordinates are global points, and may be
/// negative. The full display array is compared at every suspension, not only the selected display.
public struct ScopedDisplayGeometry: Equatable, Sendable {
    public let id: String
    public let nativeID: UInt32
    public let frame: CGRect
    public let scale: Double
    public let rotation: Double
    public init(id: String, nativeID: UInt32, frame: CGRect, scale: Double, rotation: Double) {
        self.id = id; self.nativeID = nativeID; self.frame = frame; self.scale = scale; self.rotation = rotation
    }
}

/// All closures are mandatory and must independently fail closed. In particular `protectedOverlaysAbsent` must
/// inspect actual visible system/permission/lock surfaces, not just ScreenCaptureKit's shareable window list, and
/// `humanEvidence` must reject secure input, lock and physical human activity. This type does not supply or imply
/// those guards. The service must bind them to the approved grant and exact observation for every invocation.
@MainActor
public struct ScopedCaptureChecks {
    public let validateGrant: () throws -> Void
    public let observationCurrent: () -> Bool
    public let humanEvidence: () throws -> String
    public let protectedOverlaysAbsent: () throws -> Bool
    public let displayLayout: () throws -> [ScopedDisplayGeometry]
    public let resolveApplication: (Int32, String) throws -> ScopeApplicationIdentity
    public let isProtectedApplication: (ScopeApplicationIdentity) throws -> Bool
    public init(validateGrant: @escaping () throws -> Void, observationCurrent: @escaping () -> Bool,
                humanEvidence: @escaping () throws -> String, protectedOverlaysAbsent: @escaping () throws -> Bool,
                displayLayout: @escaping () throws -> [ScopedDisplayGeometry],
                resolveApplication: @escaping (Int32, String) throws -> ScopeApplicationIdentity,
                isProtectedApplication: @escaping (ScopeApplicationIdentity) throws -> Bool) {
        self.validateGrant = validateGrant; self.observationCurrent = observationCurrent
        self.humanEvidence = humanEvidence; self.protectedOverlaysAbsent = protectedOverlaysAbsent
        self.displayLayout = displayLayout; self.resolveApplication = resolveApplication
        self.isProtectedApplication = isProtectedApplication
    }
}

struct ScopedCaptureApplication: Equatable {
    let pid: Int32
    let bundleId: String
}
struct ScopedCaptureDisplay: Equatable {
    let id: UInt32
    let frame: CGRect
}
enum ScopedCaptureFilter: Equatable {
    case include(pid: Int32)
    case excludeProtectedApplications(pids: [Int32])
}
struct ScopedCapturePlan {
    let filter: ScopedCaptureFilter
    let applications: [(identity: ScopeApplicationIdentity, isProtected: Bool)]
}

@MainActor
protocol ScopedDisplayCaptureSource {
    associatedtype Catalog
    func catalog() async throws -> Catalog
    func displays(in catalog: Catalog) -> [ScopedCaptureDisplay]
    func applications(in catalog: Catalog) -> [ScopedCaptureApplication]
    func image(in catalog: Catalog, display: UInt32, filter: ScopedCaptureFilter, width: Int, height: Int) async throws -> CGImage
}

@MainActor
struct ScreenCaptureKitScopedDisplays: ScopedDisplayCaptureSource {
    func catalog() async throws -> SCShareableContent {
        try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    }
    func displays(in catalog: SCShareableContent) -> [ScopedCaptureDisplay] {
        catalog.displays.map { ScopedCaptureDisplay(id: $0.displayID, frame: $0.frame) }
    }
    func applications(in catalog: SCShareableContent) -> [ScopedCaptureApplication] {
        catalog.applications.map { ScopedCaptureApplication(pid: $0.processID, bundleId: $0.bundleIdentifier) }
    }
    func image(in catalog: SCShareableContent, display: UInt32, filter: ScopedCaptureFilter, width: Int, height: Int) async throws -> CGImage {
        let displays = catalog.displays.filter { $0.displayID == display }
        guard displays.count == 1, let selected = displays.first else { throw ControlError.refuse("display-unavailable") }
        let contentFilter: SCContentFilter
        switch filter {
        case .include(let pid):
            let apps = catalog.applications.filter { $0.processID == pid }
            guard apps.count == 1 else { throw ControlError.refuse("scope-target-changed") }
            // No excepting windows: every window owned by this one exact process is included.
            contentFilter = SCContentFilter(display: selected, including: apps, exceptingWindows: [])
        case .excludeProtectedApplications(let pids):
            let apps = catalog.applications.filter { pids.contains($0.processID) }
            guard apps.count == pids.count else { throw ControlError.refuse("scope-app-unverifiable") }
            // Unlike an inclusion filter, this preserves the desktop and Dock. Newly appearing protected apps are
            // checked against a fresh catalog after capture; brief appearances entirely between checks can be missed.
            contentFilter = SCContentFilter(display: selected, excludingApplications: apps, exceptingWindows: [])
        }
        let configuration = SCStreamConfiguration()
        configuration.width = width; configuration.height = height; configuration.showsCursor = false
        return try await SCScreenshotManager.captureImage(contentFilter: contentFilter, configuration: configuration)
    }
}

/// Build an explicit app filter from actual catalog entries. Unknown, duplicate or unverified identities fail before
/// requesting pixels. An app approval is for one process generation, even if the bundle has multiple instances.
@MainActor
func scopedCaptureFilter(scope: ScopeApprovalScope, applications: [ScopedCaptureApplication], checks: ScopedCaptureChecks) throws -> ScopedCapturePlan {
    var seen = Set<Int32>(), protected: [Int32] = [], selected = false
    var verified: [(identity: ScopeApplicationIdentity, isProtected: Bool)] = []
    for app in applications {
        guard app.pid > 0, seen.insert(app.pid).inserted else {
            throw ControlError.refuse("scope-app-unverifiable")
        }
        // ScreenCaptureKit lists WindowServer with an empty bundle identifier (macOS 26.7, measured 2026-10-30), so a
        // menu bar or recording indicator on screen made every capture refuse. An empty bundle is accepted only when the
        // resolver proves that pid is the Apple-signed compositor; any other empty bundle stays unverifiable.
        let identity = try checks.resolveApplication(app.pid, app.bundleId)
        guard identity.pid == app.pid,
              identity.bundleId == app.bundleId || (app.bundleId.isEmpty && identity.bundleId == "com.apple.WindowServer"),
              ComputerUseScopeApproval.validApplication(identity) else { throw ControlError.refuse("scope-app-unverifiable") }
        let isProtected = try checks.isProtectedApplication(identity)
        verified.append((identity, isProtected))
        if isProtected { protected.append(app.pid) }
        if case .application(let requested) = scope, requested == identity {
            guard !isProtected else { throw ControlError.refuse("scope-target-refused") }
            selected = true
        }
    }
    switch scope {
    case .desktop: return ScopedCapturePlan(filter: .excludeProtectedApplications(pids: protected.sorted()), applications: verified)
    case .application(let requested):
        guard selected else { throw ControlError.refuse("scope-target-changed") }
        return ScopedCapturePlan(filter: .include(pid: requested.pid), applications: verified)
    }
}

@MainActor
func scopedLayoutValid(_ layout: [ScopedDisplayGeometry]) -> Bool {
    guard !layout.isEmpty, layout.count <= 32, Set(layout.map(\.id)).count == layout.count,
          Set(layout.map(\.nativeID)).count == layout.count else { return false }
    return layout.allSatisfy { d in
        !d.id.isEmpty && d.id.utf8.count <= 160 && d.nativeID != 0 && d.frame.origin.x.isFinite && d.frame.origin.y.isFinite &&
            d.frame.width.isFinite && d.frame.height.isFinite && d.frame.width > 0 && d.frame.height > 0 &&
            d.scale.isFinite && d.scale > 0 && d.rotation.isFinite
    }
}

/// Internal seam for deterministic tests; the public entry point always checks the real macOS Screen Recording TCC.
@MainActor
func captureScopedDisplay<Source: ScopedDisplayCaptureSource>(scope: ScopeApprovalScope, displayID: String,
    layout: [ScopedDisplayGeometry], checks: ScopedCaptureChecks, screenPermission: () -> Bool, source: Source) async throws -> [String: Any] {
    guard ComputerUseScopeApproval.validScope(scope), scopedLayoutValid(layout),
          let selected = layout.first(where: { $0.id == displayID }) else { throw ControlError.refuse("display-unavailable") }
    func safety(_ human: String?) throws -> String {
        try checks.validateGrant()
        guard screenPermission() else { throw ControlError.refuse("screen-permission-required") }
        guard checks.observationCurrent(), try checks.displayLayout() == layout,
              try checks.protectedOverlaysAbsent() else { throw ControlError.refuse("observation-discarded") }
        let now = try checks.humanEvidence()
        guard !now.isEmpty, now.utf8.count <= 1024, human == nil || human == now else {
            throw ControlError.refuse("human-state-unavailable")
        }
        return now
    }
    let before = try safety(nil)
    let catalog = try await source.catalog()
    _ = try safety(before)
    let displays = source.displays(in: catalog).filter { $0.id == selected.nativeID }
    guard displays.count == 1, displays[0].frame == selected.frame else { throw ControlError.refuse("display-changed") }
    let plan = try scopedCaptureFilter(scope: scope, applications: source.applications(in: catalog), checks: checks)
    func verifyApplications() throws {
        for app in plan.applications {
            let current = try checks.resolveApplication(app.identity.pid, app.identity.bundleId)
            guard current == app.identity, try checks.isProtectedApplication(current) == app.isProtected else {
                throw ControlError.refuse("scope-target-changed")
            }
        }
    }
    let ratio = min(1.0, WindowCaptureLimits.longestSide / max(selected.frame.width, selected.frame.height))
    let width = max(1, Int((selected.frame.width * ratio).rounded(.down)))
    let height = max(1, Int((selected.frame.height * ratio).rounded(.down)))
    _ = try safety(before)
    try verifyApplications()
    let image = try await source.image(in: catalog, display: selected.nativeID, filter: plan.filter, width: width, height: height)
    _ = try safety(before)
    try verifyApplications()
    // A protected application created after the first list was taken must invalidate the image rather than leak it.
    // SCK cannot guarantee detection of an overlay that appears and disappears entirely between OS observations.
    let afterCatalog = try await source.catalog()
    _ = try safety(before)
    let afterDisplays = source.displays(in: afterCatalog).filter { $0.id == selected.nativeID }
    guard afterDisplays.count == 1, afterDisplays[0].frame == selected.frame else { throw ControlError.refuse("display-changed") }
    let afterPlan = try scopedCaptureFilter(scope: scope, applications: source.applications(in: afterCatalog), checks: checks)
    guard afterPlan.filter == plan.filter else { throw ControlError.refuse("protected-app-changed") }
    try verifyApplications()
    guard image.width == width, image.height == height else { throw ControlError.refuse("screen-image-invalid") }
    var encoded: Data?
    for quality in [0.75, 0.55, 0.35, 0.2] {
        let buffer = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(buffer, UTType.jpeg.identifier as CFString, 1, nil) else { break }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { break }
        if buffer.length <= WindowCaptureLimits.jpegBytes { encoded = buffer as Data; break }
    }
    guard let encoded else { throw ControlError.refuse("screen-image-too-large") }
    _ = try safety(before)
    try verifyApplications()
    return ["mediaType": "image/jpeg", "data": encoded.base64EncodedString(), "width": image.width, "height": image.height,
            "displayWidth": selected.frame.width, "displayHeight": selected.frame.height, "displayId": selected.id,
            "originX": selected.frame.origin.x, "originY": selected.frame.origin.y]
}

/// Actual ScreenCaptureKit display capture. No TCC request or authorization is made here. The service must not call
/// this unless all closures above are backed by genuine, current OS evidence and the user approved screen access.
@MainActor
public func captureScopedDisplay(scope: ScopeApprovalScope, displayID: String, layout: [ScopedDisplayGeometry],
                                 checks: ScopedCaptureChecks) async throws -> [String: Any] {
    try await captureScopedDisplay(scope: scope, displayID: displayID, layout: layout, checks: checks,
                                   screenPermission: { CGPreflightScreenCaptureAccess() }, source: ScreenCaptureKitScopedDisplays())
}
