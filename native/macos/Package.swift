// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "EchoPilotSecurity",
    platforms: [.macOS(.v13)],
    products: [
        // Spawned by the Electron main process with stdio pipes only: the helper registers its
        // capabilities through the private parent channel and listens on no socket or port.
        .executable(name: "echopilot-secrets", targets: ["Secrets"]),
    ],
    targets: [
        .executableTarget(name: "Secrets", path: "Sources/Secrets"),
    ]
)
