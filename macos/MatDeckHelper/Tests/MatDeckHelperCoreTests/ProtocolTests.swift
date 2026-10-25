// Testes do protocolo com Swift Testing (as Command Line Tools não trazem o XCTest).
import Foundation
import Testing
@testable import MatDeckHelperCore

@Suite struct ProtocolTests {
    @Test func decodesRequestWithArgs() throws {
        let r = try Request.decode(line: #"{"id":7,"op":"key.shortcut","args":{"keys":["cmd","shift","m"]}}"#)
        #expect(r.id == 7)
        #expect(r.op == "key.shortcut")
        #expect(r.args["keys"]?.arrayValue?.compactMap { $0.stringValue } == ["cmd", "shift", "m"])
    }

    @Test func decodesRequestWithoutArgs() throws {
        let r = try Request.decode(line: #"{"id":1,"op":"hello"}"#)
        #expect(r.op == "hello")
        #expect(r.args.isEmpty)
    }

    @Test func encodesOkResponseOnOneLine() {
        let s = Outgoing.response(id: 1, ok: true, result: .object(["pid": .number(42)]), error: nil, message: nil).encodeLine()
        #expect(s.hasSuffix("\n"))
        #expect(s.filter { $0 == "\n" }.count == 1)
        #expect(s.contains(#""ok":true"#))
        #expect(s.contains(#""pid":42"#))
    }

    @Test func encodesErrorResponse() {
        let s = Outgoing.response(id: 2, ok: false, result: nil, error: HelperError.accessibilityDenied.rawValue, message: "Conceda em Ajustes").encodeLine()
        #expect(s.contains(#""ok":false"#))
        #expect(s.contains(#""error":"accessibility_denied""#))
        #expect(s.contains(#""message":"Conceda em Ajustes""#))
    }

    @Test func encodesEvent() {
        let s = Outgoing.event(name: "window.active", data: .object(["app": .string("Safari")])).encodeLine()
        #expect(s.contains(#""event":"window.active""#))
        #expect(s.contains(#""app":"Safari""#))
    }

    @Test func framerSplitsAndKeepsRemainder() {
        var f = LineFramer()
        #expect(f.feed(Data("{\"a\":1}\n{\"b\"".utf8)) == ["{\"a\":1}"])
        #expect(f.feed(Data(":2}\n".utf8)) == ["{\"b\":2}"])
    }

    @Test func framerDropsOversizedLine() {
        var f = LineFramer()
        _ = f.feed(Data(repeating: 0x61, count: 1_048_577))
        let lines = f.feed(Data("\n{\"ok\":1}\n".utf8))
        #expect(f.droppedOversized == 1)
        #expect(lines == ["{\"ok\":1}"])
    }

    @Test func jsonValueRoundTrip() throws {
        let v: JSONValue = .object(["a": .array([.number(1), .bool(true), .null]), "s": .string("x")])
        let data = try JSONEncoder().encode(v)
        let back = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(back == v)
        #expect(back.objectValue?["s"]?.stringValue == "x")
    }
}
