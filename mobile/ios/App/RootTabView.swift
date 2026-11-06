import SwiftUI

enum AppTab: Hashable {
    case conversations, board, space, files, settings
}

struct RootTabView: View {
    @State private var selection: AppTab = .conversations

    var body: some View {
        TabView(selection: $selection) {
            RequiresServer(selection: $selection) { ConversationsView(client: $0) }
                .tabItem { Label("对话", systemImage: "bubble.left.and.bubble.right") }
                .tag(AppTab.conversations)
            UnsupportedTab(title: "看板", icon: "square.grid.2x2")
                .tabItem { Label("看板", systemImage: "square.grid.2x2") }
                .tag(AppTab.board)
            UnsupportedTab(title: "协作空间", icon: "person.2")
                .tabItem { Label("协作空间", systemImage: "person.2") }
                .tag(AppTab.space)
            RequiresServer(selection: $selection) { FilesView(client: $0) }
                .tabItem { Label("文件", systemImage: "folder") }
                .tag(AppTab.files)
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
    }
}

/// The Host does not grant the Companion preset access to this surface (ADR-0054).
private struct UnsupportedTab: View {
    let title: String
    let icon: String

    var body: some View {
        NavigationStack {
            ContentUnavailableView(title, systemImage: icon, description: Text("手机端暂不支持"))
                .navigationTitle(title)
        }
    }
}

#Preview {
    RootTabView().environment(ServerStore(defaults: UserDefaults(suiteName: "preview")!))
}
