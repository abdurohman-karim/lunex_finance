import XCTest

/// A goal from a template, then a deposit that reaches the first milestone.
final class GoalsUITests: LunexUITestCase {
    func testCreateGoalFromTemplateAndDeposit() {
        launch(.signedIn)

        tap(tab("tab.goals"))
        tap(app.buttons[ru("goals.new")].firstMatch)
        tap(button(containing: "Машина"))
        let amount = waitFor(app.textFields["0"])
        amount.tap()
        amount.typeText("1000000")
        tap(app.buttons[ru("common.save")])

        // The first goal is the primary one: its card has «Пополнить» right on it.
        waitFor(app.staticTexts["Машина"])
        XCTAssertTrue(app.staticTexts["0%"].exists)
        tap(app.buttons[ru("goals.deposit")].firstMatch)
        for digit in "250000" {
            tap(app.buttons[String(digit)])
        }
        tap(app.buttons[ru("add.done")])

        waitFor(app.staticTexts["25%"])
    }
}
