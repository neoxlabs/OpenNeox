// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NeoxMacSpeech",
    platforms: [ .macOS(.v13) ],
    products: [
        .executable(name: "neox-mac-speech", targets: ["NeoxMacSpeech"])
    ],
    targets: [
        .executableTarget(
            name: "NeoxMacSpeech",
            path: "Sources/NeoxMacSpeech",
            exclude: ["Info.plist"],
            linkerSettings: [
                /* 内嵌 Info.plist 到 Mach-O __TEXT.__info_plist section (TCC 隐私弹窗需要). */
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/NeoxMacSpeech/Info.plist",
                ])
            ]
        )
    ]
)
