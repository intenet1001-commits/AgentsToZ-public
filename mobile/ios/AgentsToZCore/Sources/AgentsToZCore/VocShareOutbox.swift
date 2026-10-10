import Foundation

/// One photo the share extension already re-encoded (JPEG, metadata stripped, long edge bounded).
public struct VocShareEncodedImage: Sendable, Equatable {
    public let data: Data
    public let width: Int
    public let height: Int
    public init(data: Data, width: Int, height: Int) { self.data = data; self.width = width; self.height = height }
}

public struct VocShareImageEntry: Codable, Sendable, Equatable {
    public let file: String
    public let mime: String
    public let bytes: Int
    public let width: Int
    public let height: Int
}

/// `voc-outbox/<id>/item.json`. The extension only writes; the app hands it to the portal page.
public struct VocShareItem: Codable, Sendable, Equatable {
    public let id: String
    public let createdAt: String
    public let comment: String
    public let images: [VocShareImageEntry]
}

public enum VocShareOutboxError: Error, Equatable {
    case noImages, tooManyImages, tooLarge, commentTooLong, invalidItem
}

/// The hand-off between the share extension and the app, inside the shared App Group container.
///
/// The extension never sends anything: the relay keys and the portal session live only in the
/// app's WKWebView store. It writes a complete item into a hidden temporary directory and renames
/// it into place, so the app can never observe a half-written item.
public struct VocShareOutbox: Sendable {
    public static let directoryName = "voc-outbox"
    public static let maxImages = 5
    public static let maxItems = 10
    public static let maxAge: TimeInterval = 7 * 24 * 60 * 60
    public static let maxTotalBytes = 12 * 1024 * 1024
    public static let maxCommentLength = 4_000
    /// The Info.plist key both targets carry: `group.$(AGENTSTOZ_APP_BUNDLE_ID)`.
    public static let appGroupInfoKey = "AgentsToZAppGroup"
    private static let temporaryPrefix = ".tmp-"
    private static let staleTemporaryAge: TimeInterval = 60 * 60

    public let root: URL

    public init(root: URL) { self.root = root }

    /// The outbox in the App Group named by this bundle's Info.plist, or nil when the group
    /// entitlement is missing (unsigned build, or the group is not registered for the team).
    public static func shared(bundle: Bundle = .main) -> VocShareOutbox? {
        guard let group = bundle.object(forInfoDictionaryKey: appGroupInfoKey) as? String,
              group.hasPrefix("group."), !group.contains("$("),
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return VocShareOutbox(root: container.appendingPathComponent(directoryName, isDirectory: true))
    }

    @discardableResult
    public func save(comment: String, images: [VocShareEncodedImage], now: Date = Date()) throws -> VocShareItem {
        guard !images.isEmpty else { throw VocShareOutboxError.noImages }
        guard images.count <= Self.maxImages else { throw VocShareOutboxError.tooManyImages }
        guard images.reduce(0, { $0 + $1.data.count }) <= Self.maxTotalBytes else { throw VocShareOutboxError.tooLarge }
        let text = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count <= Self.maxCommentLength else { throw VocShareOutboxError.commentTooLong }
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let id = UUID().uuidString.lowercased()
        // The creation second is in the name so a crashed write can be expired without reading
        // file timestamps (a required-reason API the extension would otherwise have to declare).
        let temporary = root.appendingPathComponent(Self.temporaryPrefix + String(Int(now.timeIntervalSince1970)) + "-" + id, isDirectory: true)
        try fm.createDirectory(at: temporary, withIntermediateDirectories: false)
        do {
            var entries: [VocShareImageEntry] = []
            for (index, image) in images.enumerated() {
                let file = "\(index + 1).jpg"
                try image.data.write(to: temporary.appendingPathComponent(file), options: .atomic)
                entries.append(VocShareImageEntry(file: file, mime: "image/jpeg", bytes: image.data.count, width: image.width, height: image.height))
            }
            let item = VocShareItem(id: id, createdAt: now.formatted(.iso8601), comment: text, images: entries)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(item).write(to: temporary.appendingPathComponent("item.json"), options: .atomic)
            // rename(2) of a directory on one volume: the item appears whole or not at all.
            try fm.moveItem(at: temporary, to: root.appendingPathComponent(id, isDirectory: true))
            prune(now: now)
            return item
        } catch {
            try? fm.removeItem(at: temporary)
            throw error
        }
    }

