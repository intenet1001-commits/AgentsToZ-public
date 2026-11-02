#if os(macOS)
import AppKit
import XCTest
import ScreenControlCore
@testable import AgentsToZViewer

private final class EmptyTargets: ViewerTargetsBackend, @unchecked Sendable {
    private(set) var writes = 0
    func read() throws -> Data? { nil }
    func write(_ data: Data) throws { writes += 1 }
}

final class TargetListChecks: XCTestCase {
    @MainActor func testRefusedRegistrationActionIsVisibleInsideTheCommunitySheet() throws {
        _ = NSApplication.shared
        let account = ViewerCommunityAccount()
        let actual = ViewerCommunitySheet(account: account)
        let previous = HumanActions.shared.refused
        HumanActions.shared.refused = { account.inputRefused($0) }
        defer { HumanActions.shared.refused = previous; actual.close() }
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let create = try XCTUnwrap(descendants(actual.window.contentView!).compactMap { $0 as? HumanButton }.first { $0.title == "첫 관리 Mac으로 커뮤니티 만들기" })
        XCTAssertFalse(create.accessibilityPerformPress())
        XCTAssertTrue(account.message.contains("not-the-control"))
        XCTAssertTrue(descendants(actual.window.contentView!).compactMap { $0 as? NSTextField }.contains { $0.stringValue.contains("인증을 시작하지 않았습니다") })
        XCTAssertFalse(actual.window.isVisible)
    }
    @MainActor func testCommunityRegistrationSheetRendersOffscreenAndKeepsContentAtTheTop() throws {
        _ = NSApplication.shared
        let sheet = ViewerCommunitySheet(account: ViewerCommunityAccount())
        sheet.window.appearance = NSAppearance(named: .aqua)
        defer { sheet.close() }
        let scroll = try XCTUnwrap(sheet.window.contentView as? NSScrollView)
        scroll.drawsBackground = true; scroll.backgroundColor = .windowBackgroundColor
        scroll.layoutSubtreeIfNeeded()
        let document = try XCTUnwrap(scroll.documentView)
        XCTAssertTrue(document.isFlipped); XCTAssertGreaterThan(document.frame.height, 100)
        XCTAssertEqual(document.frame.width, scroll.contentView.bounds.width, accuracy: 1)
        XCTAssertFalse(sheet.window.isVisible)
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let title = try XCTUnwrap(descendants(document).compactMap { $0 as? NSTextField }.first { $0.stringValue == "커뮤니티에 한 번 등록하고 함께 연결" })
        let titleRect = title.convert(title.bounds, to: document)
        XCTAssertLessThan(titleRect.minY, 50)
        let root = FileManager.default.temporaryDirectory.appending(path: "agentstoz-community-sheet-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for (appearance, filename) in [(NSAppearance.Name.aqua, "community-ready-light.png"), (.darkAqua, "community-ready-dark.png")] {
            sheet.window.appearance = NSAppearance(named: appearance)
            var rendered: Data?
            sheet.window.appearance?.performAsCurrentDrawingAppearance {
                if let bitmap = scroll.bitmapImageRepForCachingDisplay(in: scroll.bounds) {
                    scroll.cacheDisplay(in: scroll.bounds, to: bitmap)
                    rendered = bitmap.representation(using: .png, properties: [:])
                }
            }
            try XCTUnwrap(rendered).write(to: root.appending(path: filename))
        }
        print("COMMUNITY_RENDER_DIR=\(root.path)")
    }
    @MainActor func testGuideWaitsForExplicitSearchAndOffersBoundedRecovery() async throws {
        _ = NSApplication.shared
        var discoveries = 0, stops = 0, keys = 0
        let stream = AsyncStream<[ControllerPairingWindowListing]>.makeStream()
        enum Unexpected: Error { case key }
        let model = PairingSheetModel(dependencies: PairingSheetDependencies(
            makeKey: { keys += 1; throw Unexpected.key }, attest: { _ in nil }, name: { "Mac" }, model: { "Mac" },
            makeDiscovery: { discoveries += 1; return PairingDiscoverySession(listings: stream.stream, start: {}, stop: { stops += 1 }) },
            discoveryTimeout: .milliseconds(40)), onPaired: { _, _, _ in XCTFail("discovery enrolled a Mac"); return nil })
        let sheet = PairingSheetController(model: model, communityName: "아젠투지3호-회사 / 아젠투지(OPS)")
        let renderRoot = FileManager.default.temporaryDirectory.appending(path: "agentstoz-viewer-guide-render-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: renderRoot, withIntermediateDirectories: true)
        sheet.window.appearance = NSAppearance(named: .aqua)
        func render(_ name: String) throws {
            let content = try XCTUnwrap(sheet.window.contentView)
            content.layoutSubtreeIfNeeded()
            content.wantsLayer = true
            var result: Result<Data, Error>?
            sheet.window.appearance?.performAsCurrentDrawingAppearance {
                result = Result {
                    content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
                    let bitmap = try XCTUnwrap(content.bitmapImageRepForCachingDisplay(in: content.bounds))
                    content.cacheDisplay(in: content.bounds, to: bitmap)
                    return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                }
            }
            try XCTUnwrap(result).get().write(to: renderRoot.appending(path: name))
        }
        defer { sheet.close(); stream.continuation.finish() }
        func all(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(all) }
        func views() -> [NSView] { all(sheet.window.contentView!) }
        XCTAssertEqual(model.searchState, .idle)
        XCTAssertEqual(discoveries, 0)
        XCTAssertFalse(views().contains { $0 is NSProgressIndicator })
        XCTAssertTrue(views().contains { ($0 as? NSTextField)?.stringValue == "아젠투지3호-회사 등록 안내" })
        XCTAssertTrue(views().contains { ($0 as? NSTextField)?.stringValue.contains("인터넷으로 처음 등록하는 기능은 아직 지원하지 않습니다") == true })
        XCTAssertFalse(views().contains { ($0 as? NSTextField)?.stringValue.contains("B에서") == true })
        try render("guide-ready.png")
        let search = try XCTUnwrap(views().compactMap { $0 as? PresentationButton }.first { $0.title == "등록 창 찾기" })
        XCTAssertEqual(search.keyEquivalent, "\r")
        search.performClick(nil)
        XCTAssertEqual(discoveries, 1)
        XCTAssertEqual(model.searchState, .searching)
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while model.searchState == .searching, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.searchState, .finished)
        XCTAssertEqual(stops, 1)
        XCTAssertEqual(keys, 0)
        XCTAssertFalse(views().contains { $0 is NSProgressIndicator })
        XCTAssertTrue(views().contains { ($0 as? NSTextField)?.stringValue == "등록 창을 찾지 못했습니다" })
        XCTAssertTrue(views().contains { ($0 as? PresentationButton)?.title == "다시 찾기" })
        XCTAssertFalse(sheet.window.isVisible)
        XCTAssertLessThan(sheet.window.contentView!.fittingSize.height, 700)
        let close = try XCTUnwrap(views().compactMap { $0 as? PresentationButton }.first { $0.title == "닫기" })
        XCTAssertEqual(close.keyEquivalent, "\u{1b}")
        try render("guide-not-found.png")
        print("GUIDE_RENDER_DIR=\(renderRoot.path)")
    }

