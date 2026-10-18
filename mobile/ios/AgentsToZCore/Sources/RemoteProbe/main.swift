import Foundation
import AgentsToZCore

@main struct RemoteProbe {
    static func main() async {
        let client = LANClient()
        do {
            // Fixture QR enters through stdin, never process arguments or logs.
            guard let input = readLine(), input.utf8.count <= 4096 else { throw RemoteFailure.invalidQR }
            let pairing = try LANPairing(scanned: input)
            if CommandLine.arguments.contains("--fixture-cancel") {
                let pending = Task { try await client.connect(pairing) }
                try await Task.sleep(for: .milliseconds(100))
                pending.cancel()
                do { _ = try await pending.value; throw RemoteFailure.invalidResponse }
                catch RemoteFailure.invalidResponse { throw RemoteFailure.invalidResponse }
                catch { /* Expected cancellation of unanswered connection. */ }
                await client.disconnect()
                print("{\"cancelled\":true}")
                return
            }
            if CommandLine.arguments.contains("--fixture-resume") {
                // The morning case: pair, lose the socket the way backgrounding does, then come
                // back on a new socket with the stored session token and no new QR.
                let first = try await client.connect(pairing)
                await client.suspend()
                guard await client.canResume(origin: pairing.origin) else { throw RemoteFailure.invalidResponse }
                let again = try await client.resume(origin: pairing.origin)
                guard again.projectCount == first.projectCount else { throw RemoteFailure.invalidResponse }
                // Ending on purpose must forget the token; the next launch has nothing to resume.
                await client.disconnect()
                guard await client.canResume(origin: pairing.origin) == false else { throw RemoteFailure.invalidResponse }
                print("{\"resumed\":true,\"projectCount\":\(again.projectCount)}")
                return
            }
            let ready = try await client.connect(pairing)
            let refreshed = try await client.refresh()
            guard ready.projectCount == refreshed.projectCount else { throw RemoteFailure.invalidResponse }
            if CommandLine.arguments.contains("--fixture-action") {
                guard let project = refreshed.projects.first else { throw RemoteFailure.invalidResponse }
                try await client.perform(.start, controlID: project.id)
                let after = try await client.refresh()
                guard after.projects.first?.status == "running" else { throw RemoteFailure.invalidResponse }
            }
            await client.disconnect()
            print("{\"connected\":true,\"refreshed\":true,\"projectCount\":\(ready.projectCount)}")
        } catch {
            await client.disconnect()
            FileHandle.standardError.write(Data("Native remote probe failed.\n".utf8))
            exit(1)
        }
    }
}
