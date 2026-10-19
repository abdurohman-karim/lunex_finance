import LunexLocalization
import SwiftUI

/// First screen for a guest. The sign-in buttons are wired up in build plan step «экраны входа».
struct WelcomeView: View {
    @Environment(Localizer.self) private var localizer

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
                signInButton("welcome.signIn.apple", systemImage: "apple.logo")
                signInButton("welcome.signIn.google", systemImage: "g.circle.fill")
                signInButton("welcome.signIn.telegram", systemImage: "paperplane.fill")
                signInButton("welcome.signIn.email", systemImage: "envelope.fill")
                Text(localizer("welcome.comingSoon"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(LunexTheme.Spacing.l)
    }

    private func signInButton(_ key: String, systemImage: String) -> some View {
        Button {} label: {
            Label(localizer(key), systemImage: systemImage)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .disabled(true)
    }
}
