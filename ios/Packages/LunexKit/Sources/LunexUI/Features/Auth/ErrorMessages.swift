import LunexCore
import LunexLocalization

extension Localizer {
    /// A short reason for a failed request, in the app's language, from the server's stable error code.
    func message(for error: Error) -> String {
        guard let error = error as? APIError else {
            return self(error is SignInFlowError ? "error.signInRejected" : "error.generic")
        }
        if error.isOffline { return self("error.offline") }
        switch error.code {
        case "rate_limited", "resend_too_soon":
            return self("error.rateLimited")
        case "invalid_code":
            if let attemptsLeft = error.detail("attemptsLeft", as: Int.self) {
                return format("error.invalidCode.attemptsLeft", attemptsLeft)
            }
            return self("error.invalidCode")
        case "code_expired":
            return self("error.codeExpired")
        case "too_many_attempts":
            return self("error.tooManyAttempts")
        case "provider_disabled":
            return self("error.providerDisabled")
        case "invalid_identity_token", "invalid_nonce", "invalid_telegram_auth", "telegram_auth_expired":
            return self("error.signInRejected")
        default:
            return self("error.generic")
        }
    }
}
