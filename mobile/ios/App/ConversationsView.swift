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
                        subtitle: conv.model,
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
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    Section("已导入项目") {
                        ForEach(groups) { group in
                            NavigationLink(value: ProjectRoute(id: group.id)) {
                                ProjectRow(group: group)
                            }
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
                .listSectionSpacing(10)
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
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    Section {
                        ForEach(visibleConversations) { item in
                            NavigationLink(value: item) { ConversationRow(item: item) }
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
                .listSectionSpacing(10)
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
                            Button(agent.displayName) { create(agent: agent, workspace: workspace) }
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

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: iconName)
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(group.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if !group.rootPath.isEmpty {
                        Text(group.rootPath)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
                HStack(spacing: 8) {
                    Text("\(group.conversations.count) 个对话")
                    if let date = group.latest {
                        Text(date, format: .relative(presentation: .named))
                    }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.leading, CGFloat(group.depth) * 16)
    }
}

private struct ConversationRow: View {
    let item: ConversationListItem

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title ?? "未命名对话").lineLimit(1)
            HStack(spacing: 8) {
                if let date = item.updatedAt {
                    Text(date, format: .relative(presentation: .named))
                }
                Text("\(item.message_count) 条消息")
                if let model = item.model { Text(model).lineLimit(1) }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }
}
