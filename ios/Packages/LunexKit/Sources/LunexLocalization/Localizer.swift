import Foundation
import Observation

public enum AppLanguage: String, CaseIterable, Identifiable, Sendable {
    case uz, ru, en

    public var id: String { rawValue }

    /// The language's own name, as shown in the picker.
    public var displayName: String {
        switch self {
        case .uz: "Oʻzbekcha"
        case .ru: "Русский"
        case .en: "English"
        }
    }

    /// Locale for numbers, dates and currency formatting.
    public var locale: Locale {
        switch self {
        case .uz: Locale(identifier: "uz_Latn_UZ")
        case .ru: Locale(identifier: "ru_RU")
        case .en: Locale(identifier: "en_US")
        }
    }

    /// First supported language among the system's preferred ones; Uzbek otherwise.
    public static func preferred(from languages: [String] = Locale.preferredLanguages) -> AppLanguage {
        for identifier in languages {
            let code = Locale(identifier: identifier).language.languageCode?.identifier
            if let code, let language = AppLanguage(rawValue: code) {
                return language
            }
        }
        return .uz
    }
}

/// App strings in the chosen language. The choice is the app's, not the system's, and
/// applies at once: views read `localizer("key")` and redraw when `language` changes.
@MainActor
@Observable
public final class Localizer {
    private static let storageKey = "lunex.language"

    public var language: AppLanguage {
        didSet { defaults.set(language.rawValue, forKey: Self.storageKey) }
    }

    public var locale: Locale { language.locale }

    /// Privacy mode («глаз»): every amount the app formats shows as dots. Set from the
    /// account's `hide_amounts` setting.
    public var hidesAmounts = false

    @ObservationIgnored private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.language = defaults.string(forKey: Self.storageKey)
            .flatMap(AppLanguage.init(rawValue:)) ?? .preferred()
    }

    public func callAsFunction(_ key: String) -> String {
        Self.string(key, language: language)
    }

    /// Strings with `%@`/`%lld` placeholders.
    public func format(_ key: String, _ arguments: any CVarArg...) -> String {
        String(format: Self.string(key, language: language), locale: locale, arguments: arguments)
    }

    /// Looks the key up in the language's table, then in English; the key itself if missing.
    nonisolated public static func string(_ key: String, language: AppLanguage) -> String {
        for candidate in [language, .en] {
            if let bundle = bundle(for: candidate) {
                let value = bundle.localizedString(forKey: key, value: missing, table: nil)
                if value != missing { return value }
            }
        }
        return key
    }

    nonisolated private static let missing = "\u{0}missing"

    nonisolated private static func bundle(for language: AppLanguage) -> Bundle? {
        Bundle.module.path(forResource: language.rawValue, ofType: "lproj").flatMap(Bundle.init(path:))
    }
}
