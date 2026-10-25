// Teclas (keycodes) que o servidor deixou pressionadas com key.down e ainda não soltou. Quando a conexão
// cai no meio de um PTT, o helper solta tudo isso para nada ficar preso no sistema.
public struct HeldKeys: Equatable {
    private var codes: [UInt16] = []

    public init() {}

    public var all: [UInt16] { codes }
    public var isEmpty: Bool { codes.isEmpty }

    public mutating func pressed(_ keycodes: [UInt16]) {
        for k in keycodes where !codes.contains(k) { codes.append(k) }
    }

    public mutating func released(_ keycodes: [UInt16]) {
        codes.removeAll { keycodes.contains($0) }
    }

    /// Devolve o que está pressionado na ordem inversa (tecla antes dos modificadores) e esvazia.
    public mutating func drain() -> [UInt16] {
        let out = Array(codes.reversed())
        codes.removeAll()
        return out
    }
}
