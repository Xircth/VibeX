import CompanionCore
import SwiftUI

private enum SidebarSectionTab: String, CaseIterable, Identifiable {
    case conversations = "最近对话"
    case files = "项目文件"
    var id: String { rawValue }
}

private struct StarterSuggestion: Identifiable {
    let id: String
    let label: String
    let prompt: String
}

/// Root of the "对话" tab:
/// - Main canvas is calm and focused: either the minimal AI Chat Landing view (`activeConversation == nil`)
///   or the active conversation (`ConversationDetailView`).
/// - Slide-out Sidebar Drawer houses Recent Conversations and Project Files in one dedicated place.
struct ConversationsView: View {
    let client: HostClient
    var onChromeHiddenChange: ((Bool) -> Void)? = nil
    var onLaunchRevealedChange: ((Bool) -> Void)? = nil
    var onSelectTab: ((AppTab) -> Void)? = nil
    @Environment(CompanionAttentionCenter.self) private var attentionCenter: CompanionAttentionCenter?

    @State private var list = RemoteList<ConversationListItem>()
    @State private var projects: [ProjectSummary]?
    @State private var agents: [CatalogAgent] = []

    // Launch logo -> Landing logo morph & radial bloom state
    @State private var launchLogoEntered = false
    @State private var isLaunchRevealed = false

    // Active conversation shown in the main canvas (`nil` = New Chat Landing view)
    @State private var activeConversation: ConversationListItem?

    // Sidebar state
    @State private var isSidebarOpen = false
    @State private var sidebarTab: SidebarSectionTab = .conversations
    @State private var sidebarSearchQuery = ""
    @State private var expandedFileProjectIDs: Set<String> = []
    @State private var projectEntriesByWorkspace: [String: [WorkspaceEntry]] = [:]
    @State private var loadingWorkspaceIDs: Set<String> = []
    @State private var removedConversationIDs: Set<String> = []
    @State private var actionErrorMessage: String?

    // Landing page configuration state
    @State private var selectedProjectID: String?
    @State private var selectedAgentID: String?
    @State private var selectedModelChoiceID: String?
    @State private var selectedAccessModeID: String?
    @State private var selectedEffortIndex: Int?
    @State private var draft = ""
    @State private var composerMenu: ComposerMenu?
    @State private var isCreatingAndSending = false
    @State private var showProjectPickerSheet = false
    @State private var activeFileBrowserWorkspace: WorkspaceSheetTarget?
    @State private var activeDiffWorkspace: WorkspaceSheetTarget?
    @State private var previewFileTarget: FilePreviewSheetTarget?

    private let suggestions: [StarterSuggestion] = [
        StarterSuggestion(
            id: "arch",
            label: "梳理项目架构",
            prompt: "梳理当前项目的整体架构、目录结构与核心模块职责"
        ),
        StarterSuggestion(
            id: "bug",
            label: "排查近期改动",
            prompt: "检查当前工作区最近的代码改动，排查潜在问题并给出修复方案"
        ),
        StarterSuggestion(
            id: "test",
            label: "补充单元测试",
            prompt: "为当前工作区最近修改的核心逻辑补充单元测试并运行验证"
        ),
    ]

    private var isConnected: Bool {
        list.errorMessage == nil && list.items != nil
    }

    private var visibleConversations: [ConversationListItem] {
        (list.items ?? []).filter { !removedConversationIDs.contains($0.id) }
    }

    private var groups: [ProjectGroup] {
        ProjectGroup.make(conversations: visibleConversations, projects: projects ?? [])
    }

    private var currentGroup: ProjectGroup? {
        if let id = selectedProjectID, let match = groups.first(where: { $0.id == id }) {
            return match
        }
        if let gitGroup = groups.first(where: { !$0.isHome && $0.id != "other" && $0.isGit }) {
            return gitGroup
        }
        if let nonHome = groups.first(where: { !$0.isHome && $0.id != "other" }) {
            return nonHome
        }
        return groups.first
    }

    private var currentWorkspaceID: String? {
        guard let group = currentGroup else {
            return visibleConversations.first?.workspace_id
        }
        return workspaceID(for: group)
    }

