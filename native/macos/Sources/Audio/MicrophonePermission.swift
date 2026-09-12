import AVFoundation
import Foundation

public enum MicrophonePermission: String, Sendable, Equatable {
    case granted
    case denied
    case unknown
}

/// Explicit, active-session microphone permission.
///
/// Capture only ever opens after `current()` reports `.granted`, or after an active session
/// deliberately asks for access with `request()` (`.notDetermined`). A denial is reported to the
/// widget as `mic_denied`; the graph is never opened "hopefully" in the background.
public enum MicrophonePermissionProbe {
    public static func current() -> MicrophonePermission {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return .granted
        case .denied, .restricted:
            return .denied
        case .notDetermined:
            return .unknown
        @unknown default:
            return .unknown
        }
    }

    public static func request() async -> MicrophonePermission {
        await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                continuation.resume(returning: granted ? .granted : .denied)
            }
        }
    }
}
