import AuthenticationServices
import LunexCore
import LunexLocalization
import SwiftUI

/// The account: sign-in methods to link and unlink (the last one stays), the plan, signing
/// out here or everywhere, and deleting the account (App Store requirement).
struct AccountSettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(SignInService.self) private var signIn
    @Environment(AccountService.self) private var account
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.colorScheme) private var colorScheme

    @State private var working: AuthProvider?
    @State private var busy = false
    @State private var errorText: String?
    @State private var appleNonce: String?
    @State private var unlinking: AuthProvider?
    @State private var confirmsEverywhere = false
    @State private var confirmsDelete = false

    private var linked: [String] { session.profile?.identities ?? [] }

    var body: some View {
        Form {
            if let profile = session.profile {
                Section {
                    if let name = profile.displayName {
                        LabeledContent(localizer("account.name"), value: name)
                    }
                    if let email = profile.email {
                        LabeledContent(localizer("account.email"), value: email)
                    }
                    LabeledContent(localizer("settings.plan"), value: plan)
                }
            }
            Section {
                ForEach(AuthProvider.allCases, id: \.self) { provider in
                    providerRow(provider)
                }
            } header: {
                Text(localizer("account.methods"))
            } footer: {
                Text(errorText ?? localizer("account.methods.footer"))
                    .foregroundStyle(errorText == nil ? LunexColor.inkMuted : LunexColor.negative)
            }
            Section {
                Button(localizer("settings.signOut")) {
                    Task { await session.signOut() }
                }
                Button(localizer("account.signOutEverywhere")) { confirmsEverywhere = true }
                    .disabled(busy)
            }
            Section {
                Button(localizer("account.delete"), role: .destructive) { confirmsDelete = true }
                    .foregroundStyle(LunexColor.negative)
                    .disabled(busy)
            } footer: {
                Text(localizer("account.delete.footer"))
            }
        }
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .navigationTitle(localizer("settings.account"))
        .inlineTitle()
        .task { await signIn.loadProviders() }
        .confirmationDialog(localizer("account.signOutEverywhere.confirm"), isPresented: $confirmsEverywhere, titleVisibility: .visible) {
            Button(localizer("account.signOutEverywhere"), role: .destructive) {
                perform { try await account.signOutEverywhere() }
            }
        }
        .confirmationDialog(localizer("account.delete.confirm"), isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button(localizer("account.delete"), role: .destructive) {
                perform { try await account.deleteAccount() }
            }
        } message: {
            Text(localizer("account.delete.footer"))
        }
        .confirmationDialog(
            localizer("account.unlink.confirm"),
            isPresented: Binding(get: { unlinking != nil }, set: { if !$0 { unlinking = nil } }),
            titleVisibility: .visible
        ) {
            if let provider = unlinking {
                Button(localizer.format("account.unlink", title(provider)), role: .destructive) {
                    run(provider) { try await account.unlink(provider) }
                }
            }
        }
    }

    private var plan: String {
        guard let access = session.access else { return "—" }
        var text = localizer(access.isPro ? "settings.plan.pro" : "settings.plan.free")
        if access.monetizationEnabled, let trial = access.trial, trial.active {
            text += " · " + localizer.format("settings.plan.trialLeft", trial.daysLeft)
        }
        return text
    }

    // MARK: Methods

    @ViewBuilder
    private func providerRow(_ provider: AuthProvider) -> some View {
        let isLinked = linked.contains(provider.rawValue)
        HStack(spacing: LunexTheme.Spacing.space3) {
            Image(systemName: icon(provider))
                .frame(width: 24)
                .foregroundStyle(LunexColor.ink)
            VStack(alignment: .leading, spacing: 2) {
                Text(title(provider))
                    .lunexText(.body)
                    .foregroundStyle(LunexColor.ink)
                if isLinked {
                    Text(localizer("account.linked"))
                        .lunexText(.caption)
                        .foregroundStyle(LunexColor.inkMuted)
                }
            }
            Spacer(minLength: LunexTheme.Spacing.space2)
            if working == provider {
                ProgressView()
            } else if isLinked {
                if linked.count > 1 {
                    Button(localizer("account.unlinkShort")) { unlinking = provider }
                        .buttonStyle(.lunex(.quiet))
                        .disabled(working != nil)
                }
            } else if signIn.isAvailable(provider) {
                linkControl(provider)
                    .disabled(working != nil)
            } else {
                Text(localizer("account.unavailable"))
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.inkFaint)
            }
        }
        .frame(minHeight: 44)
    }

    @ViewBuilder
    private func linkControl(_ provider: AuthProvider) -> some View {
        switch provider {
        case .apple:
            SignInWithAppleButton(.continue) { request in
                let nonce = AppleSignIn.makeNonce()
                appleNonce = nonce
                request.requestedScopes = [.email]
                request.nonce = AppleSignIn.sha256(nonce)
            } onCompletion: { result in
                guard case let .success(authorization) = result,
                      let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                      let data = credential.identityToken,
                      let token = String(data: data, encoding: .utf8),
                      let nonce = appleNonce
                else { return }
                run(.apple) { try await account.link(.apple(identityToken: token, nonce: nonce, displayName: nil)) }
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .id(colorScheme)
            .frame(width: 150, height: 36)
            .clipShape(Capsule())
        case .google:
            Button(localizer("account.link")) { linkGoogle() }
                .buttonStyle(.lunex(.secondary, size: .compact))
        case .telegram:
            Button(localizer("account.link")) { linkTelegram() }
                .buttonStyle(.lunex(.secondary, size: .compact))
        case .email:
            NavigationLink {
                EmailSignInView(submit: { credential in
                    try await account.link(credential)
                    toasts.show(localizer("account.linkedToast"))
                })
            } label: {
                Text(localizer("account.link"))
                    .lunexText(.callout, weight: .semibold)
                    .foregroundStyle(LunexColor.ink)
            }
            .fixedSize()
        }
    }

    private func linkGoogle() {
        guard let google = signIn.google else { return }
        run(.google) {
            let request = google.makeRequest()
            let callback = try await webAuthenticationSession.authenticate(
                using: request.url, callback: .customScheme(google.callbackScheme), additionalHeaderFields: [:]
            )
            let code = try google.code(from: callback, for: request)
            try await account.link(.google(idToken: try await google.idToken(code: code, for: request)))
        }
    }

    private func linkTelegram() {
        run(.telegram) {
            let callback = try await webAuthenticationSession.authenticate(
                using: signIn.telegramStartURL, callback: .customScheme(TelegramLogin.callbackScheme), additionalHeaderFields: [:]
            )
            guard let authData = TelegramLogin.authData(from: callback) else { throw SignInFlowError.cancelled }
            try await account.link(.telegram(authData))
        }
    }

    private func run(_ provider: AuthProvider, _ work: @escaping () async throws -> Void) {
        errorText = nil
        working = provider
        Task {
            defer { working = nil }
            do {
                try await work()
            } catch where Self.isCancellation(error) {
            } catch {
                errorText = localizer.accountMessage(error)
            }
        }
    }

    private func perform(_ work: @escaping () async throws -> Void) {
        errorText = nil
        busy = true
        Task {
            defer { busy = false }
            do {
                try await work()
            } catch {
                errorText = localizer.accountMessage(error)
            }
        }
    }

    private func title(_ provider: AuthProvider) -> String {
        switch provider {
        case .apple: "Apple"
        case .google: "Google"
        case .telegram: "Telegram"
        case .email: localizer("account.email")
        }
    }

    private func icon(_ provider: AuthProvider) -> String {
        switch provider {
        case .apple: "apple.logo"
        case .google: "g.circle"
        case .telegram: "paperplane"
        case .email: "envelope"
        }
    }

    private static func isCancellation(_ error: Error) -> Bool {
        switch error {
        case is CancellationError: true
        case SignInFlowError.cancelled: true
        case let error as ASWebAuthenticationSessionError: error.code == .canceledLogin
        case let error as ASAuthorizationError: error.code == .canceled
        default: false
        }
    }
}

extension Localizer {
    /// Why linking or the account action was refused, in words.
    func accountMessage(_ error: Error) -> String {
        if let error = error as? APIError {
            switch error.code {
            case "identity_in_use": return self("account.error.inUse")
            case "provider_already_linked": return self("account.error.alreadyLinked")
            case "last_identity": return self("account.error.last")
            case "admin_account": return self("account.error.admin")
            default: break
            }
        }
        return message(for: error)
    }
}
