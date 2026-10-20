import XCTest

/// An expense in two taps, and what it changes at once.
final class QuickAddUITests: LunexUITestCase {
    func testExpenseLowersWhatIsLeftForToday() {
        launch(.signedIn)
        let before = safeToSpend
        XCTAssertEqual(before, dailyLimitFromEstimate)

        addExpense("25000", category: "Еда")

        XCTAssertEqual(safeToSpend, before - 25_000)
        XCTAssertTrue(app.staticTexts[ru("home.recent")].exists)
        XCTAssertTrue(app.staticTexts["Еда"].exists)
    }

    func testUndoFromTheToastTakesTheExpenseBack() {
        launch(.signedIn)
        let before = safeToSpend

        addExpense("40000", category: "Транспорт")
        XCTAssertEqual(safeToSpend, before - 40_000)
        tap(app.buttons[ru("common.undo")])

        waitUntilGone(app.staticTexts["Транспорт"])
        XCTAssertEqual(safeToSpend, before)
    }
}
