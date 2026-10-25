import Testing
@testable import MatDeckHelperCore

@Suite struct KeyComboTests {
    @Test func parsesModifiersAndKey() {
        let c = KeyCombo.parse(["cmd", "shift", "m"])!
        #expect(c.modifiers == [.cmd, .shift])
        #expect(c.key == "m")
    }

    @Test func acceptsLinuxAliases() {
        let c = KeyCombo.parse(["super", "alt", "x"])!
        #expect(c.modifiers == [.cmd, .alt])
        #expect(KeyCombo.parse(["control", "option", "y"])!.modifiers == [.ctrl, .alt])
    }

    @Test func keyNamesAreCaseInsensitive() {
        #expect(KeyCombo.parse(["Cmd", "Shift", "M"])!.key == "m")
    }

    @Test func specialKeys() {
        #expect(KeyCombo.specialKeyCode("escape") == 53)
        #expect(KeyCombo.specialKeyCode("esc") == 53)
        #expect(KeyCombo.specialKeyCode("f11") == 103)
        #expect(KeyCombo.specialKeyCode("return") == 36)
        #expect(KeyCombo.specialKeyCode("space") == 49)
        #expect(KeyCombo.specialKeyCode("ç") == nil)
    }

    @Test func punctuationNamesMapToCharacters() {
        #expect(KeyCombo.character(forName: "slash") == "/")
        #expect(KeyCombo.character(forName: "comma") == ",")
        #expect(KeyCombo.character(forName: "bracketleft") == "[")
        #expect(KeyCombo.character(forName: "a") == "a")
        #expect(KeyCombo.character(forName: "escape") == nil)
    }

    @Test func modifierOnlyCombo() {
        let c = KeyCombo.parse(["ctrl"])!
        #expect(c.key == nil)
        #expect(c.modifiers == [.ctrl])
    }

    @Test func emptyIsNil() {
        #expect(KeyCombo.parse([]) == nil)
    }

    @Test func mediaKeyTypes() {
        #expect(MediaKey(rawValue: "play_pause")?.nxKeyType == 16)
        #expect(MediaKey(rawValue: "next")?.nxKeyType == 17)
        #expect(MediaKey(rawValue: "prev")?.nxKeyType == 18)
        #expect(MediaKey(rawValue: "mute")?.nxKeyType == 7)
        #expect(MediaKey(rawValue: "vol_up")?.nxKeyType == 0)
        #expect(MediaKey(rawValue: "vol_down")?.nxKeyType == 1)
        #expect(MediaKey(rawValue: "xyz") == nil)
    }
}
