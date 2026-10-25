// Permissões do macOS que o helper precisa: Acessibilidade (teclas, foco, título de janela).
import ApplicationServices
import Foundation
import MatDeckHelperCore

enum Permissions {
    static var accessibility: Bool { AXIsProcessTrusted() }

    /// Pede a permissão com o diálogo do sistema (abre Ajustes do Sistema → Privacidade → Acessibilidade).
    static func requestAccessibility() -> Bool {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }

    static func requireAccessibility() throws {
        if !accessibility { throw HelperFailure(.accessibilityDenied, "Conceda Acessibilidade ao MatDeck Helper em Ajustes do Sistema → Privacidade e Segurança") }
    }

    static var asJSON: JSONValue { .object(["accessibility": .bool(accessibility)]) }
}
