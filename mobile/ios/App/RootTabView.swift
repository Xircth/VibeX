import CompanionCore
import SwiftUI
import UIKit

enum AppTab: Hashable, CaseIterable, Identifiable {
    case conversations
    case board
    case space
    case settings

    var id: Self { self }

    var title: String {
        switch self {
        case .conversations: return "对话"
        case .board: return "看板"
        case .space: return "协作空间"
        case .settings: return "设置"
        }
    }

    var icon: String {
        switch self {
        case .conversations: return "message"
        case .board: return "square.grid.2x2"
        case .space: return "person.2"
        case .settings: return "gearshape"
        }
    }

    var selectedIcon: String {
        switch self {
        case .conversations: return "message.fill"
        case .board: return "square.grid.2x2.fill"
        case .space: return "person.2.fill"
        case .settings: return "gearshape.fill"
        }
    }
}

struct RootTabView: View {
    @Environment(ServerStore.self) private var servers
    @Environment(AppAppearanceStore.self) private var appearance
    @State private var selection: AppTab = .conversations
    @State private var attentionCenter = CompanionAttentionCenter()
    @State private var isConversationsChromeHidden = false
    @State private var isLaunchRevealed = false
    @State private var isKeyboardVisible = false

    private var activeClient: HostClient? {
        guard let profile = servers.activeProfile else { return nil }
        return servers.client(for: profile)
    }

    private var shouldShowBottomBar: Bool {
        if isKeyboardVisible { return false }
        if selection == .conversations && isConversationsChromeHidden { return false }
        return true
    }

    private var isBottomBarRevealed: Bool {
        isLaunchRevealed || servers.activeProfile == nil || selection != .conversations
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                RequiresServer(selection: $selection) { client in
                    ConversationsView(
                        client: client,
                        onChromeHiddenChange: { hidden in
                            withAnimation(.smooth(duration: 0.2)) {
                                isConversationsChromeHidden = hidden
                            }
                        },
                        onLaunchRevealedChange: { revealed in
                            withAnimation(.spring(response: 1.05, dampingFraction: 0.86, blendDuration: 0.2)) {
                                isLaunchRevealed = revealed
                            }
                        }
                    )
                }
                .opacity(selection == .conversations ? 1 : 0)
                .allowsHitTesting(selection == .conversations)

                if selection == .board {
                    RequiresServer(selection: $selection) { BoardView(client: $0) }
                        .transition(.opacity)
                } else if selection == .space {
                    RequiresServer(selection: $selection) { CollaborationSpaceView(client: $0) }
                        .transition(.opacity)
                } else if selection == .settings {
                    SettingsView()
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if shouldShowBottomBar {
                bottomNavigationBar
                    .opacity(isBottomBarRevealed ? 1 : 0)
                    .offset(y: isBottomBarRevealed ? 0 : 36)
                    .blur(radius: isBottomBarRevealed ? 0 : 3)
                    .allowsHitTesting(isBottomBarRevealed)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .environment(attentionCenter)
        .overlay(alignment: .top) {
            if let client = activeClient {
                CompanionToastOverlay(
                    client: client,
                    center: attentionCenter,
                    onOpenConversation: { conversation in
                        selection = .conversations
                        attentionCenter.openConversation(conversation)
                    }
                )
            }
        }
        .task(id: servers.activeProfile?.id) {
            guard let client = activeClient else { return }
            while !Task.isCancelled {
                await attentionCenter.poll(client: client)
                try? await Task.sleep(for: .milliseconds(1500))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            withAnimation(.easeOut(duration: 0.18)) {
                isKeyboardVisible = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            withAnimation(.easeOut(duration: 0.18)) {
                isKeyboardVisible = false
            }
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

    private var bottomNavigationBar: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 0.5)

            HStack(spacing: 0) {
                ForEach(AppTab.allCases) { tab in
                    let isSelected = selection == tab
                    Button {
                        if selection != tab {
                            withAnimation(.smooth(duration: 0.16)) {
                                selection = tab
                            }
                        }
                    } label: {
                        VStack(spacing: 3.5) {
                            Image(systemName: isSelected ? tab.selectedIcon : tab.icon)
                                .font(.system(size: 17.5, weight: isSelected ? .semibold : .regular))
                                .frame(height: 22)

                            Text(tab.title)
                                .font(.system(size: 10.5, weight: isSelected ? .semibold : .medium))
                                .lineLimit(1)
                        }
                        .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 7)
                        .padding(.bottom, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tab.title)
                }
            }
            .padding(.horizontal, 8)
        }
        .background(
            Color(.secondarySystemGroupedBackground)
                .ignoresSafeArea(edges: .bottom)
        )
    }
}

#Preview {
    RootTabView()
        .environment(ServerStore(defaults: UserDefaults(suiteName: "preview")!))
        .environment(AppAppearanceStore(defaults: UserDefaults(suiteName: "preview")!))
}
