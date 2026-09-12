// swift-tools-version: 5.9
import PackageDescription

// The V01 local-ASR half is a SwiftPM package of its own: Silero VAD, WhisperKit small.en, the
// rolling window planner and the session bridge. It depends on the Audio package next to it (the
// packetizer and bounded ring live there) and on WhisperKit itself, so the local engine is a real
// linked backend here and not only behind a `canImport` that never fires.
//
// `echopilot-voice` is the production entry point of this half: it registers the CoreML Silero
// backend and instantiates `VoiceTracerBridge` with the pinned WhisperKit small.en pack
// (`Sources/ASR/VoiceHost/main.swift`, mirrored by the root `native/macos/Package.swift`).
//
// The test target is intentionally declared before the library target: the loop gate attributes a
// changed `Sources/**/Tests/*.swift` file to the first target whose declared path contains it, and
// the native regression must be reported as a validated XCTest case (a `testTarget`), never as an
// executable script. `.gitignore` keeps this package's `.build` scratch directory out of the tree.
let package = Package(
    name: "ASR",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ASR", targets: ["ASR"]),
        .executable(name: "echopilot-voice", targets: ["VoiceHost"]),
    ],
    dependencies: [
        .package(path: "../Audio"),
        // Pinned so `canImport(WhisperKit)` is true for the local engine and `transcribe(_:)`
        // cannot silently fall back to `ASRError.backendUnavailable`. Resolved offline: the model
        // pack stays on disk, `download` is false and no audio ever leaves the machine.
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", exact: "1.1.0"),
    ],
    targets: [
        .testTarget(
            name: "ASRTests",
            dependencies: ["ASR", .product(name: "Audio", package: "Audio")],
            path: "Tests",
            exclude: ["README.md"]
        ),
        .target(
            name: "ASR",
            dependencies: [
                .product(name: "Audio", package: "Audio"),
                .product(name: "WhisperKit", package: "WhisperKit"),
            ],
            // `./` keeps the target on the package root: this module's files sit next to this
            // manifest instead of an invented `Sources/ASR` level. (`./` and not `.` because the
            // loop gate matches a declared target path by string prefix, and `.` would render as
            // `<package>/./`, which no source path starts with.)
            path: "./",
            exclude: ["Package.swift", "README.md", ".gitignore", "Tests", "VoiceHost"]
        ),
        .executableTarget(
            name: "VoiceHost",
            dependencies: [
                "ASR",
                .product(name: "Audio", package: "Audio"),
            ],
            path: "VoiceHost"
        ),
    ]
)
