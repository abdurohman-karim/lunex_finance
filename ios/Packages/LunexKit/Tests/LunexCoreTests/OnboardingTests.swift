import Foundation
@testable import LunexCore
import Testing

private let car = GoalTemplate(key: "car", emoji: "🚗", color: "#B1A296", name: "Машина")

@Suite("Onboarding")
struct OnboardingDraftTests {
    @Test("answers become one request; ids and time zone come from the caller")
    func request() throws {
        var draft = OnboardingDraft(language: "ru")
        draft.currency = "USD"
        draft.focus = .save
        draft.monthlyIncome = "002500"
        draft.goalTemplate = car
        draft.goalAmount = "15000"
        let cash = UUID()
        let goal = UUID()

        let request = draft.request(cashAccountId: cash, goalId: goal, timezone: "Asia/Tashkent")
        #expect(request.language == "ru")
        #expect(request.baseCurrency == "USD")
        #expect(request.focus == .save)
        #expect(request.monthlyIncomeEstimate == "2500")
        #expect(request.cashAccountId == cash)
        #expect(request.firstGoal == NewGoal(
            id: goal, title: "Машина", templateKey: "car", emoji: "🚗",
            color: "#B1A296", targetAmount: "15000", currency: "USD"
        ))
    }

    @Test("skipped steps are left out of the JSON")
    func skipped() throws {
        var draft = OnboardingDraft(language: "uz")
        draft.goalTemplate = car
        draft.goalAmount = "0"
        #expect(!draft.hasValidGoal)

        let endpoint = API.completeOnboarding(draft.request(cashAccountId: UUID(), goalId: UUID(), timezone: "Asia/Tashkent"))
        #expect(endpoint.path == "me/onboarding")
        let body = try #require(endpoint.body)
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["firstGoal"] == nil)
        #expect(json["monthlyIncomeEstimate"] == nil)
        #expect(json["focus"] == nil)
        #expect(json["baseCurrency"] as? String == "UZS")
        #expect(json["cashAccountId"] is String)
    }
}

@Suite("Onboarding service")
@MainActor
struct OnboardingServiceTests {
    @Test("completing onboarding signs the user into the finished profile; a retry reuses the ids")
    func complete() async throws {
        let completed = profileJSON.replacingOccurrences(of: "\"onboardingCompleted\": false", with: "\"onboardingCompleted\": true")
        let transport = StubTransport { request in
            switch request.url?.path() {
            case "/v1/goals/templates":
                (200, ##"[{"key":"car","emoji":"🚗","color":"#B1A296","name":"Машина","labels":{"ru":"Машина"}}]"##)
            case "/v1/me/onboarding":
                (200, #"{"profile": \#(completed), "account": null, "goal": null, "checklist": {}}"#)
            default:
                (200, profileJSON)
            }
        }
        let auth = AuthSession(store: signedInStore(), refresher: { _ in TokenPair(accessToken: "a", accessTokenExpiresAt: .distantFuture, refreshToken: "r", refreshTokenExpiresAt: .distantFuture) })
        let api = APIClient(baseURL: baseURL, transport: transport, session: auth)
        let session = SessionStore(api: api, auth: auth, cache: UserDefaultsProfileCache(defaults: UserDefaults(suiteName: "lunex.tests.\(UUID())")!))
        let service = OnboardingService(api: api, session: session)

        await service.loadTemplates(language: "ru")
        #expect(service.templates.map(\.key) == ["car"])
        #expect(transport.requests.first?.url?.query() == "language=ru")

        var draft = OnboardingDraft(language: "ru")
        draft.goalTemplate = service.templates.first
        draft.goalAmount = "1000"
        try await service.complete(draft, timezone: "Asia/Tashkent")
        try await service.complete(draft, timezone: "Asia/Tashkent")
        #expect(session.profile?.onboardingCompleted == true)

        let bodies = transport.requests
            .filter { $0.url?.path() == "/v1/me/onboarding" }
            .compactMap { $0.httpBody }
            .compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        #expect(bodies.count == 2)
        #expect(bodies[0]["cashAccountId"] as? String == bodies[1]["cashAccountId"] as? String)
        let goalIds = bodies.compactMap { ($0["firstGoal"] as? [String: Any])?["id"] as? String }
        #expect(goalIds.count == 2 && goalIds[0] == goalIds[1])
    }
}
