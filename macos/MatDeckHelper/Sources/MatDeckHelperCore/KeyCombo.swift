// Combos de tecla no formato neutro do MatDeck ("ctrl", "shift", "alt", "cmd"/"super", letras, nomes
// especiais) e a tradução para o macOS. Letras e pontuação viram keycode pelo layout ativo (no KeyService,
// via UCKeyTranslate); aqui ficam só a análise e as tabelas fixas (teclas especiais, nomes de pontuação, mídia).
import Foundation

public enum Modifier: Hashable { case cmd, ctrl, alt, shift }

public struct KeyCombo: Equatable {
    public let modifiers: Set<Modifier>
    public let key: String?

    private static let modifierNames: [String: Modifier] = [
        "cmd": .cmd, "command": .cmd, "super": .cmd, "meta": .cmd, "win": .cmd, "leftmeta": .cmd, "rightmeta": .cmd,
        "ctrl": .ctrl, "control": .ctrl, "lctrl": .ctrl, "rctrl": .ctrl, "leftctrl": .ctrl, "rightctrl": .ctrl,
        "alt": .alt, "option": .alt, "lalt": .alt, "ralt": .alt, "leftalt": .alt, "rightalt": .alt, "altgr": .alt,
        "shift": .shift, "lshift": .shift, "rshift": .shift, "leftshift": .shift, "rightshift": .shift
    ]

    // Virtual keycodes (Carbon kVK_*), iguais em qualquer layout
    private static let specialKeys: [String: UInt16] = [
        "escape": 53, "esc": 53, "return": 36, "enter": 36, "tab": 48, "space": 49,
        "backspace": 51, "delete": 51, "forwarddelete": 117, "del": 117,
        "up": 126, "down": 125, "left": 123, "right": 124,
        "home": 115, "end": 119, "pageup": 116, "prior": 116, "pagedown": 121, "next": 121,
        "capslock": 57,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111
    ]

    // Nomes de pontuação usados pelos perfis (herdados do xdotool) → caractere, resolvido pelo layout
    private static let punctuationNames: [String: Character] = [
        "slash": "/", "comma": ",", "period": ".", "dot": ".", "minus": "-", "equal": "=",
        "semicolon": ";", "apostrophe": "'", "bracketleft": "[", "leftbrace": "[", "bracketright": "]", "rightbrace": "]",
        "backslash": "\\", "grave": "`"
    ]

    public static func parse(_ names: [String]) -> KeyCombo? {
        var mods = Set<Modifier>()
        var key: String? = nil
        for raw in names {
            let n = raw.trimmingCharacters(in: .whitespaces).lowercased()
            if n.isEmpty { continue }
            if let m = modifierNames[n] { mods.insert(m) } else { key = n }
        }
        if mods.isEmpty && key == nil { return nil }
        return KeyCombo(modifiers: mods, key: key)
    }

    /// Keycode de uma tecla especial (independe do layout) ou nil.
    public static func specialKeyCode(_ name: String) -> UInt16? {
        specialKeys[name.lowercased()]
    }

    /// Caractere que uma tecla "normal" produz (letras, dígitos, pontuação por nome); nil para especiais.
    public static func character(forName name: String) -> Character? {
        let n = name.lowercased()
        if specialKeys[n] != nil { return nil }
        if let c = punctuationNames[n] { return c }
        if n.count == 1 { return n.first }
        return nil
    }
}

/// Teclas de mídia (NX_KEYTYPE_* de IOKit/hidsystem/ev_keymap.h)
public enum MediaKey: String {
    case playPause = "play_pause", next, prev, mute, volUp = "vol_up", volDown = "vol_down"

    public var nxKeyType: Int32 {
        switch self {
        case .volUp: return 0      // NX_KEYTYPE_SOUND_UP
        case .volDown: return 1    // NX_KEYTYPE_SOUND_DOWN
        case .mute: return 7       // NX_KEYTYPE_MUTE
        case .playPause: return 16 // NX_KEYTYPE_PLAY
        case .next: return 17      // NX_KEYTYPE_NEXT
        case .prev: return 18      // NX_KEYTYPE_PREVIOUS
        }
    }
}
