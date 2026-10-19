import LunexCore
import LunexLocalization
import SwiftUI

/// Passwordless sign-in: the email, then the 6-digit code from the letter. The code is
/// sent as soon as all six digits are in, including when iOS fills it from Mail.
struct EmailSignInView: View {
    private enum Field {
        case email, code
    }

    @Environment(SignInService.self) private var signIn
    @Environment(Localizer.self) private var localizer

    @State private var email = ""
    @State private var code = ""
    /// The address a code went to; the screen asks for the code once it is set.
    @State private var sentTo: String?
    @State private var resendAt = Date.distantPast
    @State private var working = false
    @State private var errorText: String?
    @FocusState private var focus: Field?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.m) {
                if let sentTo {
                    codeStep(sentTo)
                } else {
                    emailStep
                }
                if let errorText {
                    Text(errorText)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            .padding(LunexTheme.Spacing.l)
        }
        .navigationTitle(localizer(sentTo == nil ? "auth.email.title" : "auth.code.title"))
        .onAppear { focus = sentTo == nil ? .email : .code }
    }

    private var emailStep: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.m) {
            Text(localizer("auth.email.subtitle"))
                .foregroundStyle(.secondary)
            TextField(localizer("auth.email.placeholder"), text: $email)
                .emailInput()
                .focused($focus, equals: .email)
                .submitLabel(.continue)
                .onSubmit(requestCode)
                .inputBackground()
            Button(action: requestCode) {
                ZStack {
                    Text(localizer("auth.email.getCode"))
                        .opacity(working ? 0 : 1)
                    if working {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(working || email.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private func codeStep(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.m) {
            Text(localizer.format("auth.code.sentTo", address))
                .foregroundStyle(.secondary)
            TextField("000000", text: codeInput(for: address))
                .oneTimeCodeInput()
                .font(.system(.title, design: .rounded, weight: .semibold).monospacedDigit())
                .kerning(8)
                .multilineTextAlignment(.center)
                // Stays enabled while the code is checked, so the keyboard does not drop and come back.
                .focused($focus, equals: .code)
                .inputBackground()
            if working {
                HStack(spacing: LunexTheme.Spacing.s) {
                    ProgressView()
                    Text(localizer("auth.signingIn"))
                        .foregroundStyle(.secondary)
                }
            }
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let secondsLeft = Int(resendAt.timeIntervalSince(context.date).rounded(.up))
                if secondsLeft > 0 {
                    Text(localizer.format(
                        "auth.code.resendIn",
                        Duration.seconds(secondsLeft).formatted(.time(pattern: .minuteSecond))
                    ))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                } else {
                    Button(localizer("auth.code.resend")) { send(to: address) }
                        .disabled(working)
                }
            }
            Button(localizer("auth.code.changeEmail")) {
                sentTo = nil
                code = ""
                errorText = nil
                focus = .email
            }
            .disabled(working)
        }
    }

    /// Keeps the first six digits and sends them once complete, whether typed or filled from Mail.
    private func codeInput(for address: String) -> Binding<String> {
        Binding {
            code
        } set: { value in
            let digits = String(value.filter(\.isASCII).filter(\.isNumber).prefix(6))
            code = digits
            if digits.count == 6, !working {
                verify(address, code: digits)
            }
        }
    }

    private func requestCode() {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard EmailAddress.isValid(address) else {
            errorText = localizer("error.invalidEmail")
            return
        }
        send(to: address)
    }

    private func send(to address: String) {
        errorText = nil
        working = true
        Task {
            defer { working = false }
            do {
                let sent = try await signIn.requestEmailCode(address, language: localizer.language.rawValue)
                resendAt = .now + TimeInterval(sent.resendIn)
                askForCode(sentTo: address)
            } catch let error as APIError where error.code == "resend_too_soon" {
                // A code went out less than a minute ago and is still good.
                resendAt = .now + TimeInterval(error.detail("retryAfter", as: Int.self) ?? 60)
                askForCode(sentTo: address)
            } catch {
                errorText = localizer.message(for: error)
            }
        }
    }

    private func askForCode(sentTo address: String) {
        sentTo = address
        code = ""
        focus = .code
    }

    private func verify(_ address: String, code: String) {
        errorText = nil
        working = true
        Task {
            defer { working = false }
            do {
                // On success the session switches the app to the main screen.
                try await signIn.signIn(.email(address: address, code: code), language: localizer.language.rawValue)
            } catch {
                errorText = localizer.message(for: error)
                self.code = ""
            }
        }
    }
}

private extension View {
    func inputBackground() -> some View {
        padding(LunexTheme.Spacing.m)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.control))
    }

    /// Email keyboard and autofill, no capitals or autocorrection.
    func emailInput() -> some View {
        #if os(iOS)
        keyboardType(.emailAddress)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        #else
        autocorrectionDisabled()
        #endif
    }

    /// Digits keyboard; iOS offers the code from Mail above it.
    func oneTimeCodeInput() -> some View {
        #if os(iOS)
        keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
        #else
        self
        #endif
    }
}
