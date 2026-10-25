// Tabela op -> handler. Cada handler recebe os args e devolve o result (ou lança HelperFailure).
import Foundation
import MatDeckHelperCore

typealias Handler = ([String: JSONValue]) throws -> JSONValue

final class Dispatcher {
    private var handlers: [String: Handler] = [:]

    func register(_ op: String, _ handler: @escaping Handler) { handlers[op] = handler }

    func handle(line: String) -> String {
        let req: Request
        do { req = try Request.decode(line: line) } catch {
            return Outgoing.fail(0, HelperFailure(.badRequest, "JSON inválido: \(error.localizedDescription)")).encodeLine()
        }
        guard let h = handlers[req.op] else {
            return Outgoing.fail(req.id, HelperFailure(.badRequest, "operação desconhecida: \(req.op)")).encodeLine()
        }
        do {
            return Outgoing.ok(req.id, try h(req.args)).encodeLine()
        } catch let f as HelperFailure {
            return Outgoing.fail(req.id, f).encodeLine()
        } catch {
            return Outgoing.fail(req.id, HelperFailure(.internalError, error.localizedDescription)).encodeLine()
        }
    }
}

/// Lê um argumento obrigatório ou lança bad_request.
func arg<T>(_ args: [String: JSONValue], _ key: String, _ get: (JSONValue) -> T?) throws -> T {
    guard let v = args[key], let t = get(v) else { throw HelperFailure(.badRequest, "argumento \(key) ausente ou inválido") }
    return t
}
