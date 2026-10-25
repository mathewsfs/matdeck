// Ícone na barra de menus (NSStatusItem): silhueta do MatDeck pintada com labelColor (segue o tema da
// barra) e um ponto colorido de estado; menu cujos itens o servidor define. Clique num item vira
// tray.menu {id}; clique no ícone quando não há itens vira tray.click.
import AppKit
import Foundation
import MatDeckHelperCore

final class TrayService: NSObject {
    private let emit: (String, JSONValue) -> Void
    private var item: NSStatusItem?
    private var menu: NSMenu?
    private var itemIds: [Int: String] = [:]

    init(emit: @escaping (String, JSONValue) -> Void) { self.emit = emit }

    func register(on d: Dispatcher) {
        d.register("tray.set") { [self] args in
            let visible = args["visible"]?.boolValue ?? true
            let tooltip = args["tooltip"]?.stringValue ?? "MatDeck"
            let state = args["state"]?.stringValue ?? "gray"
            let items: [(String, String)] = (args["items"]?.arrayValue ?? []).compactMap { v in
                guard let o = v.objectValue, let id = o["id"]?.stringValue, let label = o["label"]?.stringValue else { return nil }
                return (id, label)
            }
            self.apply(visible: visible, tooltip: tooltip, state: state, items: items)
            return .object(["visible": .bool(visible)])
        }
    }

    private func apply(visible: Bool, tooltip: String, state: String, items: [(String, String)]) {
        guard visible else { remove(); return }
        let it = item ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item = it
        if let button = it.button {
            button.image = TrayService.icon(state: state)
            button.toolTip = tooltip
            button.target = self
            button.action = #selector(clicked(_:))
        }
        itemIds = [:]
        if items.isEmpty { menu = nil; return }
        let m = NSMenu()
        for (i, (id, label)) in items.enumerated() {
            let mi = NSMenuItem(title: label, action: #selector(menuChosen(_:)), keyEquivalent: "")
            mi.target = self
            mi.tag = i
            itemIds[i] = id
            m.addItem(mi)
        }
        if items.count > 2 { m.insertItem(.separator(), at: 2) }   // abrir… | parar, ocultar
        menu = m
    }

    @objc private func clicked(_ sender: Any?) {
        guard let it = item else { return }
        guard let m = menu else { emit("tray.click", .object([:])); return }
        // Menu só durante o clique: assim o botão mantém a ação (e o tray.click quando não há itens)
        it.menu = m
        it.button?.performClick(nil)
        it.menu = nil
    }

    @objc private func menuChosen(_ sender: NSMenuItem) {
        guard let id = itemIds[sender.tag] else { return }
        emit("tray.menu", .object(["id": .string(id)]))
    }

    private func remove() {
        if let it = item { NSStatusBar.system.removeStatusItem(it) }
        item = nil
        menu = nil
    }

    /// Desenhado sob demanda: labelColor resolve com a aparência atual da barra a cada desenho.
    static func icon(state: String) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let base = Bundle.main.url(forResource: "menubar-icon", withExtension: "png").flatMap { NSImage(contentsOf: $0) }
        let color: NSColor? = state == "green" ? .systemGreen : (state == "amber" ? .systemOrange : (state == "gray" ? .systemGray : nil))
        let img = NSImage(size: size, flipped: false) { rect in
            if let base {
                base.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
                NSColor.labelColor.setFill()
                rect.fill(using: .sourceAtop)
            }
            if let color {
                let dot = NSRect(x: rect.maxX - 6, y: rect.minY, width: 6, height: 6)
                NSColor.windowBackgroundColor.setFill()
                NSBezierPath(ovalIn: dot.insetBy(dx: -1, dy: -1)).fill()
                color.setFill()
                NSBezierPath(ovalIn: dot).fill()
            }
            return true
        }
        img.isTemplate = false
        return img
    }
}
