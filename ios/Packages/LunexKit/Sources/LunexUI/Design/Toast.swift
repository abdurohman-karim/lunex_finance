import LunexCore
import LunexLocalization
import SwiftUI

/// A short message at the bottom of the screen with one action, gone after five seconds
/// («Расход сохранён · Отменить»).
@MainActor
@Observable
public final class ToastCenter {
    public struct Toast: Identifiable {
        public let id = UUID()
        public let message: String
        public let actionTitle: String?
        public let action: (@MainActor () -> Void)?
    }

    public private(set) var current: Toast?
    @ObservationIgnored private var hideTask: Task<Void, Never>?

    public init() {}

    public func show(_ message: String, actionTitle: String? = nil, action: (@MainActor () -> Void)? = nil) {
        let toast = Toast(message: message, actionTitle: actionTitle, action: action)
        current = toast
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled, self?.current?.id == toast.id else { return }
            self?.current = nil
        }
    }

    public func dismiss() {
        hideTask?.cancel()
        current = nil
    }

    func runAction() {
        let action = current?.action
        dismiss()
        action?()
    }
}

extension View {
    /// Shows the center's toast above the tab bar.
    func toastHost(_ center: ToastCenter) -> some View {
        overlay(alignment: .bottom) {
            if let toast = center.current {
                ToastView(toast: toast) { center.runAction() }
                    .padding(.horizontal, LunexTheme.Spacing.space4)
                    .padding(.bottom, 64)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .id(toast.id)
            }
        }
        .animation(.snappy, value: center.current?.id)
    }
}

private struct ToastView: View {
    let toast: ToastCenter.Toast
    let action: () -> Void

    var body: some View {
        HStack(spacing: LunexTheme.Spacing.space4) {
            Text(toast.message)
                .lunexText(.callout, weight: .medium)
                .lineLimit(2)
            Spacer(minLength: 0)
            if let title = toast.actionTitle {
                Button(title, action: action)
                    .lunexText(.callout, weight: .semibold)
                    .underline()
                    .buttonStyle(.plain)
                    .padding(.vertical, LunexTheme.Spacing.space2)
            }
        }
        .foregroundStyle(LunexColor.onInk)
        .padding(.leading, LunexTheme.Spacing.space4)
        .padding(.trailing, LunexTheme.Spacing.space4)
        .frame(minHeight: LunexTheme.Size.controlHeight)
        .background(LunexColor.ink, in: Capsule())
        .shadow(color: .black.opacity(0.12), radius: 16, y: -4)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}

/// Lays children out in rows, wrapping to the next row when one is full (category chips).
struct FlowLayout: Layout {
    var spacing: CGFloat = LunexTheme.Spacing.space2

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let height = rows.last.map { $0.y + $0.height } ?? 0
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: bounds.minY + row.y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private struct Row {
        var indices: [Int] = []
        var y: CGFloat = 0
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !row.indices.isEmpty, row.width + spacing + size.width > width {
                rows.append(row)
                row = Row(y: row.y + row.height + spacing)
            }
            row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}

extension Localizer {
    /// «45 000», «−45 000», «12,50 $»: grouped the language's way; the currency is named only
    /// when asked (a sum in another currency than the base one).
    func amount(_ value: Decimal, currency: String, signed: Bool = false, showCurrency: Bool = false) -> String {
        if hidesAmounts {
            return showCurrency ? "•••• \(currencyName(currency))" : "••••"
        }
        let digits = LunexCore.Money.fractionDigits(for: currency)
        let number = abs(value).formatted(
            .number.precision(.fractionLength(digits)).locale(locale)
        )
        let sign = signed ? (value < 0 ? "−" : value > 0 ? "+" : "") : (value < 0 ? "−" : "")
        let text = sign + number
        return showCurrency ? "\(text) \(currencyName(currency))" : text
    }

    /// «сум» / «soʻm» / «sum» for UZS; the usual symbol for the others.
    func currencyName(_ code: String) -> String {
        if code == "UZS" { return self("currency.UZS") }
        return locale.localizedCurrencySymbol(code) ?? code
    }
}

private extension Locale {
    func localizedCurrencySymbol(_ code: String) -> String? {
        let formatter = NumberFormatter()
        formatter.locale = self
        formatter.numberStyle = .currency
        formatter.currencyCode = code
        return formatter.currencySymbol
    }
}
