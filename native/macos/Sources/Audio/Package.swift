// swift-tools-version: 5.9
import PackageDescription

// The V01 capture half is a SwiftPM package of its own: the 20 ms PCM frame shape, the bounded
// transport ring, CoreAudio device enumeration, the explicit microphone permission probe and the
// `MicrophoneGraph` AVAudioEngine boundary. It builds and is validated without the signed helper's
// Xcode project, and the root `native/macos/Package.swift` keeps building only the signed
// `echopilot-secrets` helper.
//
// `.gitignore` next to this manifest keeps the package's scratch directory (`.build`) out of the
// repository, so a gate that runs `swift build --package-path native/macos/Sources/Audio` leaves
// the candidate tree untouched.
let package = Package(
    name: "Audio",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "Audio", targets: ["Audio"]),
    ],
    targets: [
        // Declared before the library target: the loop gate attributes a changed test file to the
        // first target whose declared path contains it, and the standby sampling regression must be
        // reported as a validated XCTest case (a `testTarget`), never as an executable script.
        .testTarget(
            name: "AudioTests",
            dependencies: ["Audio"],
            path: "Tests/AudioTests"
        ),
        .target(
            name: "Audio",
            // `./` keeps the target on the package root: this module's files sit next to this
            // manifest instead of an invented `Sources/Audio` level. (`./` and not `.` because the
            // loop gate matches a declared target path by string prefix, and `.` would render as
            // `<package>/./`, which no source path starts with.)
            path: "./",
            exclude: ["Package.swift", "README.md", ".gitignore", "Tests"]
        ),
    ]
)
