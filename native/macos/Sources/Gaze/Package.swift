// swift-tools-version: 6.0
import PackageDescription
import Foundation

let infoPath = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("GazeInfo.plist").path

let package = Package(name: "Gaze", platforms: [.macOS(.v13)], products: [
    .library(name: "GazeFeatures", targets: ["GazeFeatures"]),
    .executable(name: "echopilot-gaze", targets: ["GazeCamera"])
], targets: [
    .target(name: "GazeFeatures"),
    .executableTarget(name: "GazeCamera", dependencies: ["GazeFeatures"], linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPath])]),
    .testTarget(name: "GazeFeaturesTests", dependencies: ["GazeFeatures"])
])
