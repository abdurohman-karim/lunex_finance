import SwiftUI

// MARK: - Logo

/// The «Lunex.» wordmark, in `ink` (light on dark). The vector lives in the app's asset
/// catalog (`LunexLogo`, template rendering); give it a width, the height follows.
public struct LunexLogo: View {
    /// The wordmark's own proportions (756 × 208).
    public static let aspectRatio: CGFloat = 756.0 / 208.0

    private let label: String

    public init(label: String = "Lunex Finance") {
        self.label = label
    }

    public var body: some View {
        Image("LunexLogo", bundle: .main)
            .renderingMode(.template)
            .resizable()
            .aspectRatio(Self.aspectRatio, contentMode: .fit)
            .foregroundStyle(LunexColor.ink)
            .accessibilityLabel(label)
    }
}

// MARK: - Button

/// Capsule buttons. One `primary` per screen; `secondary` for the rest; `quiet` for
/// «Не сегодня», «Изменить почту», «Пропустить».
public struct LunexButtonStyle: ButtonStyle {
    public enum Kind: Sendable {
        case primary, secondary, quiet
    }

    public enum Size: Sendable {
        /// Full width, `controlHeight` tall.
        case regular
        /// Hugs its label, 40 pt tall: actions inside cards.
        case compact
    }

    let kind: Kind
    let size: Size

    public init(_ kind: Kind, size: Size = .regular) {
        self.kind = kind
        self.size = size
    }

    public func makeBody(configuration: Configuration) -> some View {
        StyledLabel(configuration: configuration, kind: kind, size: size)
    }

    private struct StyledLabel: View {
        let configuration: Configuration
        let kind: Kind
        let size: Size
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .lunexText(size == .compact ? .callout : .body, weight: kind == .quiet ? .medium : .semibold)
                .foregroundStyle(foreground)
                .padding(.horizontal, kind == .quiet ? LunexTheme.Spacing.space3 : horizontalPadding)
                .frame(maxWidth: size == .regular && kind != .quiet ? .infinity : nil)
                .frame(minHeight: height)
                .background(background, in: Capsule())
                .contentShape(Capsule())
                .opacity(configuration.isPressed ? 0.6 : isEnabled ? 1 : 0.4)
        }

        private var height: CGFloat {
            switch (kind, size) {
            case (.quiet, _): 44
            case (_, .compact): 40
            case (_, .regular): LunexTheme.Size.controlHeight
            }
        }

        private var horizontalPadding: CGFloat {
            size == .compact ? 20 : LunexTheme.Spacing.space6
        }

        private var foreground: Color {
            switch kind {
            case .primary: LunexColor.onInk
            case .secondary: LunexColor.ink
            case .quiet: LunexColor.inkMuted
            }
        }

        private var background: Color {
            switch kind {
            case .primary: LunexColor.ink
            case .secondary: LunexColor.surfaceSunken
            case .quiet: .clear
            }
        }
    }
}

extension ButtonStyle where Self == LunexButtonStyle {
    public static func lunex(_ kind: LunexButtonStyle.Kind, size: LunexButtonStyle.Size = .regular) -> LunexButtonStyle {
        LunexButtonStyle(kind, size: size)
    }
}

// MARK: - Inputs

extension View {
    /// The design system's text field: `surfaceSunken`, medium radius, no border until focused.
    public func lunexInput() -> some View {
        lunexText(.body)
            .foregroundStyle(LunexColor.ink)
            .padding(.horizontal, LunexTheme.Spacing.space4)
            .frame(minHeight: LunexTheme.Size.controlHeight)
            .background(LunexColor.surfaceSunken, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous))
    }
}

/// Six cells showing a one-time code; the real text field sits underneath (see EmailSignInView).
struct CodeCells: View {
    let code: String
    let length: Int
    let isFocused: Bool

