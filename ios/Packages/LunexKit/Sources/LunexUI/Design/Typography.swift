import SwiftUI

/// Text styles of the design system: SF Pro, scaled with Dynamic Type.
/// One `amountHero` per screen: the thin, tightly tracked number is the system's signature.
public enum LunexTextStyle: Sendable {
    case amountHero, amountL, amountM
    case titleL, titleM
    case body, bodyStrong, callout, caption
    /// Capitals with wide tracking, `inkMuted`: labels above numbers and sections.
    case label

    var size: CGFloat {
        switch self {
        case .amountHero: 56
        case .amountL: 34
        case .titleL: 28
        case .titleM: 20
        case .amountM, .body, .bodyStrong: 17
        case .callout: 15
        case .caption: 13
        case .label: 11
        }
    }

    var weight: Font.Weight {
        switch self {
        case .amountHero, .amountL: .light
        case .amountM: .medium
        case .titleL, .titleM, .bodyStrong, .label: .semibold
        case .body, .callout, .caption: .regular
        }
    }

    /// Letter spacing in em.
    var tracking: CGFloat {
        switch self {
        case .amountHero: -0.02
        case .amountL, .titleL: -0.01
        case .label: 0.08
        default: 0
        }
    }

    /// Which Dynamic Type style the size follows.
    var scalesWith: Font.TextStyle {
        switch self {
        case .amountHero, .amountL, .titleL: .largeTitle
        case .titleM: .title3
        case .amountM, .body, .bodyStrong: .body
        case .callout: .callout
        case .caption: .footnote
        case .label: .caption2
        }
    }

    var isAmount: Bool {
        switch self {
        case .amountHero, .amountL, .amountM: true
        default: false
        }
    }
}

extension View {
    /// Sets font, tracking and digits for a design-system text style; `weight` overrides the style's.
    public func lunexText(_ style: LunexTextStyle, weight: Font.Weight? = nil) -> some View {
        modifier(LunexTextModifier(style: style, weight: weight))
    }
}

private struct LunexTextModifier: ViewModifier {
    let style: LunexTextStyle
    let weight: Font.Weight?
    @ScaledMetric private var size: CGFloat

    init(style: LunexTextStyle, weight: Font.Weight?) {
        self.style = style
        self.weight = weight
        _size = ScaledMetric(wrappedValue: style.size, relativeTo: style.scalesWith)
    }

    @ViewBuilder
    func body(content: Content) -> some View {
        let font = Font.system(size: size, weight: weight ?? style.weight)
        let styled = content
            .font(style.isAmount ? font.monospacedDigit() : font)
            .tracking(style.tracking * size)
        if style == .label {
            styled
                .textCase(.uppercase)
                .foregroundStyle(LunexColor.inkMuted)
        } else {
            styled
        }
    }
}