    private func workspaceID(for group: ProjectGroup) -> String? {
        group.conversations.first?.workspace_id
            ?? group.workspaceIds.first
            ?? projects?.first(where: { $0.id == group.id })?.workspaceIds.first
    }

    private var usableAgents: [CatalogAgent] {
        let usable = agents.filter(\.usable)
        return usable.isEmpty ? agents : usable
    }

    private var currentAgent: CatalogAgent? {
        if let id = selectedAgentID, let match = usableAgents.first(where: { $0.id == id }) {
            return match
        }
        if let recentAgentID = currentGroup?.conversations.first?.agent_id ?? visibleConversations.first?.agent_id,
           let match = usableAgents.first(where: { $0.id == recentAgentID }) {
            return match
        }
        return usableAgents.first
    }

    var body: some View {
        ZStack(alignment: .leading) {
            Group {
                if let activeConversation {
                    NavigationStack {
                        ConversationDetailView(
                            client: client,
                            conversation: activeConversation,
                            onToggleSidebar: {
                                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                                    isSidebarOpen.toggle()
                                }
                            },
                            onReturnToLanding: {
                                withAnimation(.smooth(duration: 0.2)) {
                                    self.activeConversation = nil
                                }
                            }
                        )
                        .id(activeConversation.id)
                    }
                } else {
                    landingWorkspaceView
                }
            }
            .disabled(isSidebarOpen)

            if isSidebarOpen {
                Color.black.opacity(0.36)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                            isSidebarOpen = false
                            dismissKeyboard()
                        }
                    }
                    .transition(.opacity)
                    .zIndex(1)

