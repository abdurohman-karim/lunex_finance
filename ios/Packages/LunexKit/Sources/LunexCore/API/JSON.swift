import Foundation

/// JSON coding shared with the NestJS API: ISO 8601 dates in UTC with milliseconds.
public enum LunexJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = parseDate(text) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Not an ISO 8601 date: \(text)"
            )
        }
        return decoder
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatDate(date))
        }
        return encoder
    }

    private static let withMilliseconds = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let withoutMilliseconds = Date.ISO8601FormatStyle()

    /// "2026-10-19T08:32:36.186Z", also without milliseconds.
    public static func parseDate(_ text: String) -> Date? {
        (try? withMilliseconds.parse(text)) ?? (try? withoutMilliseconds.parse(text))
    }

    /// "2026-10-19T08:32:36.186Z". Milliseconds are rounded, not truncated: .186 is
    /// 0.18599… as a Double and the system formatter would print .185.
    public static func formatDate(_ date: Date) -> String {
        let milliseconds = (date.timeIntervalSince1970 * 1000).rounded()
        let seconds = (milliseconds / 1000).rounded(.down)
        let fraction = Int(milliseconds - seconds * 1000)
        let whole = withoutMilliseconds.format(Date(timeIntervalSince1970: seconds))
        // "…36Z" → "…36.186Z"
        return "\(whole.dropLast()).\(String(format: "%03d", fraction))Z"
    }
}
