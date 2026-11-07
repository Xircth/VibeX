import CompanionCore
import SwiftUI

/// Conversations grouped by project: the root lists projects, a project lists only its own conversations.
struct ConversationsView: View {
    let client: HostClient
    @State private var list = RemoteList<ConversationListItem>()
    @State private var projects: [ProjectSummary]?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("对话")
                .navigationDestination(for: ProjectRoute.self) { route in
                    ProjectConversationsView(
                        client: client,
                        group: group(id: route.id),
                        projects: projects ?? [],
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

    private var groups: [ProjectGroup] {
        ProjectGroup.make(conversations: list.items ?? [], projects: projects ?? [])
    }

    private func group(id: String) -> ProjectGroup {
        groups.first { $0.id == id } ?? ProjectGroup(id: id, name: "", conversations: [])
    }

    @ViewBuilder
    private var content: some View {
        if let items = list.items {
            if let projects, !projects.isEmpty {
                List {
                    Section("已导入项目") {
                        ForEach(groups) { group in
                            NavigationLink(value: ProjectRoute(id: group.id)) {
                                ProjectRow(group: group)
                            }
                        }
                    }
                }
                .refreshable { await reload() }
            } else if items.isEmpty {
                ContentUnavailableView("最近没有对话", systemImage: "bubble.left.and.bubble.right")
            } else {
                // The Host did not describe its projects; fall back to one flat list.
                List(items) { item in
                    NavigationLink(value: item) { ConversationRow(item: item) }
                }
                .refreshable { await reload() }
            }
        } else if let message = list.errorMessage {
            LoadFailureView(message: message) { Task { await reload() } }
        } else {
            ProgressView()
        }
    }

    private func reload() async {
        projects = try? await client.projects()
        await list.load {
            try await client.call(
                "conversation_list_recent",
                args: ["sinceDays": 30, "limit": 100],
                as: [ConversationListItem].self
            )
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
    let onRefresh: () async -> Void

    @State private var agents: [CatalogAgent] = []
    @State private var created: ConversationListItem?
    @State private var errorMessage: String?

    var body: some View {
        List(group.conversations) { item in
            NavigationLink(value: item) { ConversationRow(item: item) }
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
