import SwiftUI

@main
struct HomeyDeckApp: App {
    #if os(macOS)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif
    @State private var model = DeckModel()

    var body: some Scene {
        #if os(macOS)
        Window("HomeyDeck", id: "main") {
            DeckView()
                .environment(model)
        }
        .defaultSize(width: 440, height: 680)
        .windowResizability(.contentMinSize)
        #else
        WindowGroup {
            DeckView()
                .environment(model)
        }
        #endif
    }
}

#if os(macOS)
/// Quits the app when its window closes, so nothing keeps running in the background.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
#endif
