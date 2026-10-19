// swift-tools-version: 6.0
import PackageDescription

// Everything except the app shell lives here, so the core can be tested with `swift test`
// on the Mac without a simulator.
let package = Package(
    name: "LunexKit",
    defaultLocalization: "en",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "LunexCore", targets: ["LunexCore"]),
        .library(name: "LunexLocalization", targets: ["LunexLocalization"]),
        .library(name: "LunexUI", targets: ["LunexUI"]),
    ],
    targets: [
        /// Models, money, API client, session, Keychain, SwiftData store. No UI.
        .target(name: "LunexCore"),
        /// uz / ru / en strings, switchable at runtime independent of the system language.
        .target(
            name: "LunexLocalization",
            resources: [.process("Resources")]
        ),
        /// Design system and screens.
        .target(
            name: "LunexUI",
            dependencies: ["LunexCore", "LunexLocalization"]
        ),
        .testTarget(name: "LunexCoreTests", dependencies: ["LunexCore"]),
        .testTarget(name: "LunexLocalizationTests", dependencies: ["LunexLocalization"]),
    ]
)
