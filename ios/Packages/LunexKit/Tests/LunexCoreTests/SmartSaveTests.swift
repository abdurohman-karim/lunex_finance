import Foundation
@testable import LunexCore
import Testing

private let suggestionId = "7b1f6e64-0f3a-4c8e-9a51-2d3c4b5a6e7f"

private func suggestionJSON(amount: String, status: String = "pending", accepted: String? = nil, currency: String = "UZS") -> String {
    """
    {
      "id": "\(suggestionId)",
      "forDate": "2026-10-19",
      "status": "\(status)",
      "goal": { "id": "0e9b5c34-5d6a-4f1e-8b2c-3a4d5e6f7a8b", "title": "Машина", "emoji": "🚗" },
      "amount": "\(amount)",
      "currency": "\(currency)",
      "amountBase": "\(amount)",
      "acceptedAmount": \(accepted.map { "\"\($0)\"" } ?? "null"),
      "expiresAt": "2026-10-19T19:00:00.000Z",
      "explanation": {
        "baseCurrency": "UZS", "monthIncome": "6000000", "monthExpenses": "1250000",
        "savedToGoals": "0", "upcomingRecurring": "1500000", "freeMoney": "3250000",
        "daysLeft": 13, "perDay": "250000", "sharePercent": 50, "goalCurrency": "\(currency)",
        "rate": null, "goalRemaining": "117000000", "accountId": null, "accountBalance": null, "cappedBy": null
      }
    }
    """
}

@MainActor
private func store(_ handler: @escaping StubTransport.Handler) -> SmartSaveStore {
    let auth = AuthSession(store: signedInStore(), refresher: { _ in
        try LunexJSON.decoder().decode(TokenPair.self, from: Data(tokensJSON(access: "access-1").utf8))
    })
    let api = APIClient(baseURL: baseURL, transport: StubTransport(handler), session: auth)
    return SmartSaveStore(api: api, sync: nil, defaults: UserDefaults(suiteName: UUID().uuidString)!)
}

@Suite("Smart Save")
@MainActor
struct SmartSaveTests {
    @Test("today's card decodes money and the explanation")
    func today() async throws {
        let smartSave = store { _ in (200, #"{"status":"available","suggestion":\#(suggestionJSON(amount: "125000")),"explanation":null}"#) }
        await smartSave.refresh()
        let today = try #require(smartSave.today)
        #expect(today.status == .available)
        let suggestion = try #require(today.suggestion)
        #expect(suggestion.amount == 125_000 && suggestion.goal.title == "Машина" && !suggestion.isForeign)
        #expect(suggestion.explanation.freeMoney == 3_250_000 && suggestion.explanation.daysLeft == 13)
        #expect(suggestion.explanation.rate == nil && suggestion.explanation.sharePercent == 50)
    }

    @Test("accepting sends the lowered amount and marks today as saved")
    func accept() async throws {
        let smartSave = store { request in
            #expect(request.url?.path == "/v1/smart-save/\(suggestionId)/accept")
            let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
            #expect(body?["amount"] == "100000")
            return (200, #"{"newMilestones":[25],"completed":false,"suggestion":\#(suggestionJSON(amount: "125000", status: "accepted", accepted: "100000"))}"#)
        }
        let suggestion = try LunexJSON.decoder().decode(SmartSaveSuggestion.self, from: Data(suggestionJSON(amount: "125000").utf8))
        let outcome = try await smartSave.accept(suggestion, amount: 100_000)
        #expect(outcome == .saved(amount: 100_000, newMilestones: [25], completed: false))
        #expect(smartSave.today?.status == .alreadySaved)
    }

    @Test("a lower safe amount at confirmation takes nothing and offers the new one")
    func amountChanged() async throws {
        let smartSave = store { _ in
            (409, #"{"code":"amount_changed","message":"The safe amount is lower now","expected":"125000","actual":"90000","suggestion":\#(suggestionJSON(amount: "90000"))}"#)
        }
        let suggestion = try LunexJSON.decoder().decode(SmartSaveSuggestion.self, from: Data(suggestionJSON(amount: "125000").utf8))
        let outcome = try await smartSave.accept(suggestion)
        guard case let .amountChanged(fresh) = outcome else {
            Issue.record("expected amountChanged, got \(outcome)")
            return
        }
        #expect(fresh.amount == 90_000)
        #expect(smartSave.today?.suggestion?.amount == 90_000 && smartSave.today?.status == .available)
    }

    @Test("when it is no longer possible, the fresh state comes back")
    func unavailable() async throws {
        let calls = Counter()
        let smartSave = store { request in
            if request.httpMethod == "POST" {
                return (409, #"{"code":"no_spare_money","message":"Smart Save is not possible right now"}"#)
            }
            calls.increment()
            return (200, #"{"status":"no_spare_money","suggestion":null,"explanation":\#(#"{"baseCurrency":"UZS","monthIncome":"0","monthExpenses":"50000","savedToGoals":"0","upcomingRecurring":"0","freeMoney":"-50000","daysLeft":13,"perDay":"0","sharePercent":50,"goalCurrency":"UZS","rate":null,"goalRemaining":null,"accountId":null,"accountBalance":null,"cappedBy":null}"#)}"#)
        }
        let suggestion = try LunexJSON.decoder().decode(SmartSaveSuggestion.self, from: Data(suggestionJSON(amount: "125000").utf8))
        let outcome = try await smartSave.accept(suggestion)
        guard case let .unavailable(today) = outcome else {
            Issue.record("expected unavailable, got \(outcome)")
            return
        }
        #expect(today.status == .noSpareMoney && today.explanation?.freeMoney == -50_000)
        #expect(calls.count == 1)
    }

    @Test("the daily limit after saving shrinks by the amount spread over the days left")
    func limitAfterSaving() {
        var inputs = BudgetInputs()
        inputs.incomeActual = 6_000_000
        inputs.daysLeft = 10
        let month = BudgetMonth(
            period: BudgetPeriod(start: .now, end: .now), daysTotal: 31, daysLeft: 10, currency: "UZS", mode: "auto",
            incomeActual: 6_000_000, incomePlanned: nil, expensesTotal: 0, expensesToday: 0, savedToGoals: 0,
            upcomingRecurring: 0, totalLimit: nil, figures: BudgetMath.compute(inputs), byCategory: [], forecast: 0,
            incomplete: false
        )
        #expect(month.figures.dailyLimit == 600_000)
        #expect(month.dailyLimit(afterSaving: 100_000) == 590_000)
        #expect(SmartSaveSteps.range(upTo: 125_000, currency: "UZS") == 1_000...125_000)
    }
}
