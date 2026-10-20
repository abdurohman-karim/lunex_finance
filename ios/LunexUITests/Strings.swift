import Foundation

/// The app's own strings (`Localizable.xcstrings`), so the tests find buttons by the words the
/// user sees and keep working when a word changes. The app runs in Russian in the tests.
enum Strings {
    static func ru(_ key: String) -> String {
        guard let value = table[key] else { fatalError("No Russian string for \(key)") }
        return value
    }

    /// A format string with its arguments, e.g. `%@ осталось`.
    static func ru(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: ru(key), locale: Locale(identifier: "ru"), arguments: arguments)
    }

    private static let table: [String: String] = {
        let file = URL(filePath: #filePath)
            .deletingLastPathComponent() // LunexUITests
            .deletingLastPathComponent() // ios
            .appending(path: "Packages/LunexKit/Sources/LunexLocalization/Resources/Localizable.xcstrings")
        guard
            let data = try? Data(contentsOf: file),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let strings = root["strings"] as? [String: [String: Any]]
        else { fatalError("Cannot read \(file.path)") }
        var table: [String: String] = [:]
        for (key, entry) in strings {
            let localizations = entry["localizations"] as? [String: Any]
            let ru = localizations?["ru"] as? [String: Any]
            let unit = ru?["stringUnit"] as? [String: Any]
            if let value = unit?["value"] as? String { table[key] = value }
        }
        return table
    }()
}
