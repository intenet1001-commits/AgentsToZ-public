// swift-tools-version: 6.0
import PackageDescription

// Shared by the Mac screen host (AgentsToZ Screen) and the iPhone/iPad viewer.
// Design: docs/design/screen-control-2026-10-24/DESIGN.md
let package = Package(
    name: "ScreenControlCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ScreenControlCore", targets: ["ScreenControlCore"]),
               .executable(name: "AgentsToZScreen", targets: ["AgentsToZScreen"])],
    targets: [.target(name: "ScreenControlCore"),
              // Mac only: screen capture and the host pipeline. `scripts/build-screen-app.ts` wraps the executable
              // into AgentsToZ Screen.app, the one bundle that holds screen recording permission (DESIGN S0-5).
              .target(name: "ScreenHost", dependencies: ["ScreenControlCore"]),
              .executableTarget(name: "AgentsToZScreen", dependencies: ["ScreenControlCore", "ScreenHost"]),
              .testTarget(name: "ScreenControlCoreTests", dependencies: ["ScreenControlCore"]),
              .testTarget(name: "ScreenHostTests", dependencies: ["ScreenHost", "ScreenControlCore"])]
)
