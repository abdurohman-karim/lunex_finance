import XCTest

/// Launches the app against its in-memory stand-in server (`UITestServer`) in Russian:
/// no network, no backend, and nothing of a real sign-in on the simulator is touched.
@MainActor
class LunexUITestCase: XCTestCase {
    enum Start: String {
        /// The welcome screen of a new user
        case signedOut
        /// Past onboarding: «Наличные», categories, an income estimate of 3 100 000 сум
        case signedIn
    }

    /// The income estimate of a signed-in start (`UITestServer.incomeEstimate`).
    static let incomeEstimate = 3_100_000

    private(set) var app = XCUIApplication()

    func launch(_ start: Start) {
        continueAfterFailure = false
        app.launchEnvironment["LUNEX_UI_TEST"] = start.rawValue
        app.launchEnvironment["LUNEX_UI_TEST_LANGUAGE"] = "ru"
        app.launch()
    }

    // MARK: Finding

    func ru(_ key: String) -> String {
        Strings.ru(key)
    }

    /// A button whose label has `text` in it: rows and tiles read their emoji, title and detail together.
    func button(containing text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    func tab(_ key: String) -> XCUIElement {
        app.tabBars.buttons[ru(key)]
    }

    @discardableResult
    func waitFor(_ element: XCUIElement, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        if !element.waitForExistence(timeout: timeout) {
            XCTFail("Not on screen: \(element)\n\(app.debugDescription)", file: file, line: line)
        }
        return element
    }

    func tap(_ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        waitFor(element, file: file, line: line).tap()
    }

    func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        if XCTWaiter.wait(for: [gone], timeout: timeout) != .completed {
            XCTFail("Still on screen: \(element)", file: file, line: line)
        }
    }

    // MARK: Home

    /// The ring on the home screen: «258 333 сум из 258 333».
    var safeToSpendRing: XCUIElement {
        app.otherElements[ru("home.safeToSpend")]
    }

    /// «Можно потратить сегодня» as a number.
    var safeToSpend: Int {
        let value = waitFor(safeToSpendRing).value as? String ?? ""
        let figure = value.components(separatedBy: "сум").first ?? ""
        return Int(figure.filter(\.isNumber)) ?? -1
    }

    /// What the budget gives a day from the estimate: the rest of this month, today included.
    var dailyLimitFromEstimate: Int {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: .now)
        let days = calendar.range(of: .day, in: .month, for: today)!.count
        let daysLeft = days - calendar.component(.day, from: today) + 1
        return Self.incomeEstimate / daysLeft
    }

    // MARK: Quick add

    /// «+», the amount on the keypad, a category, «Готово».
    func addExpense(_ digits: String, category: String) {
        tap(app.buttons[ru("history.add")])
        for digit in digits {
            tap(app.buttons[String(digit)])
        }
        tap(app.buttons[category])
        tap(app.buttons[ru("add.done")])
        waitFor(app.staticTexts[ru("add.saved.expense")])
    }
}
