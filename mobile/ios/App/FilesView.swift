import CompanionCore
import SwiftUI

private enum FilesRoute: Hashable {
    case project(workspaceID: String, title: String)
    case directory(workspaceID: String, path: String)
    case file(workspaceID: String, path: String)
}

struct FilesView: View {
    let client: HostClient
    @State private var list = RemoteList<ProjectSummary>()
    @State private var stack: [FilesRoute] = []
    @State private var diffWorkspaceID: String?
    @State private var searchQuery = ""

    var body: some View {
        NavigationStack(path: $stack) {
            content
                .navigationTitle("文件")
                .navigationDestination(for: FilesRoute.self) { route in
                    switch route {
                    case .project(let workspaceID, let title):
                        DirectoryView(
                            client: client,
                            workspaceID: workspaceID,
                            path: "",
                            rootTitle: title,
                            navigate: { push($0, workspaceID: workspaceID) }
                        )
                        .toolbar {
                            ToolbarItem(placement: .primaryAction) {
                                Button {
                                    diffWorkspaceID = workspaceID
                                } label: {
                                    Label("代码差异", systemImage: "plus.forwardslash.minus")
                                }
                            }
                        }
                    case .directory(let workspaceID, let path):
                        DirectoryView(
                            client: client,
                            workspaceID: workspaceID,
                            path: path,
                            navigate: { push($0, workspaceID: workspaceID) }
                        )
                    case .file(let workspaceID, let path):
                        FileContentView(client: client, workspaceID: workspaceID, path: path)
                    }
                }
        }
        .sheet(isPresented: Binding(
            get: { diffWorkspaceID != nil },
            set: { if !$0 { diffWorkspaceID = nil } }
        )) {
            if let workspaceID = diffWorkspaceID {
                DiffListView(client: client, workspaceID: workspaceID)
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
        ProjectGroup.make(conversations: [], projects: list.items ?? [])
    }

    private var searchResults: [SearchResultItem] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        return groups.compactMap { group in
            guard group.name.lowercased().contains(q) || group.rootPath.lowercased().contains(q),
                  let workspaceID = group.workspaceIds.first
            else { return nil }
            return SearchResultItem(
                id: group.id,
                title: group.name,
                subtitle: group.rootPath,
                icon: group.isGit ? "arrow.triangle.branch" : "folder",
                action: { stack.append(.project(workspaceID: workspaceID, title: group.name)) }
            )
        }
    }

    @ViewBuilder
    private var content: some View {
        if let items = list.items {
            if items.isEmpty {
                ContentUnavailableView("还没有已导入项目", systemImage: "folder")
            } else {
                List {
                    Section {
                        SearchListCard(
                            query: $searchQuery,
                            placeholder: "搜索项目…",
                            results: searchResults
                        )
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    Section("已导入项目") {
                        ForEach(groups) { group in
                            if let workspaceID = group.workspaceIds.first {
                                NavigationLink(value: FilesRoute.project(workspaceID: workspaceID, title: group.name)) {
                                    ImportedProjectRow(group: group)
                                }
                            } else {
                                ImportedProjectRow(group: group)
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

    private func push(_ target: BrowseTarget, workspaceID: String) {
        switch target {
        case .directory(let path):
            stack.append(.directory(workspaceID: workspaceID, path: path))
        case .file(let path):
            stack.append(.file(workspaceID: workspaceID, path: path))
        }
    }

    private func reload() async {
        await list.load {
            try await client.projects()
        }
    }
}

private struct ImportedProjectRow: View {
    let group: ProjectGroup

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: group.isGit ? "arrow.triangle.branch" : "folder")
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .frame(width: 22)
            Text(group.name)
                .font(.body.weight(.medium))
                .lineLimit(1)
            Spacer(minLength: 8)
            if !group.rootPath.isEmpty {
                Text(group.rootPath)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
        .padding(.vertical, 2)
        .padding(.leading, CGFloat(group.depth) * 16)
    }
}