                sidebarDrawer
                    .transition(.move(edge: .leading))
                    .zIndex(2)
            }
        }
        .gesture(
            DragGesture(minimumDistance: 24, coordinateSpace: .local)
                .onEnded { value in
                    if !isSidebarOpen && value.startLocation.x < 32 && value.translation.width > 64 {
                        dismissKeyboard()
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                            isSidebarOpen = true
                        }
                    } else if isSidebarOpen && value.translation.width < -60 {
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                            isSidebarOpen = false
                        }
                    }
                }
        )
        .sheet(item: $activeFileBrowserWorkspace) { target in
            FileBrowserView(client: client, workspaceID: target.workspaceID)
        }
        .sheet(item: $activeDiffWorkspace) { target in
            DiffListView(client: client, workspaceID: target.workspaceID)
        }
        .sheet(item: $previewFileTarget) { target in
            NavigationStack {
                FileContentView(client: client, workspaceID: target.workspaceID, path: target.path)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("完成") { previewFileTarget = nil }
                        }
                    }
            }
        }
        .sheet(isPresented: $showProjectPickerSheet) {
            projectPickerSheet
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .onAppear {
            consumePendingNavigationIfNeeded()
            onChromeHiddenChange?(isSidebarOpen)
            if !launchLogoEntered {
                withAnimation(.easeOut(duration: 0.36)) {
                    launchLogoEntered = true
                }
            }
        }
        .onChange(of: isSidebarOpen) { _, _ in
            onChromeHiddenChange?(isSidebarOpen)
        }
        .onChange(of: attentionCenter?.pendingNavigationConversation) { _, _ in
            consumePendingNavigationIfNeeded()
        }
        .task {
            guard !isLaunchRevealed else { return }
            try? await Task.sleep(for: .milliseconds(620))
            guard !Task.isCancelled else { return }
            withAnimation(.spring(response: 1.08, dampingFraction: 0.86, blendDuration: 0.2)) {
                isLaunchRevealed = true
            }
            onLaunchRevealedChange?(true)
        }
        .task {
            while !Task.isCancelled {
                await reload()
                try? await Task.sleep(for: .seconds(list.errorMessage == nil ? 25 : 4))
            }
        }
    }

    // MARK: - Minimal, Focused AI Chat Landing View

    private var landingWorkspaceView: some View {
        VStack(spacing: 0) {
            landingTopBar
                .opacity(isLaunchRevealed ? 1 : 0)
                .scaleEffect(isLaunchRevealed ? 1 : 0.82)
                .offset(y: isLaunchRevealed ? 0 : 145)
                .blur(radius: isLaunchRevealed ? 0 : 5)

            Spacer(minLength: 24)

            // Single focal point: Persistent Logo (morphs from center launch logo -> landing logo)
            // + Greeting + Quiet Project Pill radiating outward from the logo
            VStack(spacing: 16) {
                Image("vibex_logo")
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: 54, height: 54)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .shadow(
                        color: .black.opacity(isLaunchRevealed ? 0.08 : 0.14),
                        radius: isLaunchRevealed ? 10 : 18,
                        x: 0,
                        y: isLaunchRevealed ? 4 : 8
                    )
                    .scaleEffect(isLaunchRevealed ? 1.0 : (launchLogoEntered ? 1.52 : 1.28))
                    .offset(y: isLaunchRevealed ? 0 : 42)
                    .zIndex(2)

                VStack(spacing: 14) {
                    Text("有什么可以帮你？")
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(.primary)

                    if let group = currentGroup {
                        projectContextPill(group: group)
                    } else if let errorMessage = list.errorMessage {
                        LoadFailureView(message: errorMessage) {
                            Task { await reload() }
                        }
                        .padding(.horizontal, 24)
                    }

                    if let actionErrorMessage {
                        Text(actionErrorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                    }
                }
                .opacity(isLaunchRevealed ? 1 : 0)
                .scaleEffect(isLaunchRevealed ? 1 : 0.78)
                .offset(y: isLaunchRevealed ? 0 : -36)
                .blur(radius: isLaunchRevealed ? 0 : 5)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .onTapGesture {
                if composerMenu != nil {
                    composerMenu = nil
                }
                dismissKeyboard()
            }

            Spacer(minLength: 24)

            // Quiet starter chips: only shown when input is empty and menu is closed
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && composerMenu == nil {
                starterChipsStrip
                    .padding(.bottom, 10)
                    .opacity(isLaunchRevealed ? 1 : 0)
                    .scaleEffect(isLaunchRevealed ? 1 : 0.82)
                    .offset(y: isLaunchRevealed ? 0 : -150)
                    .blur(radius: isLaunchRevealed ? 0 : 5)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            landingPromptBar
                .opacity(isLaunchRevealed ? 1 : 0)
                .scaleEffect(isLaunchRevealed ? 1 : 0.85)
                .offset(y: isLaunchRevealed ? 0 : -195)
                .blur(radius: isLaunchRevealed ? 0 : 6)
        }
        .allowsHitTesting(isLaunchRevealed)
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
        .animation(.smooth(duration: 0.18), value: draft.isEmpty)
    }

    private var landingTopBar: some View {
        HStack {
            Button {
                dismissKeyboard()
                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                    isSidebarOpen.toggle()
                }
            } label: {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 16.5, weight: .medium))
                    .foregroundStyle(.primary)
                    .frame(width: 36, height: 36)
                    .background(
                        Circle()
                            .fill(Color(.secondarySystemGroupedBackground))
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("打开侧边栏")

            Spacer()

            HStack(spacing: 5) {
                Circle()
                    .fill(isConnected ? Color.green : Color.orange)
                    .frame(width: 6, height: 6)
                Text(isConnected ? "已连接" : "连接中")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            // Symmetric spacer to keep the status centered without adding extra buttons
            Color.clear
                .frame(width: 36, height: 36)
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 4)
    }

    private func projectContextPill(group: ProjectGroup) -> some View {
        Button {
            showProjectPickerSheet = true
        } label: {
            HStack(spacing: 7) {
                Image(systemName: group.isHome ? "house" : "folder")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(.secondary)

                Text(group.name)
                    .font(.system(size: 13.5, weight: .medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                if group.isGit {
                    Text("·")
                        .foregroundStyle(.tertiary)
                    HStack(spacing: 2.5) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 10, weight: .medium))
                        Text("main")
                            .font(.system(size: 12.5))
                    }
                    .foregroundStyle(.secondary)
                }

                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 2)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(
                Capsule(style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.07), lineWidth: 0.6)
            )
        }
        .buttonStyle(.plain)
    }

    private var starterChipsStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggestions) { item in
                    Button {
                        withAnimation(.smooth(duration: 0.16)) {
                            draft = item.prompt
                        }
                    } label: {
                        Text(item.label)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 7.5)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(Color(.secondarySystemGroupedBackground))
                            )
                            .overlay(
                                Capsule(style: .continuous)
                                    .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.6)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 14)
        }
    }

    // MARK: - Slide-Out Sidebar Drawer (Recent Conversations + Project Files)

    private var sidebarDrawer: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Sidebar top bar: segmented switcher + New Chat button
            HStack(spacing: 8) {
                HStack(spacing: 3) {
                    ForEach(SidebarSectionTab.allCases) { tab in
                        let selected = sidebarTab == tab
                        Button {
                            withAnimation(.smooth(duration: 0.18)) {
                                sidebarTab = tab
                            }
                        } label: {
                            Text(tab.rawValue)
                                .font(.system(size: 13, weight: selected ? .semibold : .medium))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(
                                    Capsule(style: .continuous)
                                        .fill(selected ? Color(.systemBackground) : Color.clear)
                                        .shadow(color: .black.opacity(selected ? 0.06 : 0), radius: 2, x: 0, y: 1)
                                )
                                .foregroundStyle(selected ? .primary : .secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(3)
                .background(
                    Capsule(style: .continuous)
                        .fill(Color(.tertiarySystemFill))
                )

                Spacer()

                Button {
                    withAnimation(.spring(response: 0.26, dampingFraction: 0.86)) {
                        activeConversation = nil
                        isSidebarOpen = false
                    }
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 32, height: 32)
                        .background(
                            Circle()
                                .fill(Color(.tertiarySystemFill))
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("新对话")
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 10)

            // Search box
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(.secondary)
                TextField(
                    sidebarTab == .conversations ? "搜索对话…" : "搜索项目…",
                    text: $sidebarSearchQuery
                )
                .font(.system(size: 13.5))
                .textFieldStyle(.plain)
                if !sidebarSearchQuery.isEmpty {
                    Button {
                        sidebarSearchQuery = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7.5)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(.tertiarySystemFill))
            )
            .padding(.horizontal, 14)
            .padding(.bottom, 10)

            Divider().opacity(0.45)

            ScrollView {
                switch sidebarTab {
                case .conversations:
                    sidebarConversationsContent
                        .padding(.vertical, 10)
                case .files:
                    sidebarFilesContent
                        .padding(.vertical, 10)
                }
            }
            .refreshable {
                await reload()
            }

            Divider().opacity(0.45)

            HStack(spacing: 4) {
                sidebarQuickNavButton(title: "新工作台", icon: "sparkles") {
                    withAnimation(.spring(response: 0.26, dampingFraction: 0.86)) {
                        activeConversation = nil
                        isSidebarOpen = false
                    }
                }
                sidebarQuickNavButton(title: "看板", icon: "square.grid.2x2") {
                    isSidebarOpen = false
                    onSelectTab?(.board)
                }
                sidebarQuickNavButton(title: "协作空间", icon: "person.2") {
                    isSidebarOpen = false
                    onSelectTab?(.space)
                }
                sidebarQuickNavButton(title: "设置", icon: "gearshape") {
                    isSidebarOpen = false
                    onSelectTab?(.settings)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
        }
        .frame(width: 304)
        .frame(maxHeight: .infinity)
        .background(
            Color(.secondarySystemGroupedBackground)
                .ignoresSafeArea()
        )
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(Color.primary.opacity(0.07))
                .frame(width: 0.5)
                .ignoresSafeArea()
        }
        .shadow(color: .black.opacity(0.18), radius: 18, x: 5, y: 0)
    }

    private func sidebarQuickNavButton(
        title: String,
        icon: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 14.5, weight: .medium))
                    .frame(height: 18)
                Text(title)
                    .font(.system(size: 10.5, weight: .medium))
                    .lineLimit(1)
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(.tertiarySystemFill).opacity(0.65))
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Sidebar Tab 1: 最近对话

    private var sidebarConversationsContent: some View {
        let q = sidebarSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let nonEmptyGroups = groups.filter { !$0.conversations.isEmpty }

        return VStack(alignment: .leading, spacing: 14) {
            if nonEmptyGroups.isEmpty {
                Text("暂无对话记录")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 32)
            } else {
                ForEach(nonEmptyGroups) { group in
                    let filteredConvs = group.conversations.filter { item in
                        guard !q.isEmpty else { return true }
                        let title = (item.title ?? "未命名对话").lowercased()
                        let model = (item.model ?? "").lowercased()
                        return title.contains(q) || model.contains(q) || group.name.lowercased().contains(q)
                    }

                    if !filteredConvs.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(group.name)
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 16)

                            VStack(spacing: 2) {
                                ForEach(filteredConvs) { item in
                                    sidebarConversationRow(item)
                                }
                            }
                            .padding(.horizontal, 8)
                        }
                    }
                }
            }
        }
    }

    private func sidebarConversationRow(_ item: ConversationListItem) -> some View {
        let isCurrent = activeConversation?.id == item.id
        return Button {
            withAnimation(.spring(response: 0.26, dampingFraction: 0.86)) {
                activeConversation = item
                isSidebarOpen = false
            }
        } label: {
            HStack(alignment: .center, spacing: 9) {
                AgentIconView(agent: item.agent_id, size: 14)
                    .frame(width: 24, height: 24)

                Text(item.title ?? "未命名对话")
                    .font(.system(size: 13.5, weight: isCurrent ? .semibold : .regular))
                    .foregroundStyle(isCurrent ? Color.accentColor : Color.primary)
                    .lineLimit(1)

                Spacer(minLength: 4)

                if let date = item.updatedAt {
                    Text(relativeChinese(date))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tertiary)
                        .layoutPriority(1)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(isCurrent ? Color.accentColor.opacity(0.12) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                archiveSingleConversation(item)
            } label: {
                Label("归档对话", systemImage: "archivebox")
            }
            Button(role: .destructive) {
                deleteSingleConversation(item)
            } label: {
                Label("删除对话", systemImage: "trash")
            }
        }
    }

    // MARK: Sidebar Tab 2: 项目文件

    private var sidebarFilesContent: some View {
        let q = sidebarSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filteredGroups = groups.filter { group in
            guard group.id != "other" else { return false }
            guard !q.isEmpty else { return true }
            return group.name.lowercased().contains(q) || group.rootPath.lowercased().contains(q)
        }

        return VStack(alignment: .leading, spacing: 6) {
            ForEach(filteredGroups) { group in
                let ws = workspaceID(for: group)
                let isExpanded = expandedFileProjectIDs.contains(group.id)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Button {
                            guard let ws else { return }
                            withAnimation(.smooth(duration: 0.18)) {
                                if isExpanded {
                                    expandedFileProjectIDs.remove(group.id)
                                } else {
                                    expandedFileProjectIDs.insert(group.id)
                                    loadSidebarWorkspaceEntries(workspaceID: ws)
                                }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                    .font(.system(size: 10.5, weight: .semibold))
                                    .foregroundStyle(.tertiary)
                                    .frame(width: 12)

                                Image(systemName: "folder")
                                    .font(.system(size: 13.5))
                                    .foregroundStyle(.secondary)

                                Text(group.name)
                                    .font(.system(size: 13.5, weight: .medium))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)

                                Spacer(minLength: 4)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if let ws {
                            Button {
                                isSidebarOpen = false
                                activeFileBrowserWorkspace = WorkspaceSheetTarget(
                                    workspaceID: ws,
                                    title: group.name
                                )
                            } label: {
                                Text("浏览")
                                    .font(.system(size: 11.5, weight: .medium))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3.5)
                                    .background(
                                        Capsule(style: .continuous)
                                            .fill(Color(.tertiarySystemFill))
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)

                    if isExpanded, let ws {
                        if loadingWorkspaceIDs.contains(ws) {
                            HStack(spacing: 8) {
                                ProgressView().controlSize(.small)
                                Text("读取中…")
                                    .font(.system(size: 11.5))
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.leading, 30)
                            .padding(.vertical, 4)
                        } else if let entries = projectEntriesByWorkspace[ws] {
                            VStack(alignment: .leading, spacing: 1) {
                                ForEach(entries.prefix(25), id: \.path) { entry in
                                    Button {
                                        isSidebarOpen = false
                                        if entry.directory {
                                            activeFileBrowserWorkspace = WorkspaceSheetTarget(
                                                workspaceID: ws,
                                                title: group.name
                                            )
                                        } else {
                                            previewFileTarget = FilePreviewSheetTarget(
                                                workspaceID: ws,
                                                path: entry.path
                                            )
                                        }
                                    } label: {
                                        HStack(spacing: 7) {
                                            Image(
                                                systemName: entry.directory
                                                    ? "folder"
                                                    : FileGlyph.symbol(for: entry.name)
                                            )
                                            .font(.system(size: 11.5))
                                            .foregroundStyle(.secondary)
                                            .frame(width: 15)

                                            Text(entry.name)
                                                .font(.system(size: 12.5))
                                                .foregroundStyle(.primary)
                                                .lineLimit(1)

                                            Spacer()
                                        }
                                        .padding(.leading, 28)
                                        .padding(.trailing, 10)
                                        .padding(.vertical, 5)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 8)
            }
        }
    }

    private func loadSidebarWorkspaceEntries(workspaceID: String) {
        guard projectEntriesByWorkspace[workspaceID] == nil,
              !loadingWorkspaceIDs.contains(workspaceID)
        else { return }
        loadingWorkspaceIDs.insert(workspaceID)
        Task {
            defer { loadingWorkspaceIDs.remove(workspaceID) }
            if let tree = try? await client.workspaceTree(workspaceID: workspaceID, path: "") {
                let sorted = tree.entries.sorted {
                    if $0.directory != $1.directory { return $0.directory && !$1.directory }
                    return $0.name.localizedStandardCompare($1.name) == .orderedAscending
                }
                projectEntriesByWorkspace[workspaceID] = sorted
            }
        }
    }

    // MARK: - Landing PromptBar Integration

    private var landingModelChoices: [PromptChoice] {
        guard let agent = currentAgent else { return [] }
        let options = agent.modelOptions
        let choices = options.flatMap { option in
            option.choices.map { choice in
                let id = "\(agent.id)|\(option.key)|\(choice.id)"
                let isDefaultSelected = selectedModelChoiceID == nil && choice.value == option.value
                return PromptChoice(
                    id: id,
                    title: choice.label,
                    tag: choice.description,
                    agentID: agent.id,
                    selected: selectedModelChoiceID == id || isDefaultSelected
                )
            }
        }
        if choices.isEmpty {
            return usableAgents.map { item in
                PromptChoice(
                    id: "agent|\(item.id)",
                    title: AgentBrand.displayName(item.id, hostName: item.displayName),
                    agentID: item.id,
                    selected: item.id == agent.id
                )
            }
        }
        return choices
    }

    private var landingOtherModelGroups: [PromptGroup] {
        let currentID = currentAgent?.id
        return usableAgents.filter { $0.id != currentID }.map { agent in
            let modelItems = agent.modelOptions.flatMap(\.choices)
            let choices: [PromptChoice] = modelItems.isEmpty
                ? [
                    PromptChoice(
                        id: "switch-agent|\(agent.id)",
                        title: AgentBrand.displayName(agent.id, hostName: agent.displayName),
                        agentID: agent.id,
                        selected: false,
                        enabled: true
                    ),
                ]
                : modelItems.map { choice in
                    PromptChoice(
                        id: "switch-agent|\(agent.id)|\(choice.id)",
                        title: choice.label,
                        tag: choice.description,
                        agentID: agent.id,
                        selected: false,
                        enabled: true
                    )
                }
            return PromptGroup(
                title: AgentBrand.displayName(agent.id, hostName: agent.displayName),
                agentID: agent.id,
                choices: choices
            )
        }
    }

    private var landingCurrentModelLabel: String? {
        if let selectedID = selectedModelChoiceID,
           let match = landingModelChoices.first(where: { $0.id == selectedID }) {
            return match.title
        }
        if let firstSelected = landingModelChoices.first(where: \.selected) {
            return firstSelected.title
        }
        if let agent = currentAgent {
            return AgentBrand.displayName(agent.id, hostName: agent.displayName)
        }
        return "Claude Code"
    }

    private var landingAccessChoices: [PromptChoice] {
        if let agent = currentAgent, !agent.modes.isEmpty {
            let activeID = selectedAccessModeID ?? agent.currentModeID ?? agent.modes.first?.id
            return agent.modes.map { mode in
                PromptChoice(
                    id: mode.id,
                    title: mode.label,
                    detail: mode.description,
                    icon: "shield",
                    selected: mode.id == activeID
                )
            }
        }
        let activeID = selectedAccessModeID ?? "auto"
        return [
            PromptChoice(
                id: "manual",
                title: "Manual",
                detail: "Always ask before making changes",
                icon: "shield",
                selected: activeID == "manual"
            ),
            PromptChoice(
                id: "accept_edits",
                title: "Accept edits",
                detail: "Automatically accept all file edits",
                icon: "shield",
                selected: activeID == "accept_edits"
            ),
            PromptChoice(
                id: "plan",
                title: "Plan",
                detail: "Create a plan before making changes",
                icon: "shield",
                selected: activeID == "plan"
            ),
            PromptChoice(
                id: "auto",
                title: "Auto",
                detail: "Agent handles permission decisions",
                icon: "shield",
                selected: activeID == "auto"
            ),
            PromptChoice(
                id: "bypass",
                title: "Bypass permissions",
                detail: "Accepts all permissions",
                icon: "shield",
                selected: activeID == "bypass"
            ),
        ]
    }

    private var landingEffortOption: ConfigOption? {
        currentAgent?.otherOptions.first {
            $0.category == "thought_level"
                || $0.key.localizedCaseInsensitiveContains("effort")
                || $0.key.localizedCaseInsensitiveContains("reasoning")
        }
    }

    private var landingEffort: PromptEffort? {
        if let option = landingEffortOption, option.choices.count > 1 {
            let defaultIdx = option.choices.firstIndex(where: { $0.value == option.value }) ?? 0
            let idx = min(max(selectedEffortIndex ?? defaultIdx, 0), option.choices.count - 1)
            return PromptEffort(levels: option.choices.map(\.label), index: idx)
        }
        let levels = ["Low", "Medium", "High"]
        let idx = min(max(selectedEffortIndex ?? 1, 0), levels.count - 1)
        return PromptEffort(levels: levels, index: idx)
    }

    private var landingPromptBar: some View {
        PromptBar(
            draft: $draft,
            menu: $composerMenu,
            isRunning: isCreatingAndSending,
            busy: isCreatingAndSending,
            hasAlert: false,
            modelName: landingCurrentModelLabel,
            agentID: currentAgent?.id ?? "claude_code",
            modelChoices: landingModelChoices,
            otherModelGroups: landingOtherModelGroups,
            otherAgentNote: nil,
            accessChoices: landingAccessChoices,
            extraChoices: [],
            effort: landingEffort,
            openFiles: {
                if let ws = currentWorkspaceID {
                    activeFileBrowserWorkspace = WorkspaceSheetTarget(
                        workspaceID: ws,
                        title: currentGroup?.name ?? "文件"
                    )
                }
            },
            send: {
                startNewConversation(with: draft)
            },
            stop: {},
            pickModel: { id in
                if id.hasPrefix("switch-agent|") {
                    let parts = id.split(separator: "|").map(String.init)
                    if parts.count >= 2 {
                        selectedAgentID = parts[1]
                        selectedModelChoiceID = nil
                    }
                } else if id.hasPrefix("agent|") {
                    selectedAgentID = String(id.dropFirst("agent|".count))
                    selectedModelChoiceID = nil
                } else {
                    selectedModelChoiceID = id
                }
                composerMenu = nil
            },
            pickAccess: { id in
                selectedAccessModeID = id
                composerMenu = nil
            },
            pickExtra: { _ in },
            setEffort: { index in
                selectedEffortIndex = index
            }
        )
    }

    private func startNewConversation(with text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isCreatingAndSending else { return }
        guard let workspaceID = currentWorkspaceID else {
            actionErrorMessage = "当前没有可用项目工作区，请先在桌面端导入项目"
            return
        }
        let agentID = currentAgent?.id ?? visibleConversations.first?.agent_id ?? "claude_code"

        isCreatingAndSending = true
        actionErrorMessage = nil
        dismissKeyboard()

        Task {
            defer { isCreatingAndSending = false }
            do {
                let created = try await client.createConversation(
                    workspaceID: workspaceID,
                    agentID: agentID
                )
                try await client.sendMessage(
                    conversationID: created.id,
                    workspaceID: workspaceID,
                    agentID: agentID,
                    text: trimmed
                )
                draft = ""
                withAnimation(.smooth(duration: 0.22)) {
                    activeConversation = created
                }
                await reload()
            } catch {
                actionErrorMessage = describeHostFailure(error)
            }
        }
    }

    // MARK: - Project Picker Sheet

    private var projectPickerSheet: some View {
        NavigationStack {
            List {
                ForEach(groups.filter { $0.id != "other" }) { group in
                    let isSelected = currentGroup?.id == group.id
                    Button {
                        selectedProjectID = group.id
                        showProjectPickerSheet = false
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: group.isHome ? "house" : "folder")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(.secondary)
                                .frame(width: 28)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(group.name)
                                    .font(.system(size: 15, weight: isSelected ? .semibold : .regular))
                                    .foregroundStyle(.primary)
                                if !group.rootPath.isEmpty {
                                    Text(group.rootPath)
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }

                            Spacer()

                            if isSelected {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                        .padding(.vertical, 3)
                    }
                    .buttonStyle(.plain)
                }
            }
            .navigationTitle("选择项目")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { showProjectPickerSheet = false }
                }
            }
        }
    }

    // MARK: - Helpers & Data Loading

    private func consumePendingNavigationIfNeeded() {
        guard let target = attentionCenter?.pendingNavigationConversation else { return }
        attentionCenter?.pendingNavigationConversation = nil
        isSidebarOpen = false
        withAnimation(.smooth(duration: 0.2)) {
            activeConversation = target
        }
    }

    private func archiveSingleConversation(_ item: ConversationListItem) {
        let id = item.id
        withAnimation {
            _ = removedConversationIDs.insert(id)
            if activeConversation?.id == id {
                activeConversation = nil
            }
        }
        Task {
            do {
                try await client.archiveConversation(conversationID: id)
                actionErrorMessage = nil
                await reload()
            } catch {
                withAnimation { _ = removedConversationIDs.remove(id) }
                actionErrorMessage = describeHostFailure(error)
            }
        }
    }

    private func deleteSingleConversation(_ item: ConversationListItem) {
        let id = item.id
        withAnimation {
            _ = removedConversationIDs.insert(id)
            if activeConversation?.id == id {
                activeConversation = nil
            }
        }
        Task {
            do {
                try await client.deleteConversation(conversationID: id)
                actionErrorMessage = nil
                await reload()
            } catch {
                withAnimation { _ = removedConversationIDs.remove(id) }
                actionErrorMessage = describeHostFailure(error)
            }
        }
    }

    private func reload() async {
        async let projectsTask = try? client.projects()
        async let agentsTask = try? client.agentCatalog()
        let (fetchedProjects, fetchedAgents) = await (projectsTask, agentsTask)
        if let fetchedProjects { projects = fetchedProjects }
        if let fetchedAgents, !fetchedAgents.isEmpty { agents = fetchedAgents }

        await list.load {
            let fetched = try await client.call(
                "conversation_list_recent",
                args: ["sinceDays": 30, "limit": 100],
                as: [ConversationListItem].self
            )
            let activeIDs = Set(fetched.map(\.id))
            removedConversationIDs.formIntersection(activeIDs)
            if let current = activeConversation,
               let updated = fetched.first(where: { $0.id == current.id }) {
                activeConversation = updated
            }
            return fetched
        }
    }
}

private struct WorkspaceSheetTarget: Identifiable {
    let workspaceID: String
    let title: String
    var id: String { workspaceID }
}

private struct FilePreviewSheetTarget: Identifiable {
    let workspaceID: String
    let path: String
    var id: String { "\(workspaceID):\(path)" }
}

extension ConversationListItem: Hashable {
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

private func relativeChinese(_ date: Date) -> String {
    date.formatted(.relative(presentation: .named).locale(Locale(identifier: "zh_Hans_CN")))
}
