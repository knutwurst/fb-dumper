// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FBDumper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "FBDumper",
            swiftSettings: [.enableUpcomingFeature("BareSlashRegexLiterals")]
        ),
    ]
)
