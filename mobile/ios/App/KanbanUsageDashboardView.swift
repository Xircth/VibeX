import CompanionCore
import SwiftUI

struct KanbanUsageDashboardView: View {
    let client: HostClient
    let projects: [ProjectSummary]
    let initialProjectID: String?

    @State private var selectedTarget: String = "global"
    @State private var dateRange: UsageDateRange = .sevenDays
    @State private var activeTab: UsageDashboardTab = .overview
    @State private var statistics: ProjectUsageStatistics?
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var sessionSortBy: SessionUsageSort = .cost

    // Plan usage state
    @State private var selectedPlanAgent: PlanAgentDescriptor = PlanAgentDescriptor.all[0]
    @State private var planUsageByAgent: [String: PlanUsageResponse] = [:]
    @State private var isLoadingPlan = false

    enum SessionUsageSort: String, CaseIterable, Identifiable {
        case cost = "按费用"
        case time = "按时间"
        var id: String { rawValue }
    }

    struct PlanAgentDescriptor: Identifiable, Equatable {
        let id: String
        let title: String
        let sourceNote: String

        static let all: [PlanAgentDescriptor] = [
            PlanAgentDescriptor(
                id: "claude_code",
                title: "Claude Code 套餐",
                sourceNote: "读取设置里的 Claude 订阅凭据"
            ),
            PlanAgentDescriptor(
                id: "codex",
                title: "Codex 套餐",
                sourceNote: "读取已安装的 Codex 与账号限额"
            ),
            PlanAgentDescriptor(
                id: "cursor",
                title: "Cursor 套餐",
                sourceNote: "读取本机 Cursor 登录凭据与官方用量接口"
            ),
            PlanAgentDescriptor(
                id: "grok",
                title: "Grok 套餐",
                sourceNote: "读取本机 Grok 登录凭据与官方套餐接口"
            ),
            PlanAgentDescriptor(
                id: "opencode",
                title: "OpenCode Go 套餐",
                sourceNote: "读取 OpenCode Go 订阅凭据与官方用量接口"
            ),
            PlanAgentDescriptor(
                id: "kimi_code",
                title: "Kimi 套餐",
                sourceNote: "读取 Kimi Code 订阅凭据与官方用量接口"
            ),
            PlanAgentDescriptor(
                id: "antigravity",
                title: "Antigravity 套餐",
                sourceNote: "读取设置里的 Antigravity 订阅凭据"
            ),
        ]
    }

    var body: some View {
        VStack(spacing: 0) {
            filterHeader
            Divider()
            subTabBar
            Divider()

            if activeTab == .plan {
                planTabContent
            } else if isLoading && statistics == nil {
                Spacer()
                ProgressView("正在加载计量统计…")
                Spacer()
            } else if let errorMessage, statistics == nil {
                Spacer()
                LoadFailureView(message: errorMessage) {
                    Task { await reloadStatistics() }
                }
                Spacer()
            } else if let stats = statistics {
                ScrollView {
                    VStack(spacing: 16) {
                        switch activeTab {
                        case .overview:
                            overviewContent(stats)
                        case .folders:
                            foldersContent(stats)
                        case .agents:
                            agentsContent(stats)
                        case .models:
                            modelsContent(stats)
                        case .sessions:
                            sessionsContent(stats)
                        case .plan:
                            EmptyView()
                        }
                    }
                    .padding(16)
                }
                .refreshable {
                    await reloadStatistics()
                }
            } else {
                Spacer()
                ContentUnavailableView("暂无数据", systemImage: "chart.bar.xaxis")
                Spacer()
            }
        }
        .task(id: "\(selectedTarget)-\(dateRange.rawValue)") {
            await reloadStatistics()
        }
        .task(id: activeTab) {
            if activeTab == .plan {
                await loadPlanUsage(for: selectedPlanAgent.id)
            }
        }
        .onAppear {
            if let initialProjectID, !initialProjectID.isEmpty, selectedTarget == "global" {
                selectedTarget = "project:\(initialProjectID)"
            }
        }
    }

    // MARK: - Header Controls

