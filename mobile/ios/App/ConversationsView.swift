import CompanionCore
import SwiftUI

/// Conversations grouped by project: the root lists projects, a project lists only its own conversations.
struct ConversationsView: View {
    let client: HostClient
    @State private var list = RemoteList<ConversationListItem>()
    @State private var projects: [ProjectSummary]?
    @State private var path = NavigationPath()
    @State private var searchQuery = ""
    @State private var removedConversationIDs: Set<String> = []
    @State private var actionErrorMessage: String?

    private var isConnected: Bool {
        list.errorMessage == nil && list.items != nil
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("对话")
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        ConnectedDeviceBar(isConnected: isConnected)
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    if let actionErrorMessage {
                        Text(actionErrorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                    }
                }
                .navigationDestination(for: ProjectRoute.self) { route in
                    ProjectConversationsView(
                        client: client,
                        group: group(id: route.id),
                        projects: projects ?? [],
                        removedIDs: $removedConversationIDs,
                        onRefresh: { await reload() }
                    )
                }
                .navigationDestination(for: ConversationListItem.self) {
                    ConversationDetailView(client: client, conversation: $0)
                }
        }
        .task {
            while !Task.isCancelled {
                await reload()
                try? await Task.sleep(for: .seconds(list.errorMessage == nil ? 30 : 4))
            }
        }
    }

    private var visibleConversations: [ConversationListItem] {
        (list.items ?? []).filter { !removedConversationIDs.contains($0.id) }
    }

    private var groups: [ProjectGroup] {
        ProjectGroup.make(conversations: visibleConversations, projects: projects ?? [])
    }

    private var searchResults: [SearchResultItem] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        var items: [SearchResultItem] = []

        for group in groups where group.name.lowercased().contains(q) || group.rootPath.lowercased().contains(q) {
            items.append(
                SearchResultItem(
                    id: "project-\(group.id)",
                    title: group.name,
                    subtitle: group.rootPath.isEmpty ? "\(group.conversations.count) 个对话" : group.rootPath,
                    icon: group.isGit ? "arrow.triangle.branch" : "folder",
                    action: { path.append(ProjectRoute(id: group.id)) }
                )
            )
        }

        for conv in visibleConversations {
            let title = conv.title ?? "未命名对话"
            if title.lowercased().contains(q) || (conv.model?.lowercased().contains(q) ?? false) {
                items.append(
                    SearchResultItem(
                        id: "conv-\(conv.id)",
                        title: title,
                        subtitle: [AgentBrand.displayName(conv.agent_id), conv.model]
                            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                        icon: "bubble.left.and.bubble.right",
                        action: { path.append(conv) }
                    )
                )
            }
        }
        return items
    }

    private func group(id: String) -> ProjectGroup {
        groups.first { $0.id == id } ?? ProjectGroup(id: id, name: "", conversations: [])
    }

    @ViewBuilder
    private var content: some View {
        if list.items != nil {
            if let projects, !projects.isEmpty {
                List {
                    Section {
                        SearchListCard(
                            query: $searchQuery,
                            placeholder: "搜索项目或对话…",
                            results: searchResults
                        )
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    Section {
                        ForEach(groups) { group in
                            NavigationLink(value: ProjectRoute(id: group.id)) {
                                ProjectRow(group: group)
                            }
                            .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                if !group.conversations.isEmpty {
                                    Button(role: .destructive) {
                                        deleteGroupConversations(group)
                                    } label: {
                                        Label("删除", systemImage: "trash")
                                    }
                                    Button {
                                        archiveGroupConversations(group)
                                    } label: {
                                        Label("归档", systemImage: "archivebox")
                                    }
                                    .tint(.indigo)
                                }
                            }
                        }
                    }
                }
                .listSectionSpacing(8)
                .contentMargins(.top, 2, for: .scrollContent)
                .scrollDismissesKeyboard(.immediately)
                .refreshable { await reload() }
            } else if visibleConversations.isEmpty {
                ContentUnavailableView("最近没有对话", systemImage: "bubble.left.and.bubble.right")
            } else {
                List {
                    Section {
                        SearchListCard(
                            query: $searchQuery,
                            placeholder: "搜索对话…",
                            results: searchResults
                        )
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    Section {
                        ForEach(visibleConversations) { item in
                            NavigationLink(value: item) { ConversationRow(item: item) }
                                .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))
                                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                    Button(role: .destructive) {
                                        deleteSingleConversation(item)
                                    } label: {
                                        Label("删除", systemImage: "trash")
                                    }
                                    Button {
                                        archiveSingleConversation(item)
                                    } label: {
                                        Label("归档", systemImage: "archivebox")
                                    }
                                    .tint(.indigo)
                                }
                        }
                    }
                }
                .listSectionSpacing(8)
                .contentMargins(.top, 2, for: .scrollContent)
                .scrollDismissesKeyboard(.immediately)
                .refreshable { await reload() }
            }
        } else if let message = list.errorMessage {
            LoadFailureView(message: message) { Task { await reload() } }
        } else {
            ProgressView()
        }
    }

    private func archiveSingleConversation(_ item: ConversationListItem) {
        let id = item.id
        withAnimation { _ = removedConversationIDs.insert(id) }
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
        withAnimation { _ = removedConversationIDs.insert(id) }
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

    private func archiveGroupConversations(_ group: ProjectGroup) {
        let ids = group.conversations.map(\.id)
        guard !ids.isEmpty else { return }
        withAnimation { removedConversationIDs.formUnion(ids) }
        Task {
            do {
                for id in ids {
                    try await client.archiveConversation(conversationID: id)
                }
                actionErrorMessage = nil
                await reload()
            } catch {
                withAnimation { removedConversationIDs.subtract(ids) }
                actionErrorMessage = describeHostFailure(error)
            }
        }
    }

    private func deleteGroupConversations(_ group: ProjectGroup) {
        let ids = group.conversations.map(\.id)
        guard !ids.isEmpty else { return }
        withAnimation { removedConversationIDs.formUnion(ids) }
        Task {
            do {
                for id in ids {
                    try await client.deleteConversation(conversationID: id)
                }
                actionErrorMessage = nil
                await reload()
            } catch {
                withAnimation { removedConversationIDs.subtract(ids) }
                actionErrorMessage = describeHostFailure(error)
            }
        }
    }

    private func reload() async {
        projects = try? await client.projects()
        await list.load {
            let fetched = try await client.call(
                "conversation_list_recent",
                args: ["sinceDays": 30, "limit": 100],
                as: [ConversationListItem].self
            )
            let activeIDs = Set(fetched.map(\.id))
            removedConversationIDs.formIntersection(activeIDs)
            return fetched
        }
    }
}

