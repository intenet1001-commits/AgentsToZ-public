// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentsToZCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "AgentsToZCore", targets: ["AgentsToZCore"]),
               .executable(name: "RemoteProbe", targets: ["RemoteProbe"])],
    targets: [.target(name: "AgentsToZCore"),
              .executableTarget(name: "RemoteProbe", dependencies: ["AgentsToZCore"]),
              .testTarget(name: "AgentsToZCoreTests", dependencies: ["AgentsToZCore"])]
)
