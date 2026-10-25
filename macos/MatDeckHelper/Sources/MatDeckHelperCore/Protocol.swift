// Protocolo entre o servidor Node e o helper: uma mensagem JSON por linha.
//   pedido   {"id":1,"op":"key.shortcut","args":{...}}
//   resposta {"id":1,"ok":true,"result":{...}}  ou  {"id":1,"ok":false,"error":"accessibility_denied","message":"..."}
//   evento   {"event":"window.active","data":{...}}
import Foundation

/// Valor JSON genérico (os args dos pedidos não têm esquema fixo).
public indirect enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "valor JSON não reconhecido")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n):
            if n == n.rounded(), abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var numberValue: Double? { if case .number(let n) = self { return n }; return nil }
    public var intValue: Int? { numberValue.map { Int($0) } }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public var stringArray: [String]? { arrayValue?.compactMap { $0.stringValue } }
}

/// Códigos de erro estáveis que o Node traduz em dicas no gerenciador.
public enum HelperError: String {
    case accessibilityDenied = "accessibility_denied"
    case automationDenied = "automation_denied"
    case notSupported = "not_supported"
    case notRunning = "not_running"
    case badRequest = "bad_request"
    case busy = "busy"
    case internalError = "internal_error"
}

/// Erro lançado pelos handlers; vira resposta `ok:false`.
public struct HelperFailure: Error {
    public let code: HelperError
    public let message: String
    public init(_ code: HelperError, _ message: String = "") { self.code = code; self.message = message }
}

public struct Request: Decodable {
    public let id: Int
    public let op: String
    public let args: [String: JSONValue]

    enum CodingKeys: String, CodingKey { case id, op, args }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        op = try c.decode(String.self, forKey: .op)
        args = try c.decodeIfPresent([String: JSONValue].self, forKey: .args) ?? [:]
    }

    public static func decode(line: String) throws -> Request {
        try JSONDecoder().decode(Request.self, from: Data(line.utf8))
    }
}

public enum Outgoing {
    case response(id: Int, ok: Bool, result: JSONValue?, error: String?, message: String?)
    case event(name: String, data: JSONValue)

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()

    /// Uma linha JSON terminada em "\n" (nunca contém "\n" no meio: o JSONEncoder não quebra linhas).
    public func encodeLine() -> String {
        var obj: [String: JSONValue]
        switch self {
        case .response(let id, let ok, let result, let error, let message):
            obj = ["id": .number(Double(id)), "ok": .bool(ok)]
            if let result { obj["result"] = result } else if ok { obj["result"] = .object([:]) }
            if let error { obj["error"] = .string(error) }
            if let message, !message.isEmpty { obj["message"] = .string(message) }
        case .event(let name, let data):
            obj = ["event": .string(name), "data": data]
        }
        let data = (try? Outgoing.encoder.encode(JSONValue.object(obj))) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self) + "\n"
    }

    public static func ok(_ id: Int, _ result: JSONValue = .object([:])) -> Outgoing {
        .response(id: id, ok: true, result: result, error: nil, message: nil)
    }

    public static func fail(_ id: Int, _ failure: HelperFailure) -> Outgoing {
        .response(id: id, ok: false, result: nil, error: failure.code.rawValue, message: failure.message)
    }
}
