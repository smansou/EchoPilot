// swift-tools-version: 5.9
import PackageDescription

// The signed PlatformHost helper is its own SwiftPM package so it can link the `Audio` package's
// `MicrophoneGraph` and `StandbyEnergySampler` without pulling in the ASR/WhisperKit graph the root
// `native/macos` manifest resolves. `swift build --package-path native/macos/Sources/PlatformHost`
// therefore works offline, next to `build.sh`, which produces the signed binary the desktop app
// probes for.
let package = Package(
    name: "PlatformHost",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../Audio"),
    ],
    targets: [
        .executableTarget(
            name: "PlatformHost",
            dependencies: [
                .product(name: "Audio", package: "Audio"),
            ],
            // `./` keeps the target on this package root: `main.swift`, `VoiceHost.swift` and the
            // remaining helper resources sit next to this manifest instead of an invented
            // `Sources/PlatformHost` level. (`./` and not `.` because the loop gate matches a
            // declared target path by string prefix, and `.` would render as `<package>/./`, which
            // no source path starts with.)
            path: "./",
            exclude: ["Package.swift", "README.md", "build.sh", ".gitignore", "Info.plist", "PlatformHost.entitlements"]
        ),
    ]
)
