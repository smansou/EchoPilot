// swift-tools-version: 5.9
import PackageDescription

// S04 — the native macOS process observer for the scoped-command host executor.
//
// `echopilot-exec-observation ps` is the Darwin `libproc` reader the host executor uses to learn
// which processes belong to the run it manages: `proc_listallpids` for the pid list plus
// `proc_pidinfo(PROC_PIDTBSDINFO)` for the parent, the process group, and the process state. It is
// the shipped form of the bootstrap that `packages/security/src/execution/native/exec-observation.c`
// compiles when no built helper is present, and it is what makes a child that escaped the managed
// process group reportable by pid instead of claimed stopped (a restricted runtime denies `ps` and
// `pgrep`, and Node's stdio close cannot stand in for a process table).
//
// The package keeps its own manifest (like `Sources/Audio`) and no dependencies, so
// `swift build --package-path native/macos/Sources/Execution` compiles and links it offline. It is
// an executable rather than a library because the observer is spawned with stdio pipes by the
// executor, never linked into the app. `.gitignore` next to this manifest keeps the SwiftPM scratch
// directory out of the repository.
let package = Package(
    name: "Execution",
    platforms: [.macOS(.v13)],
    products: [
        // Spawned by packages/security/src/execution/process-table.ts as `... ps` with stdio pipes
        // only: one whitespace-separated `<pid> <ppid> <pgid> <pbi_status>` line per process.
        .executable(name: "echopilot-exec-observation", targets: ["ExecObservation"]),
    ],
    targets: [
        .executableTarget(name: "ExecObservation", path: "Sources/ExecObservation"),
    ]
)
