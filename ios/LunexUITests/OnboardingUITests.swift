import XCTest

/// Sign-in by email and onboarding, as a new beta tester goes through them.
final class OnboardingUITests: LunexUITestCase {
    func testEmailSignInAndOnboardingOpenHome() {
        launch(.signedOut)

        tap(app.buttons[ru("welcome.signIn.email")])
        let email = waitFor(app.textFields.firstMatch)
        email.tap()
        email.typeText("beta@lunex.test")
        tap(app.buttons[ru("auth.email.getCode")])
        let code = waitFor(app.textFields[ru("auth.code.title")])
        code.tap()
        // The sixth digit sends the code.
        code.typeText("123456")

        // Language, currency, focus, income, first goal, notifications
        tap(button(containing: "Русский"))
        tap(app.buttons[ru("onboarding.next")])
        tap(app.buttons[ru("onboarding.next")])
        tap(button(containing: ru("onboarding.focus.save")))
        tap(app.buttons[ru("onboarding.next")])
        waitFor(app.textFields.firstMatch).typeText(String(Self.incomeEstimate))
        tap(app.buttons[ru("onboarding.next")])
        tap(button(containing: "Телефон"))
        waitFor(app.textFields.firstMatch).typeText("9000000")
        tap(app.buttons[ru("onboarding.next")])
        tap(app.buttons[ru("onboarding.notifications.later")])

        // Home: the budget runs on the income from onboarding; the goal is the primary one.
        waitFor(safeToSpendRing, timeout: 10)
        XCTAssertEqual(safeToSpend, dailyLimitFromEstimate)
        XCTAssertTrue(app.staticTexts["Телефон"].exists)
    }

    func testWrongCodeIsRefused() {
        launch(.signedOut)

        tap(app.buttons[ru("welcome.signIn.email")])
        let email = waitFor(app.textFields.firstMatch)
        email.tap()
        email.typeText("beta@lunex.test")
        tap(app.buttons[ru("auth.email.getCode")])
        let code = waitFor(app.textFields[ru("auth.code.title")])
        code.tap()
        code.typeText("000000")

        waitFor(app.staticTexts[ru("error.invalidCode")])
        XCTAssertFalse(app.buttons[ru("onboarding.next")].exists)
    }
}
