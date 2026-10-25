// Servidor de socket Unix (um cliente por vez). Tudo roda na fila principal: os handlers usam AppKit.
import Foundation
import MatDeckHelperCore

final class SocketServer {
    let path: String
    private var listenFd: Int32 = -1
    private var listenSource: DispatchSourceRead?
    private var clientFd: Int32 = -1
    private var clientSource: DispatchSourceRead?
    private var framer = LineFramer()
    private var warnedDropped = false

    var onLine: ((String) -> Void)?
    var onConnect: (() -> Void)?
    var onDisconnect: (() -> Void)?

    init(path: String) { self.path = path }

    var hasClient: Bool { clientFd >= 0 }

    /// Um cliente que fecha antes de ler a resposta não pode matar o processo com SIGPIPE.
    private func disableSigpipe(_ fd: Int32) {
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    }

    func start() throws {
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        unlink(path)
        listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFd >= 0 else { throw HelperFailure(.internalError, "socket(): \(errno)") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { throw HelperFailure(.internalError, "caminho do socket longo demais") }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: bytes.count + 1) { p in
                for (i, b) in bytes.enumerated() { p[i] = CChar(bitPattern: b) }
                p[bytes.count] = 0
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFd, $0, len) } }
        guard bound == 0 else { throw HelperFailure(.internalError, "bind(): \(errno)") }
        chmod(path, 0o600)
        guard listen(listenFd, 4) == 0 else { throw HelperFailure(.internalError, "listen(): \(errno)") }

        let src = DispatchSource.makeReadSource(fileDescriptor: listenFd, queue: .main)
        src.setEventHandler { [weak self] in self?.acceptClient() }
        src.resume()
        listenSource = src
    }

    private func acceptClient() {
        let fd = accept(listenFd, nil, nil)
        guard fd >= 0 else { return }
        disableSigpipe(fd)
        if clientFd >= 0 {
            // Só um servidor MatDeck por vez: o segundo recebe `busy` e é fechado
            let line = Outgoing.event(name: "busy", data: .object([:])).encodeLine()
            _ = line.withCString { write(fd, $0, strlen($0)) }
            close(fd)
            return
        }
        clientFd = fd
        framer = LineFramer()
        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        src.setEventHandler { [weak self] in self?.readClient() }
        src.setCancelHandler { close(fd) }
        src.resume()
        clientSource = src
        onConnect?()
    }

    private func readClient() {
        var buf = [UInt8](repeating: 0, count: 65536)
        let n = read(clientFd, &buf, buf.count)
        if n <= 0 { dropClient(); return }
        let lines = framer.feed(Data(buf[0..<n]))
        if framer.droppedOversized > 0 && !warnedDropped {
            warnedDropped = true
            FileHandle.standardError.write(Data("[helper] linha maior que 1 MiB descartada\n".utf8))
        }
        for line in lines { onLine?(line) }
    }

    private func dropClient() {
        guard clientFd >= 0 else { return }
        clientSource?.cancel()
        clientSource = nil
        clientFd = -1
        onDisconnect?()
    }

    func send(_ line: String) {
        guard clientFd >= 0 else { return }
        var data = Array(line.utf8)
        var offset = 0
        while offset < data.count {
            let n = data.withUnsafeMutableBufferPointer { write(clientFd, $0.baseAddress! + offset, $0.count - offset) }
            if n <= 0 { dropClient(); return }
            offset += n
        }
    }

    func stop() {
        dropClient()
        listenSource?.cancel()
        listenSource = nil
        if listenFd >= 0 { close(listenFd); listenFd = -1 }
        unlink(path)
    }
}
