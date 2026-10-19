import LunexCore
import SwiftUI

extension Color {
    /// `#557A95`; nil for anything else.
    init?(hex: String?) {
        guard let hex, hex.count == 7, hex.first == "#", let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

/// Amounts typed into a plain text field (opening balance, goal target).
enum AmountText {
    /// «1 250 000,50» → 1250000.50; empty is zero, anything else unreadable is nil.
    static func parse(_ text: String) -> Decimal? {
        let cleaned = text.filter { !$0.isWhitespace && $0 != "\u{00A0}" && $0 != "\u{202F}" }
            .replacingOccurrences(of: ",", with: ".")
        if cleaned.isEmpty { return 0 }
        return Decimal.exact(cleaned)
    }

    static func text(_ value: Decimal, separator: String) -> String {
        NSDecimalNumber(decimal: value).stringValue.replacingOccurrences(of: ".", with: separator)
    }
}

/// SF Symbols offered in the editors (outline forms: the design system draws outlines).
enum Symbols {
    static let accounts = [
        "banknote", "creditcard", "building.columns", "lock", "wallet.pass", "dollarsign.circle",
        "eurosign.circle", "rublesign.circle", "bag", "briefcase", "house", "car",
        "airplane", "gift", "graduationcap", "heart", "star", "archivebox",
    ]

    static let categories = [
        "tag", "fork.knife", "cup.and.saucer", "cart", "bag", "bus",
        "car", "fuelpump", "house", "bolt", "drop", "wifi",
        "phone", "tv", "gamecontroller", "film", "music.note", "book",
        "graduationcap", "cross.case", "pills", "heart", "figure.run", "pawprint",
        "gift", "airplane", "tshirt", "scissors", "wrench.and.screwdriver", "sparkles",
        "banknote", "briefcase", "chart.line.uptrend.xyaxis", "dollarsign.circle", "arrow.uturn.down", "star",
    ]
}

/// An account's or category's symbol on a soft wash of its own color.
struct SymbolWell: View {
    let symbol: String
    let color: String?
    var size: CGFloat = LunexTheme.Size.iconWell

    var body: some View {
        let tint = Color(hex: color) ?? LunexColor.ink
        Image(systemName: symbol)
            .font(.system(size: size * 0.42, weight: .medium))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.14), in: Circle())
            .accessibilityHidden(true)
    }
}

/// Six symbols to a row; the chosen one sits on its color.
struct SymbolGrid: View {
    let symbols: [String]
    @Binding var selection: String
    let color: String
    let label: String

    var body: some View {
        let tint = Color(hex: color) ?? LunexColor.ink
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: LunexTheme.Spacing.space2), count: 6), spacing: LunexTheme.Spacing.space2) {
            ForEach(symbols, id: \.self) { symbol in
                let isSelected = symbol == selection
                Button { selection = symbol } label: {
                    Image(systemName: symbol)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(isSelected ? Color.white : LunexColor.ink)
                        .frame(width: 44, height: 44)
                        .background(isSelected ? tint : LunexColor.surfaceSunken, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(symbol)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(.vertical, LunexTheme.Spacing.space1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}

/// The data palette as dots, five to a row; the chosen one is ringed.
struct ColorRow: View {
    @Binding var selection: String
    let label: String

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 5), spacing: 0) {
            ForEach(Palette.data, id: \.self) { hex in
                let isSelected = hex == selection
                Button { selection = hex } label: {
                    Circle()
                        .fill(Color(hex: hex) ?? LunexColor.ink)
                        .frame(width: 28, height: 28)
                        .padding(4)
                        .overlay(Circle().strokeBorder(isSelected ? LunexColor.ink : .clear, lineWidth: 2))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(hex)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}
