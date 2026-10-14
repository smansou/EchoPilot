import Foundation

@main struct GazeMain {
    struct Event<Value: Encodable>: Encodable {let type: String; let payload: Value}
    struct Started: Encodable {let cameraId: String}
    struct Unavailable: Encodable {let reason: String}
    static func emit<Value: Encodable>(_ type: String, _ value: Value) {
        guard let data = try? JSONEncoder().encode(Event(type: type, payload: value)) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    static func main() async {
        guard CommandLine.arguments.count == 2, CommandLine.arguments[1].utf8.count <= 256 else { return }
        let worker = CameraWorker()
        do {
            let (cameraId, frames) = try await worker.start(displayId: CommandLine.arguments[1])
            emit("started", Started(cameraId: cameraId))
            let output = Task {
                for await frame in frames { emit("frame", frame) }
            }
            // Private stdin EOF or the exact stop command ends capture, without a socket or polling.
            await Task.detached { while let line = readLine() { if line == "stop" { break } } }.value
            await worker.stop()
            output.cancel()
        } catch CameraWorker.CameraError.denied { emit("unavailable", Unavailable(reason: "camera_denied")) }
        catch { emit("unavailable", Unavailable(reason: "camera_unavailable")) }
    }
}
