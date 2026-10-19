import LunexCore
import LunexLocalization
import SwiftUI

/// Passwordless sign-in: the email, then the 6-digit code from the letter. The code is
/// sent as soon as all six digits are in, including when iOS fills it from Mail.
struct EmailSignInView: View {
    private enum Field {
        case email, code
    }

    /// Where the checked code goes instead of signing in: linking the address to the account.
    var submit: ((SignInCredential) async throws -> Void)?

    @Environment(SignInService.self) private var signIn
    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss

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
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space6) {
                if let sentTo {
                    codeStep(sentTo)
                } else {
                    emailStep
                }
                if let errorText {
                    Text(errorText)
                        .lunexText(.caption)
                        .foregroundStyle(LunexColor.negative)
                }
            }
            .padding(.horizontal, LunexTheme.Spacing.space6)
            .padding(.top, LunexTheme.Spacing.space2)
        }
        .scrollDismissesKeyboard(.never)
        .background(LunexColor.paper)
        .onAppear { focus = sentTo == nil ? .email : .code }
    }

    private func header(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
            Text(title)
                .lunexText(.titleL)
                .foregroundStyle(LunexColor.ink)
            Text(subtitle)
                .lunexText(.body)
                .foregroundStyle(LunexColor.inkMuted)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private var emailStep: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space6) {
            header(localizer("auth.email.title"), localizer("auth.email.subtitle"))
            VStack(spacing: LunexTheme.Spacing.space3) {
                TextField(localizer("auth.email.placeholder"), text: $email)
                    .emailInput()
                    .focused($focus, equals: .email)
                    .submitLabel(.continue)
                    .onSubmit(requestCode)
                    .lunexInput()
                Button(action: requestCode) {
                    ZStack {
                        Text(localizer("auth.email.getCode"))
                            .opacity(working ? 0 : 1)
                        if working {
                            ProgressView().tint(LunexColor.onInk)
                        }
                    }
                }
                .buttonStyle(.lunex(.primary))
                .disabled(working || email.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func codeStep(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space6) {
            header(localizer("auth.code.title"), localizer.format("auth.code.sentTo", address))
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                // The real field (one-time-code autofill, paste, VoiceOver) under the six cells.
                // It stays enabled while the code is checked, so the keyboard does not drop and come back.
                ZStack {
                    TextField("", text: codeInput(for: address))
                        .oneTimeCodeInput()
                        .focused($focus, equals: .code)
                        .foregroundStyle(.clear)
                        .tint(.clear)
                        .frame(height: 60)
                        .accessibilityLabel(localizer("auth.code.title"))
                    CodeCells(code: code, length: 6, isFocused: focus == .code)
                        .allowsHitTesting(false)
                }
                if working {
                    HStack(spacing: LunexTheme.Spacing.space2) {
                        ProgressView()
                        Text(localizer("auth.signingIn"))
                            .lunexText(.caption)
                            .foregroundStyle(LunexColor.inkMuted)
                    }
                } else {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let secondsLeft = Int(resendAt.timeIntervalSince(context.date).rounded(.up))
                        if secondsLeft > 0 {
                            Text(localizer.format(
                                "auth.code.resendIn",
                                Duration.seconds(secondsLeft).formatted(.time(pattern: .minuteSecond))
                            ))
                            .lunexText(.caption)
                            .foregroundStyle(LunexColor.inkMuted)
                            .monospacedDigit()
                        } else {
                            Button(localizer("auth.code.resend")) { send(to: address) }
                                .buttonStyle(.lunex(.quiet))
                                .padding(.leading, -LunexTheme.Spacing.space3)
                        }
                    }
                }
            }
            Button(localizer("auth.code.changeEmail")) {
                sentTo = nil
                code = ""
                errorText = nil
                focus = .email
            }
            .buttonStyle(.lunex(.quiet))
            .padding(.leading, -LunexTheme.Spacing.space3)
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
                let credential = SignInCredential.email(address: address, code: code)
                if let submit {
                    try await submit(credential)
                    dismiss()
                } else {
                    // On success the session switches the app to the main screen.
                    try await signIn.signIn(credential, language: localizer.language.rawValue)
                }
            } catch {
                errorText = localizer.message(for: error)
                self.code = ""
            }
        }
    }
}

private extension View {
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
