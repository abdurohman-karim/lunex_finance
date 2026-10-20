import XCTest

/// History: a swipe deletes an operation, «Отменить» brings it back.
final class HistoryUITests: LunexUITestCase {
    func testSwipeDeleteAndUndo() {
        launch(.signedIn)
        addExpense("15000", category: "Еда")

        tap(tab("tab.transactions"))
        let row = waitFor(app.cells.containing(.staticText, identifier: "Еда").firstMatch)
        row.swipeLeft()
        tap(app.buttons[ru("history.delete")])
        waitUntilGone(row)

        tap(app.buttons[ru("common.undo")])
        waitFor(app.cells.containing(.staticText, identifier: "Еда").firstMatch)
    }
}
