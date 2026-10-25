// Corta o fluxo do socket em linhas (terminadas em "\n"). Uma linha maior que 1 MiB é descartada inteira,
// contada em `droppedOversized`, e o fluxo continua na linha seguinte.
import Foundation

public struct LineFramer {
    public static let maxLineBytes = 1_048_576

    private var buffer = Data()
    private var dropping = false
    public private(set) var droppedOversized = 0

    public init() {}

    public mutating func feed(_ data: Data) -> [String] {
        var lines: [String] = []
        var chunk = data
        while let nl = chunk.firstIndex(of: 0x0A) {
            let part = chunk.subdata(in: chunk.startIndex..<nl)
            chunk = chunk.subdata(in: (nl + 1)..<chunk.endIndex)
            if dropping {
                dropping = false
                droppedOversized += 1
                buffer.removeAll(keepingCapacity: true)
                continue
            }
            buffer.append(part)
            if buffer.count > LineFramer.maxLineBytes {
                droppedOversized += 1
            } else if !buffer.isEmpty {
                lines.append(String(decoding: buffer, as: UTF8.self))
            }
            buffer.removeAll(keepingCapacity: true)
        }
        if !dropping {
            buffer.append(chunk)
            if buffer.count > LineFramer.maxLineBytes {
                dropping = true
                buffer.removeAll(keepingCapacity: true)
            }
        }
        return lines
    }
}
