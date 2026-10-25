// Teclas por CGEvent. Letras/pontuação são traduzidas para keycode pelo layout de teclado ativo
// (UCKeyTranslate), então ABNT2 e US funcionam sem tabela fixa. Exige Acessibilidade.
import AppKit
import Carbon
import Foundation
import MatDeckHelperCore

final class KeyService {
    private var charMap: [Character: UInt16] = [:]
    private var charMapLayoutId: String = ""

    func register(on d: Dispatcher) {
        d.register("key.shortcut") { [self] args in
            try Permissions.requireAccessibility()
            let combo = try self.combo(from: args)
            try self.press(combo, down: true); try self.press(combo, down: false)
            return .object([:])
        }
        d.register("key.down") { [self] args in
            try Permissions.requireAccessibility()
            try self.press(try self.combo(from: args), down: true)
            return .object([:])
        }
        d.register("key.up") { [self] args in
            try Permissions.requireAccessibility()
            try self.press(try self.combo(from: args), down: false)
            return .object([:])
        }
        d.register("key.media") { args in
            try Permissions.requireAccessibility()
            let name = try arg(args, "name") { $0.stringValue }
            guard let key = MediaKey(rawValue: name) else { throw HelperFailure(.badRequest, "tecla de mídia desconhecida: \(name)") }
            KeyService.postMediaKey(key)
            return .object([:])
        }
    }

    private func combo(from args: [String: JSONValue]) throws -> KeyCombo {
        let names = try arg(args, "keys") { $0.stringArray }
        guard let c = KeyCombo.parse(names) else { throw HelperFailure(.badRequest, "combo vazio") }
        return c
    }

    // MARK: layout

    private func refreshCharMapIfNeeded() {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else { return }
        let idPtr = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
        let layoutId = idPtr.map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? ""
        if layoutId == charMapLayoutId && !charMap.isEmpty { return }
        charMap = [:]
        charMapLayoutId = layoutId
        guard let dataPtr = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return }
        let data = Unmanaged<CFData>.fromOpaque(dataPtr).takeUnretainedValue() as Data
        data.withUnsafeBytes { raw in
            guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            var deadKeys: UInt32 = 0
            var chars = [UniChar](repeating: 0, count: 4)
            var length = 0
            for code in UInt16(0)...UInt16(127) {
                deadKeys = 0
                let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                                            UInt32(kUCKeyTranslateNoDeadKeysMask), &deadKeys, chars.count, &length, &chars)
                if status == noErr, length > 0, let scalar = Unicode.Scalar(chars[0]) {
                    let ch = Character(scalar)
                    if charMap[ch] == nil { charMap[ch] = code }
                }
            }
        }
    }

    private func keyCode(for name: String) throws -> UInt16 {
        if let special = KeyCombo.specialKeyCode(name) { return special }
        guard let ch = KeyCombo.character(forName: name) else { throw HelperFailure(.badRequest, "tecla desconhecida: \(name)") }
        refreshCharMapIfNeeded()
        if let code = charMap[ch] { return code }
        if let code = charMap[Character(String(ch).uppercased())] { return code }
        throw HelperFailure(.badRequest, "tecla sem keycode no layout atual: \(name)")
    }

    // MARK: eventos

    private static func flags(_ mods: Set<Modifier>) -> CGEventFlags {
        var f = CGEventFlags()
        if mods.contains(.cmd) { f.insert(.maskCommand) }
        if mods.contains(.ctrl) { f.insert(.maskControl) }
        if mods.contains(.alt) { f.insert(.maskAlternate) }
        if mods.contains(.shift) { f.insert(.maskShift) }
        return f
    }

    private static let modifierKeyCodes: [Modifier: UInt16] = [.cmd: 55, .shift: 56, .alt: 58, .ctrl: 59]
    private static let modifierOrder: [Modifier] = [.ctrl, .alt, .shift, .cmd]

    /// down=true pressiona modificadores e tecla; down=false solta em ordem inversa.
    private func press(_ combo: KeyCombo, down: Bool) throws {
        let source = CGEventSource(stateID: .combinedSessionState)
        let mods = KeyService.modifierOrder.filter { combo.modifiers.contains($0) }
        var events: [CGEvent] = []
        if down {
            for m in mods {
                if let e = CGEvent(keyboardEventSource: source, virtualKey: KeyService.modifierKeyCodes[m]!, keyDown: true) { e.flags = KeyService.flags(Set(mods.prefix(upTo: mods.firstIndex(of: m)! + 1))); events.append(e) }
            }
            if let key = combo.key, let e = CGEvent(keyboardEventSource: source, virtualKey: try keyCode(for: key), keyDown: true) {
                e.flags = KeyService.flags(combo.modifiers); events.append(e)
            }
        } else {
            if let key = combo.key, let e = CGEvent(keyboardEventSource: source, virtualKey: try keyCode(for: key), keyDown: false) {
                e.flags = KeyService.flags(combo.modifiers); events.append(e)
            }
            for m in mods.reversed() {
                if let e = CGEvent(keyboardEventSource: source, virtualKey: KeyService.modifierKeyCodes[m]!, keyDown: false) { e.flags = CGEventFlags(); events.append(e) }
            }
        }
        for e in events { e.post(tap: .cghidEventTap); usleep(4000) }
    }

    /// Tecla de mídia: evento de sistema (subtype 8) com data1 = (tipo << 16) | (0xA00 down / 0xB00 up).
    static func postMediaKey(_ key: MediaKey) {
        for down in [true, false] {
            let data1 = Int((key.nxKeyType << 16) | (down ? 0xA00 : 0xB00))
            if let ev = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: down ? [] : [],
                                           timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil,
                                           subtype: 8, data1: data1, data2: -1) {
                ev.cgEvent?.post(tap: .cghidEventTap)
            }
            usleep(4000)
        }
    }
}
