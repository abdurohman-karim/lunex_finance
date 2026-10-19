import Foundation
@testable import LunexCore
import SwiftData
import Testing

@Suite("Settings")
@MainActor
struct SettingsTests {
    private func harness() throws -> (ModelContainer, SettingsStore) {
        let container = try LunexStore.makeContainer(inMemory: true)
        let auth = AuthSession(store: InMemorySecureStore(), refresher: { _ in throw APIError.offline(URLError(.notConnectedToInternet)) })
        let api = APIClient(baseURL: baseURL, transport: StubTransport { _ in throw URLError(.notConnectedToInternet) }, session: auth)
        return (container, SettingsStore(container: container, sync: SyncEngine(api: api, container: container) { _ in }))
    }

    private func queued(_ container: ModelContainer) throws -> [(type: String, data: [String: Any])] {
        try container.mainContext.fetch(FetchDescriptor<PendingOperation>(sortBy: [SortDescriptor(\.sequence)])).map {
            let body = try JSONSerialization.jsonObject(with: $0.payload) as! [String: Any]
            return ($0.type, body["data"] as? [String: Any] ?? [:])
        }
    }

    @Test("a change is saved locally and only that field is sent")
    func update() throws {
        let (container, settings) = try harness()
        try settings.update(.hideAmounts(true))
        try settings.update(.monthStartsOnDay(40))
        try settings.update(.dailyReminderTime("21:30"))
        try settings.update(.quietHoursStart("25:00"))

        let record = settings.current()
        #expect(record.hideAmounts && record.monthStartsOnDay == 31 && record.dailyReminderTime == "21:30")
        #expect(record.quietHoursStart == "22:00")

        let ops = try queued(container)
        #expect(ops.map(\.type) == ["settings.update", "settings.update", "settings.update"])
        #expect(ops[0].data as? [String: Bool] == ["hideAmounts": true])
        #expect(ops[1].data as? [String: Int] == ["monthStartsOnDay": 31])
        #expect(ops[2].data as? [String: String] == ["dailyReminderTime": "21:30"])
    }

    @Test("profile changes go as profile.update")
    func profile() throws {
        let (container, settings) = try harness()
        try settings.updateProfile(language: "uz", baseCurrency: "USD")
        try settings.updateProfile()
        let ops = try queued(container)
        #expect(ops.map(\.type) == ["profile.update"])
        #expect(ops[0].data as? [String: String] == ["language": "uz", "baseCurrency": "USD"])
    }
}

@Suite("App lock")
@MainActor
struct AppLockTests {
    @Test("locks on launch and after the set time in the background")
    func policy() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        let lock = AppLock(enabled: true, lockAfterSeconds: 60)
        #expect(lock.isLocked)

        let off = AppLock(enabled: false)
        off.didEnterBackground(now: start)
        off.didBecomeActive(now: start.addingTimeInterval(3600))
        #expect(!off.isLocked)

        let on = AppLock(enabled: false, lockAfterSeconds: 60)
        on.configure(enabled: true, lockAfterSeconds: 60)
        on.didEnterBackground(now: start)
        on.didBecomeActive(now: start.addingTimeInterval(59))
        #expect(!on.isLocked)
        on.didEnterBackground(now: start)
        on.didBecomeActive(now: start.addingTimeInterval(60))
        #expect(on.isLocked)

        on.configure(enabled: false, lockAfterSeconds: 60)
        #expect(!on.isLocked)
        #expect(LockPolicy.shouldLock(enabled: true, lockAfterSeconds: 0, backgroundedAt: start, now: start))
        #expect(!LockPolicy.shouldLock(enabled: true, lockAfterSeconds: 0, backgroundedAt: nil, now: start))
    }
}
