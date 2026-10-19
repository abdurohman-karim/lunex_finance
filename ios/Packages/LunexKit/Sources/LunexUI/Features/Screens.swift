import LunexCore
import LunexLocalization
import SwiftUI

// Tab roots. Each feature step of the build plan replaces its placeholder with the real screen.

struct HomeView: View {
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer

    var body: some View {
        ScrollView {
            VStack(spacing: LunexTheme.Spacing.space4) {
                HStack {
                    SectionLabel(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(localizer.locale)))
                    Spacer()
                    if session.lastError?.isOffline == true {
                        Label(localizer("home.offline"), systemImage: "wifi.slash")
                            .labelStyle(.iconOnly)
                            .foregroundStyle(LunexColor.inkMuted)
                            .accessibilityLabel(localizer("home.offline"))
                    }
                }
                // Filled by the budget («Можно потратить сегодня») in the home-screen step.
                ProgressRing(progress: 0) {
                    VStack(spacing: LunexTheme.Spacing.space1) {
                        SectionLabel(localizer("home.safeToSpend"))
                            .multilineTextAlignment(.center)
                        Text("—")
                            .lunexText(.amountHero)
                            .foregroundStyle(LunexColor.ink)
                    }
                }
                .frame(width: LunexTheme.Size.ringHero, height: LunexTheme.Size.ringHero)
                .padding(.top, LunexTheme.Spacing.space4)
            }
            .padding(.horizontal, LunexTheme.Spacing.space4)
        }
        .background(LunexColor.paper)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(localizer("home.addOperation"), systemImage: "plus") {}
                    .disabled(true)
            }
        }
        .refreshable { await session.reloadProfile() }
    }
}

struct TransactionsView: View {
    @Environment(Localizer.self) private var localizer

    var body: some View {
        ContentUnavailableView(
            localizer("empty.transactions.title"),
            systemImage: "list.bullet.rectangle",
            description: Text(localizer("empty.transactions.body"))
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LunexColor.paper)
        .navigationTitle(localizer("tab.transactions"))
    }
}

struct GoalsView: View {
    @Environment(Localizer.self) private var localizer

    var body: some View {
        ContentUnavailableView(
            localizer("empty.goals.title"),
            systemImage: "target",
            description: Text(localizer("empty.goals.body"))
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LunexColor.paper)
        .navigationTitle(localizer("tab.goals"))
    }
}

struct BudgetView: View {
    @Environment(Localizer.self) private var localizer

    var body: some View {
        ContentUnavailableView(
            localizer("empty.budget.title"),
            systemImage: "chart.pie",
            description: Text(localizer("empty.budget.body"))
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LunexColor.paper)
        .navigationTitle(localizer("tab.budget"))
    }
}

struct SettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer

    var body: some View {
        @Bindable var localizer = localizer
        Form {
            if let profile = session.profile {
                Section(localizer("settings.account")) {
                    VStack(alignment: .leading, spacing: LunexTheme.Spacing.space1) {
                        Text(profile.displayName ?? profile.email ?? "—")
                            .lunexText(.bodyStrong)
                        if profile.displayName != nil, let email = profile.email {
                            Text(email)
                                .lunexText(.callout)
                                .foregroundStyle(LunexColor.inkMuted)
                        }
                    }
                }
            }
            Section(localizer("settings.language")) {
                Picker(localizer("settings.language"), selection: $localizer.language) {
                    ForEach(AppLanguage.allCases) { language in
                        Text(language.displayName).tag(language)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            if let access = session.access {
                Section(localizer("settings.plan")) {
                    HStack {
                        Text(localizer(access.isPro ? "settings.plan.pro" : "settings.plan.free"))
                        Spacer()
                        if access.monetizationEnabled, let trial = access.trial, trial.active {
                            StatusBadge(localizer.format("settings.plan.trialLeft", trial.daysLeft), isProminent: true)
                        }
                    }
                }
            }
            Section {
                Button(localizer("settings.signOut"), role: .destructive) {
                    Task { await session.signOut() }
                }
            }
            Section {
                LabeledContent(localizer("settings.version"), value: Bundle.main.appVersion)
            }
        }
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .navigationTitle(localizer("tab.settings"))
    }
}

extension Bundle {
    var appVersion: String {
        let version = object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "\(version) (\(build))"
    }
}