    @MainActor func testManyDiscoveryResultsStayScrollableAndClosingCancelsTheDeadline() async throws {
        _ = NSApplication.shared
        let stream = AsyncStream<[ControllerPairingWindowListing]>.makeStream()
        var stops = 0
        enum Unexpected: Error { case key }
        let model = PairingSheetModel(dependencies: PairingSheetDependencies(
            makeKey: { throw Unexpected.key }, attest: { _ in nil }, name: { "Mac" }, model: { "Mac" },
            makeDiscovery: { PairingDiscoverySession(listings: stream.stream, start: {}, stop: { stops += 1 }) },
            discoveryTimeout: .seconds(2)), onPaired: { _, _, _ in XCTFail("discovery enrolled a Mac"); return nil })
        let sheet = PairingSheetController(model: model)
        defer { sheet.close(); stream.continuation.finish() }
        model.startBrowsing()
        let listings = (0..<20).map { index in
            ControllerPairingWindowListing(serviceName: ControllerPairingProtocol.serviceName(
                windowID: Data(repeating: UInt8(index), count: ControllerPairingProtocol.windowIDSize)), txt: ["pv": "1", "n": "Test Mac \(index)"])!
        }
        stream.continuation.yield(listings)
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while model.listings.count != 20, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(model.listings.count, 20)
        func all(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(all) }
        let scroll = try XCTUnwrap(all(sheet.window.contentView!).compactMap { $0 as? NSScrollView }.first)
        sheet.window.contentView?.layoutSubtreeIfNeeded()
        XCTAssertLessThanOrEqual(scroll.frame.height, 180)
        XCTAssertTrue(scroll.hasVerticalScroller)
        sheet.close()
        XCTAssertEqual(stops, 1)
        XCTAssertEqual(model.searchState, .finished)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(stops, 1)
        XCTAssertFalse(sheet.window.isVisible)
    }

