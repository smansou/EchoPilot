import CoreAudio
import Foundation

public struct AudioInputDevice: Sendable, Equatable {
    public let id: AudioDeviceID
    public let uid: String
    public let name: String
    public let isDefault: Bool

    public var jsonObject: [String: Any] {
        ["id": id, "uid": uid, "name": name, "isDefault": isDefault]
    }
}

public enum AudioDeviceError: Error, Equatable {
    case coreAudio(OSStatus)
    case noInputDevice
}

/// CoreAudio device enumeration + change observation for the microphone graph.
public enum AudioDeviceEnumerator {
    private static func address(
        _ selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain
        )
    }

    private static func check(_ status: OSStatus) throws {
        guard status == noErr else { throw AudioDeviceError.coreAudio(status) }
    }

    public static func deviceIDs() throws -> [AudioDeviceID] {
        var property = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size
        ))
        let count = Int(size) / MemoryLayout<AudioDeviceID>.size
        guard count > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: count)
        ids.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            var mutableSize = size
            _ = AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &mutableSize, base
            )
        }
        return ids
    }

    public static func defaultInputDeviceID() throws -> AudioDeviceID? {
        var property = address(kAudioHardwarePropertyDefaultInputDevice)
        var deviceID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &property, 0, nil, &size, &deviceID
        )
        if status == kAudioHardwareBadObjectError || status == kAudioHardwareUnknownPropertyError {
            return nil
        }
        try check(status)
        return deviceID == 0 ? nil : deviceID
    }

    public static func defaultInputDevice() throws -> AudioInputDevice? {
        guard let id = try defaultInputDeviceID() else { return nil }
        return try describe(id: id, isDefault: true)
    }

    private static func stringProperty(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
        var property = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        try check(AudioObjectGetPropertyData(objectID, &property, 0, nil, &size, &value))
        return value?.takeRetainedValue() as String? ?? ""
    }

    private static func inputChannelCount(_ deviceID: AudioDeviceID) throws -> Int {
        var property = address(kAudioDevicePropertyStreamConfiguration, scope: kAudioObjectPropertyScopeInput)
        var size: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(deviceID, &property, 0, nil, &size))
        guard size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        try check(AudioObjectGetPropertyData(deviceID, &property, 0, nil, &size, raw))
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }

    private static func describe(id: AudioDeviceID, isDefault: Bool) throws -> AudioInputDevice {
        let uid = (try? stringProperty(id, kAudioDevicePropertyDeviceUID)) ?? ""
        let name = (try? stringProperty(id, kAudioObjectPropertyName)) ?? uid
        return AudioInputDevice(id: id, uid: uid, name: name, isDefault: isDefault)
    }

    /// Every device that can capture, including the current default input.
    public static func inputDevices() throws -> [AudioInputDevice] {
        let defaultID = try defaultInputDeviceID()
        var devices: [AudioInputDevice] = []
        for id in try deviceIDs() {
            guard let channels = try? inputChannelCount(id), channels > 0 else { continue }
            devices.append(try describe(id: id, isDefault: id == defaultID))
        }
        return devices
    }
}

/// Observes the device list and the default input so removal surfaces as a visible widget state.
public final class AudioDeviceObserver: @unchecked Sendable {
    public typealias ChangeListener = ([AudioInputDevice]) -> Void

    private let queue = DispatchQueue(label: "voice.audio.devices")
    private let listener: ChangeListener
    private var registrations: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

    public init(listener: @escaping ChangeListener) throws {
        self.listener = listener
        let systemObject = AudioObjectID(kAudioObjectSystemObject)
        try register(systemObject, kAudioHardwarePropertyDevices)
        try register(systemObject, kAudioHardwarePropertyDefaultInputDevice)
        if let defaultID = try AudioDeviceEnumerator.defaultInputDeviceID() {
            try register(defaultID, kAudioDevicePropertyDeviceIsAlive)
        }
    }

    deinit {
        stop()
    }

    private func register(_ objectID: AudioObjectID, _ selector: AudioObjectPropertySelector) throws {
        var property = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.publish()
        }
        let status = AudioObjectAddPropertyListenerBlock(objectID, &property, queue, block)
        guard status == noErr else { throw AudioDeviceError.coreAudio(status) }
        registrations.append((objectID, property, block))
    }

    private func publish() {
        let devices = (try? AudioDeviceEnumerator.inputDevices()) ?? []
        listener(devices)
    }

    public func stop() {
        for registration in registrations {
            var property = registration.1
            AudioObjectRemovePropertyListenerBlock(registration.0, &property, queue, registration.2)
        }
        registrations.removeAll()
    }
}
