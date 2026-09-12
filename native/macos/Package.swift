// swift-tools-version: 5.9
import PackageDescription

// The macOS native workspace. It builds the signed `echopilot-secrets` helper and the local voice
// tracer `echopilot-voice` (V01: Speak → native audio → local ASR → widget transcript → mute).
//
// `echopilot-voice` is the production wiring of the voice half: it links the `Audio` package
// (microphone graph, 20 ms packetizer, bounded ring), the `ASR` package (Silero VAD, WhisperKit
// small.en, window planner, `VoiceTracerBridge`) and, transitively, the pinned WhisperKit backend
// itself. Both packages keep their own `.build`/`Package.resolved` scratch out of the tree.
let package = Package(
    name: "EchoPilotNative",
    platforms: [.macOS(.v13)],
    products: [
        // Spawned by the Electron main process with stdio pipes only: the helper registers its
        // capabilities through the private parent channel and listens on no socket or port.
        .executable(name: "echopilot-secrets", targets: ["Secrets"]),
        // The voice helper the widget's session drives: stdio JSON only, no socket and no port.
        .executable(name: "echopilot-voice", targets: ["EchoPilotVoiceHost"]),
    ],
    dependencies: [
        .package(path: "Sources/Audio"),
        .package(path: "Sources/ASR"),
    ],
    targets: [
        .executableTarget(name: "Secrets", path: "Sources/Secrets"),
        .executableTarget(
            // The ASR package declares the same sources as its own `VoiceHost` target; target names
            // must be unique across the package graph, so the root uses its own name.
            name: "EchoPilotVoiceHost",
            dependencies: [
                .product(name: "ASR", package: "ASR"),
                .product(name: "Audio", package: "Audio"),
            ],
            path: "Sources/ASR/VoiceHost"
        ),
    ]
)
