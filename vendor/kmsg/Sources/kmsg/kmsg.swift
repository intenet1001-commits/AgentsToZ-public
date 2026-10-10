import ArgumentParser
import Foundation

private func invokedCommandName() -> String {
    let executable = CommandLine.arguments.first ?? "kmsg"
    let name = URL(fileURLWithPath: executable).lastPathComponent
    return name.isEmpty ? "kmsg" : name
}

@main
struct Kmsg: ParsableCommand {
    private static let commandName = invokedCommandName()

    static let configuration = CommandConfiguration(
        commandName: commandName,
        abstract: "A CLI tool for KakaoTalk on macOS",
        discussion: "App-private AgentsToZ KakaoTalk transport. Updated only with the app.",
        version: BuildVersion.current,
        subcommands: [StatusCommand.self, ChatsCommand.self, SendCommand.self, ReadCommand.self],
        defaultSubcommand: StatusCommand.self
    )

    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.count == 1, arguments[0] == "-v" {
            print(BuildVersion.current)
            return
        }
        self.main(arguments)
    }
}
