import SwiftUI

@main
struct VibeXCompanionApp: App {
    @State private var servers = ServerStore()

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environment(servers)
        }
    }
}
