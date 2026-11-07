import SwiftUI

enum AppTab: Hashable {
    case conversations, board, space, files, settings
}

struct RootTabView: View {
    @Environment(AppAppearanceStore.self) private var appearance
    @State private var selection: AppTab = .conversations

    var body: some View {
        TabView(selection: $selection) {
            RequiresServer(selection: $selection) { ConversationsView(client: $0) }
                .tabItem { Label("对话", systemImage: "bubble.left.and.bubble.right") }
                .tag(AppTab.conversations)
            RequiresServer(selection: $selection) { BoardView(client: $0) }
                .tabItem { Label("看板", systemImage: "square.grid.2x2") }
                .tag(AppTab.board)
            RequiresServer(selection: $selection) { CollaborationSpaceView(client: $0) }
                .tabItem { Label("协作空间", systemImage: "person.2") }
                .tag(AppTab.space)
            RequiresServer(selection: $selection) { FilesView(client: $0) }
                .tabItem { Label("文件", systemImage: "folder") }
                .tag(AppTab.files)
            SettingsView()
                .tabItem { Label("设置", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
        .dynamicTypeSize(appearance.fontSizePreset.dynamicTypeSize)
        .fontDesign(appearance.fontStylePreset.fontDesign)
        .preferredColorScheme(appearance.themeMode.colorScheme)
        .onAppear {
            appearance.applyInterfaceStyleToAllWindows(appearance.themeMode.uiInterfaceStyle)
        }
        .onChange(of: selection) { _, _ in
            dismissKeyboard()
        }
        .background(
            GlobalInteractionInstaller()
                .frame(width: 0, height: 0)
                .allowsHitTesting(false)
        )
    }
}

#Preview {
    RootTabView()
        .environment(ServerStore(defaults: UserDefaults(suiteName: "preview")!))
        .environment(AppAppearanceStore(defaults: UserDefaults(suiteName: "preview")!))
}