    var body: some View {
        let digits = Array(code)
        HStack(spacing: LunexTheme.Spacing.space2) {
            ForEach(0..<length, id: \.self) { index in
                let isCurrent = isFocused && index == min(digits.count, length - 1) && digits.count < length
                Text(index < digits.count ? String(digits[index]) : " ")
                    .font(.system(size: 30, weight: .light).monospacedDigit())
                    .foregroundStyle(LunexColor.ink)
                    .frame(maxWidth: .infinity, minHeight: 60)
                    .background(LunexColor.surfaceSunken, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous)
                            .strokeBorder(isCurrent ? LunexColor.ink : .clear, lineWidth: 1)
                    }
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Text

/// Capitals above a number or a section: «МОЖНО ПОТРАТИТЬ СЕГОДНЯ».
public struct SectionLabel: View {
    private let text: String

    public init(_ text: String) {
        self.text = text
    }

    public var body: some View {
        Text(text).lunexText(.label)
    }
}

/// The screen's one big number: label, amount with currency, one line of explanation.
public struct AmountDisplay: View {
    public enum Scale: Sendable {
        case hero, large
    }

    private let label: String?
    private let value: String
    private let currency: String?
    private let caption: String?
    private let scale: Scale
    private let isNegative: Bool

    /// `value` is already formatted («184 000»); `currency` goes after it in `inkMuted`.
    public init(
        label: String? = nil,
        value: String,
        currency: String? = nil,
        caption: String? = nil,
        scale: Scale = .hero,
        isNegative: Bool = false
    ) {
        self.label = label
        self.value = value
        self.currency = currency
        self.caption = caption
        self.scale = scale
        self.isNegative = isNegative
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space1) {
            if let label {
                SectionLabel(label)
            }
            HStack(alignment: .firstTextBaseline, spacing: LunexTheme.Spacing.space1) {
                Text(value)
                    .lunexText(scale == .hero ? .amountHero : .amountL)
                    .foregroundStyle(isNegative ? LunexColor.negative : LunexColor.ink)
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                if let currency {
                    Text(currency)
                        .lunexText(.body)
                        .foregroundStyle(LunexColor.inkMuted)
                }
            }
            if let caption {
                Text(caption)
                    .lunexText(.caption)
                    .foregroundStyle(isNegative ? LunexColor.negative : LunexColor.inkMuted)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Data

/// Progress ring: `dataTrack` underneath, a round-capped arc on top, content in the middle.
public struct ProgressRing<Center: View>: View {
    private let progress: Double
    private let tint: Color
    private let lineWidth: CGFloat
    private let center: Center
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        progress: Double,
        tint: Color = LunexColor.dataSteel,
        lineWidth: CGFloat = LunexTheme.Size.ringStroke,
        @ViewBuilder center: () -> Center
    ) {
        self.progress = progress
        self.tint = tint
        self.lineWidth = lineWidth
        self.center = center()
    }

    public var body: some View {
        ZStack {
            Circle()
                .stroke(LunexColor.dataTrack, lineWidth: lineWidth)
            Circle()
                .trim(from: 0, to: min(max(progress, 0), 1))
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            center
                .padding(lineWidth * 2)
        }
        .padding(lineWidth / 2)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: progress)
    }
}

/// Thin progress bar for goals and budget categories; over 100% it fills with `negative`.
public struct ProgressBar: View {
    private let progress: Double
    private let tint: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(progress: Double, tint: Color = LunexColor.dataSteel) {
        self.progress = progress
        self.tint = tint
    }

    public var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(LunexColor.dataTrack)
                Capsule()
                    .fill(progress > 1 ? LunexColor.negative : tint)
                    .frame(width: proxy.size.width * min(max(progress, 0), 1))
            }
        }
        .frame(height: LunexTheme.Size.barHeight)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: progress)
        .accessibilityElement()
        .accessibilityValue(Text(progress, format: .percent.precision(.fractionLength(0))))
    }
}

// MARK: - Selection and status

/// A capsule to pick a category, a filter or a template; the selected one is filled with `ink`.
public struct Chip: View {
    private let title: String
    private let systemImage: String?
    private let isSelected: Bool
    private let action: () -> Void

