import SwiftUI
import VisionKit

struct QRScannerSheet: View {
    var scanned: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var unavailable = false
    var body: some View {
        NavigationStack {
            Group {
                if !unavailable && DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    ScannerView(scanned: scanned, unavailable: { unavailable = true })
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
    let scanned: (String) -> Void
    let unavailable: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(scanned: scanned) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                                                   qualityLevel: .balanced, recognizesMultipleItems: false,
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
        let scanned: (String) -> Void
        var delivered = false
        init(scanned: @escaping (String) -> Void) { self.scanned = scanned }
        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !delivered else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let value = barcode.payloadStringValue, value.utf8.count <= 4096 {
                    delivered = true; scanner.stopScanning(); scanned(value); return
                }
            }
        }
    }
}
