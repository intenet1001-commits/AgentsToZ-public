import UIKit
import SwiftUI
import UniformTypeIdentifiers
import ImageIO
import AgentsToZCore

/// "AgentsToZ VOC" in the Photos share sheet.
///
/// It only files the photos into the App Group outbox. It never sends anything (the relay keys
/// and the portal login live only in the app's WKWebView store) and never tries to launch the
/// app: the next time the app is in front it hands the photos to the portal's VOC composer.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.finish = { [weak self] saved in
            guard let context = self?.extensionContext else { return }
            if saved { context.completeRequest(returningItems: [], completionHandler: nil) }
            else { context.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) }
        }
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
            .filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
        model.load(providers)
    }
}

struct SharedPhoto: Identifiable {
    let id = UUID()
    var encoded: VocShareEncodedImage
    let thumbnail: UIImage?
}

@MainActor final class ShareModel: ObservableObject {
    enum Phase: Equatable { case loading, editing, saving, saved, failed(String) }
    @Published var phase: Phase = .loading
    @Published var photos: [SharedPhoto] = []
    @Published var notices: [String] = []
    @Published var comment = ""
    @Published var error: String?
    var finish: (Bool) -> Void = { _ in }

    func load(_ providers: [NSItemProvider]) {
        if providers.count > VocShareOutbox.maxImages {
            notices.append("사진은 최대 \(VocShareOutbox.maxImages)장까지 담을 수 있어 앞의 \(VocShareOutbox.maxImages)장만 담았습니다.")
        }
        let selected = Array(providers.prefix(VocShareOutbox.maxImages))
        Task {
            var failed = 0
            // One at a time: a share extension has a small memory budget and a full-size
            // decoded photo is tens of megabytes.
            for provider in selected {
                if let photo = await ShareImageLoader.load(provider) { photos.append(photo) } else { failed += 1 }
            }
            if failed > 0 { notices.append("사진 \(failed)장을 읽지 못해 제외했습니다.") }
            fitTotalSize()
            phase = photos.isEmpty ? .failed("공유한 사진을 읽지 못했습니다.") : .editing
        }
    }

    /// Keep the item under the outbox bound: shrink first, and only then drop photos.
    private func fitTotalSize() {
        func total() -> Int { photos.reduce(0) { $0 + $1.encoded.data.count } }
        guard total() > VocShareOutbox.maxTotalBytes else { return }
        for index in photos.indices {
            if let smaller = ShareImageLoader.reencode(photos[index].encoded, maxPixelSize: 1600, quality: 0.75) {
                photos[index].encoded = smaller
            }
        }
        var dropped = 0
        while total() > VocShareOutbox.maxTotalBytes, photos.count > 1 { photos.removeLast(); dropped += 1 }
        notices.append(dropped > 0
            ? "용량 제한(12MB) 때문에 사진 크기를 줄이고 마지막 \(dropped)장을 제외했습니다."
            : "용량 제한(12MB) 때문에 사진 크기를 줄였습니다.")
    }

    func save() {
        guard phase == .editing else { return }
        guard let outbox = VocShareOutbox.shared() else {
            error = "앱과 공유하는 저장 공간을 열지 못했습니다. AgentsToZ 앱을 다시 설치해 주세요."
            return
        }
        error = nil
        phase = .saving
        let images = photos.map(\.encoded)
        let text = String(comment.prefix(VocShareOutbox.maxCommentLength))
        Task.detached {
            let result: Result<VocShareItem, Error> = Result { try outbox.save(comment: text, images: images) }
            await MainActor.run {
                switch result {
                case .success: self.phase = .saved
                case .failure:
                    self.error = "사진을 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요."
                    self.phase = .editing
                }
            }
        }
    }
}

enum ShareImageLoader {
    static let maxPixelSize = 2400
    static let quality: CGFloat = 0.85

    /// HEIC/PNG/JPEG from Photos arrive as a file; other apps may hand over a URL, data or a UIImage.
    /// The provider stays on the main actor; decoding happens in the provider's callback queue.
    @MainActor
    static func load(_ provider: NSItemProvider) async -> SharedPhoto? {
        if let photo = await loadFile(provider) { return photo }
        return await loadItem(provider)
    }

