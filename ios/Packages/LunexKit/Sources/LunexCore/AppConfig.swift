import Foundation

/// Build-time settings from Info.plist, filled from build settings in `project.yml`.
public struct AppConfig: Sendable {
    public let apiBaseURL: URL?
    public let sentryDSN: String?
    public let appVersion: String

    public init(apiBaseURL: URL?, sentryDSN: String?, appVersion: String) {
        self.apiBaseURL = apiBaseURL
        self.sentryDSN = sentryDSN
        self.appVersion = appVersion
    }

    public init(bundle: Bundle) {
        let value = { (key: String) -> String? in
            guard let text = bundle.object(forInfoDictionaryKey: key) as? String,
                  !text.trimmingCharacters(in: .whitespaces).isEmpty
            else { return nil }
            return text
        }
        let version = value("CFBundleShortVersionString") ?? "0"
        let build = value("CFBundleVersion") ?? "0"
        self.init(
            apiBaseURL: value("LunexAPIBaseURL").flatMap(URL.init(string:)),
            sentryDSN: value("LunexSentryDSN"),
            appVersion: "\(version) (\(build))"
        )
    }
}
