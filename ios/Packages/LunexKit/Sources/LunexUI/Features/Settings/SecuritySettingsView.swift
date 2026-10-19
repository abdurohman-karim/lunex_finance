import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// Face ID / Touch ID / passcode lock, when it locks again, and hidden amounts.
struct SecuritySettingsView: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @Query private var records: [SettingsRecord]
    @State private var biometry = AppLock.biometry
    @State private var notice: String?

    private static let delays = [0, 30, 60, 300, 900]

    var body: some View {
        let record = records.first
        Form {
            Section {
                Toggle(lockTitle, isOn: Binding(
                    get: { record?.biometricLockEnabled ?? false },
                    set: { setLock($0) }
                ))
                .tint(LunexColor.ink)
                .disabled(biometry == .unavailable && !(record?.biometricLockEnabled ?? false))
                Picker(localizer("security.autoLock"), selection: Binding(
                    get: { record?.lockAfterSeconds ?? 60 },
                    set: { value in run { try settings.update(.lockAfterSeconds(value)) } }
                )) {
                    ForEach(Self.delays, id: \.self) { Text(delayTitle($0)).tag($0) }
                }
                .disabled(!(record?.biometricLockEnabled ?? false))
            } footer: {
                Text(notice ?? localizer(biometry == .unavailable ? "security.lock.unavailable" : "security.lock.footer"))
            }
            Section {
                Toggle(localizer("security.hideAmounts"), isOn: Binding(
                    get: { record?.hideAmounts ?? false },
                    set: { value in run { try settings.update(.hideAmounts(value)) } }
                ))
                .tint(LunexColor.ink)
            } footer: {
                Text(localizer("security.hideAmounts.footer"))
            }
        }
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .navigationTitle(localizer("settings.security"))
        .inlineTitle()
        .onAppear { biometry = AppLock.biometry }
    }

    private var lockTitle: String {
        switch biometry {
        case .faceID: localizer("security.lock.faceID")
        case .touchID: localizer("security.lock.touchID")
        case .opticID: localizer("security.lock.opticID")
        case .passcode, .unavailable: localizer("security.lock.passcode")
        }
    }

    private func delayTitle(_ seconds: Int) -> String {
        if seconds == 0 { return localizer("security.autoLock.now") }
        let duration = Duration.seconds(seconds)
        return seconds < 60
            ? localizer.format("security.autoLock.seconds", seconds)
            : localizer.format("security.autoLock.minutes", Int(duration.components.seconds / 60))
    }

    /// Turning it on asks once, so a lock that cannot be opened is never set.
    private func setLock(_ on: Bool) {
        notice = nil
        guard on else {
            run { try settings.update(.biometricLock(false)) }
            return
        }
        Task {
            if await AppLock.authenticate(reason: localizer("security.lock.reason")) {
                run { try settings.update(.biometricLock(true)) }
            } else {
                notice = localizer("security.lock.failed")
            }
        }
    }

    private func run(_ action: () throws -> Void) {
        do {
            try action()
        } catch {
            toasts.show(localizer("add.saveFailed"))
        }
    }
}

/// Which pushes come and when: the evening reminder, alert kinds, quiet hours.
struct NotificationSettingsView: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @Query private var records: [SettingsRecord]

    var body: some View {
        let record = records.first
        Form {
            Section {
                toggle("notifications.reminder", record?.dailyReminderEnabled ?? true) { .dailyReminder($0) }
                DatePicker(
                    localizer("notifications.reminder.time"),
                    selection: time(record?.dailyReminderTime ?? "21:00") { .dailyReminderTime($0) },
                    displayedComponents: .hourAndMinute
                )
                .disabled(!(record?.dailyReminderEnabled ?? true))
            } footer: {
                Text(localizer("notifications.reminder.footer"))
            }
            Section(localizer("notifications.kinds")) {
                toggle("notifications.budget", record?.budgetAlertsEnabled ?? true) { .budgetAlerts($0) }
                toggle("notifications.goals", record?.goalAlertsEnabled ?? true) { .goalAlerts($0) }
                toggle("notifications.recurring", record?.recurringAlertsEnabled ?? true) { .recurringAlerts($0) }
                toggle("notifications.smartSave", record?.smartSaveEnabled ?? true) { .smartSave($0) }
                toggle("notifications.weekly", record?.weeklyReportEnabled ?? true) { .weeklyReport($0) }
            }
            Section {
                DatePicker(
                    localizer("notifications.quiet.from"),
                    selection: time(record?.quietHoursStart ?? "22:00") { .quietHoursStart($0) },
                    displayedComponents: .hourAndMinute
                )
                DatePicker(
                    localizer("notifications.quiet.to"),
                    selection: time(record?.quietHoursEnd ?? "08:00") { .quietHoursEnd($0) },
                    displayedComponents: .hourAndMinute
                )
            } header: {
                Text(localizer("notifications.quiet"))
            } footer: {
                Text(localizer("notifications.quiet.footer"))
            }
        }
        .tint(LunexColor.ink)
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .navigationTitle(localizer("settings.notifications"))
        .inlineTitle()
    }

    private func toggle(_ key: String, _ value: Bool, _ change: @escaping (Bool) -> SettingsChange) -> some View {
        Toggle(localizer(key), isOn: Binding(get: { value }, set: { new in run { try settings.update(change(new)) } }))
            .tint(LunexColor.ink)
    }

    /// `HH:MM` ↔ a date today, for the time picker.
    private func time(_ text: String, _ change: @escaping (String) -> SettingsChange) -> Binding<Date> {
        Binding(
            get: {
                let parts = text.split(separator: ":").compactMap { Int($0) }
                return Calendar.current.date(bySettingHour: parts.first ?? 0, minute: parts.last ?? 0, second: 0, of: .now) ?? .now
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                run { try settings.update(change(String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0))) }
            }
        )
    }

    private func run(_ action: () throws -> Void) {
        do {
            try action()
        } catch {
            toasts.show(localizer("add.saveFailed"))
        }
    }
}

// MARK: - Lock and privacy cover

/// Shown over the app while it is locked: Face ID asks by itself, the button asks again.
struct LockView: View {
    @Environment(AppLock.self) private var lock
    @Environment(Localizer.self) private var localizer
    @State private var asked = false

    var body: some View {
        VStack(spacing: LunexTheme.Spacing.space6) {
            Spacer()
            LunexLogo(label: localizer("app.name"))
                .frame(width: 160)
            Image(systemName: "lock")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(LunexColor.inkMuted)
            Text(localizer("lock.title"))
                .lunexText(.titleM)
                .foregroundStyle(LunexColor.ink)
            Spacer()
            Button(unlockTitle) { unlock() }
                .buttonStyle(.lunex(.primary))
                .disabled(lock.isAuthenticating)
        }
        .padding(LunexTheme.Spacing.space6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LunexColor.paper)
        .task {
            guard !asked else { return }
            asked = true
            unlock()
        }
    }

    private var unlockTitle: String {
        switch AppLock.biometry {
        case .faceID: localizer("lock.unlock.faceID")
        case .touchID: localizer("lock.unlock.touchID")
        default: localizer("lock.unlock")
        }
    }

    private func unlock() {
        Task { await lock.unlock(reason: localizer("lock.reason")) }
    }
}

/// What the app switcher shows: the screen blurred under the logo.
struct PrivacyCover: View {
    @Environment(Localizer.self) private var localizer

    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
            LunexLogo(label: localizer("app.name"))
                .frame(width: 140)
        }
        .ignoresSafeArea()
    }
}
