// Troca de aba por AppleScript nos navegadores que expõem abas (Safari e a família Chromium).
// Firefox não é scriptável. Exige a permissão de Automação para cada navegador (o sistema pergunta).
import Foundation

enum BrowserTabs {
    static let chromiumFamily: Set<String> = ["com.google.chrome", "com.brave.browser", "com.microsoft.edgemac", "org.chromium.chromium", "com.vivaldi.vivaldi"]
    static let safari = "com.apple.safari"

    static func isScriptable(_ bundleId: String) -> Bool {
        let b = bundleId.lowercased()
        return b == safari || chromiumFamily.contains(b)
    }

    private static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }

    /// Ativa a primeira aba cujo título contém um dos hints. Devolve false se não achou ou sem permissão.
    static func activateTab(bundleId: String, containing hints: [String]) -> Bool {
        let b = bundleId.lowercased()
        let conditions = hints.map { "title of t contains \"\(escape($0))\"" }.joined(separator: " or ")
        let safariConditions = hints.map { "name of t contains \"\(escape($0))\"" }.joined(separator: " or ")
        guard !conditions.isEmpty else { return false }
        let script: String
        if b == safari {
            script = """
            tell application id "\(bundleId)"
                repeat with w in windows
                    repeat with t in tabs of w
                        if \(safariConditions) then
                            set current tab of w to t
                            set index of w to 1
                            return true
                        end if
                    end repeat
                end repeat
            end tell
            return false
            """
        } else {
            script = """
            tell application id "\(bundleId)"
                repeat with w in windows
                    set i to 1
                    repeat with t in tabs of w
                        if \(conditions) then
                            set active tab index of w to i
                            set index of w to 1
                            return true
                        end if
                        set i to i + 1
                    end repeat
                end repeat
            end tell
            return false
            """
        }
        var error: NSDictionary?
        guard let apple = NSAppleScript(source: script) else { return false }
        let result = apple.executeAndReturnError(&error)
        if let error {
            FileHandle.standardError.write(Data("[helper] AppleScript de abas falhou: \(error[NSAppleScript.errorMessage] ?? error)\n".utf8))
            return false
        }
        return result.booleanValue
    }
}
