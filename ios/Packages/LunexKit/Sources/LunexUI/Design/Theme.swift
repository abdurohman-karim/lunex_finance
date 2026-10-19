import SwiftUI

/// Spacing, radius and size tokens; names follow the design system (`space-4` → `Spacing.space4`).
public enum LunexTheme {
    public enum Spacing {
        public static let space1: CGFloat = 4
        public static let space2: CGFloat = 8
        public static let space3: CGFloat = 12
        /// Screen side margins, card padding.
        public static let space4: CGFloat = 16
        /// Between sections of a screen.
        public static let space6: CGFloat = 24
        public static let space8: CGFloat = 32
        public static let space12: CGFloat = 48
    }

    public enum Radius {
        public static let small: CGFloat = 8
        /// Inputs, keypad keys, code cells.
        public static let medium: CGFloat = 14
        /// Cards and sheets.
        public static let large: CGFloat = 22
    }

    public enum Size {
        /// Buttons, inputs.
        public static let controlHeight: CGFloat = 52
        public static let rowHeight: CGFloat = 60
        public static let iconWell: CGFloat = 40
        public static let ringHero: CGFloat = 264
        public static let ringStroke: CGFloat = 10
        public static let barHeight: CGFloat = 6
    }
}

/// A block on paper: `surface`, large radius, no shadow or border.
public struct Card<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(LunexTheme.Spacing.space4)
            .background(LunexColor.surface, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.large, style: .continuous))
    }
}