    func testCommunityLabelsArePresentationOnlyAndKeepTheActualResponseTime() {
        XCTAssertEqual(ViewerCommunityText.deviceName("아젠투지3호 / 아젠투지(OPS)"), "아젠투지3호")
        XCTAssertEqual(ViewerCommunityText.deviceName("내 Mac / 프로젝트"), "내 Mac / 프로젝트")
        XCTAssertEqual(ViewerCommunityText.lastResponse(nil), "최근 응답 시각 없음")
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let text = ViewerCommunityText.lastResponse(now.addingTimeInterval(-120), timeZone: TimeZone(secondsFromGMT: 0)!)
        XCTAssertEqual(text, "최근 응답: 2023년 11월 14일 22:11")
    }

    @MainActor func testGuideCanCloseWithoutAProofWhileEnrollmentStaysGuarded() throws {
        _ = NSApplication.shared
        var keysMade = 0, closed = false, enrolled = false
        enum Unexpected: Error { case key }
        let model = PairingSheetModel(dependencies: PairingSheetDependencies(
            makeKey: { keysMade += 1; throw Unexpected.key }, attest: { _ in nil }, name: { "Mac" }, model: { "Mac" }),
            onPaired: { _, _, _ in enrolled = true; return nil })
        let sheet = PairingSheetController(model: model, communityName: "아젠투지 1호")
        sheet.closed = { closed = true }
        func all(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(all) }
        let views = all(try XCTUnwrap(sheet.window.contentView))
        let close = try XCTUnwrap(views.compactMap { $0 as? PresentationButton }.first { $0.title == "닫기" })
        XCTAssertFalse(sheet.window.isVisible)
        close.performClick(nil)
        XCTAssertTrue(closed)
        XCTAssertEqual(keysMade, 0)
        XCTAssertFalse(enrolled)
        var selected = false
        let protected = HumanButton(title: "이 창 고르기") { _ in selected = true }
        protected.performClick(nil)
        XCTAssertFalse(selected)
    }

    @MainActor func testDiscoveryLayoutRefreshesWithoutShowingAWindowOrWritingEnrollment() throws {
        _ = NSApplication.shared
        let backend = EmptyTargets()
        let data = Data("""
        {"schemaVersion":1,"generatedAt":1700000000000,"expiresAt":1700000090000,"inside":true,
         "devices":[{"ref":"0123456789abcdef","name":"커뮤니티 Mac 1호","lastSeenAt":null}]}
        """.utf8)
        let directory = try ViewerCommunityDirectory.decode(data, now: Date(timeIntervalSince1970: 1_700_000_000))
        let controller = TargetListController(ledger: ViewerTargetsLedger(backend: backend), communityDirectory: { directory })
        for _ in 0..<3 { controller.refresh(); controller.window.contentView?.layoutSubtreeIfNeeded() }
        func all(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(all) }
        let views = all(try XCTUnwrap(controller.window.contentView))
        XCTAssertTrue(views.contains { ($0 as? NSTextField)?.stringValue == "커뮤니티 Mac 1호" })
        XCTAssertEqual(views.compactMap { $0 as? PresentationButton }.filter { $0.title == "Mac 추가…" }.count, 1)
        XCTAssertEqual(views.compactMap { $0 as? PresentationButton }.filter { $0.title == "화면 등록 안내…" }.count, 1)
        XCTAssertEqual(backend.writes, 0)
        XCTAssertNil(controller.active)
        XCTAssertFalse(controller.window.isVisible)
        controller.window.close()
    }
}
#endif