    private var filterHeader: some View {
        HStack(spacing: 10) {
            Menu {
                Button {
                    selectedTarget = "global"
                } label: {
                    HStack {
                        Text("全局")
                        if selectedTarget == "global" { Image(systemName: "checkmark") }
                    }
                }
                ForEach(projects.filter { !$0.isHome }) { project in
                    let target = "project:\(project.id)"
                    Button {
                        selectedTarget = target
                    } label: {
                        HStack {
                            Text(project.displayName)
                            if selectedTarget == target { Image(systemName: "checkmark") }
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: selectedTarget == "global" ? "globe" : "folder")
                        .font(.caption)
                    Text(selectedTargetLabel)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color(.secondarySystemGroupedBackground), in: Capsule())
            }
            .buttonStyle(.plain)

            Spacer()

            if activeTab != .plan {
                Picker("时间范围", selection: $dateRange) {
                    ForEach(UsageDateRange.allCases) { range in
                        Text(range.label).tag(range)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 156)
            }

            Button {
                Task {
                    if activeTab == .plan {
                        await loadPlanUsage(for: selectedPlanAgent.id, force: true)
                    } else {
                        await reloadStatistics()
                    }
                }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.subheadline.weight(.medium))
                    .frame(width: 30, height: 30)
                    .background(Color(.secondarySystemGroupedBackground), in: Circle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(.systemGroupedBackground))
    }

    private var selectedTargetLabel: String {
        if selectedTarget == "global" { return "全局" }
        let id = selectedTarget.replacingOccurrences(of: "project:", with: "")
        return projects.first { $0.id.lowercased() == id.lowercased() }?.displayName ?? "当前项目"
    }

    private var subTabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(UsageDashboardTab.allCases) { tab in
                    let isSelected = activeTab == tab
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            activeTab = tab
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: tab.icon)
                                .font(.caption)
                            Text(tab.label)
                                .font(.footnote.weight(isSelected ? .semibold : .medium))
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .foregroundStyle(isSelected ? Color.white : Color.primary)
                        .background(
                            isSelected ? Color.accentColor : Color(.secondarySystemGroupedBackground),
                            in: Capsule()
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .background(Color(.systemGroupedBackground))
    }

    // MARK: - Overview Tab

    @ViewBuilder
    private func overviewContent(_ stats: ProjectUsageStatistics) -> some View {
        let preferredTokens = stats.totalTokens.preferred

        // Summary Metric Grid
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            metricCard(
                title: "总费用",
                value: Self.formatCost(stats.resolvedCost),
                subtitle: stats.totalSessions > 0 && stats.resolvedCost != nil
                    ? "平均 \(Self.formatCost((stats.resolvedCost ?? 0) / Double(stats.totalSessions)))/会话"
                    : "按协议与日志估算",
                icon: "dollarsign.circle.fill",
                tint: .green
            )
            metricCard(
                title: "总会话",
                value: "\(stats.totalSessions)",
                subtitle: "\(stats.activeDaysCount) 个活跃日",
                icon: "bubble.left.and.bubble.right.fill",
                tint: .blue
            )
            metricCard(
                title: "总 Token",
                value: Self.formatTokens(preferredTokens.resolvedTotal),
                subtitle: "平均每次 \(Self.formatTokens(stats.avgTokensPerSession)) Token",
                icon: "cpu.fill",
                tint: .purple
            )
            metricCard(
                title: "缓存命中率",
                value: stats.cacheHitRatePercent.map { String(format: "%.1f%%", $0) } ?? "--",
                subtitle: "缓存读取 \(Self.formatTokens(preferredTokens.cacheReadTokens ?? 0))",
                icon: "bolt.horizontal.circle.fill",
                tint: .orange
            )
        }

        // Token Composition
        VStack(alignment: .leading, spacing: 12) {
            Text("Token 构成")
                .font(.subheadline.weight(.semibold))

            let total = max(1, Double(preferredTokens.resolvedTotal))
            let items: [(String, Int64, Color)] = [
                ("输入", preferredTokens.inputTokens ?? 0, .blue),
                ("输出", preferredTokens.outputTokens ?? 0, .purple),
                ("缓存写入", preferredTokens.cacheWriteTokens ?? 0, .orange),
                ("缓存读取", preferredTokens.cacheReadTokens ?? 0, .green),
            ]

            ForEach(items, id: \.0) { label, count, color in
                VStack(spacing: 4) {
                    HStack {
                        Circle()
                            .fill(color)
                            .frame(width: 8, height: 8)
                        Text(label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(Self.formatTokens(count))
                            .font(.caption.monospacedDigit().weight(.medium))
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(Color(.systemFill))
                            Capsule()
                                .fill(color)
                                .frame(width: max(4, geo.size.width * CGFloat(Double(count) / total)))
                        }
                    }
                    .frame(height: 6)
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))

        // Daily Trend
        if !stats.dailyUsage.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("用量趋势")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("\(stats.dailyUsage.count) 天")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                let maxTokens = max(
                    1,
                    stats.dailyUsage.map { $0.tokens.preferred.resolvedTotal }.max() ?? 1
                )

                ForEach(stats.dailyUsage.suffix(14).reversed()) { day in
                    let dayTokens = day.tokens.preferred.resolvedTotal
                    VStack(spacing: 4) {
                        HStack {
                            Text(day.date)
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text("\(day.sessions) 会话")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text("\(Self.formatTokens(dayTokens)) Token")
                                .font(.caption.monospacedDigit().weight(.medium))
                            if let cost = day.cost {
                                Text(Self.formatCost(cost))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.green)
                            }
                        }
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule()
                                    .fill(Color(.systemFill))
                                Capsule()
                                    .fill(Color.accentColor)
                                    .frame(
                                        width: dayTokens > 0
                                            ? max(4, geo.size.width * CGFloat(Double(dayTokens) / Double(maxTokens)))
                                            : 0
                                    )
                            }
                        }
                        .frame(height: 6)
                    }
                }
            }
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        }

        // Top Models & Top Agents quick view
        if !stats.byModel.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("常用模型")
                    .font(.subheadline.weight(.semibold))
                ForEach(stats.byModel.prefix(5)) { item in
                    HStack {
                        Text(item.model)
                            .font(.footnote.weight(.medium))
                            .lineLimit(1)
                        Spacer()
                        Text("\(item.sessionCount) 会话")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(Self.formatTokens(item.tokens.preferred.resolvedTotal))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                        if let cost = item.cost {
                            Text(Self.formatCost(cost))
                                .font(.caption.monospacedDigit().weight(.semibold))
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
        }
    }

    // MARK: - Folders Tab

    @ViewBuilder
    private func foldersContent(_ stats: ProjectUsageStatistics) -> some View {
        if stats.byFolder.isEmpty {
            ContentUnavailableView("暂无目录数据", systemImage: "folder")
                .padding(.top, 40)
        } else {
            ForEach(stats.byFolder) { item in
                let counts = item.tokens.preferred
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: "folder.fill")
                            .foregroundStyle(.blue)
                        Text(item.displayName)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        Spacer()
                        if let cost = item.cost {
                            Text(Self.formatCost(cost))
                                .font(.subheadline.monospacedDigit().weight(.semibold))
                                .foregroundStyle(.green)
                        }
                    }
                    if let folder = item.folder, !folder.isEmpty {
                        Text(folder)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    HStack(spacing: 12) {
                        Label("\(item.sessionCount) 会话", systemImage: "bubble.left.and.bubble.right")
                        Label("总 Token: \(Self.formatTokens(counts.resolvedTotal))", systemImage: "cpu")
                        Spacer()
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(14)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    // MARK: - Agents Tab

    @ViewBuilder
    private func agentsContent(_ stats: ProjectUsageStatistics) -> some View {
        if stats.byAgent.isEmpty {
            ContentUnavailableView("暂无 Agent 数据", systemImage: "bolt")
                .padding(.top, 40)
        } else {
            ForEach(stats.byAgent) { item in
                let counts = item.tokens.preferred
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: "sparkles")
                            .foregroundStyle(.purple)
                        Text(item.displayName)
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        if let cost = item.cost {
                            Text(Self.formatCost(cost))
                                .font(.subheadline.monospacedDigit().weight(.semibold))
                                .foregroundStyle(.green)
                        }
                    }
                    HStack(spacing: 12) {
                        Text("\(item.sessionCount) 会话")
                        Text("输入: \(Self.formatTokens(counts.inputTokens ?? 0))")
                        Text("输出: \(Self.formatTokens(counts.outputTokens ?? 0))")
                        Text("总计: \(Self.formatTokens(counts.resolvedTotal))")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(14)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    // MARK: - Models Tab

    @ViewBuilder
    private func modelsContent(_ stats: ProjectUsageStatistics) -> some View {
        if stats.byModel.isEmpty {
            ContentUnavailableView("暂无模型数据", systemImage: "number")
                .padding(.top, 40)
        } else {
            ForEach(stats.byModel) { item in
                let counts = item.tokens.preferred
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Image(systemName: "cube.transparent.fill")
                            .foregroundStyle(.indigo)
                        Text(item.model)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        Spacer()
                        if let cost = item.cost {
                            Text(Self.formatCost(cost))
                                .font(.subheadline.monospacedDigit().weight(.semibold))
                                .foregroundStyle(.green)
                        }
                    }
                    HStack(spacing: 12) {
                        Text("\(item.sessionCount) 会话")
                        Text("输入: \(Self.formatTokens(counts.inputTokens ?? 0))")
                        Text("输出: \(Self.formatTokens(counts.outputTokens ?? 0))")
                        Text("总 Token: \(Self.formatTokens(counts.resolvedTotal))")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(14)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    // MARK: - Sessions Tab

    @ViewBuilder
    private func sessionsContent(_ stats: ProjectUsageStatistics) -> some View {
        let sorted = stats.sessions.sorted { left, right in
            switch sessionSortBy {
            case .cost:
                return (left.cost ?? -1) > (right.cost ?? -1)
            case .time:
                return left.timestamp > right.timestamp
            }
        }

        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("会话列表 (\(sorted.count))")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Picker("排序", selection: $sessionSortBy) {
                    ForEach(SessionUsageSort.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 140)
            }

            if sorted.isEmpty {
                ContentUnavailableView("暂无会话数据", systemImage: "list.bullet")
                    .padding(.top, 32)
            } else {
                ForEach(sorted.prefix(50)) { item in
                    let counts = item.tokens.preferred
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(item.displayTitle)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                            Spacer()
                            if let cost = item.cost {
                                Text(Self.formatCost(cost))
                                    .font(.footnote.monospacedDigit().weight(.semibold))
                                    .foregroundStyle(.green)
                            }
                        }
                        HStack(spacing: 8) {
                            if let agent = item.agentId, !agent.isEmpty {
                                Text(KanbanSessionSummary.formatAgentDisplayName(agent))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                            }
                            if let model = item.model, !model.isEmpty {
                                Text(model)
                                    .lineLimit(1)
                            }
                            if let turns = item.turns, turns > 0 {
                                Text("\(turns) 轮次")
                            }
                            Text("\(Self.formatTokens(counts.resolvedTotal)) Token")
                            Spacer()
                            Text(item.date, style: .relative)
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    // MARK: - Plan Usage Tab

    private var planTabContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(PlanAgentDescriptor.all) { descriptor in
                            let isSelected = selectedPlanAgent.id == descriptor.id
                            Button {
                                selectedPlanAgent = descriptor
                                Task { await loadPlanUsage(for: descriptor.id) }
                            } label: {
                                Text(KanbanSessionSummary.formatAgentDisplayName(descriptor.id))
                                    .font(.footnote.weight(isSelected ? .semibold : .medium))
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 7)
                                    .foregroundStyle(isSelected ? Color.white : Color.primary)
                                    .background(
                                        isSelected
                                            ? Color.accentColor
                                            : Color(.secondarySystemGroupedBackground),
                                        in: Capsule()
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(selectedPlanAgent.title)
                                .font(.headline)
                            Text(selectedPlanAgent.sourceNote)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if case .ok(let usage) = planUsageByAgent[selectedPlanAgent.id],
                           let planType = usage.planType, !planType.isEmpty
                        {
                            Text("\(planType.uppercased()) 套餐")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.accentColor.opacity(0.15), in: Capsule())
                        }
                    }

                    if isLoadingPlan && planUsageByAgent[selectedPlanAgent.id] == nil {
                        HStack {
                            Spacer()
                            ProgressView("正在读取额度…")
                            Spacer()
                        }
                        .padding(.vertical, 24)
                    } else if let response = planUsageByAgent[selectedPlanAgent.id] {
                        switch response {
                        case .ok(let usage):
                            if usage.windows.isEmpty {
                                Text("账号未返回任何限额窗口")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .padding(.vertical, 12)
                            } else {
                                ForEach(usage.windows) { window in
                                    planWindowRow(window)
                                }
                            }
                            if let credits = usage.credits {
                                HStack(spacing: 8) {
                                    Image(systemName: "creditcard")
                                        .foregroundStyle(.secondary)
                                    Text(
                                        credits.unlimited
                                            ? "额度不限量"
                                            : "赠送额度余额：\(credits.balance ?? "--")"
                                    )
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                }
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
                            }
                        case .unavailable:
                            HStack(spacing: 8) {
                                Image(systemName: "info.circle")
                                    .foregroundStyle(.secondary)
                                Text(response.unavailableDescription ?? "暂不可用")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 12)
                        case .error(let msg):
                            HStack(spacing: 8) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.orange)
                                Text(msg)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 12)
                        }
                    }
                }
                .padding(16)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
            }
            .padding(16)
        }
    }

    @ViewBuilder
    private func planWindowRow(_ window: PlanUsageWindow) -> some View {
        let used = window.clampedUsedPercent
        let remaining = window.remainingPercent
        let barColor: Color = {
            guard let used else { return .accentColor }
            if used >= 90 { return .red }
            if used >= 70 { return .orange }
            return .accentColor
        }()

        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(window.localizedTitle)
                        .font(.subheadline.weight(.semibold))
                    if let reset = window.resetLabel() {
                        Text(reset)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(used.map { "已用 \($0)%" } ?? "--")
                        .font(.subheadline.monospacedDigit().weight(.semibold))
                    Text(remaining.map { "剩余 \($0)%" } ?? "--")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color(.systemFill))
                    Capsule()
                        .fill(barColor)
                        .frame(width: geo.size.width * CGFloat(Double(used ?? 0) / 100.0))
                }
            }
            .frame(height: 8)
        }
        .padding(12)
        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Helpers

    private func metricCard(
        title: String,
        value: String,
        subtitle: String,
        icon: String,
        tint: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: icon)
                    .foregroundStyle(tint)
                    .font(.subheadline)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            Text(value)
                .font(.title3.monospacedDigit().weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func reloadStatistics() async {
        isLoading = true
        defer { isLoading = false }
        let scope = selectedTarget == "global" ? "global" : "project"
        let projectID = selectedTarget == "global"
            ? nil
            : selectedTarget.replacingOccurrences(of: "project:", with: "")
        do {
            statistics = try await client.projectUsageStatistics(
                scope: scope,
                projectID: projectID,
                dateRange: dateRange
            )
            errorMessage = nil
        } catch {
            errorMessage = describeHostFailure(error)
        }
    }

    private func loadPlanUsage(for agentID: String, force: Bool = false) async {
        if !force, planUsageByAgent[agentID] != nil { return }
        isLoadingPlan = true
        defer { isLoadingPlan = false }
        do {
            let res = try await client.agentPlanUsage(agentID: agentID)
            planUsageByAgent[agentID] = res
        } catch {
            planUsageByAgent[agentID] = .error(message: describeHostFailure(error))
        }
    }

    static func formatCost(_ cost: Double?) -> String {
        guard let cost else { return "--" }
        if cost == 0 { return "$0.00" }
        if cost < 0.01 { return String(format: "$%.4f", cost) }
        return String(format: "$%.2f", cost)
    }

    static func formatTokens(_ count: Int64) -> String {
        if count >= 1_000_000_000 {
            return String(format: "%.2fB", Double(count) / 1_000_000_000.0)
        }
        if count >= 1_000_000 {
            return String(format: "%.2fM", Double(count) / 1_000_000.0)
        }
        if count >= 1_000 {
            return String(format: "%.1fK", Double(count) / 1_000.0)
        }
        return "\(count)"
    }
}
