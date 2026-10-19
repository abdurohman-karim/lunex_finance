import Foundation

/// An amount in a currency. The API sends money as decimal strings ("150000", "12.50");
/// it is never a Double, so sums stay exact.
public struct Money: Hashable, Sendable, Codable {
    public var amount: Decimal
    public var currency: String

    public init(_ amount: Decimal, _ currency: String) {
        self.amount = amount
        self.currency = currency
    }

    /// `Money("150000", "UZS")`; nil when the text is not a plain decimal number.
    public init?(_ text: String, _ currency: String) {
        guard let amount = Decimal.exact(text) else { return nil }
        self.init(amount, currency)
    }

    /// Text the API accepts: plain digits with a dot, no grouping.
    public var apiValue: String {
        NSDecimalNumber(decimal: amount).stringValue
    }

    /// "150 000 soʻm", "$12.50"; minor units follow the currency (UZS shows none).
    public func formatted(locale: Locale, hidden: Bool = false) -> String {
        if hidden { return "••••" }
        return amount.formatted(
            .currency(code: currency)
                .locale(locale)
                .precision(.fractionLength(Self.fractionDigits(for: currency)))
        )
    }

    /// Minor units shown for a currency; matches the server's `currencies.decimals`.
    public static func fractionDigits(for currency: String) -> Int {
        switch currency {
        case "UZS", "KZT": 0
        default: 2
        }
    }
}

extension Decimal {
    /// Parses "-12.50" without locale surprises; rejects anything else.
    public static func exact(_ text: String) -> Decimal? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard trimmed.wholeMatch(of: /-?\d+(\.\d+)?/) != nil else { return nil }
        return Decimal(string: trimmed, locale: Locale(identifier: "en_US_POSIX"))
    }
}
