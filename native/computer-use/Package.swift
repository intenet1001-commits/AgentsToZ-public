// swift-tools-version: 6.2
import PackageDescription

// AgentsToZ Control (native/computer-use/CONTRACT.md). The engine runs inside the signed sibling app's own process
// (`agentstoz-control`, packaged as `AgentsToZ Control.app` by scripts/build-computer-use-control-app.ts). The child
// worker `agentstoz-computer-use` wraps the same engine for labs and tests only; the bundled sidecar refuses to start it.
let peekaboo: [Target.Dependency] = [.product(name: "PeekabooAutomationKit", package: "Peekaboo"),
                                     .product(name: "PeekabooFoundation", package: "Peekaboo")]
let package = Package(
    name: "AgentsToZComputerUse",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "agentstoz-control", targets: ["AgentsToZControl"]),
               .executable(name: "agentstoz-computer-use", targets: ["ComputerUseWorker"]),
               .library(name: "ComputerUseApproval", targets: ["ComputerUseApproval"]),
               .library(name: "ComputerUseControlCore", targets: ["ComputerUseControlCore"]),
               // Own-fixture integration check only; never bundled or selected by an agent request.
               .executable(name: "agentstoz-computer-use-native-lab", targets: ["ComputerUseNativeLab"]),
               // Lab only: checks the approval byte format and signature against the TypeScript verifier.
               .executable(name: "agentstoz-computer-use-approval-lab", targets: ["ComputerUseApprovalLab"])],
    dependencies: [.package(url: "https://github.com/openclaw/Peekaboo.git",
                            revision: "5639e70501010ca9dcae5f594a0b57dd69e9b395")],
    targets: [.target(name: "ComputerUseApproval"),
              // Pure contract and state: Foundation only, also compiled alone by scripts/check-computer-use-control.ts.
              .target(name: "ComputerUseControlCore", dependencies: ["ComputerUseApproval"]),
              .target(name: "ComputerUseEngine", dependencies: ["ComputerUseApproval", "ComputerUseControlCore"] + peekaboo),
              .executableTarget(name: "AgentsToZControl", dependencies: ["ComputerUseApproval", "ComputerUseControlCore",
                                                                           "ComputerUseEngine"]),
              .executableTarget(name: "ComputerUseWorker", dependencies: ["ComputerUseApproval", "ComputerUseControlCore",
                                                                            "ComputerUseEngine"]),
              .executableTarget(name: "ComputerUseApprovalLab", dependencies: ["ComputerUseApproval"]),
              .executableTarget(name: "ComputerUseNativeLab", dependencies: ["ComputerUseEngine", "ComputerUseControlCore"]),
              .testTarget(name: "ComputerUseControlCoreTests", dependencies: ["ComputerUseControlCore", "ComputerUseApproval"],
                          path: "Tests/ComputerUseControlCoreChecks"),
              .testTarget(name: "ComputerUseEngineTests", dependencies: ["ComputerUseEngine", "ComputerUseControlCore", "ComputerUseApproval"],
                          path: "Tests/ComputerUseEngineTests")])
