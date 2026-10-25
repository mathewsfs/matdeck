// Aplicativos instalados (.app nas pastas padrão), ícone em PNG e abertura por NSWorkspace.
import AppKit
import Foundation
import MatDeckHelperCore

final class AppsService {
    static let folders: [String] = [
        "/Applications", "/System/Applications", "/System/Applications/Utilities",
        NSHomeDirectory() + "/Applications"
    ]

    struct App { let id: String; let name: String; let path: String }

    func register(on d: Dispatcher) {
        d.register("apps.list") { [self] _ in
            .object(["apps": .array(self.listApps().map {
                .object(["id": .string($0.id), "name": .string($0.name), "path": .string($0.path)])
            })])
        }
        d.register("apps.icon") { [self] args in
            let id = try arg(args, "id") { $0.stringValue }
            guard let app = self.resolve(id) else { throw HelperFailure(.badRequest, "aplicativo desconhecido: \(id)") }
            return .object(["png": .string(self.iconPNG(path: app.path) ?? "")])
        }
        d.register("apps.launch") { [self] args in
            let id = try arg(args, "id") { $0.stringValue }
            guard let app = self.resolve(id) else { throw HelperFailure(.badRequest, "aplicativo desconhecido: \(id)") }
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: app.path), configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error { FileHandle.standardError.write(Data("[helper] abrir \(app.name) falhou: \(error.localizedDescription)\n".utf8)) }
            }
            return .object(["launched": .bool(true)])
        }
        d.register("apps.open") { args in
            let target = try arg(args, "target") { $0.stringValue }
            let url: URL
            if target.hasPrefix("/") || target.hasPrefix("~") {
                url = URL(fileURLWithPath: (target as NSString).expandingTildeInPath)
            } else if let u = URL(string: target), u.scheme != nil {
                url = u
            } else {
                throw HelperFailure(.badRequest, "alvo inválido: \(target)")
            }
            return .object(["opened": .bool(NSWorkspace.shared.open(url))])
        }
    }

    // MARK: lista

    func listApps() -> [App] {
        var seen = Set<String>()
        var out: [App] = []
        let fm = FileManager.default
        for folder in AppsService.folders {
            guard let names = try? fm.contentsOfDirectory(atPath: folder) else { continue }
            for name in names where name.hasSuffix(".app") {
                let path = folder + "/" + name
                guard let app = describe(path: path), !seen.contains(app.id) else { continue }
                seen.insert(app.id)
                out.append(app)
            }
        }
        return out
    }

    private func describe(path: String) -> App? {
        guard let bundle = Bundle(path: path) else { return nil }
        let info = bundle.infoDictionary ?? [:]
        let fileName = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        let name = (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String) ?? fileName
        let id = bundle.bundleIdentifier ?? path
        return App(id: id, name: name, path: path)
    }

    /// Aceita bundle id (procura nas pastas padrão e, se não achar, pergunta ao LaunchServices) ou caminho de .app.
    func resolve(_ id: String) -> App? {
        if id.hasPrefix("/") { return describe(path: id) }
        if let app = listApps().first(where: { $0.id.caseInsensitiveCompare(id) == .orderedSame }) { return app }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) { return describe(path: url.path) }
        return nil
    }

    // MARK: ícone

    func iconPNG(path: String, size: Int = 64) -> String? {
        let icon = NSWorkspace.shared.icon(forFile: path)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])?.base64EncodedString()
    }
}
