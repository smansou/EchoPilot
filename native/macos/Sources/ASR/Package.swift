// swift-tools-version: 5.9
import PackageDescription

// The V01 local-ASR half is a SwiftPM package of its own: Silero VAD, WhisperKit small.en, the
// rolling window planner and the session bridge. It depends on the Audio package next to it (the
// packetizer and bounded ring live there), so both modules are compiled and tested by the loop
// gates without the signed helper's Xcode project.
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
    ],
    dependencies: [
        .package(path: "../Audio"),
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
            dependencies: [.product(name: "Audio", package: "Audio")],
            // `./` keeps the target on the package root: this module's files sit next to this
            // manifest instead of an invented `Sources/ASR` level. (`./` and not `.` because the
            // loop gate matches a declared target path by string prefix, and `.` would render as
            // `<package>/./`, which no source path starts with.)
            path: "./",
            exclude: ["Package.swift", "README.md", ".gitignore", "Tests"]
        ),
    ]
)
