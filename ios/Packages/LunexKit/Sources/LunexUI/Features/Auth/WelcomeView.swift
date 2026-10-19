import AuthenticationServices
import LunexCore
import LunexLocalization
import SwiftUI

/// First screen for a guest: Apple, Google, Telegram or an email code.
struct WelcomeView: View {
    @Environment(SignInService.self) private var signIn
    @Environment(Localizer.self) private var localizer
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.colorScheme) private var colorScheme

    /// The method being signed in with; every button waits meanwhile.
    @State private var working: AuthProvider?
    @State private var errorText: String?
    /// Raw nonce of the Apple request in flight; Apple only sees its hash.
    @State private var appleNonce: String?

    var body: some View {
        VStack(spacing: LunexTheme.Spacing.l) {
            Spacer()
            Image(systemName: "moon.stars.fill")
                .font(.system(size: 64))
                .foregroundStyle(.tint)
            VStack(spacing: LunexTheme.Spacing.s) {
                Text(localizer("app.name"))
                    .font(.largeTitle.bold())
                Text(localizer("app.tagline"))
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            VStack(spacing: LunexTheme.Spacing.s) {
                appleButton
                Button(action: signInWithGoogle) {
                    ProviderLabel(localizer("welcome.signIn.google"), systemImage: "g.circle.fill", working: working == .google)
                }
                Button(action: signInWithTelegram) {
                    ProviderLabel(localizer("welcome.signIn.telegram"), systemImage: "paperplane.fill", working: working == .telegram)
                }
                NavigationLink {
                    EmailSignInView()
                } label: {
                    ProviderLabel(localizer("welcome.signIn.email"), systemImage: "envelope.fill", working: false)
                }
                if let errorText {
                    Text(errorText)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .transition(.opacity)
                }
            }
            .buttonStyle(ProviderButtonStyle())
            .disabled(working != nil)
        }
        .padding(LunexTheme.Spacing.l)
        .animation(.default, value: errorText)
        .task { await signIn.loadProviders() }
    }

    /// Apple's own button, as App Review expects; its label follows the system language.
    private var appleButton: some View {
        SignInWithAppleButton(.signIn) { request in
            let nonce = AppleSignIn.makeNonce()
            appleNonce = nonce
            request.requestedScopes = [.fullName, .email]
            request.nonce = AppleSignIn.sha256(nonce)
        } onCompletion: { result in
            switch result {
            case let .success(authorization):
                signInWithApple(authorization)
            case let .failure(error):
                if !Self.isCancellation(error) {
                    errorText = localizer("error.signInRejected")
                }
            }
        }
        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
        .frame(height: ProviderButtonStyle.height)
        .clipShape(RoundedRectangle(cornerRadius: LunexTheme.Radius.control))
        .overlay {
            // Apple's button cannot be stopped once tapped; cover it when the server has Apple off.
            if !signIn.isAvailable(.apple) {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { errorText = localizer("error.providerDisabled") }
            }
        }
        .opacity(working == nil || working == .apple ? 1 : 0.5)
    }

    private func signInWithApple(_ authorization: ASAuthorization) {
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let identityToken = String(data: tokenData, encoding: .utf8),
            let nonce = appleNonce
        else {
            errorText = localizer("error.signInRejected")
            return
        }
        // Apple gives the name only on the very first authorization.
        let name = credential.fullName
            .map { PersonNameComponentsFormatter.localizedString(from: $0, style: .default) }
            .flatMap { $0.isEmpty ? nil : $0 }
        run(.apple) {
            try await signIn.signIn(
                .apple(identityToken: identityToken, nonce: nonce, displayName: name),
                language: localizer.language.rawValue
            )
        }
    }

    private func signInWithGoogle() {
        guard signIn.isAvailable(.google), let google = signIn.google else {
            errorText = localizer("error.providerDisabled")
            return
        }
        run(.google) {
            let request = google.makeRequest()
            let callback = try await webAuthenticationSession.authenticate(
                using: request.url,
                callback: .customScheme(google.callbackScheme),
                additionalHeaderFields: [:]
            )
            let code = try google.code(from: callback, for: request)
            let idToken = try await google.idToken(code: code, for: request)
            try await signIn.signIn(.google(idToken: idToken), language: localizer.language.rawValue)
        }
    }

    private func signInWithTelegram() {
        guard signIn.isAvailable(.telegram) else {
            errorText = localizer("error.providerDisabled")
            return
        }
        run(.telegram) {
            let callback = try await webAuthenticationSession.authenticate(
                using: signIn.telegramStartURL,
                callback: .customScheme(TelegramLogin.callbackScheme),
                additionalHeaderFields: [:]
            )
            guard let authData = TelegramLogin.authData(from: callback) else {
                errorText = localizer("auth.telegram.noResult")
                return
            }
            try await signIn.signIn(.telegram(authData), language: localizer.language.rawValue)
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
                // Closed the sheet: nothing to report.
            } catch {
                errorText = localizer.message(for: error)
            }
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

/// Icon and title of a sign-in button, or a spinner while that method is working.
struct ProviderLabel: View {
    private let title: String
    private let systemImage: String
    private let working: Bool

    init(_ title: String, systemImage: String, working: Bool) {
        self.title = title
        self.systemImage = systemImage
        self.working = working
    }

    var body: some View {
        ZStack {
            Label(title, systemImage: systemImage)
                .opacity(working ? 0 : 1)
            if working {
                ProgressView()
            }
        }
    }
}

/// Full-width buttons matching the height and corners of Apple's sign-in button.
struct ProviderButtonStyle: ButtonStyle {
    static let height: CGFloat = 50

    func makeBody(configuration: Configuration) -> some View {
        StyledBody(configuration: configuration)
    }

    private struct StyledBody: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, minHeight: ProviderButtonStyle.height)
                .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.control))
                .contentShape(RoundedRectangle(cornerRadius: LunexTheme.Radius.control))
                .opacity(configuration.isPressed ? 0.6 : isEnabled ? 1 : 0.5)
        }
    }
}
