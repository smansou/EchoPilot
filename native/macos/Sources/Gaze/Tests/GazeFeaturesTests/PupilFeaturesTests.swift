import Testing
import GazeFeatures

struct PupilFeaturesTests {
    func eye(pupil: SIMD2<Double>?) -> EyeGeometry { EyeGeometry(contour: [SIMD2(0.0, 0.0), SIMD2(1.0, 0.0), SIMD2(1.0, 0.3), SIMD2(0.0, 0.3)], pupil: pupil) }
    @Test func noPupilNeverBecomesHeadGaze() {
        #expect(PupilFeatures.extract(left: eye(pupil: nil), right: eye(pupil: SIMD2(0.5, 0.15)), faceX: 0.5, faceY: 0.5, faceScale: 0.5, yaw: 0, pitch: 0, roll: 0) == nil)
    }
    @Test func measuredPupilGeometryIsEyeRelative() throws {
        let features = try #require(PupilFeatures.extract(left: eye(pupil: SIMD2(0.25, 0.15)), right: eye(pupil: SIMD2(0.75, 0.15)), faceX: 0.5, faceY: 0.5, faceScale: 0.5, yaw: 0, pitch: 0, roll: 0))
        #expect(features.irisX == 0.5)
        #expect(features.irisY == 0.5)
        #expect(features.ear == 0.3)
    }
    @Test func invalidPupilIsRejected() {
        #expect(PupilFeatures.extract(left: eye(pupil: SIMD2(4, 0.15)), right: eye(pupil: SIMD2(0.5, 0.15)), faceX: 0.5, faceY: 0.5, faceScale: 0.5, yaw: 0, pitch: 0, roll: 0) == nil)
    }
}