private struct ProjectRoute: Hashable { let id: String }

extension ConversationListItem: Hashable {
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

private struct ProjectConversationsView: View {
    let client: HostClient
    let group: ProjectGroup
    let projects: [ProjectSummary]
    @Binding var removedIDs: Set<String>
    let onRefresh: () async -> Void

    @State private var agents: [CatalogAgent] = []
    @State private var created: ConversationListItem?
    @State private var errorMessage: String?

    var body: some View {
        List {
            ForEach(group.conversations) { item in
                NavigationLink(value: item) {
                    ConversationRow(item: item)
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    Button(role: .destructive) {
                        delete(item)
                    } label: {
                        Label("删除", systemImage: "trash")
                    }
                    Button {
                        archive(item)
                    } label: {
                        Label("归档", systemImage: "archivebox")
                    }
                    .tint(.indigo)
                }
            }
        }
        .listSectionSpacing(8)
        .contentMargins(.top, 4, for: .scrollContent)
        .overlay {
            if group.conversations.isEmpty {
                ContentUnavailableView("这个项目还没有对话", systemImage: "bubble.left.and.bubble.right")
            }
        }
        .navigationTitle(group.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let workspace = workspaceID, group.id != "other" {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        ForEach(agents.filter(\.usable)) { agent in
                            Button { create(agent: agent, workspace: workspace) } label: {
                                AgentMenuLabel(agentID: agent.id, hostName: agent.displayName)
                            }
                        }
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .accessibilityLabel("新对话")
                    .disabled(agents.allSatisfy { !$0.usable })
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
            }
        }
        .navigationDestination(item: $created) { ConversationDetailView(client: client, conversation: $0) }
        .refreshable { await onRefresh() }
        .task { agents = (try? await client.agentCatalog()) ?? [] }
    }

