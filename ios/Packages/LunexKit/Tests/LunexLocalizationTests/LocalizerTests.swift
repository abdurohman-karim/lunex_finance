import Foundation
@testable import LunexLocalization
import Testing

@Suite("Localization")
struct LocalizerTests {
    @Test("looks strings up in the chosen language")
    func lookup() {
        #expect(Localizer.string("tab.home", language: .ru) == "Главная")
        #expect(Localizer.string("tab.home", language: .uz) == "Asosiy")
        #expect(Localizer.string("tab.home", language: .en) == "Home")
    }

    @Test("falls back to the key for unknown strings")
    func missing() {
        #expect(Localizer.string("no.such.key", language: .ru) == "no.such.key")
    }

    @Test("every key is translated into uz, ru and en")
    func complete() throws {
        let catalog = try #require(Bundle.module.url(forResource: "en", withExtension: "lproj"))
        let english = try #require(NSDictionary(contentsOf: catalog.appending(path: "Localizable.strings")) as? [String: String])
        #expect(!english.isEmpty)
        for language in AppLanguage.allCases {
            for key in english.keys {
                #expect(Localizer.string(key, language: language) != key, "\(key) is missing in \(language)")
            }
        }
    }

    @Test("picks the first supported system language, Uzbek otherwise")
    func preferred() {
        #expect(AppLanguage.preferred(from: ["de-DE", "ru-RU", "en-US"]) == .ru)
        #expect(AppLanguage.preferred(from: ["uz-Latn-UZ"]) == .uz)
        #expect(AppLanguage.preferred(from: ["de-DE"]) == .uz)
    }

    @Test("remembers the choice and switches at once")
    @MainActor
    func persistence() throws {
        let defaults = try #require(UserDefaults(suiteName: "lunex.tests.\(UUID())"))
        let localizer = Localizer(defaults: defaults)
        localizer.language = .en
        #expect(localizer("tab.goals") == "Goals")
        localizer.language = .ru
        #expect(localizer("tab.goals") == "Цели")
        #expect(Localizer(defaults: defaults).language == .ru)
    }
}
