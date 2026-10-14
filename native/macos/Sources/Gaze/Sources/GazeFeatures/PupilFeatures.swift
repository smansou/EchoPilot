import Foundation

/// Normalized eye geometry; missing pupil evidence is never substituted with head position.
public struct EyeGeometry: Sendable {
    public let contour: [SIMD2<Double>]
    public let pupil: SIMD2<Double>?
    public init(contour: [SIMD2<Double>], pupil: SIMD2<Double>?) { self.contour = contour; self.pupil = pupil }
}

/// Metadata shared with the calibrated TypeScript gaze runtime; it contains no image data.
public struct PupilFeatures: Codable, Sendable {
    public let irisX: Double
    public let irisY: Double
    public let ear: Double
    public let faceX: Double
    public let faceY: Double
    public let faceScale: Double
    public let yaw: Double
    public let pitch: Double
    public let roll: Double

    /// Extracts binocular eye-relative pupil position; rejects absent, closed, or invalid eyes.
    /// - Returns: Usable eye features, or nil when the evidence cannot support gaze.
    public static func extract(left: EyeGeometry, right: EyeGeometry, faceX: Double, faceY: Double, faceScale: Double, yaw: Double, pitch: Double, roll: Double) -> PupilFeatures? {
        guard let l = measurement(left), let r = measurement(right),
              [faceX, faceY, faceScale, yaw, pitch, roll].allSatisfy(\.isFinite), faceScale > 0,
              l.ear >= 0.15, r.ear >= 0.15 else { return nil }
        return PupilFeatures(irisX: (l.x + r.x) / 2, irisY: (l.y + r.y) / 2, ear: min(l.ear, r.ear), faceX: faceX, faceY: faceY, faceScale: faceScale, yaw: yaw, pitch: pitch, roll: roll)
    }

    private static func measurement(_ eye: EyeGeometry) -> (x: Double, y: Double, ear: Double)? {
        guard eye.contour.count >= 4, let pupil = eye.pupil,
              eye.contour.allSatisfy({ $0.x.isFinite && $0.y.isFinite }), pupil.x.isFinite, pupil.y.isFinite,
              let minX = eye.contour.map(\.x).min(), let maxX = eye.contour.map(\.x).max(),
              let minY = eye.contour.map(\.y).min(), let maxY = eye.contour.map(\.y).max() else { return nil }
        let width = maxX - minX
        let height = maxY - minY
        guard width > 0.0001, height > 0.0001, pupil.x >= minX, pupil.x <= maxX, pupil.y >= minY, pupil.y <= maxY else { return nil }
        return ((pupil.x - minX) / width, (pupil.y - minY) / height, height / width)
    }
}
