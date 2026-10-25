// Volume master do dispositivo de saída padrão por CoreAudio, com assinatura de mudanças.
import CoreAudio
import Foundation
import MatDeckHelperCore

final class AudioService {
    private let emit: (String, JSONValue) -> Void
    private var listenerDevice: AudioObjectID = kAudioObjectUnknown
    private var listenerBlock: AudioObjectPropertyListenerBlock?
    private var defaultDeviceBlock: AudioObjectPropertyListenerBlock?
    private var subscribed = false
    private var last: (Int, Bool)?

    init(emit: @escaping (String, JSONValue) -> Void) { self.emit = emit }

    func register(on d: Dispatcher) {
        d.register("audio.master.get") { [self] _ in try self.stateJSON() }
        d.register("audio.master.set") { [self] args in
            let v = try arg(args, "volume") { $0.numberValue }
            try self.setVolume(max(0, min(100, v)))
            return try self.stateJSON()
        }
        d.register("audio.master.mute") { [self] args in
            let m = try arg(args, "muted") { $0.boolValue }
            try self.setMuted(m)
            return try self.stateJSON()
        }
        d.register("audio.master.subscribe") { [self] args in
            let on = try arg(args, "on") { $0.boolValue }
            self.setSubscribed(on)
            return .object(["subscribed": .bool(on)])
        }
    }

    // MARK: dispositivo e propriedades

    private func address(_ selector: AudioObjectPropertySelector, _ element: UInt32 = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioDevicePropertyScopeOutput, mElement: element)
    }

    private func defaultOutputDevice() throws -> AudioObjectID {
        var dev = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev)
        guard st == noErr, dev != kAudioObjectUnknown else { throw HelperFailure(.notSupported, "sem dispositivo de saída padrão") }
        return dev
    }

    /// Elementos com controle de volume: o principal (0) ou os canais 1 e 2.
    private func volumeElements(_ dev: AudioObjectID) -> [UInt32] {
        var a = address(kAudioDevicePropertyVolumeScalar)
        if AudioObjectHasProperty(dev, &a) { return [kAudioObjectPropertyElementMain] }
        let channels: [UInt32] = [1, 2].filter { ch in var b = address(kAudioDevicePropertyVolumeScalar, ch); return AudioObjectHasProperty(dev, &b) }
        return channels
    }

    private func getFloat(_ dev: AudioObjectID, _ selector: AudioObjectPropertySelector, _ element: UInt32) -> Float32? {
        var addr = address(selector, element)
        var v: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        return AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &v) == noErr ? v : nil
    }

    private func getUInt(_ dev: AudioObjectID, _ selector: AudioObjectPropertySelector, _ element: UInt32 = kAudioObjectPropertyElementMain) -> UInt32? {
        var addr = address(selector, element)
        var v: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &v) == noErr ? v : nil
    }

    func state() throws -> (volume: Int, muted: Bool) {
        let dev = try defaultOutputDevice()
        let elements = volumeElements(dev)
        guard !elements.isEmpty else { throw HelperFailure(.notSupported, "o dispositivo de saída não tem controle de volume") }
        let values = elements.compactMap { getFloat(dev, kAudioDevicePropertyVolumeScalar, $0) }
        guard !values.isEmpty else { throw HelperFailure(.internalError, "não foi possível ler o volume") }
        let volume = Int((values.reduce(0, +) / Float32(values.count) * 100).rounded())
        let muted = (getUInt(dev, kAudioDevicePropertyMute) ?? 0) != 0
        return (volume, muted)
    }

    private func stateJSON() throws -> JSONValue {
        let s = try state()
        return .object(["volume": .number(Double(s.volume)), "muted": .bool(s.muted)])
    }

    private func setVolume(_ percent: Double) throws {
        let dev = try defaultOutputDevice()
        let elements = volumeElements(dev)
        guard !elements.isEmpty else { throw HelperFailure(.notSupported, "o dispositivo de saída não tem controle de volume") }
        var v = Float32(percent / 100)
        for el in elements {
            var addr = address(kAudioDevicePropertyVolumeScalar, el)
            let st = AudioObjectSetPropertyData(dev, &addr, 0, nil, UInt32(MemoryLayout<Float32>.size), &v)
            guard st == noErr else { throw HelperFailure(.internalError, "AudioObjectSetPropertyData(volume): \(st)") }
        }
    }

    private func setMuted(_ muted: Bool) throws {
        let dev = try defaultOutputDevice()
        var addr = address(kAudioDevicePropertyMute)
        guard AudioObjectHasProperty(dev, &addr) else { throw HelperFailure(.notSupported, "o dispositivo de saída não tem mudo") }
        var v: UInt32 = muted ? 1 : 0
        let st = AudioObjectSetPropertyData(dev, &addr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v)
        guard st == noErr else { throw HelperFailure(.internalError, "AudioObjectSetPropertyData(mute): \(st)") }
    }

    // MARK: assinatura

    private func setSubscribed(_ on: Bool) {
        subscribed = on
        if on {
            installDeviceListener()
            if defaultDeviceBlock == nil {
                // Troca do dispositivo padrão (fones ↔ alto-falantes): reinstala o listener e avisa o estado novo
                let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.installDeviceListener(); self?.emitState() }
                var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
                AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, .main, block)
                defaultDeviceBlock = block
            }
            emitState()
        } else {
            removeDeviceListener()
            if let block = defaultDeviceBlock {
                var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
                AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, .main, block)
                defaultDeviceBlock = nil
            }
            last = nil
        }
    }

    private func installDeviceListener() {
        guard let dev = try? defaultOutputDevice() else { return }
        if dev == listenerDevice, listenerBlock != nil { return }
        removeDeviceListener()
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.emitState() }
        for el in volumeElements(dev) {
            var addr = address(kAudioDevicePropertyVolumeScalar, el)
            AudioObjectAddPropertyListenerBlock(dev, &addr, .main, block)
        }
        var mute = address(kAudioDevicePropertyMute)
        if AudioObjectHasProperty(dev, &mute) { AudioObjectAddPropertyListenerBlock(dev, &mute, .main, block) }
        listenerDevice = dev
        listenerBlock = block
    }

    private func removeDeviceListener() {
        guard listenerDevice != kAudioObjectUnknown, let block = listenerBlock else { return }
        for el in volumeElements(listenerDevice) {
            var addr = address(kAudioDevicePropertyVolumeScalar, el)
            AudioObjectRemovePropertyListenerBlock(listenerDevice, &addr, .main, block)
        }
        var mute = address(kAudioDevicePropertyMute)
        AudioObjectRemovePropertyListenerBlock(listenerDevice, &mute, .main, block)
        listenerDevice = kAudioObjectUnknown
        listenerBlock = nil
    }

    private func emitState() {
        guard subscribed, let s = try? state() else { return }
        if let l = last, l == (s.volume, s.muted) { return }
        last = (s.volume, s.muted)
        emit("audio.master", .object(["volume": .number(Double(s.volume)), "muted": .bool(s.muted)]))
    }
}
