// matdeck-helper --socket <caminho>
// App sem Dock (LSUIElement no Info.plist do bundle) que escuta num socket Unix e executa o que o servidor
// MatDeck pede. Encerra com SIGTERM/SIGINT apagando o socket.
import AppKit
import Foundation
import MatDeckHelperCore

func parseSocketPath() -> String {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--socket"), i + 1 < args.count { return args[i + 1] }
    let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    return appSupport.appendingPathComponent("MatDeck/helper.sock").path
}

func osVersionString() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

func machineArch() -> String {
    var u = utsname(); uname(&u)
    return withUnsafePointer(to: &u.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) } }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let socketPath = parseSocketPath()
let server = SocketServer(path: socketPath)
let dispatcher = Dispatcher()
let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0-dev"

dispatcher.register("hello") { _ in
    .object([
        "version": .string(version),
        "pid": .number(Double(ProcessInfo.processInfo.processIdentifier)),
        "platform": .object(["version": .string(osVersionString()), "arch": .string(machineArch())]),
        "permissions": Permissions.asJSON
    ])
}
dispatcher.register("permissions.request") { args in
    let kind = try arg(args, "kind") { $0.stringValue }
    switch kind {
    case "accessibility": return .object(["granted": .bool(Permissions.requestAccessibility())])
    default: throw HelperFailure(.badRequest, "permissão desconhecida: \(kind)")
    }
}
dispatcher.register("permissions.status") { _ in Permissions.asJSON }

let keyService = KeyService()
keyService.register(on: dispatcher)

server.onLine = { line in server.send(dispatcher.handle(line: line)) }
server.onConnect = { FileHandle.standardError.write(Data("[helper] servidor conectado\n".utf8)) }
server.onDisconnect = { FileHandle.standardError.write(Data("[helper] servidor desconectado\n".utf8)) }

do {
    try server.start()
    FileHandle.standardError.write(Data("[helper] MatDeck Helper \(version) escutando em \(socketPath)\n".utf8))
} catch {
    FileHandle.standardError.write(Data("[helper] falha ao abrir o socket \(socketPath): \(error)\n".utf8))
    exit(1)
}

for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { server.stop(); exit(0) }
    src.resume()
    _ = Unmanaged.passRetained(src)
}

app.run()
