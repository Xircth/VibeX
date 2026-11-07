import CompanionCore
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct BoardView: View {
    let client: HostClient

    @State private var viewMode: KanbanViewMode = .columns
    @State private var projects: [ProjectSummary] = []
    @State private var selectedProjectID: String? // nil = 全部项目
    @State private var sessions: [KanbanSessionSummary] = []
    @State private var workspaces: [KanbanWorkspaceRecord] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var noticeMessage: String?

    // Columns board presentation
    @State private var columnsLayout: ColumnsLayoutStyle = .horizontalBoard
    @State private var focusedColumn: KanbanSessionStatus = .todo

    // Session Hub state
    @State private var hubSubMode: SessionHubSubMode = .list
    @State private var searchQuery = ""
    @State private var sortField: KanbanSortField = .defaultOrder
    @State private var selectedWorkspaceFilterIDs: Set<String> = []
    @State private var selectedAgentFilters: Set<String> = []
    @State private var isArchiveView = false
    @State private var isBulkDeleteMode = false
    @State private var selectedDeleteIDs: Set<String> = []
    @State private var collapsedStatuses: Set<KanbanSessionStatus> = []

    // Monitor & Canvas state
    @State private var monitoredSessionIDs: Set<String> = []
    @State private var monitorPreviews: [String: String] = [:]
    @State private var showAddMonitorPicker = false
    @State private var canvasGrouping: CanvasGroupingMode = .byProject
    @State private var collapsedCanvasGroups: Set<String> = []

    // Sheets & Alerts
    @State private var path = NavigationPath()
    @State private var createSheetInitialStatus: KanbanSessionStatus?
    @State private var showCreateSheet = false
    @State private var renamingSession: KanbanSessionSummary?
    @State private var renameDraft = ""
    @State private var deletingSession: KanbanSessionSummary?
    @State private var showBulkDeleteConfirm = false

    enum ColumnsLayoutStyle: String, CaseIterable, Identifiable {
        case horizontalBoard = "四栏画板"
        case statusTabs = "分栏列表"
        var id: String { rawValue }
    }

    enum SessionHubSubMode: String, CaseIterable, Identifiable {
        case list = "会话列表"
        case monitor = "会话监控区"
        case canvas = "画布分组"
        var id: String { rawValue }

        var icon: String {
            switch self {
            case .list: return "list.bullet"
            case .monitor: return "rectangle.grid.2x2"
            case .canvas: return "square.on.square.dashed"
            }
        }
    }

    enum CanvasGroupingMode: String, CaseIterable, Identifiable {
        case byProject = "按项目"
        case byAgent = "按 Agent"
        case byRecent = "最近时间"
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                topModeBar
                Divider()

                if let noticeMessage {
                    noticeBanner(noticeMessage)
                }

                switch viewMode {
                case .columns:
                    columnsBoardContent
                case .sessionHub:
                    sessionHubContent
                case .usage:
                    KanbanUsageDashboardView(
                        client: client,
                        projects: projects,
                        initialProjectID: selectedProjectID
                    )
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("看板")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    projectSelectorMenu
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        createSheetInitialStatus = .todo
                        showCreateSheet = true
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.title3)
                    }
                    .accessibilityLabel("新建会话")
                }
            }
            .navigationDestination(for: ConversationListItem.self) { item in
                ConversationDetailView(client: client, conversation: item)
            }
            .sheet(isPresented: $showCreateSheet) {
                KanbanCreateSessionSheet(
                    client: client,
                    projects: projects,
                    initialProjectID: selectedProjectID ?? projects.first(where: { !$0.isHome })?.id ?? projects.first?.id,
                    initialStatus: createSheetInitialStatus ?? .todo
                ) { createdItem, initialStatus in
                    Task {
                        if initialStatus != .todo {
                            try? await client.updateSessionStatus(sessionID: createdItem.id, status: initialStatus)
                        }
                        await reload()
                        path.append(createdItem)
                    }
                }
            }
            .sheet(isPresented: $showAddMonitorPicker) {
                addMonitorSessionSheet
            }
            .alert(
                "重命名会话",
                isPresented: Binding(
                    get: { renamingSession != nil },
                    set: { if !$0 { renamingSession = nil } }
                )
            ) {
                TextField("会话名称", text: $renameDraft)
                Button("取消", role: .cancel) { renamingSession = nil }
                Button("保存") {
                    if let target = renamingSession {
                        performRename(target, newName: renameDraft)
                    }
                    renamingSession = nil
                }
            }
            .alert(
                "删除会话",
                isPresented: Binding(
                    get: { deletingSession != nil },
                    set: { if !$0 { deletingSession = nil } }
                ),
                presenting: deletingSession
            ) { target in
                Button("取消", role: .cancel) { deletingSession = nil }
                Button("删除", role: .destructive) {
                    performDelete(target)
                    deletingSession = nil
                }
            } message: { target in
                Text("确定删除会话“\(target.resolvedTitle)”吗？正在执行中的会话不会被删除。")
            }
            .alert(
                "批量删除会话",
                isPresented: $showBulkDeleteConfirm
            ) {
                Button("取消", role: .cancel) {}
                Button("删除 (\(selectedDeleteIDs.count))", role: .destructive) {
                    performBulkDelete()
                }
            } message: {
                Text("确定删除已选中的 \(selectedDeleteIDs.count) 个会话吗？正在执行中的会话不会被删除。")
            }
        }
        .task {
            while !Task.isCancelled {
                await reload()
                try? await Task.sleep(for: .seconds(errorMessage == nil ? 15 : 4))
            }
        }
    }

    // MARK: - Top Bars

    private var projectSelectorMenu: some View {
        Menu {
            Button {
                selectedProjectID = nil
                selectedWorkspaceFilterIDs.removeAll()
                Task { await reload() }
            } label: {
                HStack {
                    Label("全部项目", systemImage: "square.stack.3d.up")
                    if selectedProjectID == nil {
                        Image(systemName: "checkmark")
                    }
                }
            }

            Divider()

            ForEach(projects) { project in
                Button {
                    selectedProjectID = project.id
                    selectedWorkspaceFilterIDs.removeAll()
                    Task { await reload() }
                } label: {
                    HStack {
                        Label(
                            project.displayName,
                            systemImage: project.isGit ? "arrow.triangle.branch" : "folder"
                        )
                        if selectedProjectID?.lowercased() == project.id.lowercased() {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: selectedProject?.isGit == true ? "arrow.triangle.branch" : "folder.fill")
                    .font(.caption)
                Text(selectedProject?.displayName ?? "全部项目")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Color(.secondarySystemGroupedBackground), in: Capsule())
        }
    }

    private var topModeBar: some View {
        HStack(spacing: 8) {
            ForEach(KanbanViewMode.allCases) { mode in
                let isSelected = viewMode == mode
                Button {
                    withAnimation(.spring(response: 0.26, dampingFraction: 0.85)) {
                        viewMode = mode
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: mode.icon)
                            .font(.caption)
                        Text(mode.title)
                            .font(.footnote.weight(isSelected ? .semibold : .medium))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .foregroundStyle(isSelected ? Color.white : Color.primary)
                    .background(
                        isSelected ? Color.accentColor : Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 10)
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(.systemGroupedBackground))
    }

    private func noticeBanner(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(Color.accentColor)
                .font(.footnote)
            Text(text)
                .font(.caption)
                .lineLimit(2)
            Spacer()
            Button {
                withAnimation { noticeMessage = nil }
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemGroupedBackground))
    }

    // MARK: - 1. Four-Column Kanban Board (`builtin:columns`)

    @ViewBuilder
    private var columnsBoardContent: some View {
        if isLoading && sessions.isEmpty {
            Spacer()
            ProgressView("正在加载会话看板...")
            Spacer()
        } else if let errorMessage, sessions.isEmpty {
            Spacer()
            LoadFailureView(message: errorMessage) {
                Task { await reload() }
            }
            Spacer()
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Picker("看板布局", selection: $columnsLayout) {
                        ForEach(ColumnsLayoutStyle.allCases) { style in
                            Text(style.rawValue).tag(style)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 170)

                    Spacer()

                    Text("共 \(activeSessions.count) 个活跃会话")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Button {
                        Task { await reload() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.footnote.weight(.medium))
                            .frame(width: 28, height: 28)
                            .background(Color(.secondarySystemGroupedBackground), in: Circle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)

                if columnsLayout == .horizontalBoard {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: 12) {
                            ForEach(KanbanSessionStatus.activeColumns) { columnStatus in
                                kanbanColumnView(status: columnStatus, width: 292)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                    }
                } else {
                    VStack(spacing: 0) {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(KanbanSessionStatus.activeColumns) { status in
                                    let count = sessionsForStatus(status).count
                                    let selected = focusedColumn == status
                                    Button {
                                        withAnimation(.easeInOut(duration: 0.18)) {
                                            focusedColumn = status
                                        }
                                    } label: {
                                        HStack(spacing: 6) {
                                            Circle()
                                                .fill(statusColor(status))
                                                .frame(width: 8, height: 8)
                                            Text(status.title)
                                                .font(.footnote.weight(selected ? .semibold : .medium))
                                            Text("\(count)")
                                                .font(.caption2.monospacedDigit().weight(.semibold))
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(
                                                    selected
                                                        ? Color.white.opacity(0.22)
                                                        : Color(.tertiarySystemFill),
                                                    in: Capsule()
                                                )
                                        }
                                        .padding(.horizontal, 12)
                                        .padding(.vertical, 7)
                                        .foregroundStyle(selected ? Color.white : Color.primary)
                                        .background(
                                            selected
                                                ? statusColor(status)
                                                : Color(.secondarySystemGroupedBackground),
                                            in: Capsule()
                                        )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 16)
                            .padding(.bottom, 8)
                        }

                        let columnItems = sessionsForStatus(focusedColumn)
                        if columnItems.isEmpty {
                            Spacer()
                            VStack(spacing: 12) {
                                Image(systemName: "rectangle.stack.badge.plus")
                                    .font(.system(size: 36))
                                    .foregroundStyle(.secondary)
                                Text("“\(focusedColumn.title)”暂无会话")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.secondary)
                                Button {
                                    createSheetInitialStatus = focusedColumn
                                    showCreateSheet = true
                                } label: {
                                    Label("新建\(focusedColumn.title)会话", systemImage: "plus")
                                        .font(.footnote.weight(.semibold))
                                        .padding(.horizontal, 14)
                                        .padding(.vertical, 8)
                                        .background(Color.accentColor, in: Capsule())
                                        .foregroundStyle(.white)
                                }
                                .buttonStyle(.plain)
                            }
                            Spacer()
                        } else {
                            ScrollView {
                                LazyVStack(spacing: 10) {
                                    ForEach(columnItems) { session in
                                        sessionCard(session, showStatusPill: false)
                                    }
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                            }
                            .refreshable {
                                await reload()
                            }
                        }
                    }
                }
            }
        }
    }

    private func kanbanColumnView(status: KanbanSessionStatus, width: CGFloat) -> some View {
        let items = sessionsForStatus(status)
        return VStack(alignment: .leading, spacing: 0) {
            // Column Header
            HStack(spacing: 8) {
                Circle()
                    .fill(statusColor(status))
                    .frame(width: 8, height: 8)
                Text(status.columnHeaderLabel)
                    .font(.caption.weight(.bold))
                    .tracking(0.4)
                Text(status.title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(items.count)")
                    .font(.caption2.monospacedDigit().weight(.semibold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color(.tertiarySystemFill), in: Capsule())
                Button {
                    createSheetInitialStatus = status
                    showCreateSheet = true
                } label: {
                    Image(systemName: "plus")
                        .font(.caption.weight(.bold))
                        .frame(width: 24, height: 24)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("在\(status.title)新建会话")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()

            if items.isEmpty {
                VStack(spacing: 8) {
                    Spacer(minLength: 40)
                    Text("暂无\(status.title)会话")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button {
                        createSheetInitialStatus = status
                        showCreateSheet = true
                    } label: {
                        Label("新建会话", systemImage: "plus")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 40)
                }
                .frame(maxWidth: .infinity)
                .padding(12)
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(spacing: 8) {
                        ForEach(items) { session in
                            sessionCard(session, showStatusPill: false)
                        }
                    }
                    .padding(10)
                }
            }
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5)
        )
    }

    // MARK: - 2. Session Hub (`builtin:sessions`: List + Monitor + Canvas + Archive)

    @ViewBuilder
    private var sessionHubContent: some View {
        VStack(spacing: 0) {
            // Sub-mode switcher: 会话列表 / 会话监控区 / 画布分组
            HStack(spacing: 8) {
                ForEach(SessionHubSubMode.allCases) { mode in
                    let selected = hubSubMode == mode
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            hubSubMode = mode
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: mode.icon)
                                .font(.caption2)
                            Text(mode.rawValue)
                                .font(.caption.weight(selected ? .semibold : .medium))
                            if mode == .monitor && !effectiveMonitoredSessions.isEmpty {
                                Text("\(effectiveMonitoredSessions.count)")
                                    .font(.caption2.monospacedDigit().weight(.bold))
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(
                                        selected ? Color.white.opacity(0.24) : Color.accentColor.opacity(0.15),
                                        in: Capsule()
                                    )
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .foregroundStyle(selected ? Color.white : Color.primary)
                        .background(
                            selected ? Color.accentColor : Color(.secondarySystemGroupedBackground),
                            in: Capsule()
                        )
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            switch hubSubMode {
            case .list:
                sessionHubListContent
            case .monitor:
                sessionHubMonitorContent
            case .canvas:
                sessionHubCanvasContent
            }
        }
    }

    private var sessionHubListContent: some View {
        VStack(spacing: 0) {
            // Controls row: Sort, Filter, Archive Toggle, Bulk Delete
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    // Sort Menu
                    Menu {
                        ForEach(KanbanSortField.allCases) { field in
                            Button {
                                sortField = field
                            } label: {
                                HStack {
                                    Text(field.label)
                                    if sortField == field { Image(systemName: "checkmark") }
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.up.arrow.down")
                                .font(.caption2)
                            Text(sortField == .defaultOrder ? "排序" : "排序：\(sortField.label)")
                                .font(.caption.weight(.medium))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(
                            sortField == .defaultOrder
                                ? Color(.secondarySystemGroupedBackground)
                                : Color.accentColor.opacity(0.15),
                            in: Capsule()
                        )
                    }

                    // Agent Filter Menu
                    if !availableAgentKeys.isEmpty {
                        Menu {
                            Button("全部代理") {
                                selectedAgentFilters.removeAll()
                            }
                            Divider()
                            ForEach(availableAgentKeys, id: \.self) { agentKey in
                                Button {
                                    if selectedAgentFilters.contains(agentKey) {
                                        selectedAgentFilters.remove(agentKey)
                                    } else {
                                        selectedAgentFilters.insert(agentKey)
                                    }
                                } label: {
                                    HStack {
                                        Text(KanbanSessionSummary.formatAgentDisplayName(agentKey))
                                        if selectedAgentFilters.contains(agentKey) {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "line.3.horizontal.decrease.circle")
                                    .font(.caption2)
                                Text(
                                    selectedAgentFilters.isEmpty
                                        ? "代理筛选"
                                        : "代理：\(selectedAgentFilters.count)"
                                )
                                .font(.caption.weight(.medium))
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                selectedAgentFilters.isEmpty
                                    ? Color(.secondarySystemGroupedBackground)
                                    : Color.accentColor.opacity(0.15),
                                in: Capsule()
                            )
                        }
                    }

                    // Workspace Filter Menu
                    if availableWorkspaceLabels.count > 1 {
                        Menu {
                            Button("全部工作区") {
                                selectedWorkspaceFilterIDs.removeAll()
                            }
                            Divider()
                            ForEach(availableWorkspaceLabels, id: \.id) { ws in
                                Button {
                                    if selectedWorkspaceFilterIDs.contains(ws.id) {
                                        selectedWorkspaceFilterIDs.remove(ws.id)
                                    } else {
                                        selectedWorkspaceFilterIDs.insert(ws.id)
                                    }
                                } label: {
                                    HStack {
                                        Text(ws.label)
                                        if selectedWorkspaceFilterIDs.contains(ws.id) {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "arrow.triangle.branch")
                                    .font(.caption2)
                                Text(
                                    selectedWorkspaceFilterIDs.isEmpty
                                        ? "工作区"
                                        : "工作区：\(selectedWorkspaceFilterIDs.count)"
                                )
                                .font(.caption.weight(.medium))
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                selectedWorkspaceFilterIDs.isEmpty
                                    ? Color(.secondarySystemGroupedBackground)
                                    : Color.accentColor.opacity(0.15),
                                in: Capsule()
                            )
                        }
                    }

                    // Archive view toggle
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isArchiveView.toggle()
                            isBulkDeleteMode = false
                            selectedDeleteIDs.removeAll()
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: isArchiveView ? "tray.full.fill" : "archivebox")
                                .font(.caption2)
                            Text(
                                isArchiveView
                                    ? "返回会话列表"
                                    : "归档区 (\(archivedSessions.count))"
                            )
                            .font(.caption.weight(.medium))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .foregroundStyle(isArchiveView ? Color.white : Color.primary)
                        .background(
                            isArchiveView ? Color.indigo : Color(.secondarySystemGroupedBackground),
                            in: Capsule()
                        )
                    }
                    .buttonStyle(.plain)

                    // Bulk delete toggle
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isBulkDeleteMode.toggle()
                            selectedDeleteIDs.removeAll()
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: isBulkDeleteMode ? "xmark.circle.fill" : "trash")
                                .font(.caption2)
                            Text(isBulkDeleteMode ? "退出删除模式" : "批量删除")
                                .font(.caption.weight(.medium))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .foregroundStyle(isBulkDeleteMode ? Color.white : Color.red)
                        .background(
                            isBulkDeleteMode ? Color.red : Color(.secondarySystemGroupedBackground),
                            in: Capsule()
                        )
                    }
                    .buttonStyle(.plain)

                    if hasActiveFilters {
                        Button {
                            sortField = .defaultOrder
                            selectedAgentFilters.removeAll()
                            selectedWorkspaceFilterIDs.removeAll()
                            searchQuery = ""
                        } label: {
                            Text("恢复默认")
                                .font(.caption)
                                .foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 6)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
            }

            if isBulkDeleteMode {
                HStack(spacing: 12) {
                    let currentPool = isArchiveView ? filteredArchivedSessions : filteredActiveSessions
                    Button {
                        if selectedDeleteIDs.count == currentPool.count {
                            selectedDeleteIDs.removeAll()
                        } else {
                            selectedDeleteIDs = Set(currentPool.map(\.id))
                        }
                    } label: {
                        Text(selectedDeleteIDs.count == currentPool.count && !currentPool.isEmpty ? "取消全选" : "全选")
                            .font(.caption.weight(.medium))
                    }

                    Text("已选择 \(selectedDeleteIDs.count) 项")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Spacer()

                    Button(role: .destructive) {
                        showBulkDeleteConfirm = true
                    } label: {
                        Text("删除选中")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 5)
                            .background(
                                selectedDeleteIDs.isEmpty ? Color.gray.opacity(0.3) : Color.red,
                                in: Capsule()
                            )
                            .foregroundStyle(.white)
                    }
                    .disabled(selectedDeleteIDs.isEmpty)
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemGroupedBackground))
            }

            List {
                Section {
                    SearchListCard(
                        query: $searchQuery,
                        placeholder: "搜索名称或用户消息…",
                        results: hubSearchResults
                    )
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                if isArchiveView {
                    if filteredArchivedSessions.isEmpty {
                        Section {
                            ContentUnavailableView("归档区暂无会话", systemImage: "archivebox")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 24)
                        }
                        .listRowBackground(Color.clear)
                    } else {
                        Section("归档区 (\(filteredArchivedSessions.count))") {
                            ForEach(filteredArchivedSessions) { session in
                                hubListRow(session)
                            }
                        }
                    }
                } else {
                    if filteredActiveSessions.isEmpty {
                        Section {
                            ContentUnavailableView(
                                hasActiveFilters ? "没有符合当前筛选或排序条件的会话" : "暂无会话，点击右上角“+”即可创建",
                                systemImage: "bubble.left.and.bubble.right"
                            )
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 24)
                        }
                        .listRowBackground(Color.clear)
                    } else {
                        ForEach(KanbanSessionStatus.activeColumns) { status in
                            let groupItems = filteredActiveSessions.filter { $0.status == status }
                            if !groupItems.isEmpty {
                                Section {
                                    if !collapsedStatuses.contains(status) {
                                        ForEach(groupItems) { session in
                                            hubListRow(session)
                                        }
                                    }
                                } header: {
                                    Button {
                                        withAnimation(.easeInOut(duration: 0.18)) {
                                            if collapsedStatuses.contains(status) {
                                                collapsedStatuses.remove(status)
                                            } else {
                                                collapsedStatuses.insert(status)
                                            }
                                        }
                                    } label: {
                                        HStack(spacing: 6) {
                                            Image(
                                                systemName: collapsedStatuses.contains(status)
                                                    ? "chevron.right"
                                                    : "chevron.down"
                                            )
                                            .font(.caption2.weight(.bold))
                                            Circle()
                                                .fill(statusColor(status))
                                                .frame(width: 8, height: 8)
                                            Text(status.title)
                                                .font(.footnote.weight(.semibold))
                                                .foregroundStyle(.primary)
                                            Text("\(groupItems.count)")
                                                .font(.caption2.monospacedDigit().weight(.semibold))
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 1)
                                                .background(Color(.tertiarySystemFill), in: Capsule())
                                            Spacer()
                                        }
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollDismissesKeyboard(.immediately)
            .refreshable {
                await reload()
            }
        }
    }

    @ViewBuilder
    private func hubListRow(_ session: KanbanSessionSummary) -> some View {
        HStack(spacing: 10) {
            if isBulkDeleteMode {
                Button {
                    if selectedDeleteIDs.contains(session.id) {
                        selectedDeleteIDs.remove(session.id)
                    } else {
                        selectedDeleteIDs.insert(session.id)
                    }
                } label: {
                    Image(
                        systemName: selectedDeleteIDs.contains(session.id)
                            ? "checkmark.circle.fill"
                            : "circle"
                    )
                    .font(.title3)
                    .foregroundStyle(
                        selectedDeleteIDs.contains(session.id) ? Color.accentColor : Color.secondary
                    )
                }
                .buttonStyle(.plain)
            }

            Button {
                if isBulkDeleteMode {
                    if selectedDeleteIDs.contains(session.id) {
                        selectedDeleteIDs.remove(session.id)
                    } else {
                        selectedDeleteIDs.insert(session.id)
                    }
                } else {
                    openSession(session)
                }
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        if session.isPinned {
                            Image(systemName: "pin.fill")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                        if session.isRunning {
                            ProgressView()
                                .controlSize(.mini)
                            Text("进行中")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Color.orange.opacity(0.16), in: Capsule())
                                .foregroundStyle(.orange)
                        } else if session.status == .inreview {
                            Text("待检查")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Color.purple.opacity(0.16), in: Capsule())
                                .foregroundStyle(.purple)
                        }
                        Text(session.resolvedTitle)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Spacer()
                        if let date = session.updatedDate {
                            Text(date, style: .relative)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }

                    HStack(spacing: 8) {
                        if let collab = session.collaboration, let member = collab.memberName, !member.isEmpty {
                            Label(member, systemImage: "person.2.fill")
                                .font(.caption2)
                                .foregroundStyle(.indigo)
                                .lineLimit(1)
                        }
                        Label(session.agentDisplayName, systemImage: "sparkles")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        if !session.workspaceDisplayLabel.isEmpty {
                            Label(session.workspaceDisplayLabel, systemImage: "arrow.triangle.branch")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        if monitoredSessionIDs.contains(session.id) {
                            Image(systemName: "eye.fill")
                                .font(.caption2)
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }
            }
            .buttonStyle(.plain)
        }
        .contextMenu {
            sessionContextMenuItems(session)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                performDelete(session)
            } label: {
                Label("删除", systemImage: "trash")
            }
            if session.isArchived {
                Button {
                    performStatusChange(session, to: .todo)
                } label: {
                    Label("移至列表", systemImage: "tray.and.arrow.up")
                }
                .tint(.blue)
            } else {
                Button {
                    performStatusChange(session, to: .archived)
                } label: {
                    Label("归档", systemImage: "archivebox")
                }
                .tint(.indigo)
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button {
                performTogglePin(session)
            } label: {
                Label(session.isPinned ? "取消置顶" : "置顶", systemImage: session.isPinned ? "pin.slash" : "pin")
            }
            .tint(.orange)

            Button {
                toggleMonitor(session)
            } label: {
                Label(
                    monitoredSessionIDs.contains(session.id) ? "取消监控" : "监控",
                    systemImage: monitoredSessionIDs.contains(session.id) ? "eye.slash" : "eye"
                )
            }
            .tint(.blue)
        }
    }

    // MARK: - Session Hub Monitor (`SessionHubMonitor`)

    private var sessionHubMonitorContent: some View {
        let monitored = effectiveMonitoredSessions
        return VStack(spacing: 0) {
            HStack {
                Text("会话监控区 (\(monitored.count))")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button {
                    showAddMonitorPicker = true
                } label: {
                    Label("添加监控会话", systemImage: "plus.circle")
                        .font(.caption.weight(.semibold))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            if monitored.isEmpty {
                Spacer()
                ContentUnavailableView {
                    Label("会话监控区为空", systemImage: "rectangle.grid.2x2")
                } description: {
                    Text("在会话列表中右滑选择“监控”或点击上方“添加监控会话”，即可在此实时监控多个会话。")
                } actions: {
                    Button("添加监控会话") {
                        showAddMonitorPicker = true
                    }
                    .buttonStyle(.borderedProminent)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible())], spacing: 12) {
                        ForEach(Array(monitored.enumerated()), id: \.element.id) { index, session in
                            monitorCardView(session: session, slotIndex: index)
                        }
                    }
                    .padding(16)
                }
                .refreshable {
                    await reload()
                    await loadMonitorPreviews()
                }
            }
        }
        .task(id: monitored.map(\.id)) {
            await loadMonitorPreviews()
        }
    }

    private func monitorCardView(session: KanbanSessionSummary, slotIndex: Int) -> some View {
        let slotColors: [Color] = [.blue, .purple, .orange, .green, .pink, .teal]
        let barColor = slotColors[slotIndex % slotColors.count]
        let preview = monitorPreviews[session.id] ?? session.firstPrompt ?? "点击“在执行区打开”查看完整对话流"

        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(barColor)
                    .frame(width: 4, height: 18)

                Text(session.resolvedTitle)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)

                Spacer()

                if session.isRunning {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.mini)
                        Text("进行中")
                            .font(.caption2.weight(.semibold))
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color.orange.opacity(0.16), in: Capsule())
                    .foregroundStyle(.orange)
                } else {
                    Text(session.status.title)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(statusColor(session.status).opacity(0.15), in: Capsule())
                        .foregroundStyle(statusColor(session.status))
                }
            }

            Text(preview)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))

            HStack(spacing: 10) {
                Label(session.agentDisplayName, systemImage: "sparkles")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                if !session.workspaceDisplayLabel.isEmpty {
                    Label(session.workspaceDisplayLabel, systemImage: "arrow.triangle.branch")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Button {
                    monitoredSessionIDs.remove(session.id)
                } label: {
                    Text("取消监控")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)

                Button {
                    openSession(session)
                } label: {
                    Label("在执行区打开", systemImage: "arrow.up.right.square")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.accentColor, in: Capsule())
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - Session Hub Canvas Grouping (`SessionCanvasView`)

    private var sessionHubCanvasContent: some View {
        let groups = buildCanvasGroups()
        return VStack(spacing: 0) {
            HStack {
                Picker("分组方式", selection: $canvasGrouping) {
                    ForEach(CanvasGroupingMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 260)

                Spacer()

                Button {
                    if collapsedCanvasGroups.count == groups.count {
                        collapsedCanvasGroups.removeAll()
                    } else {
                        collapsedCanvasGroups = Set(groups.map(\.id))
                    }
                } label: {
                    Text(collapsedCanvasGroups.count == groups.count ? "全部展开" : "全部收起")
                        .font(.caption.weight(.medium))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)

            if groups.isEmpty {
                Spacer()
                ContentUnavailableView("画布是空的", systemImage: "square.on.square.dashed")
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 14) {
                        ForEach(groups) { group in
                            let isCollapsed = collapsedCanvasGroups.contains(group.id)
                            VStack(alignment: .leading, spacing: 10) {
                                Button {
                                    withAnimation(.easeInOut(duration: 0.18)) {
                                        if isCollapsed {
                                            collapsedCanvasGroups.remove(group.id)
                                        } else {
                                            collapsedCanvasGroups.insert(group.id)
                                        }
                                    }
                                } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                                            .font(.caption.weight(.bold))
                                            .foregroundStyle(.secondary)
                                        Image(systemName: group.icon)
                                            .font(.subheadline)
                                            .foregroundStyle(Color.accentColor)
                                        Text(group.title)
                                            .font(.subheadline.weight(.semibold))
                                            .foregroundStyle(.primary)
                                        Spacer()
                                        Text("\(group.sessions.count) 个会话")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 3)
                                            .background(Color(.tertiarySystemFill), in: Capsule())
                                    }
                                }
                                .buttonStyle(.plain)

                                if !isCollapsed {
                                    ForEach(group.sessions) { session in
                                        sessionCard(session, showStatusPill: true)
                                    }
                                }
                            }
                            .padding(14)
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
                        }
                    }
                    .padding(16)
                }
                .refreshable {
                    await reload()
                }
            }
        }
    }

    // MARK: - Reusable Session Card (`SessionHubListItem` in `kanban-board` mode)

    private func sessionCard(_ session: KanbanSessionSummary, showStatusPill: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 6) {
                if session.isPinned {
                    Image(systemName: "pin.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .padding(.top, 2)
                }

                Text(session.resolvedTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                Spacer(minLength: 4)

                Menu {
                    sessionContextMenuItems(session)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Color(.tertiarySystemFill), in: Circle())
                }
            }

            if let prompt = session.firstPrompt?.trimmingCharacters(in: .whitespacesAndNewlines),
               !prompt.isEmpty,
               prompt != session.resolvedTitle
            {
                Text(prompt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack(spacing: 6) {
                if session.isRunning {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.mini)
                        Text("进行中")
                            .font(.caption2.weight(.semibold))
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.16), in: Capsule())
                    .foregroundStyle(.orange)
                } else if showStatusPill || session.status == .inreview {
                    Text(session.status.title)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(statusColor(session.status).opacity(0.15), in: Capsule())
                        .foregroundStyle(statusColor(session.status))
                }

                if let collab = session.collaboration, let member = collab.memberName, !member.isEmpty {
                    HStack(spacing: 3) {
                        Image(systemName: "person.2.fill")
                        Text(member)
                    }
                    .font(.caption2.weight(.medium))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.indigo.opacity(0.14), in: Capsule())
                    .foregroundStyle(.indigo)
                }

                Spacer()

                // Quick status move menu on card
                Menu {
                    ForEach(KanbanSessionStatus.activeColumns) { target in
                        if target != session.status {
                            Button {
                                performStatusChange(session, to: target)
                            } label: {
                                Label("移至“\(target.title)”", systemImage: "arrow.right.circle")
                            }
                        }
                    }
                    Divider()
                    Button {
                        performStatusChange(session, to: .archived)
                    } label: {
                        Label("归档", systemImage: "archivebox")
                    }
                } label: {
                    HStack(spacing: 3) {
                        Circle()
                            .fill(statusColor(session.status))
                            .frame(width: 6, height: 6)
                        Text(session.status.title)
                            .font(.caption2.weight(.medium))
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 8, weight: .bold))
                    }
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color(.tertiarySystemFill), in: Capsule())
                    .foregroundStyle(.secondary)
                }
            }

            Divider()

            HStack(spacing: 8) {
                Label(session.agentDisplayName, systemImage: "sparkles")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if !session.workspaceDisplayLabel.isEmpty {
                    Label(session.workspaceDisplayLabel, systemImage: "arrow.triangle.branch")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                if let date = session.updatedDate {
                    Text(date, style: .relative)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(12)
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5)
        )
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onTapGesture {
            openSession(session)
        }
        .contextMenu {
            sessionContextMenuItems(session)
        }
    }

    @ViewBuilder
    private func sessionContextMenuItems(_ session: KanbanSessionSummary) -> some View {
        Button {
            openSession(session)
        } label: {
            Label("打开会话", systemImage: "bubble.left.and.bubble.right")
        }

        Menu("移动状态") {
            ForEach(KanbanSessionStatus.activeColumns) { status in
                Button {
                    performStatusChange(session, to: status)
                } label: {
                    HStack {
                        Text(status.title)
                        if session.status == status {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        }

        Button {
            performTogglePin(session)
        } label: {
            Label(
                session.isPinned ? "取消置顶" : "置顶",
                systemImage: session.isPinned ? "pin.slash" : "pin"
            )
        }

        Button {
            renameDraft = session.resolvedTitle
            renamingSession = session
        } label: {
            Label("重命名会话", systemImage: "pencil")
        }

        Button {
            toggleMonitor(session)
        } label: {
            Label(
                monitoredSessionIDs.contains(session.id) ? "取消监控" : "加入监控区",
                systemImage: monitoredSessionIDs.contains(session.id) ? "eye.slash" : "eye"
            )
        }

        if session.isForkSupported {
            Button {
                performFork(session)
            } label: {
                Label("从本会话 Fork", systemImage: "arrow.branch")
            }
        }

        Menu("复制") {
            Button {
                copyToClipboard(session.resolvedTitle)
                noticeMessage = "已复制会话名称"
            } label: {
                Label("会话名称", systemImage: "doc.on.doc")
            }
            Button {
                copyToClipboard(session.sessionInfoText)
                noticeMessage = "已复制会话信息"
            } label: {
                Label("会话信息", systemImage: "info.circle")
            }
        }

        Divider()

        if session.isArchived {
            Button {
                performStatusChange(session, to: .todo)
            } label: {
                Label("移至会话列表", systemImage: "tray.and.arrow.up")
            }
        } else {
            Button {
                performStatusChange(session, to: .archived)
            } label: {
                Label("归档", systemImage: "archivebox")
            }
        }

        Button(role: .destructive) {
            deletingSession = session
        } label: {
            Label("删除会话", systemImage: "trash")
        }
    }

    private var addMonitorSessionSheet: some View {
        NavigationStack {
            List {
                ForEach(activeSessions) { session in
                    let isMonitored = monitoredSessionIDs.contains(session.id)
                    Button {
                        toggleMonitor(session)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(session.resolvedTitle)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Text("\(session.agentDisplayName) · \(session.status.title)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: isMonitored ? "checkmark.circle.fill" : "plus.circle")
                                .foregroundStyle(isMonitored ? Color.accentColor : Color.secondary)
                                .font(.title3)
                        }
                    }
                }
            }
            .navigationTitle("选择监控会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") {
                        showAddMonitorPicker = false
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: - Computed Properties & Filtering

    private var selectedProject: ProjectSummary? {
        guard let selectedProjectID else { return nil }
        return projects.first { $0.id.lowercased() == selectedProjectID.lowercased() }
    }

    private var activeWorkspaceIDs: [String] {
        if let selectedProject {
            return selectedProject.workspaceIds
        }
        return projects.flatMap(\.workspaceIds)
    }

    private var activeSessions: [KanbanSessionSummary] {
        sessions.filter { !$0.isArchived }
    }

    private var archivedSessions: [KanbanSessionSummary] {
        sessions.filter(\.isArchived)
    }

    private func sessionsForStatus(_ status: KanbanSessionStatus) -> [KanbanSessionSummary] {
        sortSessionsList(activeSessions.filter { $0.status == status }, by: .defaultOrder)
    }

    private var hasActiveFilters: Bool {
        sortField != .defaultOrder
            || !selectedAgentFilters.isEmpty
            || !selectedWorkspaceFilterIDs.isEmpty
            || !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var availableAgentKeys: [String] {
        let keys = Set(sessions.compactMap(\.effectiveAgentKey))
        return keys.sorted()
    }

    private var availableWorkspaceLabels: [(id: String, label: String)] {
        var map: [String: String] = [:]
        for ws in workspaces {
            map[ws.id] = ws.displayLabel
        }
        for s in sessions where map[s.workspaceId] == nil && !s.workspaceId.isEmpty {
            map[s.workspaceId] = s.workspaceDisplayLabel.isEmpty ? "默认工作区" : s.workspaceDisplayLabel
        }
        return map.map { (id: $0.key, label: $0.value) }.sorted { $0.label < $1.label }
    }

    private var filteredActiveSessions: [KanbanSessionSummary] {
        applyHubFilters(to: activeSessions)
    }

    private var filteredArchivedSessions: [KanbanSessionSummary] {
        applyHubFilters(to: archivedSessions)
    }

    private func applyHubFilters(to input: [KanbanSessionSummary]) -> [KanbanSessionSummary] {
        let needle = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filtered = input.filter { session in
            if !selectedWorkspaceFilterIDs.isEmpty && !selectedWorkspaceFilterIDs.contains(session.workspaceId) {
                return false
            }
            if !selectedAgentFilters.isEmpty {
                guard let key = session.effectiveAgentKey, selectedAgentFilters.contains(key) else {
                    return false
                }
            }
            if !needle.isEmpty {
                let matchTitle = session.resolvedTitle.lowercased().contains(needle)
                let matchPrompt = session.firstPrompt?.lowercased().contains(needle) ?? false
                let matchBranch = session.workspaceDisplayLabel.lowercased().contains(needle)
                let matchAgent = session.agentDisplayName.lowercased().contains(needle)
                if !(matchTitle || matchPrompt || matchBranch || matchAgent) {
                    return false
                }
            }
            return true
        }
        return sortSessionsList(filtered, by: sortField)
    }

    private func sortSessionsList(
        _ list: [KanbanSessionSummary],
        by field: KanbanSortField
    ) -> [KanbanSessionSummary] {
        list.sorted { left, right in
            if left.isPinned != right.isPinned {
                return left.isPinned && !right.isPinned
            }
            switch field {
            case .defaultOrder, .time:
                return (left.updatedDate ?? .distantPast) > (right.updatedDate ?? .distantPast)
            case .name:
                let cmp = left.resolvedTitle.localizedStandardCompare(right.resolvedTitle)
                if cmp != .orderedSame { return cmp == .orderedAscending }
                return (left.updatedDate ?? .distantPast) > (right.updatedDate ?? .distantPast)
            case .status:
                if left.status.sortOrder != right.status.sortOrder {
                    return left.status.sortOrder < right.status.sortOrder
                }
                return (left.updatedDate ?? .distantPast) > (right.updatedDate ?? .distantPast)
            case .agent:
                let cmp = left.agentDisplayName.localizedStandardCompare(right.agentDisplayName)
                if cmp != .orderedSame { return cmp == .orderedAscending }
                return (left.updatedDate ?? .distantPast) > (right.updatedDate ?? .distantPast)
            }
        }
    }

    private var hubSearchResults: [SearchResultItem] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return [] }
        return sessions.filter {
            $0.resolvedTitle.lowercased().contains(q)
                || ($0.firstPrompt?.lowercased().contains(q) ?? false)
        }
        .prefix(6)
        .map { session in
            SearchResultItem(
                id: session.id,
                title: session.resolvedTitle,
                subtitle: "\(session.status.title) · \(session.agentDisplayName)",
                icon: "bubble.left.and.bubble.right",
                action: { openSession(session) }
            )
        }
    }

    private var effectiveMonitoredSessions: [KanbanSessionSummary] {
        let explicit = activeSessions.filter { monitoredSessionIDs.contains($0.id) }
        if !explicit.isEmpty { return explicit }
        let autoAttention = activeSessions.filter { $0.isRunning || $0.status == .inreview }
        return Array(autoAttention.prefix(6))
    }

    private struct CanvasGroup: Identifiable {
        let id: String
        let title: String
        let icon: String
        let sessions: [KanbanSessionSummary]
    }

    private func buildCanvasGroups() -> [CanvasGroup] {
        switch canvasGrouping {
        case .byProject:
            var wsToProject: [String: ProjectSummary] = [:]
            for proj in projects {
                for ws in proj.workspaceIds {
                    wsToProject[ws.lowercased()] = proj
                }
            }
            var buckets: [String: (title: String, icon: String, list: [KanbanSessionSummary])] = [:]
            for s in activeSessions {
                if let proj = wsToProject[s.workspaceId.lowercased()] {
                    var entry = buckets[proj.id] ?? (proj.displayName, proj.isGit ? "arrow.triangle.branch" : "folder.fill", [])
                    entry.list.append(s)
                    buckets[proj.id] = entry
                } else {
                    var entry = buckets["other"] ?? ("其他工作区", "folder", [])
                    entry.list.append(s)
                    buckets["other"] = entry
                }
            }
            return buckets.map { CanvasGroup(id: $0.key, title: $0.value.title, icon: $0.value.icon, sessions: $0.value.list) }
                .sorted { $0.sessions.count > $1.sessions.count }

        case .byAgent:
            var buckets: [String: [KanbanSessionSummary]] = [:]
            for s in activeSessions {
                let key = s.agentDisplayName
                buckets[key, default: []].append(s)
            }
            return buckets.map { CanvasGroup(id: $0.key, title: $0.key, icon: "sparkles", sessions: $0.value) }
                .sorted { $0.sessions.count > $1.sessions.count }

        case .byRecent:
            let now = Date()
            var today: [KanbanSessionSummary] = []
            var sevenDays: [KanbanSessionSummary] = []
            var older: [KanbanSessionSummary] = []
            for s in activeSessions {
                let d = s.updatedDate ?? .distantPast
                let hours = now.timeIntervalSince(d) / 3600.0
                if hours <= 24 {
                    today.append(s)
                } else if hours <= 24 * 7 {
                    sevenDays.append(s)
                } else {
                    older.append(s)
                }
            }
            var groups: [CanvasGroup] = []
            if !today.isEmpty { groups.append(CanvasGroup(id: "1d", title: "最近 1 天", icon: "clock.fill", sessions: today)) }
            if !sevenDays.isEmpty { groups.append(CanvasGroup(id: "7d", title: "最近 7 天", icon: "calendar", sessions: sevenDays)) }
            if !older.isEmpty { groups.append(CanvasGroup(id: "older", title: "更早之前", icon: "archivebox", sessions: older)) }
            return groups
        }
    }

    private func statusColor(_ status: KanbanSessionStatus) -> Color {
        switch status {
        case .todo: return .blue
        case .inprogress: return .orange
        case .inreview: return .purple
        case .done: return .green
        case .archived: return .gray
        }
    }

    // MARK: - Actions & Data Loading

    private func reload() async {
        do {
            let loadedProjects = try await client.projects()
            projects = loadedProjects
            let wsIDs: [String]
            if let selectedProjectID,
               let match = loadedProjects.first(where: { $0.id.lowercased() == selectedProjectID.lowercased() })
            {
                wsIDs = match.workspaceIds
                if let wsList = try? await client.kanbanWorkspaces(projectID: match.id) {
                    workspaces = wsList
                }
            } else {
                wsIDs = loadedProjects.flatMap(\.workspaceIds)
            }
            let loadedSessions = try await client.kanbanAllSessions(workspaceIDs: wsIDs)
            sessions = loadedSessions
            errorMessage = nil
            isLoading = false
        } catch {
            errorMessage = describeHostFailure(error)
            isLoading = false
        }
    }

    private func loadMonitorPreviews() async {
        for session in effectiveMonitoredSessions.prefix(6) {
            var state = TranscriptState(conversationID: session.id)
            if (try? await client.refresh(&state)) != nil {
                if let last = state.items.last(where: { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                    monitorPreviews[session.id] = last.text
                }
            }
        }
    }

    private func openSession(_ session: KanbanSessionSummary) {
        if session.completesWhenViewed {
            if let idx = sessions.firstIndex(where: { $0.id == session.id }) {
                sessions[idx].status = .done
            }
            Task {
                try? await client.markSessionViewed(sessionID: session.id)
                await reload()
            }
        }
        path.append(session.asConversationListItem)
    }

    private func performStatusChange(_ session: KanbanSessionSummary, to newStatus: KanbanSessionStatus) {
        let oldStatus = session.status
        if let idx = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[idx].status = newStatus
        }
        Task {
            do {
                try await client.updateSessionStatus(sessionID: session.id, status: newStatus)
                await reload()
            } catch {
                if let idx = sessions.firstIndex(where: { $0.id == session.id }) {
                    sessions[idx].status = oldStatus
                }
                noticeMessage = describeHostFailure(error)
            }
        }
    }

    private func performTogglePin(_ session: KanbanSessionSummary) {
        let nextPinned = !session.isPinned
        if let idx = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[idx].pinnedAt = nextPinned ? ISO8601DateFormatter().string(from: Date()) : nil
        }
        Task {
            do {
                try await client.setSessionPinned(sessionID: session.id, pinned: nextPinned)
                await reload()
            } catch {
                noticeMessage = describeHostFailure(error)
                await reload()
            }
        }
    }

    private func performRename(_ session: KanbanSessionSummary, newName: String) {
        let trimmed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        if let idx = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[idx].name = trimmed.isEmpty ? nil : trimmed
        }
        Task {
            do {
                try await client.renameSession(sessionID: session.id, name: trimmed.isEmpty ? nil : trimmed)
                await reload()
            } catch {
                noticeMessage = describeHostFailure(error)
                await reload()
            }
        }
    }

    private func performDelete(_ session: KanbanSessionSummary) {
        let removed = session
        withAnimation {
            sessions.removeAll { $0.id == session.id }
            monitoredSessionIDs.remove(session.id)
            selectedDeleteIDs.remove(session.id)
        }
        Task {
            do {
                try await client.deleteKanbanSession(sessionID: removed.id)
                await reload()
            } catch {
                noticeMessage = describeHostFailure(error)
                await reload()
            }
        }
    }

    private func performBulkDelete() {
        let ids = Array(selectedDeleteIDs)
        guard !ids.isEmpty else { return }
        withAnimation {
            sessions.removeAll { ids.contains($0.id) }
            selectedDeleteIDs.removeAll()
            isBulkDeleteMode = false
        }
        Task {
            for id in ids {
                try? await client.deleteKanbanSession(sessionID: id)
            }
            noticeMessage = "已删除 \(ids.count) 个会话。"
            await reload()
        }
    }

    private func performFork(_ session: KanbanSessionSummary) {
        Task {
            do {
                if let newID = try await client.forkConversation(conversationID: session.id) {
                    noticeMessage = "已分叉会话"
                    await reload()
                    if let forked = sessions.first(where: { $0.id == newID }) {
                        openSession(forked)
                    }
                }
            } catch {
                noticeMessage = "分叉失败：\(describeHostFailure(error))"
            }
        }
    }

    private func toggleMonitor(_ session: KanbanSessionSummary) {
        if monitoredSessionIDs.contains(session.id) {
            monitoredSessionIDs.remove(session.id)
        } else {
            monitoredSessionIDs.insert(session.id)
        }
    }

    private func copyToClipboard(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }
}

// MARK: - Create Kanban Session Sheet

private struct KanbanCreateSessionSheet: View {
    let client: HostClient
    let projects: [ProjectSummary]
    let initialProjectID: String?
    let initialStatus: KanbanSessionStatus
    let onCreated: (ConversationListItem, KanbanSessionStatus) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedProjectID: String = ""
    @State private var agents: [CatalogAgent] = []
    @State private var selectedAgentID: String = "claude_code"
    @State private var selectedStatus: KanbanSessionStatus = .todo
    @State private var sessionName: String = ""
    @State private var initialPrompt: String = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("归属项目与状态") {
                    Picker("项目", selection: $selectedProjectID) {
                        ForEach(projects) { project in
                            Text(project.displayName).tag(project.id)
                        }
                    }

                    Picker("看板列", selection: $selectedStatus) {
                        ForEach(KanbanSessionStatus.activeColumns) { status in
                            Text(status.title).tag(status)
                        }
                    }
                }

                Section("编程代理") {
                    if agents.isEmpty {
                        HStack {
                            Text("默认代理")
                            Spacer()
                            Text(KanbanSessionSummary.formatAgentDisplayName(selectedAgentID))
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Picker("Agent", selection: $selectedAgentID) {
                            ForEach(agents) { agent in
                                Text(agent.displayName).tag(agent.id)
                            }
                        }
                    }
                }

                Section("会话信息（可选）") {
                    TextField("会话名称（留空则自动生成）", text: $sessionName)
                    TextField("初始消息 / 任务描述（可选）", text: $initialPrompt, axis: .vertical)
                        .lineLimit(3...6)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("新建会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await create() }
                    } label: {
                        if isSubmitting {
                            ProgressView()
                        } else {
                            Text("创建会话")
                        }
                    }
                    .disabled(isSubmitting || selectedWorkspaceID == nil)
                }
            }
            .onAppear {
                selectedStatus = initialStatus
                if selectedProjectID.isEmpty {
                    selectedProjectID = initialProjectID ?? projects.first?.id ?? ""
                }
            }
            .task {
                if let loaded = try? await client.agentCatalog(), !loaded.isEmpty {
                    agents = loaded
                    if let usable = loaded.first(where: \.usable) ?? loaded.first {
                        selectedAgentID = usable.id
                    }
                }
            }
        }
    }

    private var selectedWorkspaceID: String? {
        projects.first { $0.id == selectedProjectID }?.workspaceIds.first
            ?? projects.first?.workspaceIds.first
    }

    private func create() async {
        guard let workspaceID = selectedWorkspaceID else { return }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            var created = try await client.createConversation(
                workspaceID: workspaceID,
                agentID: selectedAgentID
            )
            let trimmedName = sessionName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedName.isEmpty {
                try? await client.renameSession(sessionID: created.id, name: trimmedName)
                created = ConversationListItem(
                    id: created.id,
                    workspace_id: created.workspace_id,
                    title: trimmedName,
                    status: selectedStatus.rawValue,
                    agent_id: created.agent_id,
                    model: created.model,
                    message_count: created.message_count,
                    updated_at: created.updated_at
                )
            }
            let trimmedPrompt = initialPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedPrompt.isEmpty {
                try? await client.sendMessage(
                    conversationID: created.id,
                    workspaceID: workspaceID,
                    agentID: selectedAgentID,
                    text: trimmedPrompt
                )
            }
            dismiss()
            onCreated(created, selectedStatus)
        } catch {
            errorMessage = describeHostFailure(error)
        }
    }
}
