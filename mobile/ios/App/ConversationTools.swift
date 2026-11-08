import CompanionCore
import SwiftUI

// MARK: - 浏览文件

enum BrowseTarget: Hashable {
    case directory(String)
    case file(String)
}

/// "浏览文件": the workspace one directory at a time, each laid out as a branched menu.
struct FileBrowserView: View {
    let client: HostClient
    let workspaceID: String
    @Environment(\.dismiss) private var dismiss
    @State private var stack: [BrowseTarget] = []

    var body: some View {
        NavigationStack(path: $stack) {
            DirectoryView(client: client, workspaceID: workspaceID, path: "", navigate: { stack.append($0) })
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("完成") { dismiss() }
                    }
                }
                .navigationDestination(for: BrowseTarget.self) { target in
                    switch target {
                    case .directory(let path):
                        DirectoryView(client: client, workspaceID: workspaceID, path: path, navigate: { stack.append($0) })
                    case .file(let path):
                        FileContentView(client: client, workspaceID: workspaceID, path: path)
                    }
                }
        }
    }
}

struct DirectoryView: View {
    let client: HostClient
    let workspaceID: String
    let path: String
    var rootTitle: String = "浏览文件"
    let navigate: (BrowseTarget) -> Void
    @State private var list = RemoteList<WorkspaceEntry>()
    @State private var truncated = false
    @State private var active = ""

    var body: some View {
        content
            .navigationTitle(path.isEmpty ? rootTitle : (path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if let entries = list.items {
            if entries.isEmpty {
                ContentUnavailableView("这个目录是空的", systemImage: "folder")
            } else {
                ScrollView {
                    BranchedMenu(sections: sections(entries), active: $active, onSelect: open)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if truncated {
                        Text("只显示前 500 项")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 20)
                    }
                }
            }
        } else if let message = list.errorMessage {
            LoadFailureView(message: message) { Task { await load() } }
        } else {
            ProgressView()
        }
    }

    private func load() async {
        await list.load {
            let tree = try await client.workspaceTree(workspaceID: workspaceID, path: path)
            truncated = tree.truncated
            return tree.entries
        }
    }

    private func sections(_ entries: [WorkspaceEntry]) -> [BranchedSection] {
        let dirs = entries.filter(\.directory).map { BranchedItem(id: "d:" + $0.path, label: $0.name, icon: "folder") }
        let files = entries.filter { !$0.directory }.map {
            BranchedItem(id: "f:" + $0.path, label: $0.name, icon: FileGlyph.symbol(for: $0.name))
        }
        return [
            BranchedSection(id: "dirs", label: "目录 \(dirs.count)", children: dirs),
            BranchedSection(id: "files", label: "文件 \(files.count)", children: files),
        ].filter { !$0.children.isEmpty }
    }

    private func open(_ id: String) {
        let target = String(id.dropFirst(2))
        // Let the branch finish drawing before the page slides in.
        Task {
            try? await Task.sleep(for: .milliseconds(220))
            navigate(id.hasPrefix("d:") ? .directory(target) : .file(target))
        }
    }
}

struct FileContentView: View {
    let client: HostClient
    let workspaceID: String
    let path: String
    @State private var file: WorkspaceFile?
    @State private var errorMessage: String?
    @State private var showFullImage = false