    /// Valid items, oldest first. Expired, surplus and malformed items are removed on the way.
    public func pending(now: Date = Date()) -> [VocShareItem] {
        prune(now: now)
        return validItems(now: now).map(\.item)
    }

    public func remove(id: String) {
        guard Self.isItemID(id) else { return }
        try? FileManager.default.removeItem(at: root.appendingPathComponent(id, isDirectory: true))
    }

    /// The image bytes of a pending item, checked against what item.json promised.
    public func imageData(for item: VocShareItem) throws -> [(entry: VocShareImageEntry, data: Data)] {
        guard Self.isItemID(item.id) else { throw VocShareOutboxError.invalidItem }
        let directory = root.appendingPathComponent(item.id, isDirectory: true)
        return try item.images.map { entry in
            let data = try Data(contentsOf: directory.appendingPathComponent(entry.file))
            guard data.count == entry.bytes else { throw VocShareOutboxError.invalidItem }
            return (entry, data)
        }
    }

    /// The `detail` of the page's `agentstoz-voc-share` event. Plain JSON types only, so it goes
    /// through JSONSerialization and user text is never concatenated into JavaScript.
    public func eventDetail(for item: VocShareItem) throws -> [String: Any] {
        let images: [[String: Any]] = try imageData(for: item).map { pair in
            ["name": pair.entry.file, "mime": pair.entry.mime, "dataBase64": pair.data.base64EncodedString()]
        }
        return ["id": item.id, "createdAt": item.createdAt, "comment": item.comment, "images": images]
    }

    public func prune(now: Date = Date()) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return }
        for name in names where name.hasPrefix(Self.temporaryPrefix) {
            // `.tmp-<epoch>-<uuid>`: an abandoned write (the extension was killed) older than an hour.
            let parts = name.dropFirst(Self.temporaryPrefix.count).split(separator: "-", maxSplits: 1)
            let started = parts.first.flatMap { Double($0) }.map(Date.init(timeIntervalSince1970:))
            if started.map({ now.timeIntervalSince($0) > Self.staleTemporaryAge || $0.timeIntervalSince(now) > Self.staleTemporaryAge }) ?? true {
                try? fm.removeItem(at: root.appendingPathComponent(name))
            }
        }
        let valid = validItems(now: now, removingInvalid: true)
        for surplus in valid.dropLast(Self.maxItems) { remove(id: surplus.item.id) }
    }

    private func validItems(now: Date, removingInvalid: Bool = false) -> [(item: VocShareItem, created: Date)] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return [] }
        var result: [(item: VocShareItem, created: Date)] = []
        for name in names where !name.hasPrefix(".") {
            let directory = root.appendingPathComponent(name, isDirectory: true)
            if let item = Self.load(directory: directory, name: name),
               let created = try? Date(item.createdAt, strategy: .iso8601),
               now.timeIntervalSince(created) <= Self.maxAge {
                result.append((item, created))
            } else if removingInvalid {
                try? fm.removeItem(at: directory)
            }
        }
        return result.sorted { $0.created == $1.created ? $0.item.id < $1.item.id : $0.created < $1.created }
    }

    private static func load(directory: URL, name: String) -> VocShareItem? {
        guard isItemID(name),
              let data = try? Data(contentsOf: directory.appendingPathComponent("item.json")), data.count <= 64 * 1024,
              let item = try? JSONDecoder().decode(VocShareItem.self, from: data),
              item.id == name, !item.images.isEmpty, item.images.count <= maxImages,
              item.comment.count <= maxCommentLength,
              item.images.reduce(0, { $0 + $1.bytes }) <= maxTotalBytes else { return nil }
        for (index, entry) in item.images.enumerated() {
            guard entry.file == "\(index + 1).jpg", entry.mime == "image/jpeg", entry.bytes > 0,
                  entry.width > 0, entry.height > 0 else { return nil }
        }
        return item
    }

    static func isItemID(_ value: String) -> Bool {
        value.count == 36 && UUID(uuidString: value) != nil && value == value.lowercased()
    }
}
