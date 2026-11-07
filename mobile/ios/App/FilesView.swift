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
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    Section {
                        ForEach(groups) { group in
                            if let workspaceID = group.workspaceIds.first {
                                NavigationLink(value: FilesRoute.project(workspaceID: workspaceID, title: group.name)) {
                                    ImportedProjectRow(group: group)
                                }
                                .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))
                                .swipeActions(edge: .trailing) {
                                    Button {
                                        diffWorkspaceID = workspaceID
                                    } label: {
                                        Label("代码差异", systemImage: "plus.forwardslash.minus")
                                    }
                                    .tint(.orange)
                                }
                            } else {
                                ImportedProjectRow(group: group)
                                    .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))
                            }
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Text("项目")
                            Text("\(groups.count)").foregroundStyle(.tertiary)
                        }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .textCase(nil)
                        .padding(.leading, -6)
                    }
                }
                .listSectionSpacing(14)
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

    private var tint: Color {
        if group.isHome { return .teal }
        return group.isGit ? .orange : .blue
    }

    private var displayPath: String {
        // Collapse the macOS home prefix to "~" so paths stay readable.
        if let range = group.rootPath.range(of: #"^/Users/[^/]+"#, options: .regularExpression) {
            return "~" + group.rootPath[range.upperBound...]
        }
        return group.rootPath
    }

    var body: some View {
        HStack(spacing: 11) {
            Image(systemName: group.isHome ? "house" : (group.isGit ? "arrow.triangle.branch" : "folder"))
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(group.name)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                if !group.rootPath.isEmpty {
                    Text(displayPath)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
        }
        .padding(.leading, CGFloat(group.depth) * 18)
    }
}