    private var isImageFile: Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "gif", "webp", "heic", "ico", "bmp"].contains(ext)
    }

    private var decodedImage: UIImage? {
        if let content = file?.content, !content.isEmpty {
            if let img = AttachmentImageStore.decodeImage(from: content) {
                return img
            }
            if let data = Data(base64Encoded: content, options: .ignoreUnknownCharacters),
               let img = UIImage(data: data)
            {
                return img
            }
        }
        return AttachmentImageStore.decodeImage(from: path)
    }

    var body: some View {
        Group {
            if let file {
                if let uiImage = decodedImage {
                    VStack(spacing: 16) {
                        MarkdownImageFrameView(
                            src: path,
                            alt: (path as NSString).lastPathComponent,
                            fixedImage: uiImage
                        )
                        Button {
                            showFullImage = true
                        } label: {
                            Label("全屏查看与标注", systemImage: "arrow.up.left.and.arrow.down.right")
                                .font(.system(size: 13.5, weight: .semibold))
                                .padding(.horizontal, 16)
                                .padding(.vertical, 9)
                                .background(Color.accentColor.opacity(0.12), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(20)
                    .fullScreenCover(isPresented: $showFullImage) {
                        ZoomableImagePreviewSheet(
                            item: PreviewableImageItem(
                                id: path,
                                image: uiImage,
                                urlString: nil,
                                title: (path as NSString).lastPathComponent
                            )
                        )
                    }
                } else if file.binary {
                    ContentUnavailableView(
                        isImageFile ? "暂无法在远端直接流式读取此二进制图片" : "二进制文件无法预览",
                        systemImage: isImageFile ? "photo" : "doc.zipper"
                    )
                } else {
                    CodeBlockView(
                        code: file.content ?? "",
                        title: path,
                        language: CodeLanguage.detect(path: path),
                        note: file.truncated ? "文件较大，只显示前 256 KB" : nil
                    )
                }
            } else if let errorMessage {
                LoadFailureView(message: errorMessage) { Task { await load() } }
            } else {
                ProgressView()
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do {
            file = try await client.workspaceFile(workspaceID: workspaceID, path: path)
            errorMessage = nil
        } catch {
            errorMessage = describeHostFailure(error)
        }
    }
}

// MARK: - 代码差异

/// "代码差异": working tree against HEAD, file by file, line by line.
struct DiffListView: View {
    let client: HostClient
    let workspaceID: String
    @Environment(\.dismiss) private var dismiss
    @State private var list = RemoteList<FileDiff>()

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("代码差异")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("完成") { dismiss() }
                    }
                }
                .navigationDestination(for: FileDiff.self) {
                    DiffFileView(client: client, workspaceID: workspaceID, diff: $0)
                }
        }
        .task { await list.load { try await client.workspaceDiff(workspaceID: workspaceID) } }
    }

    @ViewBuilder
    private var content: some View {
        if let diffs = list.items {
            if diffs.isEmpty {
                ContentUnavailableView("没有未提交的改动", systemImage: "checkmark.circle")
            } else {
                List(diffs) { diff in
                    NavigationLink(value: diff) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text((diff.path as NSString).lastPathComponent).lineLimit(1)
                            HStack(spacing: 8) {
                                Text(label(for: diff.change)).foregroundStyle(.secondary)
                                if !diff.isBinary && (diff.additions > 0 || diff.deletions > 0 || diff.change != .untracked) {
                                    Text("+\(diff.additions)").foregroundStyle(.green)
                                    if diff.deletions > 0 || diff.change != .untracked {
                                        Text("−\(diff.deletions)").foregroundStyle(.red)
                                    }
                                }
                                Text(diff.path).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.head)
                            }
                            .font(.footnote)
                        }
                    }
                }
                .refreshable { await list.load { try await client.workspaceDiff(workspaceID: workspaceID) } }
            }
        } else if let message = list.errorMessage {
            LoadFailureView(message: message) {
                Task { await list.load { try await client.workspaceDiff(workspaceID: workspaceID) } }
            }
        } else {
            ProgressView()
        }
    }

    private func label(for change: FileDiff.Change) -> String {
        switch change {
        case .added, .untracked: "新增"
        case .deleted: "删除"
        case .renamed: "重命名"
        case .modified: "修改"
        }
    }
}

extension FileDiff: Hashable {
    public func hash(into hasher: inout Hasher) { hasher.combine(path) }
}

struct DiffFileView: View {
    let client: HostClient
    let workspaceID: String
    let diff: FileDiff
    @State private var hunks: [DiffHunk]
    @State private var loadingContent = false
    @State private var isEmptyFile = false
    @State private var detectedBinary = false
    @State private var loadError: String?

