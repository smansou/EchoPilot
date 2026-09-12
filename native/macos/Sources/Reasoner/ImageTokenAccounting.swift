import Foundation

/// The processor's own image-token calculation. Images are never claimed to cost zero tokens, and a
/// screenshot with no positive pixel dimensions is rejected instead of being charged a guess.
public protocol ImageTokenProcessing: Sendable {
    func imageTokens(width: Int, height: Int) throws -> Int
}

/// Qwen3.5 vision towers patch the image on a 28-pixel grid: one visual token per patch.
public struct Qwen35VisionProcessor: ImageTokenProcessing {
    public static let patchSize = 28

    public init() {}

    public func imageTokens(width: Int, height: Int) throws -> Int {
        guard width > 0, height > 0 else {
            throw ReasonerContractError.invalidImageDescriptor(id: "\(width)x\(height)")
        }
        let columns = (width + Qwen35VisionProcessor.patchSize - 1) / Qwen35VisionProcessor.patchSize
        let rows = (height + Qwen35VisionProcessor.patchSize - 1) / Qwen35VisionProcessor.patchSize
        return max(1, columns * rows)
    }
}
