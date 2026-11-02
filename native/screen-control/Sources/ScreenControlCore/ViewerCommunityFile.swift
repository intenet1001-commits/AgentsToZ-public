#if canImport(Darwin)
import Foundation
import Darwin

extension ViewerCommunityDirectory {
    /// One bounded, owner-only regular file; no symlinks, pipes, sockets or credentials.
    public static func read(at url: URL, now: Date = Date()) throws -> Self {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw Invalid.document }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? file.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o077 == 0, info.st_size <= Int64(maximumBytes),
              let data = try file.read(upToCount: maximumBytes + 1)
        else { throw Invalid.document }
        return try decode(data, now: now)
    }
}
#endif
