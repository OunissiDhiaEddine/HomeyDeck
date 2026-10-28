import SwiftUI

@main
struct HomeyDeckApp: App {
    @State private var model = DeckModel()

    var body: some Scene {
        #if os(macOS)
        WindowGroup(id: "main") {
            DeckView()
                .environment(model)
        }
        .defaultSize(width: 440, height: 680)
        .windowResizability(.contentMinSize)

        MenuBarExtra {
            MenuBarPanel()
                .environment(model)
        } label: {
            Image(systemName: model.phase == .online ? "power.circle.fill" : "power.circle")
        }
        .menuBarExtraStyle(.window)
        #else
        WindowGroup {
            DeckView()
                .environment(model)
        }
        #endif
    }
}