    /// New conversations go to the project's most recently used workspace.
    private var workspaceID: String? {
        group.conversations.first?.workspace_id
            ?? projects.first { $0.id == group.id }?.workspaceIds.first
    }

    private func archive(_ item: ConversationListItem) {
        let id = item.id
        withAnimation { _ = removedIDs.insert(id) }
        Task {
            do {
                try await client.archiveConversation(conversationID: id)
                errorMessage = nil
                await onRefresh()
            } catch {
                withAnimation { _ = removedIDs.remove(id) }
                errorMessage = describeHostFailure(error)
            }
        }
    }

    private func delete(_ item: ConversationListItem) {
        let id = item.id
        withAnimation { _ = removedIDs.insert(id) }
        Task {
            do {
                try await client.deleteConversation(conversationID: id)
                errorMessage = nil
                await onRefresh()
            } catch {
                withAnimation { _ = removedIDs.remove(id) }
                errorMessage = describeHostFailure(error)
            }
        }
    }

    private func create(agent: CatalogAgent, workspace: String) {
        Task {
            do {
                created = try await client.createConversation(workspaceID: workspace, agentID: agent.id)
                errorMessage = nil
            } catch {
                errorMessage = describeHostFailure(error)
            }
        }
    }
}

private struct ProjectRow: View {
    let group: ProjectGroup

    private var iconName: String {
        if group.id == "other" { return "tray" }
        return group.isGit ? "arrow.triangle.branch" : "folder"
    }

    /// Distinct agents used in this project, most recent first.
    private var recentAgents: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for conv in group.conversations {
            guard let id = conv.agent_id, let key = AgentBrand.normalizedKey(id),
                  seen.insert(key).inserted else { continue }
            result.append(id)
        }
        return result
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconName)
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(group.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    AgentIconStack(agents: recentAgents)
                }
                HStack(spacing: 6) {
                    Text("\(group.conversations.count) 个对话")
                    if let date = group.latest {
                        Text("·")
                        Text(relativeChinese(date))
                    }
                    Spacer(minLength: 4)
                    if !group.rootPath.isEmpty {
                        Text(group.rootPath)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 1)
        .padding(.leading, CGFloat(group.depth) * 14)
    }
}

/// Overlapping agent marks, capped at three with a "+N" overflow.
private struct AgentIconStack: View {
    let agents: [String]

    var body: some View {
        if !agents.isEmpty {
            HStack(spacing: -5) {
                ForEach(Array(agents.prefix(3)), id: \.self) { agent in
                    AgentIconView(agent: agent, size: 13)
                        .padding(2.5)
                        .background(Circle().fill(Color(.secondarySystemGroupedBackground)))
                        .overlay(Circle().stroke(Color(.separator).opacity(0.5), lineWidth: 0.5))
                }
                if agents.count > 3 {
                    Text("+\(agents.count - 3)")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 8)
                }
            }
        }
    }
}

private struct ConversationRow: View {
    let item: ConversationListItem

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            AgentIconView(agent: item.agent_id, size: 22)
                .padding(5)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color(.tertiarySystemFill))
                )
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title ?? "未命名对话")
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Text(item.model?.isEmpty == false ? item.model! : AgentBrand.displayName(item.agent_id))
                        .lineLimit(1)
                    Text("·")
                    Text("\(item.message_count) 条")
                    if let date = item.updatedAt {
                        Spacer(minLength: 4)
                        Text(relativeChinese(date))
                            .foregroundStyle(.tertiary)
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 1)
    }
}

private func relativeChinese(_ date: Date) -> String {
    date.formatted(.relative(presentation: .named).locale(Locale(identifier: "zh_Hans_CN")))
}
