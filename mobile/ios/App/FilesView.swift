import CompanionCore
import SwiftUI

struct FilesView: View {
    let client: HostClient
    @State private var list = RemoteList<ArtifactListItem>()

    var body: some View {
        NavigationStack {
            content.navigationTitle("文件")
        }
        .task {
            while !Task.isCancelled {
                await reload()
                try? await Task.sleep(for: .seconds(list.errorMessage == nil ? 30 : 4))
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let items = list.items {
            if items.isEmpty {
                ContentUnavailableView("还没有 Agent 生成的文件", systemImage: "folder")
            } else {
                List(items) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.fileName).lineLimit(1)
                        HStack(spacing: 8) {
                            Text(item.updatedAt, format: .relative(presentation: .named))
                            Text(item.media_type).lineLimit(1)
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
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
        await list.load {
            try await client.call("artifact_list", args: ["limit": 100], as: [ArtifactListItem].self)
        }
    }
}
