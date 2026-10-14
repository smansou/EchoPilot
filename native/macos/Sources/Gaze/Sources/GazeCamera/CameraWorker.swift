import AVFoundation
import Foundation

/// Owns one explicit camera capture session; no pixels are retained, persisted, or transmitted.
actor CameraWorker {
    private let session = AVCaptureSession()
    private var delegate: CameraFrameDelegate?

    func start(displayId: String) async throws -> (String, AsyncStream<CameraLandmarks>) {
        guard await AVCaptureDevice.requestAccess(for: .video) else { throw CameraError.denied }
        guard let device = AVCaptureDevice.default(for: .video) else { throw CameraError.unavailable }
        session.beginConfiguration()
        session.sessionPreset = .vga640x480
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { session.commitConfiguration(); throw CameraError.unavailable }
        session.addInput(input)
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        let delegate = CameraFrameDelegate(cameraId: device.uniqueID, displayId: displayId)
        output.setSampleBufferDelegate(delegate, queue: DispatchQueue(label: "EchoPilot.gaze.frames"))
        guard session.canAddOutput(output) else { session.commitConfiguration(); throw CameraError.unavailable }
        session.addOutput(output)
        session.commitConfiguration()
        self.delegate = delegate
        session.startRunning()
        return (device.uniqueID, delegate.frames)
    }

    func stop() {
        session.stopRunning()
        session.beginConfiguration()
        for output in session.outputs { session.removeOutput(output) }
        for input in session.inputs { session.removeInput(input) }
        session.commitConfiguration()
        delegate = nil
    }

    enum CameraError: Error {case denied, unavailable}
}