    init(client: HostClient, workspaceID: String, diff: FileDiff) {
        self.client = client
        self.workspaceID = workspaceID
        self.diff = diff
        _hunks = State(initialValue: diff.hunks)
        _loadingContent = State(initialValue: diff.needsContent && diff.hunks.isEmpty)
        _detectedBinary = State(initialValue: diff.isBinary)
    }

    var body: some View {
        Group {
            if loadingContent {
                ProgressView("正在读取文件变更…")
            } else if detectedBinary {
                ContentUnavailableView("二进制或图片资源文件，无文本行差异", systemImage: "doc.zipper")
            } else if isEmptyFile {
                ContentUnavailableView("这是一个空文件（0 行内容）", systemImage: "doc")
            } else if hunks.isEmpty {
                ContentUnavailableView(
                    loadError ?? "没有可显示的文本差异",
                    systemImage: "plus.forwardslash.minus"
                )
            } else {
                ScrollView([.vertical, .horizontal]) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(hunks) { hunk in
                            Text(hunk.header)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 6)
                                .padding(.horizontal, 12)
                            ForEach(hunk.lines) { DiffRow(line: $0) }
                        }
                        if diff.truncated {
                            Text("差异过长，只显示前一部分")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .padding(12)
                        }
                    }
                    .frame(minWidth: UIScreen.main.bounds.width, alignment: .leading)
                }
            }
        }
        .navigationTitle((diff.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard diff.needsContent, hunks.isEmpty else {
                loadingContent = false
                return
            }
            loadingContent = true
            defer { loadingContent = false }
            do {
                let file = try await client.workspaceFile(workspaceID: workspaceID, path: diff.path)
                if file.binary {
                    detectedBinary = true
                } else if let content = file.content {
                    let parsed = FileDiff.additions(of: content)
                    if parsed.isEmpty {
                        isEmptyFile = true
                    } else {
                        hunks = parsed
                    }
                } else {
                    isEmptyFile = file.size == 0
                }
            } catch {
                loadError = describeHostFailure(error)
            }
        }
    }
}

private struct DiffRow: View {
    let line: DiffLine

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            number(line.oldNumber)
            number(line.newNumber)
            Text(marker).foregroundStyle(tint)
            Text(line.text.isEmpty ? " " : line.text)
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(line.kind == .context ? 0 : 0.12))
        .textSelection(.enabled)
    }

    private func number(_ value: Int?) -> some View {
        Text(value.map(String.init) ?? "")
            .foregroundStyle(.tertiary)
            .frame(minWidth: 30, alignment: .trailing)
    }

    private var marker: String {
        switch line.kind {
        case .added: "+"
        case .removed: "−"
        case .context: " "
        }
    }

    private var tint: Color {
        switch line.kind {
        case .added: .green
        case .removed: .red
        case .context: .secondary
        }
    }
}

/// One file's diff, opened from a changed-file chip.
struct FileDiffSheet: View {
    let client: HostClient
    let workspaceID: String
    let path: String
    @Environment(\.dismiss) private var dismiss
    @State private var diff: FileDiff?
    @State private var missing = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if let diff {
                    DiffFileView(client: client, workspaceID: workspaceID, diff: diff)
                } else if missing {
                    ContentUnavailableView("这个文件已经没有未提交的改动", systemImage: "checkmark.circle")
                        .navigationTitle((path as NSString).lastPathComponent)
                        .navigationBarTitleDisplayMode(.inline)
                } else if let errorMessage {
                    LoadFailureView(message: errorMessage) { Task { await load() } }
                } else {
                    ProgressView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let all = try await client.workspaceDiff(workspaceID: workspaceID)
            diff = all.first { $0.path == path }
            missing = diff == nil
            errorMessage = nil
        } catch {
            errorMessage = describeHostFailure(error)
        }
    }
}
