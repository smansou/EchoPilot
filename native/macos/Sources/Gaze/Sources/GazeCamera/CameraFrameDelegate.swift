import AVFoundation
import Foundation
import Vision
import GazeFeatures

struct CameraLandmarks: Encodable, Sendable {
    let capturedAt: String
    let cameraId: String
    let displayId: String
    let eyesVisible: Bool
    let quality: Double
    let features: PupilFeatures
}

/// SDK callbacks arrive only on the owned serial event queue; metadata crosses through AsyncStream.
final class CameraFrameDelegate: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let frames: AsyncStream<CameraLandmarks>
    private let continuation: AsyncStream<CameraLandmarks>.Continuation
    private let cameraId: String
    private let displayId: String
    private var lastFrame: Double = 0
    private let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    init(cameraId: String, displayId: String) {
        self.cameraId = cameraId
        self.displayId = displayId
        let stream = AsyncStream<CameraLandmarks>.makeStream(bufferingPolicy: .bufferingNewest(1))
        frames = stream.stream
        continuation = stream.continuation
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let capturedAt = Date()
        guard capturedAt.timeIntervalSince1970 - lastFrame >= 1 / 6 else { return }
        lastFrame = capturedAt.timeIntervalSince1970
        guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let request = VNDetectFaceLandmarksRequest()
        do {
            try VNImageRequestHandler(cvPixelBuffer: image, orientation: .up).perform([request])
            guard let faces = request.results, faces.count == 1, let face = faces.first,
                  let landmarks = face.landmarks, let left = landmarks.leftEye, let right = landmarks.rightEye,
                  let leftPupil = landmarks.leftPupil, let rightPupil = landmarks.rightPupil,
                  leftPupil.pointCount > 0, rightPupil.pointCount > 0,
                  let features = PupilFeatures.extract(left: geometry(eye: left, pupil: leftPupil), right: geometry(eye: right, pupil: rightPupil),
                    faceX: face.boundingBox.midX, faceY: face.boundingBox.midY, faceScale: face.boundingBox.width,
                    yaw: face.yaw?.doubleValue ?? 0, pitch: face.pitch?.doubleValue ?? 0, roll: face.roll?.doubleValue ?? 0) else { return }
            continuation.yield(CameraLandmarks(capturedAt: timestampFormatter.string(from: capturedAt), cameraId: cameraId, displayId: displayId, eyesVisible: true, quality: Double(face.confidence), features: features))
        } catch { /* No usable pupil evidence: no frame or head-position guess is emitted. */ }
    }

    private func geometry(eye: VNFaceLandmarkRegion2D, pupil: VNFaceLandmarkRegion2D) -> EyeGeometry {
        let contour = (0..<eye.pointCount).map { index in SIMD2(Double(eye.normalizedPoints[index].x), Double(eye.normalizedPoints[index].y)) }
        let point = pupil.normalizedPoints[0]
        return EyeGeometry(contour: contour, pupil: SIMD2(Double(point.x), Double(point.y)))
    }
}
