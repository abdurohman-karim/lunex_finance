import Foundation
@testable import LunexCore
import SwiftData
import Testing

/// The UI tests' stand-in server must answer in the format the app decodes; these run the
/// app's own clients against it, without a simulator.
@Suite("UI test server")
@MainActor
struct UITestServerTests {
    @MainActor
    private struct App {
        let session: SessionStore
        let signIn: SignInService
        let onboarding: OnboardingService
        let sync: SyncEngine
        let container: ModelContainer

        init(_ start: UITestServer.Start) throws {
            let server = UITestServer(start: start)
            let store = InMemorySecureStore(start == .signedIn ? [SecureKey.refreshToken: UITestServer.refreshToken] : [:])
            let publicAPI = APIClient(baseURL: baseURL, transport: server, session: nil)
            let auth = AuthSession(store: store, refresher: { try await publicAPI.send(API.refresh($0)) })
            let api = APIClient(baseURL: baseURL, transport: server, session: auth)
            let session = SessionStore(
                api: api, auth: auth, cache: UserDefaultsProfileCache(defaults: UserDefaults(suiteName: "lunex.tests.\(UUID())")!)
            )
            container = try LunexStore.makeContainer(inMemory: true)
            self.session = session
            signIn = SignInService(
                api: publicAPI, session: session, device: DeviceInfo(id: UUID(), model: nil, osVersion: nil, appVersion: "test"),
                telegramStartURL: TelegramLogin.startURL(apiBaseURL: baseURL), google: nil
            )
            onboarding = OnboardingService(api: api, session: session)
            sync = SyncEngine(api: api, container: container) { profile in session.update(profile) }
        }

        func fetch<Model: PersistentModel>(_ type: Model.Type) throws -> [Model] {
            try container.mainContext.fetch(FetchDescriptor<Model>())
        }
    }

    @Test("a new user signs in by email, finishes onboarding and gets «Наличные» and the goal on the first sync")
    func signUp() async throws {
        let app = try App(.signedOut)
        await app.session.restore()
        #expect(app.session.state == .signedOut)
        await app.signIn.loadProviders()
        #expect(app.signIn.isAvailable(.email) && !app.signIn.isAvailable(.apple))

        await #expect(throws: APIError.self) {
            try await app.signIn.signIn(.email(address: "beta@lunex.test", code: "000000"), language: "ru")
        }
        try await app.signIn.signIn(.email(address: "beta@lunex.test", code: UITestServer.emailCode), language: "ru")
        #expect(app.session.profile?.onboardingCompleted == false)
        #expect(app.session.access?.isPro == true)

        await app.onboarding.loadTemplates(language: "ru")
        var draft = OnboardingDraft(language: "ru")
        draft.monthlyIncome = "3100000"
        draft.goalTemplate = try #require(app.onboarding.templates.first { $0.key == "phone" })
        draft.goalAmount = "9000000"
        try await app.onboarding.complete(draft)
        #expect(app.session.profile?.onboardingCompleted == true)
        #expect(app.session.profile?.monthlyIncomeEstimate == "3100000")

        await app.sync.sync()
        #expect(app.sync.status == .idle)
        #expect(try app.fetch(AccountRecord.self).map(\.name) == ["Наличные"])
        #expect(try app.fetch(GoalRecord.self).map(\.title) == ["Телефон"])
        #expect(try app.fetch(CategoryRecord.self).count == 8)
        #expect(try app.fetch(SettingsRecord.self).count == 1)
    }

    @Test("a signed-in start opens with the account and accepts the queue")
    func signedIn() async throws {
        let app = try App(.signedIn)
        await app.session.restore()
        #expect(app.session.profile?.onboardingCompleted == true)

        await app.sync.sync()
        let cash = try #require(try app.fetch(AccountRecord.self).first)
        let food = try #require(try app.fetch(CategoryRecord.self).first { $0.key == "food" })
        let ledger = Ledger(container: app.container, sync: app.sync) { "UZS" }
        var amount = AmountInput(fractionDigits: 0)
        for key in [AmountInput.Key.digit(2), .digit(5), .thousands] { amount.press(key) }
        _ = try ledger.create(TransactionDraft(amount: amount, accountId: cash.id, categoryId: food.id))
        await app.sync.sync()

        #expect(app.sync.pendingCount == 0)
        #expect(app.sync.rejections.isEmpty)
        #expect(try app.fetch(TransactionRecord.self).map(\.amount) == [25_000])
    }
}
