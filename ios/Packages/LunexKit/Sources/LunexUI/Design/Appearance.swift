#if canImport(UIKit)
import UIKit

/// UIKit-drawn parts SwiftUI does not style: navigation titles in `titleL` and `ink`.
@MainActor
public enum LunexAppearance {
    public static func apply() {
        let ink = UIColor.lunex(light: 0x141416, dark: 0xF2F2F4)
        let large = UIFontMetrics(forTextStyle: .largeTitle)
            .scaledFont(for: .systemFont(ofSize: 28, weight: .semibold))
        let inline = UIFontMetrics(forTextStyle: .headline)
            .scaledFont(for: .systemFont(ofSize: 17, weight: .semibold))
        let bar = UINavigationBar.appearance()
        bar.largeTitleTextAttributes = [.font: large, .foregroundColor: ink, .kern: -0.28]
        bar.titleTextAttributes = [.font: inline, .foregroundColor: ink]
    }
}
#endif
