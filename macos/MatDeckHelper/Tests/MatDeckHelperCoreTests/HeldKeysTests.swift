import Testing
@testable import MatDeckHelperCore

// Teclas que o servidor deixou pressionadas (PTT) precisam ser soltas quando a conexão cai.
@Suite struct HeldKeysTests {
    @Test func pressAndReleaseTracksKeycodes() {
        var held = HeldKeys()
        held.pressed([59, 56, 35])          // ctrl, shift, p
        #expect(held.all == [59, 56, 35])
        held.released([35])
        #expect(held.all == [59, 56])
        held.released([59, 56])
        #expect(held.isEmpty)
    }

    @Test func drainReturnsInReverseOrderAndEmpties() {
        var held = HeldKeys()
        held.pressed([59, 56, 35])
        let toRelease = held.drain()
        #expect(toRelease == [35, 56, 59])   // tecla antes dos modificadores, como um dedo soltando
        #expect(held.isEmpty)
        #expect(held.drain().isEmpty)
    }

    @Test func pressingTwiceDoesNotDuplicate() {
        var held = HeldKeys()
        held.pressed([59, 35]); held.pressed([59, 35])
        #expect(held.all == [59, 35])
    }
}