    @MainActor
    private static func loadFile(_ provider: NSItemProvider) async -> SharedPhoto? {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
                // The file is deleted when this returns, so decode it here.
                let source = url.flatMap { CGImageSourceCreateWithURL($0 as CFURL, nil) }
                continuation.resume(returning: source.flatMap { photo(from: $0) })
            }
        }
    }

    @MainActor
    private static func loadItem(_ provider: NSItemProvider) async -> SharedPhoto? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, _ in
                var result: SharedPhoto?
                if let url = item as? URL, let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
                    result = photo(from: source)
                } else if let data = item as? Data, let source = CGImageSourceCreateWithData(data as CFData, nil) {
                    result = photo(from: source)
                } else if let image = item as? UIImage, let data = image.pngData(),
                          let source = CGImageSourceCreateWithData(data as CFData, nil) {
                    result = photo(from: source)
                }
                continuation.resume(returning: result)
            }
        }
    }

    /// Downscale with the orientation applied, then re-encode from pixels: the JPEG carries no
    /// EXIF, GPS or other metadata of the original.
    static func photo(from source: CGImageSource, maxPixelSize: Int = maxPixelSize, quality: CGFloat = quality) -> SharedPhoto? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let data = UIImage(cgImage: image).jpegData(compressionQuality: quality) else { return nil }
        let encoded = VocShareEncodedImage(data: data, width: image.width, height: image.height)
        return SharedPhoto(encoded: encoded, thumbnail: thumbnail(encoded.data))
    }

    static func reencode(_ encoded: VocShareEncodedImage, maxPixelSize: Int, quality: CGFloat) -> VocShareEncodedImage? {
        guard let source = CGImageSourceCreateWithData(encoded.data as CFData, nil) else { return nil }
        return photo(from: source, maxPixelSize: maxPixelSize, quality: quality)?.encoded
    }

    private static func thumbnail(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 240,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    @FocusState private var editing: Bool

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    ProgressView("사진을 준비하는 중").frame(maxWidth: .infinity, maxHeight: .infinity)
                case .saved:
                    ContentUnavailableView {
                        Label("VOC에 담았습니다", systemImage: "checkmark.circle")
                    } description: {
                        Text("AgentsToZ 앱을 열면 VOC 작성 화면에 사진이 담겨 있습니다.")
                    } actions: {
                        Button("확인") { model.finish(true) }.buttonStyle(.borderedProminent)
                    }
                    .task {
                        try? await Task.sleep(for: .seconds(2.5))
                        model.finish(true)
                    }
                case .failed(let message):
                    ContentUnavailableView("담지 못했습니다", systemImage: "exclamationmark.triangle", description: Text(message))
                default:
                    editor
                }
            }
            .navigationTitle("AgentsToZ VOC")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { model.finish(false) }.disabled(model.phase == .saving || model.phase == .saved)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") { editing = false; model.save() }
                        .disabled(model.phase != .editing || model.photos.isEmpty)
                }
            }
        }
    }

    private var editor: some View {
        Form {
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(model.photos) { photo in
                            Group {
                                if let thumbnail = photo.thumbnail {
                                    Image(uiImage: thumbnail).resizable().scaledToFill()
                                } else {
                                    Color.secondary.opacity(0.2)
                                }
                            }
                            .frame(width: 88, height: 88).clipShape(RoundedRectangle(cornerRadius: 8))
                            .accessibilityLabel("공유한 사진")
                        }
                    }.padding(.vertical, 4)
                }
            } header: {
                Text("사진 \(model.photos.count)장")
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(model.notices, id: \.self) { Text($0) }
                    if let error = model.error { Text(error).foregroundStyle(.red) }
                }
            }
            Section {
                TextField("무엇을 고치면 좋을까요? (선택)", text: $model.comment, axis: .vertical)
                    .lineLimit(4...10)
                    .focused($editing)
                    .disabled(model.phase == .saving)
            } header: {
                Text("고칠 내용")
            } footer: {
                Text("여기서는 보내지 않습니다. AgentsToZ 앱을 열면 VOC 작성 화면에 사진과 내용이 담기고, 그 화면에서 확인한 뒤 보냅니다.")
            }
            if model.phase == .saving { ProgressView("저장하는 중") }
        }
    }
}
