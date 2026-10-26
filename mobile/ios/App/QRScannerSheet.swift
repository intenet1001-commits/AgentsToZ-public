import SwiftUI
import VisionKit

struct QRScannerSheet: View {
    /// When set, only a QR this accepts is handed over: any other QR in view is skipped and `rejectedHint` shown while
    /// the scan goes on. Delivering the first QR seen let a neighbouring QR on the Mac's screen end a registration
    /// with 「등록 QR이 아닙니다」 (2026-10-25, iPad mini).
    var accepts: ((String) -> Bool)? = nil
    var rejectedHint: String? = nil
    var scanned: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var unavailable = false
    @State private var rejected = false
    var body: some View {
        NavigationStack {
            Group {
                if !unavailable && DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    ScannerView(accepts: accepts, scanned: scanned, rejected: { rejected = true }, unavailable: { unavailable = true })
                        .overlay(alignment: .bottom) {
                            if rejected, let rejectedHint {
                                Text(rejectedHint)
                                    .font(.subheadline)
                                    .padding(12)
                                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                                    .padding()
                                    .accessibilityIdentifier("scannerRejectedHint")
                            }
                        }
                } else {
                    ContentUnavailableView("카메라를 사용할 수 없습니다", systemImage: "camera",
                                           description: Text("설정에서 카메라 권한을 확인하거나 연결 주소를 직접 입력해 주세요."))
                }
            }
            .navigationTitle("Mac의 QR 스캔")
            .toolbar { Button("닫기") { dismiss() } }
        }
    }
}

private struct ScannerView: UIViewControllerRepresentable {
    let accepts: ((String) -> Bool)?
    let scanned: (String) -> Void
    let rejected: () -> Void
    let unavailable: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(accepts: accepts, scanned: scanned, rejected: rejected) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        // With a filter every QR in view is tracked, so the right one is found next to a wrong one.
        let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                                                   qualityLevel: .balanced, recognizesMultipleItems: accepts != nil,
                                                   isHighFrameRateTrackingEnabled: false, isGuidanceEnabled: true,
                                                   isHighlightingEnabled: true)
        controller.delegate = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
        if !controller.isScanning && !context.coordinator.delivered {
            do { try controller.startScanning() }
            catch { Task { @MainActor in unavailable() } }
        }
    }
    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
        controller.stopScanning(); controller.delegate = nil
    }
    @MainActor final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let accepts: ((String) -> Bool)?
        let scanned: (String) -> Void
        let rejected: () -> Void
        var delivered = false
        init(accepts: ((String) -> Bool)?, scanned: @escaping (String) -> Void, rejected: @escaping () -> Void) {
            self.accepts = accepts; self.scanned = scanned; self.rejected = rejected
        }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            scan(allItems, using: scanner)
        }
        func dataScanner(_ scanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            scan(allItems, using: scanner)
        }
        // A tracked QR can acquire its payload after didAdd. Both callbacks use the same bounded filter and delivery guard.
        private func scan(_ items: [RecognizedItem], using scanner: DataScannerViewController) {
            guard !delivered else { return }
            var skipped = false
            for item in items {
                guard case .barcode(let barcode) = item, let value = barcode.payloadStringValue, value.utf8.count <= 4096 else { continue }
                guard accepts?(value) ?? true else { skipped = true; continue }
                delivered = true; scanner.stopScanning(); scanned(value); return
            }
            if skipped { rejected() }
        }
    }
}
