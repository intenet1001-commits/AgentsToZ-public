#if os(macOS)
import Foundation
import ScreenControlCore

enum ViewerCommunityReader {
    static func read() throws -> ViewerCommunityDirectory {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return try ViewerCommunityDirectory.read(at: base.appending(path: "com.portmanager.portmanager/viewer-community.json"))
    }
}
#endif
