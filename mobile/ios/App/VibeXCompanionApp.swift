import SwiftUI

@main
struct VibeXCompanionApp: App {
    @State private var servers = ServerStore()
    @State private var appearance = AppAppearanceStore()

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environment(servers)
                .environment(appearance)
        }
    }
}
