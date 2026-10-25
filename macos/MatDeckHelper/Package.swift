// swift-tools-version: 5.9
// Helper nativo do MatDeck para macOS: fala com o servidor Node por um socket Unix (JSON por linha) e
// faz o que exige API nativa (teclas, janela ativa, apps, volume, barra de menus). Sem dependências externas.
import PackageDescription

let package = Package(
    name: "MatDeckHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "MatDeckHelperCore",
            path: "Sources/MatDeckHelperCore"
        ),
        .executableTarget(
            name: "matdeck-helper",
            dependencies: ["MatDeckHelperCore"],
            path: "Sources/MatDeckHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("Carbon")
            ]
        ),
        .testTarget(
            name: "MatDeckHelperCoreTests",
            dependencies: ["MatDeckHelperCore"],
            path: "Tests/MatDeckHelperCoreTests"
        )
    ]
)
