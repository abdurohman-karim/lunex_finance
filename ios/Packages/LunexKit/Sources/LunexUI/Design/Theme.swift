import SwiftUI

/// Design tokens. Colors adapt to light and dark mode through the system palette;
/// the brand accent is set in the app's asset catalog (AccentColor).
public enum LunexTheme {
    public static let income = Color.green
    public static let expense = Color.red
    public static let savings = Color.indigo

    public enum Radius {
        public static let card: CGFloat = 20
        public static let control: CGFloat = 14
    }

    public enum Spacing {
        public static let xs: CGFloat = 4
        public static let s: CGFloat = 8
        public static let m: CGFloat = 16
        public static let l: CGFloat = 24
    }
}

/// A rounded surface for home-screen blocks.
public struct Card<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(LunexTheme.Spacing.m)
            .background(.fill.quinary, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.card))
    }
}

/// The big number of a screen, e.g. «Можно потратить сегодня».
public struct HeadlineAmount: View {
    private let title: String
    private let value: String

    public init(title: String, value: String) {
        self.title = title
        self.value = value
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.xs) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                .monospacedDigit()
                .contentTransition(.numericText())
        }
        .accessibilityElement(children: .combine)
    }
}
