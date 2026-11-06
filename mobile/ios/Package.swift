// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VibeXCompanion",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CompanionCore", targets: ["CompanionCore"]),
    ],
    targets: [
        .target(
            name: "CompanionCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "CompanionCoreTests",
            dependencies: ["CompanionCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
