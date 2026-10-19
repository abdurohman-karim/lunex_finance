import Foundation

/// What the amount keypad has typed: numbers with + − × between them («45000+12000»).
/// The value is worked out as you type, × before + and −, rounded to the currency's minor units.
public struct AmountInput: Equatable, Sendable {
    public enum Key: Hashable, Sendable {
        case digit(Int)
        /// «000», handy for sums
        case thousands
        /// The decimal comma; only for currencies with minor units
        case decimal
        case plus, minus, times
        case backspace
    }

    /// Canonical text: digits, «.», «+», «−», «×».
    public private(set) var text: String
    public let fractionDigits: Int

    static let maxIntegerDigits = 12
    private static let operators: Set<Character> = ["+", "−", "×"]

    public init(fractionDigits: Int, text: String = "") {
        self.fractionDigits = fractionDigits
        self.text = text
    }

    /// An existing amount, to edit an operation.
    public init(amount: Decimal, fractionDigits: Int) {
        self.init(fractionDigits: fractionDigits, text: NSDecimalNumber(decimal: amount).stringValue)
    }

    public var isEmpty: Bool { text.isEmpty }

    /// True while the text is an expression rather than one number.
    public var hasOperator: Bool { text.contains { Self.operators.contains($0) } }

    public mutating func press(_ key: Key) {
        let number = currentNumber
        switch key {
        case let .digit(digit):
            guard (0...9).contains(digit) else { return }
            if let dot = number.firstIndex(of: ".") {
                guard number[dot...].count - 1 < fractionDigits else { return }
            } else {
                guard number.count < Self.maxIntegerDigits else { return }
                if number == "0" { text.removeLast() }
            }
            text.append(String(digit))
        case .thousands:
            guard !number.isEmpty, number != "0", !number.contains("."),
                  number.count + 3 <= Self.maxIntegerDigits else { return }
            text.append("000")
        case .decimal:
            guard fractionDigits > 0, !number.contains(".") else { return }
            text.append(number.isEmpty ? "0." : ".")
        case .plus, .minus, .times:
            guard let last = text.last else { return }
            if Self.operators.contains(last) || last == "." {
                text.removeLast()
            }
            guard !text.isEmpty else { return }
            text.append(key == .plus ? "+" : key == .minus ? "−" : "×")
        case .backspace:
            if !text.isEmpty { text.removeLast() }
        }
    }

    /// The number being typed after the last operator.
    private var currentNumber: Substring {
        guard let index = text.lastIndex(where: { Self.operators.contains($0) }) else { return text[...] }
        return text[text.index(after: index)...]
    }

    /// The result so far; nil when nothing is typed.
    public var value: Decimal? {
        var terms: [Decimal] = []
        var signs: [Decimal] = []
        var product: Decimal?
        var sign: Decimal = 1
        var number = ""

        func closeNumber() -> Bool {
            guard !number.isEmpty else { return false }
            let parsed = Decimal(string: number, locale: Locale(identifier: "en_US_POSIX")) ?? 0
            product = (product ?? 1) * parsed
            number = ""
            return true
        }

        for character in text {
            switch character {
            case "×":
                _ = closeNumber()
            case "+", "−":
                if closeNumber(), let value = product {
                    terms.append(value)
                    signs.append(sign)
                }
                product = nil
                sign = character == "+" ? 1 : -1
            default:
                number.append(character)
            }
        }
        if closeNumber() || product != nil, let value = product {
            terms.append(value)
            signs.append(sign)
        }
        guard !terms.isEmpty else { return nil }
        var total: Decimal = 0
        for (term, sign) in zip(terms, signs) {
            total += term * sign
        }
        var rounded = Decimal()
        NSDecimalRound(&rounded, &total, fractionDigits, .plain)
        return rounded
    }

    /// «45 000 + 12 000»: thousands grouped and the decimal comma written as the language does.
    public func display(decimalSeparator: String = ",", groupingSeparator: String = " ") -> String {
        var result = ""
        var number = ""
        func flush() {
            guard !number.isEmpty else { return }
            let parts = number.split(separator: ".", omittingEmptySubsequences: false)
            result += Self.group(String(parts[0]), separator: groupingSeparator)
            if parts.count > 1 {
                result += decimalSeparator + parts[1]
            }
            number = ""
        }
        for character in text {
            if Self.operators.contains(character) {
                flush()
                result += " \(character) "
            } else {
                number.append(character)
            }
        }
        flush()
        return result
    }

    static func group(_ digits: String, separator: String = " ") -> String {
        var result = ""
        for (index, character) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { result += separator }
            result.append(character)
        }
        return result
    }
}
