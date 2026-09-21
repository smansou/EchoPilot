// swift-tools-version: 5.9
import PackageDescription

// C02's native half is a SwiftPM package of its own, like `Sources/Audio` and `Sources/ASR`: the
// Accessibility adapter (target identity and fingerprints, guards, one AX write, read-back
// verification) and the `echopilot-desktop` stdio helper the Electron main process spawns for a
// granted desktop action. It builds and is tested without the signed helper's Xcode project, and
// the root `native/macos/Package.swift` keeps building only the products already wired there.
//
// The test target is declared first: the loop gate attributes a changed `Tests/**` file to the
// first target whose declared path contains it, and the native regression must be reported as a
// validated XCTest case, never as an executable script. `.gitignore` next to this manifest keeps
// the package's `.build` scratch directory out of the repository.
let package = Package(
    name: "Accessibility",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "DesktopAX", targets: ["DesktopAX"]),
        // Spawned by the Electron main process with stdio pipes only: the helper registers its
        // capabilities through the private parent channel and listens on no socket or port.
        .executable(name: "echopilot-desktop", targets: ["EchoPilotDesktop"]),
    ],
    targets: [
        .testTarget(
            name: "DesktopAXTests",
            dependencies: ["DesktopAX"],
            path: "Tests/DesktopAXTests"
        ),
        .target(
            name: "DesktopAX",
            path: "Sources/Accessibility"
        ),
        .executableTarget(
            name: "EchoPilotDesktop",
            dependencies: ["DesktopAX"],
            path: "Sources/echopilot-desktop"
        ),
    ]
)
