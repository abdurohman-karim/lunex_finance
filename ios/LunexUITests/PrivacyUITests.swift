import XCTest

/// The «eye» hides every amount and shows them again.
final class PrivacyUITests: LunexUITestCase {
    func testEyeHidesAndShowsAmounts() {
        launch(.signedIn)
        let shown = safeToSpend
        XCTAssertGreaterThan(shown, 0)

        tap(app.buttons[ru("home.hideAmounts")])
        waitFor(app.buttons[ru("home.showAmounts")])
        XCTAssertTrue((safeToSpendRing.value as? String ?? "").contains("••••"))

        tap(app.buttons[ru("home.showAmounts")])
        waitFor(app.buttons[ru("home.hideAmounts")])
        XCTAssertEqual(safeToSpend, shown)
    }
}
