import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Color tokens of the Lunex design system (the «Lunex Finance» design-system artifact).
/// The interface is monochrome; `data*` colors are for data only: rings, bars, chart segments.
public enum LunexColor {
    /// Screen background.
    public static let paper = Color(light: 0xF4F4F5, dark: 0x0E0E10)
    /// Cards and sheets on paper.
    public static let surface = Color(light: 0xFFFFFF, dark: 0x18181B)
    /// Inputs, keypad keys, segmented track, secondary button, icon wells.
    public static let surfaceSunken = Color(light: 0xEBEBED, dark: 0x232327)
    /// 1px hairlines between rows and around inputs.
    public static let line = Color(light: 0xE0DFE3, dark: 0x2E2E33)
    /// Primary text, numbers, icons; the primary button's fill.
    public static let ink = Color(light: 0x141416, dark: 0xF2F2F4)
    /// Secondary text: labels, captions, currency next to an amount.
    public static let inkMuted = Color(light: 0x5D5C61, dark: 0xA09FA6)
    /// Placeholders, disabled labels, chart grid. Never text people must read.
    public static let inkFaint = Color(light: 0x9B9AA0, dark: 0x5F5E64)
    /// Text and icons on an `ink` fill.
    public static let onInk = Color(light: 0xFFFFFF, dark: 0x141416)
    /// Overspending and errors only.
    public static let negative = Color(light: 0xA8463C, dark: 0xE2786D)
    /// Focus ring.
    public static let focus = Color(light: 0x557A95, dark: 0x7FA2BE)

    /// The main data color: the «can spend today» ring, the primary goal, the first series.
    public static let dataSteel = Color(light: 0x557A95, dark: 0x6E92AE)
    public static let dataSand = Color(light: 0xB1A296, dark: 0xC4B7AA)
    public static let dataGraphite = Color(light: 0x5D5C61, dark: 0x85848B)
    public static let dataSky = Color(light: 0x7395AE, dark: 0x8DABC2)
    public static let dataMauve = Color(light: 0x938E94, dark: 0xA9A4AA)
    /// Track under rings and bars.
    public static let dataTrack = surfaceSunken

    /// Chart series in order: neighbours differ in lightness, not only in hue.
    public static let data: [Color] = [dataSteel, dataSand, dataGraphite, dataSky, dataMauve]
}

extension Color {
    /// A color that follows light and dark mode, from 0xRRGGBB values.
    init(light: UInt32, dark: UInt32) {
        #if canImport(UIKit)
        self.init(uiColor: UIColor.lunex(light: light, dark: dark))
        #else
        self.init(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(rgb: isDark ? dark : light)
        })
        #endif
    }
}

#if canImport(UIKit)
extension UIColor {
    /// The UIKit side of a design-system color, for appearance proxies.
    static func lunex(light: UInt32, dark: UInt32) -> UIColor {
        UIColor { traits in UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light) }
    }

    fileprivate convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
#else
private extension NSColor {
    convenience init(rgb: UInt32) {
        self.init(
            srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
#endif