    public init(_ title: String, systemImage: String? = nil, isSelected: Bool, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.isSelected = isSelected
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            ChipLabel(title, systemImage: systemImage, isSelected: isSelected)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// A chip's look without the button, for menus that open from a chip (filters, account, date).
struct ChipLabel: View {
    enum Size {
        /// 36 pt: categories, filters
        case regular
        /// 32 pt: the account and date under the amount
        case small
    }

    private let title: String
    private let systemImage: String?
    private let trailingImage: String?
    private let isSelected: Bool
    private let size: Size

    init(_ title: String, systemImage: String? = nil, trailingImage: String? = nil, isSelected: Bool, size: Size = .regular) {
        self.title = title
        self.systemImage = systemImage
        self.trailingImage = trailingImage
        self.isSelected = isSelected
        self.size = size
    }

    var body: some View {
        HStack(spacing: LunexTheme.Spacing.space1) {
            if let systemImage {
                Image(systemName: systemImage)
            }
            Text(title)
                .lineLimit(1)
            if let trailingImage {
                Image(systemName: trailingImage)
                    .font(.system(size: 10, weight: .semibold))
                    .opacity(0.6)
            }
        }
        .lunexText(size == .small ? .caption : .callout, weight: .medium)
        .foregroundStyle(isSelected ? LunexColor.onInk : LunexColor.ink)
        .padding(.horizontal, size == .small ? LunexTheme.Spacing.space3 : 14)
        .frame(minHeight: size == .small ? 32 : 36)
        .background(isSelected ? LunexColor.ink : LunexColor.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(isSelected ? LunexColor.ink : LunexColor.line, lineWidth: 1))
        .contentShape(Capsule())
    }
}

/// A small capsule with a word and, optionally, a colored dot: «В графике», «Pro · осталось 23 дня».
public struct StatusBadge: View {
    private let text: String
    private let dot: Color?
    private let isProminent: Bool

    public init(_ text: String, dot: Color? = nil, isProminent: Bool = false) {
        self.text = text
        self.dot = dot
        self.isProminent = isProminent
    }

    public var body: some View {
        HStack(spacing: 6) {
            if let dot {
                Circle().fill(dot).frame(width: 8, height: 8)
            }
            Text(text)
        }
        .lunexText(.caption, weight: .semibold)
        .foregroundStyle(isProminent ? LunexColor.onInk : LunexColor.ink)
        .padding(.horizontal, 10)
        .frame(minHeight: 24)
        .background(isProminent ? LunexColor.ink : LunexColor.surfaceSunken, in: Capsule())
    }
}

/// A round button with one SF Symbol on `surfaceSunken`: back, close, privacy.
public struct IconButton: View {
    private let systemImage: String
    private let label: String
    private let action: () -> Void

    public init(_ label: String, systemImage: String, action: @escaping () -> Void) {
        self.label = label
        self.systemImage = systemImage
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(LunexColor.ink)
                .frame(width: 44, height: 44)
                .background(LunexColor.surfaceSunken, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

#Preview("Components") {
    ScrollView {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space6) {
            ProgressRing(progress: 0.74) {
                AmountDisplay(label: "Можно потратить", value: "184 000", caption: "сум из 250 000", scale: .large)
            }
            .frame(width: LunexTheme.Size.ringHero, height: LunexTheme.Size.ringHero)
            Card {
                VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
                    AmountDisplay(label: "Баланс", value: "12 480 000", currency: "сум", scale: .large)
                    ProgressBar(progress: 0.54)
                }
            }
            HStack {
                StatusBadge("В графике", dot: LunexColor.dataSteel)
                StatusBadge("Pro · осталось 23 дня", isProminent: true)
            }
            HStack {
                Chip("Кафе", isSelected: true) {}
                Chip("Транспорт", isSelected: false) {}
            }
            Button("Получить код") {}.buttonStyle(.lunex(.primary))
            Button("Войти по почте") {}.buttonStyle(.lunex(.secondary))
            Button("Не сегодня") {}.buttonStyle(.lunex(.quiet))
        }
        .padding(LunexTheme.Spacing.space4)
    }
    .background(LunexColor.paper)
}
