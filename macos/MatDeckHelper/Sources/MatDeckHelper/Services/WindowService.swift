// Janela ativa (NSWorkspace + título pela Acessibilidade) e foco de janela/aba.
import AppKit
import ApplicationServices
import Foundation
import MatDeckHelperCore

final class WindowService {
    private let emit: (String, JSONValue) -> Void
    private var subscribed = false
    private var workspaceObserver: NSObjectProtocol?
    private var axObserver: AXObserver?
    private var observedPid: pid_t = 0

    init(emit: @escaping (String, JSONValue) -> Void) { self.emit = emit }

    func register(on d: Dispatcher) {
        d.register("window.active") { [self] _ in self.activeInfo() }
        d.register("window.subscribe") { [self] args in
            let on = try arg(args, "on") { $0.boolValue }
            self.setSubscribed(on)
            return .object(["subscribed": .bool(on)])
        }
        d.register("window.focus") { [self] args in
            try Permissions.requireAccessibility()
            let bundleIds = Set((args["bundleIds"]?.stringArray ?? []).map { $0.lowercased() })
            let names = Set((args["names"]?.stringArray ?? []).map { $0.lowercased() })
            let hints = args["titleHints"]?.stringArray ?? []
            let requireTitle = args["requireTitle"]?.boolValue ?? false
            let (focused, how) = self.focus(bundleIds: bundleIds, names: names, titleHints: hints, requireTitle: requireTitle)
            return .object(["focused": .bool(focused), "how": how.map { .string($0) } ?? .null])
        }
    }

    // MARK: janela ativa

    private func activeInfo() -> JSONValue {
        guard let app = NSWorkspace.shared.frontmostApplication else { return .object([:]) }
        return info(for: app)
    }

    private func info(for app: NSRunningApplication) -> JSONValue {
        .object([
            "app": .string(app.localizedName ?? ""),
            "bundleId": .string(app.bundleIdentifier ?? ""),
            "pid": .number(Double(app.processIdentifier)),
            "title": .string(focusedWindowTitle(pid: app.processIdentifier) ?? "")
        ])
    }

    private func focusedWindowTitle(pid: pid_t) -> String? {
        guard Permissions.accessibility else { return nil }
        let appEl = AXUIElementCreateApplication(pid)
        var win: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &win) == .success, let w = win else { return nil }
        var title: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success else { return nil }
        return title as? String
    }

    private func setSubscribed(_ on: Bool) {
        subscribed = on
        if on {
            if workspaceObserver == nil {
                workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
                    guard let self, self.subscribed, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
                    self.observeTitle(of: app)
                    self.emit("window.active", self.info(for: app))
                }
            }
            if let app = NSWorkspace.shared.frontmostApplication { observeTitle(of: app); emit("window.active", info(for: app)) }
        } else {
            if let o = workspaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(o); workspaceObserver = nil }
            stopTitleObserver()
        }
    }

    /// AXObserver no app da frente: título mudou ou outra janela do mesmo app ganhou foco (abas, documentos).
    private func observeTitle(of app: NSRunningApplication) {
        guard Permissions.accessibility else { return }
        let pid = app.processIdentifier
        if pid == observedPid, axObserver != nil { return }
        stopTitleObserver()
        var observer: AXObserver?
        let callback: AXObserverCallback = { _, _, _, refcon in
            guard let refcon else { return }
            let service = Unmanaged<WindowService>.fromOpaque(refcon).takeUnretainedValue()
            if let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier == service.observedPid {
                service.emit("window.active", service.info(for: app))
            }
        }
        guard AXObserverCreate(pid, callback, &observer) == .success, let obs = observer else { return }
        let appEl = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(obs, appEl, kAXFocusedWindowChangedNotification as CFString, refcon)
        AXObserverAddNotification(obs, appEl, kAXTitleChangedNotification as CFString, refcon)
        AXObserverAddNotification(obs, appEl, kAXWindowCreatedNotification as CFString, refcon)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        axObserver = obs
        observedPid = pid
    }

    private func stopTitleObserver() {
        if let obs = axObserver { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode) }
        axObserver = nil
        observedPid = 0
    }

    // MARK: foco

    private func windowTitles(pid: pid_t) -> [(AXUIElement, String)] {
        let appEl = AXUIElementCreateApplication(pid)
        var wins: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &wins) == .success, let arr = wins as? [AXUIElement] else { return [] }
        return arr.map { w in
            var t: CFTypeRef?
            _ = AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t)
            return (w, (t as? String) ?? "")
        }
    }

    private func focus(bundleIds: Set<String>, names: Set<String>, titleHints: [String], requireTitle: Bool) -> (Bool, String?) {
        let hints = titleHints.map { $0.lowercased() }
        let candidates = NSWorkspace.shared.runningApplications.filter { app in
            guard app.activationPolicy == .regular else { return false }
            let bid = (app.bundleIdentifier ?? "").lowercased()
            let name = (app.localizedName ?? "").lowercased()
            return bundleIds.contains(bid) || names.contains(name)
        }
        for app in candidates {
            if !hints.isEmpty {
                for (win, title) in windowTitles(pid: app.processIdentifier) where hints.contains(where: { title.lowercased().contains($0) }) {
                    AXUIElementPerformAction(win, kAXRaiseAction as CFString)
                    app.activate(options: [.activateIgnoringOtherApps])
                    return (true, "window")
                }
                if let bid = app.bundleIdentifier, BrowserTabs.isScriptable(bid), BrowserTabs.activateTab(bundleId: bid, containing: titleHints) {
                    app.activate(options: [.activateIgnoringOtherApps])
                    return (true, "tab")
                }
            }
        }
        if requireTitle { return (false, nil) }
        if let app = candidates.first {
            app.activate(options: [.activateIgnoringOtherApps])
            return (true, "app")
        }
        return (false, nil)
    }
}
