import CompanionCore
import SwiftUI

struct CollaborationSpaceView: View {
    let client: HostClient

    @State private var projects: [ProjectSummary] = []
    @State private var selectedProjectID: String = ""
    @State private var sidebarItems: [CollabSidebarItem] = []
    @State private var contactGroups: [CollabContactGroup] = []
    @State private var spaces: [CollabSpaceSummary] = []
    @State private var loading = true
    @State private var errorMessage: String?
    @State private var searchQuery = ""
    @State private var filterKind: FilterKind = .all
    @State private var collapsedGroupIDs: Set<String> = []
    @State private var path = NavigationPath()

    // Modals & Alerts
    @State private var showingCreateAssistant = false
    @State private var showingCreateGroup = false
    @State private var showingCreateContactGroup = false
    @State private var showingRolesAndTeams = false
    @State private var newGroupName = ""
    @State private var newContactGroupName = ""
    @State private var renamingGroup: CollabContactGroup?
    @State private var renameGroupDraft = ""

    enum FilterKind: String, CaseIterable, Identifiable {
        case all = "全部"
        case group = "群组"
        case assistant = "助手"
        var id: String { rawValue }
    }

    private var orderedProjects: [ProjectGroup] {
        ProjectGroup.make(conversations: [], projects: projects)
    }

    private var activeProject: ProjectGroup? {
        orderedProjects.first { $0.id == selectedProjectID } ?? orderedProjects.first
    }

