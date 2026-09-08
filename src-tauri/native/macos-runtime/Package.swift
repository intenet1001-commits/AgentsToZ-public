// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AgentsToZMacOSRuntime",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(
            name: "com.intenet.agentstozbycs.runtime-broker",
            targets: ["RuntimeBroker"]
        ),
        .executable(
            name: "com.intenet.agentstozbycs.runtime-broker-fixture",
            targets: ["RuntimeBrokerFixture"]
        ),
        .executable(
            name: "com.intenet.agentstozbycs.runtime-worker-fixture",
            targets: ["RuntimeWorkerFixture"]
        ),
        .executable(
            name: "com.intenet.agentstozbycs.runtime-dedicated-worker-fixture",
            targets: ["RuntimeDedicatedWorkerFixture"]
        ),
        .executable(
            name: "agentstoz-runtime-protocol-self-test",
            targets: ["RuntimeBrokerProtocolSelfTest"]
        ),
    ],
    targets: [
        .target(
            name: "RuntimeBrokerProtocol",
            linkerSettings: [
                .linkedFramework("Security"),
            ]
        ),
        .executableTarget(
            name: "RuntimeBroker",
            dependencies: ["RuntimeBrokerProtocol"],
            swiftSettings: [
                .unsafeFlags(["-parse-as-library"]),
            ],
            linkerSettings: [
                .linkedFramework("OpenDirectory"),
            ]
        ),
        .executableTarget(
            name: "RuntimeBrokerFixture",
            dependencies: ["RuntimeBrokerProtocol"],
            linkerSettings: [
                .linkedFramework("Security"),
            ]
        ),
        .executableTarget(
            name: "RuntimeWorkerFixture",
            dependencies: ["RuntimeBrokerProtocol"]
        ),
        .executableTarget(
            name: "RuntimeDedicatedWorkerFixture",
            dependencies: ["RuntimeBrokerProtocol"]
        ),
        .executableTarget(
            name: "RuntimeBrokerProtocolSelfTest",
            dependencies: ["RuntimeBrokerProtocol"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
