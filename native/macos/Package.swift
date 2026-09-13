// swift-tools-version: 5.9
import PackageDescription

// The macOS native workspace. It builds the signed `echopilot-secrets` helper, the local voice
// tracer `echopilot-voice` (V01: Speak → native audio → local ASR → widget transcript → mute) and
// the bundled Reasoner worker `echopilot-reasoner` (M02: live event batch → local extraction →
// bounded context → grounded answer).
//
// `echopilot-voice` is the production wiring of the voice half: it links the `Audio` package
// (microphone graph, 20 ms packetizer, bounded ring), the `ASR` package (Silero VAD, WhisperKit
// small.en, window planner, `VoiceTracerBridge`) and, transitively, the pinned WhisperKit backend
// itself. Both packages keep their own `.build`/`Package.resolved` scratch out of the tree.
//
// `echopilot-reasoner` is the production wiring of the M02 half: `Sources/Reasoner` in this
// package builds the budget (`BoundedBudget`), the exact tokenizer and image accounting, the
// bounded-context assembler and the stdio worker as one executable, so the same sources the
// TypeScript seam drives are compiled and linked here. `Sources/Reasoner/test/main.swift` is the
// test-role-owned native oracle; it is compiled directly by the frozen M02 command
// (`packages/memory/src/consolidation/test/check.mjs`), so it is excluded from the target rather
// than declared as an XCTest case it is not.
let package = Package(
    name: "EchoPilotNative",
    platforms: [.macOS(.v13)],
    products: [
        // Spawned by the Electron main process with stdio pipes only: the helper registers its
        // capabilities through the private parent channel and listens on no socket or port.
        .executable(name: "echopilot-secrets", targets: ["Secrets"]),
        // The voice helper the widget's session drives: stdio JSON only, no socket and no port.
        .executable(name: "echopilot-voice", targets: ["EchoPilotVoiceHost"]),
        // The bundled Reasoner worker: one bounded JSON request per line in, one grounded response
        // per line out.
        .executable(name: "echopilot-reasoner", targets: ["EchoPilotReasoner"]),
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
        .executableTarget(
            // M02's Reasoner half: Foundation-only, no external dependency, so the gate's
            // `swift build --package-path native/macos` compiles and links it offline.
            name: "EchoPilotReasoner",
            path: "Sources/Reasoner",
            exclude: ["test", "README.md", ".gitignore"]
        ),
    ]
)