    private var activeWorkspaceID: String? {
        activeProject?.workspaceIds.first
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("协作空间")
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        if !orderedProjects.isEmpty {
                            Menu {
                                ForEach(orderedProjects) { project in
                                    Button {
                                        selectedProjectID = project.id
                                        Task { await reload() }
                                    } label: {
                                        HStack {
                                            Text(String(repeating: "  ", count: project.depth) + project.name)
                                            if project.id == activeProject?.id {
                                                Image(systemName: "checkmark")
                                            }
                                        }
                                    }
                                }
                            } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: activeProject?.isGit == true ? "arrow.triangle.branch" : "folder")
                                        .font(.system(size: 12, weight: .medium))
                                    Text(activeProject?.name ?? "选择项目")
                                        .font(.system(size: 13, weight: .medium))
                                    Image(systemName: "chevron.down")
                                        .font(.system(size: 10, weight: .semibold))
                                }
                            }
                        }
                    }

                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button {
                                showingCreateAssistant = true
                            } label: {
                                Label("新建助手", systemImage: "person.badge.plus")
                            }
                            Button {
                                newGroupName = ""
                                showingCreateGroup = true
                            } label: {
                                Label("新建群组", systemImage: "person.3")
                            }
                            Button {
                                newContactGroupName = ""
                                showingCreateContactGroup = true
                            } label: {
                                Label("新建联系人分组", systemImage: "folder.badge.plus")
                            }
                            Divider()
                            Button {
                                showingRolesAndTeams = true
                            } label: {
                                Label("角色与团队管理", systemImage: "person.text.rectangle")
                            }
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("新建")
                        .disabled(activeWorkspaceID == nil)
                    }
                }
                .navigationDestination(for: CollabSidebarItem.self) { item in
                    if let workspaceID = activeWorkspaceID {
                        CollaborationChatView(
                            client: client,
                            workspaceID: workspaceID,
                            item: item,
                            allSidebarItems: sidebarItems,
                            contactGroups: contactGroups,
                            onChanged: { await reload() }
                        )
                    }
                }
                .navigationDestination(for: ConversationListItem.self) { conv in
                    ConversationDetailView(client: client, conversation: conv)
                }
        }
        .sheet(isPresented: $showingCreateAssistant) {
            if let workspaceID = activeWorkspaceID {
                CreateAssistantSheet(
                    client: client,
                    workspaceID: workspaceID,
                    targetSpaceID: nil,
                    onCreated: { await reload() }
                )
            }
        }
        .sheet(isPresented: $showingRolesAndTeams) {
            RolesAndTeamsSheet(client: client)
        }
        .alert("新建群组", isPresented: $showingCreateGroup) {
            TextField("群组名称", text: $newGroupName)
            Button("取消", role: .cancel) {}
            Button("创建") { createGroup() }
        }
        .alert("新建联系人分组", isPresented: $showingCreateContactGroup) {
            TextField("分组名称", text: $newContactGroupName)
            Button("取消", role: .cancel) {}
            Button("创建") { createContactGroup() }
        }
        .alert(
            "重命名分组",
            isPresented: Binding(
                get: { renamingGroup != nil },
                set: { if !$0 { renamingGroup = nil } }
            )
        ) {
            TextField("分组名称", text: $renameGroupDraft)
            Button("取消", role: .cancel) { renamingGroup = nil }
            Button("保存") {
                if let group = renamingGroup {
                    renameContactGroup(group, to: renameGroupDraft)
                }
                renamingGroup = nil
            }
        }
        .task {
            while !Task.isCancelled {
                await reload()
                try? await Task.sleep(for: .seconds(errorMessage == nil ? 8 : 4))
            }
        }
    }

    // MARK: - Filtering & Grouping

    private var filteredItems: [CollabSidebarItem] {
        sidebarItems.filter { item in
            switch filterKind {
            case .all: return true
            case .group: return item.isGroup
            case .assistant: return item.isDirect
            }
        }
    }

    private var supervisorItem: CollabSidebarItem? {
        let directs = filteredItems.filter(\.isDirect)
        if let explicit = directs.first(where: { $0.member?.isSupervisor == true }) {
            return explicit
        }
        return nil
    }

    private var nonSupervisorItems: [CollabSidebarItem] {
        guard let sup = supervisorItem else { return filteredItems }
        return filteredItems.filter { $0.id != sup.id }
    }

    private var searchResults: [SearchResultItem] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        return sidebarItems.compactMap { item in
            let matchesName = item.displayName.lowercased().contains(q)
            let matchesPreview = item.lastMessage?.preview?.lowercased().contains(q) ?? false
            guard matchesName || matchesPreview else { return nil }
            return SearchResultItem(
                id: item.id,
                title: item.displayName,
                subtitle: item.lastMessage?.preview ?? (item.isGroup ? "群组" : "私聊"),
                icon: item.isGroup ? "person.3.fill" : "person.crop.circle.fill",
                action: { path.append(item) }
            )
        }
    }

    @ViewBuilder
    private var content: some View {
        if loading && sidebarItems.isEmpty && errorMessage == nil {
            ProgressView()
        } else if let errorMessage, sidebarItems.isEmpty {
            LoadFailureView(message: errorMessage) { Task { await reload() } }
        } else {
            List {
                Section {
                    VStack(spacing: 10) {
                        SearchListCard(
                            query: $searchQuery,
                            placeholder: "搜索群组或助手…",
                            results: searchResults
                        )
                        Picker("筛选", selection: $filterKind) {
                            ForEach(FilterKind.allCases) { kind in
                                Text(kind.rawValue).tag(kind)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                if let supervisor = supervisorItem {
                    Section("主管") {
                        NavigationLink(value: supervisor) {
                            CollabContactRow(item: supervisor, isSupervisorSlot: true)
                        }
                        .modifier(rowActions(for: supervisor))
                    }
                }

                if nonSupervisorItems.isEmpty && supervisorItem == nil {
                    Section {
                        ContentUnavailableView {
                            Label("还没有群组或助手", systemImage: "person.2")
                        } description: {
                            Text("点击右上角 + 创建助手或群组，开启多智能体协作")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 24)
                    }
                    .listRowBackground(Color.clear)
                } else if !contactGroups.isEmpty {
                    ForEach(contactGroups) { group in
                        let groupEntries = nonSupervisorItems.filter { $0.groupId == group.groupId }
                        let isCollapsed = collapsedGroupIDs.contains(group.groupId)
                        Section {
                            if !isCollapsed {
                                ForEach(groupEntries) { item in
                                    NavigationLink(value: item) {
                                        CollabContactRow(item: item, isSupervisorSlot: false)
                                    }
                                    .modifier(rowActions(for: item))
                                }
                            }
                        } header: {
                            HStack {
                                Button {
                                    withAnimation {
                                        if isCollapsed {
                                            collapsedGroupIDs.remove(group.groupId)
                                        } else {
                                            collapsedGroupIDs.insert(group.groupId)
                                        }
                                    }
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                                            .font(.system(size: 11, weight: .semibold))
                                        Text("\(group.name) (\(groupEntries.count))")
                                    }
                                    .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                                Spacer()
                                Menu {
                                    Button {
                                        renameGroupDraft = group.name
                                        renamingGroup = group
                                    } label: {
                                        Label("重命名分组", systemImage: "pencil")
                                    }
                                    Button(role: .destructive) {
                                        deleteContactGroup(group)
                                    } label: {
                                        Label("删除分组", systemImage: "trash")
                                    }
                                } label: {
                                    Image(systemName: "ellipsis")
                                        .font(.system(size: 12))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }

                    let knownGroupIDs = Set(contactGroups.map(\.groupId))
                    let ungrouped = nonSupervisorItems.filter { item in
                        guard let gid = item.groupId, !gid.isEmpty else { return true }
                        return !knownGroupIDs.contains(gid)
                    }
                    if !ungrouped.isEmpty {
                        Section("未分组 (\(ungrouped.count))") {
                            ForEach(ungrouped) { item in
                                NavigationLink(value: item) {
                                    CollabContactRow(item: item, isSupervisorSlot: false)
                                }
                                .modifier(rowActions(for: item))
                            }
                        }
                    }
                } else {
                    let groupItems = nonSupervisorItems.filter(\.isGroup)
                    let directItems = nonSupervisorItems.filter(\.isDirect)

                    if !groupItems.isEmpty {
                        Section("群组 (\(groupItems.count))") {
                            ForEach(groupItems) { item in
                                NavigationLink(value: item) {
                                    CollabContactRow(item: item, isSupervisorSlot: false)
                                }
                                .modifier(rowActions(for: item))
                            }
                        }
                    }

                    if !directItems.isEmpty {
                        Section("助手 (\(directItems.count))") {
                            ForEach(directItems) { item in
                                NavigationLink(value: item) {
                                    CollabContactRow(item: item, isSupervisorSlot: false)
                                }
                                .modifier(rowActions(for: item))
                            }
                        }
                    }
                }
            }
            .listSectionSpacing(10)
            .scrollDismissesKeyboard(.immediately)
            .refreshable { await reload() }
        }
    }

    private func rowActions(for item: CollabSidebarItem) -> CollabRowActionsModifier {
        CollabRowActionsModifier(
            item: item,
            contactGroups: contactGroups,
            onToggleRead: { toggleRead(item) },
            onMoveToGroup: { setThreadGroup(item, groupID: $0) },
            onSetTagColor: { setTagColor(item, color: $0) },
            onToggleSupervisor: { toggleSupervisor(item) },
            onDelete: { deleteItem(item) }
        )
    }

    // MARK: - Actions & Loading

    private func reload() async {
        do {
            let loadedProjects = try await client.projects()
            projects = loadedProjects
            if selectedProjectID.isEmpty || !loadedProjects.contains(where: { $0.id == selectedProjectID }) {
                selectedProjectID = ProjectGroup.make(conversations: [], projects: loadedProjects).first?.id ?? ""
            }
            guard let workspaceID = activeWorkspaceID else {
                loading = false
                return
            }
            async let sidebarTask = client.collabSidebar(workspaceID: workspaceID)
            async let groupsTask = client.collabContactGroups(workspaceID: workspaceID)
            async let spacesTask = client.collabSpaces(workspaceID: workspaceID)
            sidebarItems = try await sidebarTask
            contactGroups = (try? await groupsTask) ?? []
            spaces = (try? await spacesTask) ?? []
            errorMessage = nil
        } catch {
            errorMessage = describeHostFailure(error)
        }
        loading = false
    }

    private func createGroup() {
        let trimmed = newGroupName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let workspaceID = activeWorkspaceID else { return }
        Task {
            _ = try? await client.collabCreateSpace(workspaceID: workspaceID, name: trimmed)
            await reload()
        }
    }

    private func createContactGroup() {
        let trimmed = newContactGroupName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let workspaceID = activeWorkspaceID else { return }
        Task {
            try? await client.collaborationCommand("contactGroup.create", input: [
                "workspaceId": workspaceID,
                "name": trimmed,
            ])
            await reload()
        }
    }

    private func renameContactGroup(_ group: CollabContactGroup, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task {
            try? await client.collaborationCommand("contactGroup.rename", input: [
                "groupId": group.groupId,
                "name": trimmed,
            ])
            await reload()
        }
    }

    private func deleteContactGroup(_ group: CollabContactGroup) {
        Task {
            try? await client.collaborationCommand("contactGroup.delete", input: [
                "groupId": group.groupId,
            ])
            await reload()
        }
    }

    private func toggleRead(_ item: CollabSidebarItem) {
        Task {
            if item.unreadCount > 0 {
                try? await client.collabMarkRead(threadID: item.threadId, seq: item.lastMessage?.seq)
            } else {
                try? await client.collabMarkUnread(threadID: item.threadId)
            }
            await reload()
        }
    }

    private func setThreadGroup(_ item: CollabSidebarItem, groupID: String?) {
        Task {
            var input: [String: Any] = ["threadId": item.threadId]
            input["groupId"] = groupID ?? NSNull()
            try? await client.collaborationCommand("thread.setGroup", input: input)
            await reload()
        }
    }

    private func setTagColor(_ item: CollabSidebarItem, color: String) {
        Task {
            var input: [String: Any] = item.isDirect
                ? ["threadId": item.threadId]
                : ["spaceId": item.targetSpaceId]
            input["tagColor"] = color
            try? await client.collaborationCommand("thread.update", input: input)
            await reload()
        }
    }

    private func toggleSupervisor(_ item: CollabSidebarItem) {
        guard let workspaceID = activeWorkspaceID, let member = item.member else { return }
        let nextMemberID: Any = member.isSupervisor ? NSNull() : member.resolvedIdentityId
        Task {
            try? await client.collaborationCommand("member.setSupervisor", input: [
                "workspaceId": workspaceID,
                "memberId": nextMemberID,
            ])
            await reload()
        }
    }

    private func deleteItem(_ item: CollabSidebarItem) {
        guard let workspaceID = activeWorkspaceID else { return }
        withAnimation {
            sidebarItems.removeAll { $0.id == item.id }
        }
        Task {
            var input: [String: Any] = [
                "workspaceId": workspaceID,
                "operationId": UUID().uuidString.lowercased(),
            ]
            if item.isGroup {
                input["spaceIds"] = [item.targetSpaceId]
                input["memberTargets"] = []
            } else if let convID = item.member?.conversationId {
                input["spaceIds"] = []
                input["memberTargets"] = [[
                    "spaceId": "unassigned:\(workspaceID)",
                    "conversationId": convID,
                ]]
            }
            try? await client.collaborationCommand("space.batchDelete", input: input)
            await reload()
        }
    }
}

// MARK: - Contact Row & Swipe/Menu Modifier

private struct CollabRowActionsModifier: ViewModifier {
    let item: CollabSidebarItem
    let contactGroups: [CollabContactGroup]
    let onToggleRead: () -> Void
    let onMoveToGroup: (String?) -> Void
    let onSetTagColor: (String) -> Void
    let onToggleSupervisor: () -> Void
    let onDelete: () -> Void

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button(role: .destructive, action: onDelete) {
                    Label("删除", systemImage: "trash")
                }
                Button(action: onToggleRead) {
                    Label(
                        item.unreadCount > 0 ? "标为已读" : "标为未读",
                        systemImage: item.unreadCount > 0 ? "envelope.open" : "envelope.badge"
                    )
                }
                .tint(.indigo)
            }
            .contextMenu {
                Button(action: onToggleRead) {
                    Label(
                        item.unreadCount > 0 ? "标为已读" : "标为未读",
                        systemImage: item.unreadCount > 0 ? "envelope.open" : "envelope.badge"
                    )
                }

                if item.isDirect, let member = item.member {
                    Button(action: onToggleSupervisor) {
                        Label(
                            member.isSupervisor ? "取消主管身份" : "设为主管",
                            systemImage: member.isSupervisor ? "crown" : "crown.fill"
                        )
                    }
                }

                if item.isGroup {
                    Menu("群标签颜色") {
                        ForEach(CollabTagPalette.presets, id: \.id) { preset in
                            Button(preset.label) { onSetTagColor(preset.id) }
                        }
                        Divider()
                        Button("清除颜色") { onSetTagColor("") }
                    }
                }

                if !contactGroups.isEmpty {
                    Menu("移至分组") {
                        ForEach(contactGroups) { group in
                            Button {
                                onMoveToGroup(group.groupId)
                            } label: {
                                HStack {
                                    Text(group.name)
                                    if item.groupId == group.groupId {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                        Divider()
                        Button("未分组") { onMoveToGroup(nil) }
                    }
                }

                Divider()
                Button(role: .destructive, action: onDelete) {
                    Label(item.isGroup ? "删除群组" : "删除助手", systemImage: "trash")
                }
            }
    }
}

struct CollabContactRow: View {
    let item: CollabSidebarItem
    let isSupervisorSlot: Bool

    var body: some View {
        HStack(spacing: 12) {
            CollabAvatarView(item: item, size: 40)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(item.displayName)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    if isSupervisorSlot || item.member?.isSupervisor == true {
                        Text("主管")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.orange)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1.5)
                            .background(Capsule().fill(Color.orange.opacity(0.14)))
                    } else if item.isGroup, item.memberCount > 0 {
                        Text("(\(item.memberCount))")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    } else if let agent = item.member?.agent, !agent.isEmpty {
                        HStack(spacing: 3) {
                            AgentIconView(agent: agent, size: 11)
                            Text(AgentBrand.displayName(agent))
                        }
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.primary.opacity(0.06)))
                    }

                    Spacer(minLength: 4)

                    if let date = item.activityDate {
                        Text(date, format: .relative(presentation: .named))
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                }

                HStack(spacing: 8) {
                    Text(item.lastMessage?.preview ?? (item.isGroup ? "点击进入群聊" : "点击发起私聊"))
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    Spacer(minLength: 4)

                    if item.unreadCount > 0 {
                        Text("\(min(item.unreadCount, 99))")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .frame(minWidth: 18, minHeight: 18)
                            .background(Capsule().fill(Color.blue))
                    }
                }
            }
        }
        .padding(.vertical, 3)
    }
}

struct CollabAvatarView: View {
    let item: CollabSidebarItem
    let size: CGFloat

    var body: some View {
        if item.isGroup {
            let memberAvatars = item.membersPreview.map(\.botAvatar)
            CollabGroupAvatarView(
                avatars: memberAvatars.isEmpty
                    ? [CollabBotAvatarConfig.derive(seed: item.displayName)]
                    : memberAvatars,
                tagColorHex: item.tagColor,
                size: size
            )
        } else {
            let avatar = item.member?.botAvatar
                ?? CollabBotAvatarConfig.derive(seed: item.displayName)
            MemberBotAvatarView(
                config: avatar,
                size: size,
                isSupervisor: item.member?.isSupervisor == true
            )
        }
    }
}

enum CollabTagPalette {
    static let presets: [(id: String, label: String, color: Color)] = [
        ("amber", "琥珀", .orange),
        ("violet", "紫罗兰", .purple),
        ("rose", "玫瑰", .pink),
        ("cyan", "青色", .cyan),
    ]

    static func color(for raw: String?) -> Color? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        if let preset = presets.first(where: { $0.id == raw }) {
            return preset.color
        }
        if raw.hasPrefix("#") {
            let hex = String(raw.dropFirst())
            if hex.count == 6, let val = Int(hex, radix: 16) {
                return Color(
                    red: Double((val >> 16) & 0xFF) / 255.0,
                    green: Double((val >> 8) & 0xFF) / 255.0,
                    blue: Double(val & 0xFF) / 255.0
                )
            }
        }
        return nil
    }

    static func hashColor(_ name: String) -> Color {
        let palette: [Color] = [.blue, .indigo, .teal, .orange, .pink, .mint, .purple]
        let hash = abs(name.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) })
        return palette[hash % palette.count]
    }
}
