import Foundation

// MARK: - Kanban View & Status Enums

public enum KanbanViewMode: String, CaseIterable, Identifiable, Sendable {
    case columns
    case sessionHub
    case usage

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .columns: return "四栏看板"
        case .sessionHub: return "会话中心"
        case .usage: return "计量统计"
        }
    }

    public var icon: String {
        switch self {
        case .columns: return "rectangle.split.3x1"
        case .sessionHub: return "list.bullet.rectangle.portrait"
        case .usage: return "chart.bar.xaxis"
        }
    }
}

public enum KanbanSessionStatus: String, CaseIterable, Codable, Identifiable, Sendable {
    case todo
    case inprogress
    case inreview
    case done
    case archived

    public var id: String { rawValue }

    public static let activeColumns: [KanbanSessionStatus] = [
        .todo, .inprogress, .inreview, .done,
    ]

    public init(rawStatus: String?) {
        guard let raw = rawStatus?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else {
            self = .todo
            return
        }
        switch raw {
        case "inprogress", "in_progress", "running":
            self = .inprogress
        case "inreview", "in_review", "review":
            self = .inreview
        case "done", "completed", "complete":
            self = .done
        case "archived", "archive":
            self = .archived
        default:
            self = .todo
        }
    }

    public var title: String {
        switch self {
        case .todo: return "待开始"
        case .inprogress: return "进行中"
        case .inreview: return "待检查"
        case .done: return "已完成"
        case .archived: return "已归档"
        }
    }

    public var columnHeaderLabel: String {
        switch self {
        case .todo: return "TODO"
        case .inprogress: return "IN PROGRESS"
        case .inreview: return "IN REVIEW"
        case .done: return "DONE"
        case .archived: return "ARCHIVED"
        }
    }

    public var sortOrder: Int {
        switch self {
        case .todo: return 0
        case .inprogress: return 1
        case .inreview: return 2
        case .done: return 3
        case .archived: return 4
        }
    }
}

public enum KanbanSortField: String, CaseIterable, Identifiable, Sendable {
    case defaultOrder
    case name
    case time
    case status
    case agent

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .defaultOrder: return "默认顺序"
        case .name: return "名称"
        case .time: return "时间"
        case .status: return "状态"
        case .agent: return "Agent"
        }
    }
}

// MARK: - Kanban Session & Workspace Models

public struct KanbanSessionCollaboration: Decodable, Equatable, Hashable, Sendable {
    public let memberId: String?
    public let memberName: String?
    public let threadId: String?
    public let threadKind: String?
    public let threadName: String?

    private enum CodingKeys: String, CodingKey {
        case memberId, member_id
        case memberName, member_name
        case threadId, thread_id
        case threadKind, thread_kind
        case threadName, thread_name
    }

    public init(
        memberId: String? = nil,
        memberName: String? = nil,
        threadId: String? = nil,
        threadKind: String? = nil,
        threadName: String? = nil
    ) {
        self.memberId = memberId
        self.memberName = memberName
        self.threadId = threadId
        self.threadKind = threadKind
        self.threadName = threadName
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memberId = (try? c.decodeIfPresent(String.self, forKey: .memberId))
            ?? (try? c.decodeIfPresent(String.self, forKey: .member_id))
        memberName = (try? c.decodeIfPresent(String.self, forKey: .memberName))
            ?? (try? c.decodeIfPresent(String.self, forKey: .member_name))
        threadId = (try? c.decodeIfPresent(String.self, forKey: .threadId))
            ?? (try? c.decodeIfPresent(String.self, forKey: .thread_id))
        threadKind = (try? c.decodeIfPresent(String.self, forKey: .threadKind))
            ?? (try? c.decodeIfPresent(String.self, forKey: .thread_kind))
        threadName = (try? c.decodeIfPresent(String.self, forKey: .threadName))
            ?? (try? c.decodeIfPresent(String.self, forKey: .thread_name))
    }
}

public struct KanbanSessionSummary: Decodable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let workspaceId: String
    public let taskId: String?
    public var name: String?
    public let displayName: String?
    public var status: KanbanSessionStatus
    public let executor: String?
    public let agentId: String?
    public let workspaceName: String?
    public let workspaceBranch: String?
    public let createdAt: String
    public var updatedAt: String
    public let firstPrompt: String?
    public var isRunning: Bool
    public var pinnedAt: String?
    public let model: String?
    public let collaboration: KanbanSessionCollaboration?

    private enum CodingKeys: String, CodingKey {
        case id
        case workspaceId, workspace_id
        case taskId, task_id
        case name
        case displayName, display_name
        case status
        case executor
        case agentId, agent_id
        case workspaceName, workspace_name
        case workspaceBranch, workspace_branch
        case createdAt, created_at
        case updatedAt, updated_at
        case firstPrompt, first_prompt
        case isRunning, is_running
        case pinnedAt, pinned_at
        case model
        case collaboration
    }

    public init(
        id: String,
        workspaceId: String,
        taskId: String? = nil,
        name: String? = nil,
        displayName: String? = nil,
        status: KanbanSessionStatus = .todo,
        executor: String? = nil,
        agentId: String? = nil,
        workspaceName: String? = nil,
        workspaceBranch: String? = nil,
        createdAt: String = "",
        updatedAt: String = "",
        firstPrompt: String? = nil,
        isRunning: Bool = false,
        pinnedAt: String? = nil,
        model: String? = nil,
        collaboration: KanbanSessionCollaboration? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.taskId = taskId
        self.name = name
        self.displayName = displayName
        self.status = status
        self.executor = executor
        self.agentId = agentId
        self.workspaceName = workspaceName
        self.workspaceBranch = workspaceBranch
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.firstPrompt = firstPrompt
        self.isRunning = isRunning
        self.pinnedAt = pinnedAt
        self.model = model
        self.collaboration = collaboration
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workspaceId = (try? c.decode(String.self, forKey: .workspaceId))
            ?? (try? c.decode(String.self, forKey: .workspace_id))
            ?? ""
        taskId = (try? c.decodeIfPresent(String.self, forKey: .taskId))
            ?? (try? c.decodeIfPresent(String.self, forKey: .task_id))
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        displayName = (try? c.decodeIfPresent(String.self, forKey: .displayName))
            ?? (try? c.decodeIfPresent(String.self, forKey: .display_name))
        let rawStatus = try? c.decodeIfPresent(String.self, forKey: .status)
        status = KanbanSessionStatus(rawStatus: rawStatus)
        executor = try? c.decodeIfPresent(String.self, forKey: .executor)
        agentId = (try? c.decodeIfPresent(String.self, forKey: .agentId))
            ?? (try? c.decodeIfPresent(String.self, forKey: .agent_id))
        workspaceName = (try? c.decodeIfPresent(String.self, forKey: .workspaceName))
            ?? (try? c.decodeIfPresent(String.self, forKey: .workspace_name))
        workspaceBranch = (try? c.decodeIfPresent(String.self, forKey: .workspaceBranch))
            ?? (try? c.decodeIfPresent(String.self, forKey: .workspace_branch))
        createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt))
            ?? (try? c.decodeIfPresent(String.self, forKey: .created_at))
            ?? ""
        updatedAt = (try? c.decodeIfPresent(String.self, forKey: .updatedAt))
            ?? (try? c.decodeIfPresent(String.self, forKey: .updated_at))
            ?? createdAt
        firstPrompt = (try? c.decodeIfPresent(String.self, forKey: .firstPrompt))
            ?? (try? c.decodeIfPresent(String.self, forKey: .first_prompt))
        isRunning = (try? c.decodeIfPresent(Bool.self, forKey: .isRunning))
            ?? (try? c.decodeIfPresent(Bool.self, forKey: .is_running))
            ?? false
        pinnedAt = (try? c.decodeIfPresent(String.self, forKey: .pinnedAt))
            ?? (try? c.decodeIfPresent(String.self, forKey: .pinned_at))
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        collaboration = try? c.decodeIfPresent(KanbanSessionCollaboration.self, forKey: .collaboration)
    }

    public init(fromConversation item: ConversationListItem) {
        self.id = item.id
        self.workspaceId = item.workspace_id
        self.taskId = nil
        self.name = item.title
        self.displayName = item.title
        self.status = KanbanSessionStatus(rawStatus: item.status)
        self.executor = item.agent_id
        self.agentId = item.agent_id
        self.workspaceName = nil
        self.workspaceBranch = nil
        self.createdAt = item.updated_at
        self.updatedAt = item.updated_at
        self.firstPrompt = nil
        self.isRunning = item.status?.lowercased() == "running"
        self.pinnedAt = nil
        self.model = item.model
        self.collaboration = nil
    }

    public var isPinned: Bool {
        guard let pinnedAt else { return false }
        return !pinnedAt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var isArchived: Bool { status == .archived }
    public var isCompleted: Bool { status == .done }
    public var completesWhenViewed: Bool { status == .inreview && !isRunning }

    public var resolvedTitle: String {
        if let n = name?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty {
            return n
        }
        if let p = firstPrompt?.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines), !p.isEmpty
        {
            return p
        }
        if let d = displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !d.isEmpty {
            return d
        }
        return "新会话"
    }

    public var effectiveAgentKey: String? {
        if let a = agentId?.trimmingCharacters(in: .whitespacesAndNewlines), !a.isEmpty { return a }
        if let e = executor?.trimmingCharacters(in: .whitespacesAndNewlines), !e.isEmpty { return e }
        return nil
    }

    public var agentDisplayName: String {
        Self.formatAgentDisplayName(effectiveAgentKey)
    }

    public static func formatAgentDisplayName(_ rawKey: String?) -> String {
        guard let key = rawKey?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else {
            return "未设置代理"
        }
        switch key.lowercased() {
        case "claude_code", "claude-code", "claude": return "Claude Code"
        case "codex": return "Codex"
        case "gemini", "gemini_cli", "gemini-cli": return "Gemini"
        case "cursor", "cursor_agent": return "Cursor"
        case "grok", "grok_cli": return "Grok"
        case "opencode", "open_code": return "OpenCode"
        case "kimi", "kimi_code", "kimi-code": return "Kimi"
        case "antigravity": return "Antigravity"
        case "deepseek_harness", "deepseek-harness", "deepseek": return "DeepSeek"
        case "pi": return "Pi"
        case "qwen", "qwen_code": return "Qwen"
        default: return key
        }
    }

    public var workspaceDisplayLabel: String {
        if let wn = workspaceName?.trimmingCharacters(in: .whitespacesAndNewlines), !wn.isEmpty {
            return wn
        }
        if let wb = workspaceBranch?.trimmingCharacters(in: .whitespacesAndNewlines), !wb.isEmpty {
            return wb
        }
        return ""
    }

    public var updatedDate: Date? {
        ConversationListItem.parseDate(updatedAt) ?? ConversationListItem.parseDate(createdAt)
    }

    public var asConversationListItem: ConversationListItem {
        ConversationListItem(
            id: id,
            workspace_id: workspaceId,
            title: resolvedTitle,
            status: status.rawValue,
            agent_id: effectiveAgentKey,
            model: model,
            message_count: 0,
            updated_at: updatedAt
        )
    }

    public var isForkSupported: Bool {
        guard let key = effectiveAgentKey?.lowercased() else { return false }
        return ["claude_code", "claude-code", "codex", "deepseek_harness", "deepseek-harness"].contains(key)
    }

    public var sessionInfoText: String {
        let ws = workspaceDisplayLabel.isEmpty ? "-" : workspaceDisplayLabel
        return [
            "会话名称: \(resolvedTitle)",
            "ID: \(id)",
            "Agent: \(agentDisplayName)",
            "工作区: \(ws)",
        ].joined(separator: "\n")
    }
}

public struct KanbanWorkspaceRecord: Decodable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let projectId: String
    public let branch: String
    public let name: String?
    public let useWorktree: Bool
    public let archived: Bool
    public let pinned: Bool

    private enum CodingKeys: String, CodingKey {
        case id
        case projectId, project_id
        case branch
        case name
        case useWorktree, use_worktree
        case archived
        case pinned
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        projectId = (try? c.decode(String.self, forKey: .projectId))
            ?? (try? c.decode(String.self, forKey: .project_id))
            ?? ""
        branch = (try? c.decode(String.self, forKey: .branch)) ?? ""
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        useWorktree = (try? c.decodeIfPresent(Bool.self, forKey: .useWorktree))
            ?? (try? c.decodeIfPresent(Bool.self, forKey: .use_worktree))
            ?? false
        archived = (try? c.decodeIfPresent(Bool.self, forKey: .archived)) ?? false
        pinned = (try? c.decodeIfPresent(Bool.self, forKey: .pinned)) ?? false
    }

    public var displayLabel: String {
        if let n = name?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty {
            return n
        }
        if !branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return branch
        }
        return "默认工作区"
    }
}

// MARK: - Usage Dashboard Models (`get_project_usage_statistics` & `agent_plan_usage`)

public enum UsageDateRange: String, CaseIterable, Identifiable, Sendable {
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case all = "all"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .sevenDays: return "7天"
        case .thirtyDays: return "30天"
        case .all: return "全部"
        }
    }
}

public enum UsageDashboardTab: String, CaseIterable, Identifiable, Sendable {
    case overview
    case folders
    case agents
    case models
    case sessions
    case plan

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .overview: return "概览"
        case .folders: return "目录"
        case .agents: return "Agent"
        case .models: return "模型"
        case .sessions: return "会话"
        case .plan: return "套餐"
        }
    }

    public var icon: String {
        switch self {
        case .overview: return "chart.line.uptrend.xyaxis"
        case .folders: return "folder"
        case .agents: return "bolt.fill"
        case .models: return "number"
        case .sessions: return "list.bullet"
        case .plan: return "shippingbox"
        }
    }
}

public struct UsageTokenCounts: Decodable, Equatable, Sendable {
    public let inputTokens: Int64?
    public let outputTokens: Int64?
    public let cacheWriteTokens: Int64?
    public let cacheReadTokens: Int64?
    public let totalTokens: Int64?

    private enum CodingKeys: String, CodingKey {
        case inputTokens, input_tokens
        case outputTokens, output_tokens
        case cacheWriteTokens, cache_write_tokens
        case cacheReadTokens, cache_read_tokens
        case totalTokens, total_tokens
    }

    public init(
        inputTokens: Int64? = nil,
        outputTokens: Int64? = nil,
        cacheWriteTokens: Int64? = nil,
        cacheReadTokens: Int64? = nil,
        totalTokens: Int64? = nil
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.cacheReadTokens = cacheReadTokens
        self.totalTokens = totalTokens
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = (try? c.decodeIfPresent(Int64.self, forKey: .inputTokens))
            ?? (try? c.decodeIfPresent(Int64.self, forKey: .input_tokens))
        outputTokens = (try? c.decodeIfPresent(Int64.self, forKey: .outputTokens))
            ?? (try? c.decodeIfPresent(Int64.self, forKey: .output_tokens))
        cacheWriteTokens = (try? c.decodeIfPresent(Int64.self, forKey: .cacheWriteTokens))
            ?? (try? c.decodeIfPresent(Int64.self, forKey: .cache_write_tokens))
        cacheReadTokens = (try? c.decodeIfPresent(Int64.self, forKey: .cacheReadTokens))
            ?? (try? c.decodeIfPresent(Int64.self, forKey: .cache_read_tokens))
        totalTokens = (try? c.decodeIfPresent(Int64.self, forKey: .totalTokens))
            ?? (try? c.decodeIfPresent(Int64.self, forKey: .total_tokens))
    }

    public var resolvedTotal: Int64 {
        if let totalTokens, totalTokens > 0 { return totalTokens }
        return (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheWriteTokens ?? 0) + (cacheReadTokens ?? 0)
    }
}

public struct UsageSourcedTokens: Decodable, Equatable, Sendable {
    public let protocolTokens: UsageTokenCounts?
    public let vendorLog: UsageTokenCounts?
    public let sourcesDisagree: Bool

    private enum CodingKeys: String, CodingKey {
        case protocolTokens = "protocol"
        case vendorLog, vendor_log
        case sourcesDisagree, sources_disagree
    }

    public init(
        protocolTokens: UsageTokenCounts? = nil,
        vendorLog: UsageTokenCounts? = nil,
        sourcesDisagree: Bool = false
    ) {
        self.protocolTokens = protocolTokens
        self.vendorLog = vendorLog
        self.sourcesDisagree = sourcesDisagree
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolTokens = try? c.decodeIfPresent(UsageTokenCounts.self, forKey: .protocolTokens)
        vendorLog = (try? c.decodeIfPresent(UsageTokenCounts.self, forKey: .vendorLog))
            ?? (try? c.decodeIfPresent(UsageTokenCounts.self, forKey: .vendor_log))
        sourcesDisagree = (try? c.decodeIfPresent(Bool.self, forKey: .sourcesDisagree))
            ?? (try? c.decodeIfPresent(Bool.self, forKey: .sources_disagree))
            ?? false
    }

    public var preferred: UsageTokenCounts {
        if let v = vendorLog, v.resolvedTotal > 0 { return v }
        if let p = protocolTokens, p.resolvedTotal > 0 { return p }
        return vendorLog ?? protocolTokens ?? UsageTokenCounts()
    }
}

public struct UsageDailyItem: Decodable, Identifiable, Equatable, Sendable {
    public let date: String
    public let sessions: Int
    public let tokens: UsageSourcedTokens
    public let cost: Double?
    public let modelsUsed: [String]
    public let turns: Int?

    public var id: String { date }

    private enum CodingKeys: String, CodingKey {
        case date, sessions, tokens, cost
        case modelsUsed, models_used
        case turns
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = (try? c.decode(String.self, forKey: .date)) ?? ""
        sessions = (try? c.decode(Int.self, forKey: .sessions)) ?? 0
        tokens = (try? c.decode(UsageSourcedTokens.self, forKey: .tokens)) ?? UsageSourcedTokens()
        cost = try? c.decodeIfPresent(Double.self, forKey: .cost)
        modelsUsed = (try? c.decode([String].self, forKey: .modelsUsed))
            ?? (try? c.decode([String].self, forKey: .models_used))
            ?? []
        turns = try? c.decodeIfPresent(Int.self, forKey: .turns)
    }
}

public struct UsageModelItem: Decodable, Identifiable, Equatable, Sendable {
    public let model: String
    public let sessionCount: Int
    public let tokens: UsageSourcedTokens
    public let cost: Double?

    public var id: String { model }

    private enum CodingKeys: String, CodingKey {
        case model
        case sessionCount, session_count
        case tokens, cost
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = (try? c.decode(String.self, forKey: .model)) ?? "未提供"
        sessionCount = (try? c.decode(Int.self, forKey: .sessionCount))
            ?? (try? c.decode(Int.self, forKey: .session_count))
            ?? 0
        tokens = (try? c.decode(UsageSourcedTokens.self, forKey: .tokens)) ?? UsageSourcedTokens()
        cost = try? c.decodeIfPresent(Double.self, forKey: .cost)
    }
}

public struct UsageFolderItem: Decodable, Identifiable, Equatable, Sendable {
    public let workspaceId: String
    public let folder: String?
    public let sessionCount: Int
    public let tokens: UsageSourcedTokens
    public let cost: Double?

    public var id: String { "\(workspaceId)-\(folder ?? "")" }

    private enum CodingKeys: String, CodingKey {
        case workspaceId, workspace_id
        case folder
        case sessionCount, session_count
        case tokens, cost
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspaceId = (try? c.decode(String.self, forKey: .workspaceId))
            ?? (try? c.decode(String.self, forKey: .workspace_id))
            ?? ""
        folder = try? c.decodeIfPresent(String.self, forKey: .folder)
        sessionCount = (try? c.decode(Int.self, forKey: .sessionCount))
            ?? (try? c.decode(Int.self, forKey: .session_count))
            ?? 0
        tokens = (try? c.decode(UsageSourcedTokens.self, forKey: .tokens)) ?? UsageSourcedTokens()
        cost = try? c.decodeIfPresent(Double.self, forKey: .cost)
    }

    public var displayName: String {
        if let folder, !folder.isEmpty {
            let name = (folder as NSString).lastPathComponent
            if !name.isEmpty && name != "/" { return name }
            return folder
        }
        return workspaceId.isEmpty ? "默认工作区" : String(workspaceId.prefix(8))
    }
}

public struct UsageAgentItem: Decodable, Identifiable, Equatable, Sendable {
    public let agentId: String
    public let sessionCount: Int
    public let tokens: UsageSourcedTokens
    public let cost: Double?

    public var id: String { agentId }

    private enum CodingKeys: String, CodingKey {
        case agentId, agent_id
        case sessionCount, session_count
        case tokens, cost
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = (try? c.decode(String.self, forKey: .agentId))
            ?? (try? c.decode(String.self, forKey: .agent_id))
            ?? "unprovided"
        sessionCount = (try? c.decode(Int.self, forKey: .sessionCount))
            ?? (try? c.decode(Int.self, forKey: .session_count))
            ?? 0
        tokens = (try? c.decode(UsageSourcedTokens.self, forKey: .tokens)) ?? UsageSourcedTokens()
        cost = try? c.decodeIfPresent(Double.self, forKey: .cost)
    }

    public var displayName: String {
        KanbanSessionSummary.formatAgentDisplayName(agentId)
    }
}

public struct UsageSessionItem: Decodable, Identifiable, Equatable, Sendable {
    public let sessionId: String
    public let workspaceId: String
    public let folder: String?
    public let agentId: String?
    public let timestamp: Int64
    public let model: String?
    public let tokens: UsageSourcedTokens
    public let cost: Double?
    public let summary: String?
    public let turns: Int?

    public var id: String { sessionId }

    private enum CodingKeys: String, CodingKey {
        case sessionId, session_id
        case workspaceId, workspace_id
        case folder
        case agentId, agent_id
        case timestamp, model, tokens, cost, summary, turns
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = (try? c.decode(String.self, forKey: .sessionId))
            ?? (try? c.decode(String.self, forKey: .session_id))
            ?? UUID().uuidString
        workspaceId = (try? c.decode(String.self, forKey: .workspaceId))
            ?? (try? c.decode(String.self, forKey: .workspace_id))
            ?? ""
        folder = try? c.decodeIfPresent(String.self, forKey: .folder)
        agentId = (try? c.decodeIfPresent(String.self, forKey: .agentId))
            ?? (try? c.decodeIfPresent(String.self, forKey: .agent_id))
        timestamp = (try? c.decode(Int64.self, forKey: .timestamp)) ?? 0
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        tokens = (try? c.decode(UsageSourcedTokens.self, forKey: .tokens)) ?? UsageSourcedTokens()
        cost = try? c.decodeIfPresent(Double.self, forKey: .cost)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        turns = try? c.decodeIfPresent(Int.self, forKey: .turns)
    }

    public var displayTitle: String {
        if let s = summary?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
            return s
        }
        return "会话 \(sessionId.prefix(8))"
    }

    public var date: Date {
        let seconds = timestamp > 10_000_000_000 ? Double(timestamp) / 1000.0 : Double(timestamp)
        return Date(timeIntervalSince1970: seconds)
    }
}

public struct ProjectUsageStatistics: Decodable, Equatable, Sendable {
    public let scope: String
    public let projectId: String
    public let projectName: String
    public let totalSessions: Int
    public let totalTokens: UsageSourcedTokens
    public let estimatedCost: Double?
    public let vendorEstimatedCost: Double?
    public let sessions: [UsageSessionItem]
    public let dailyUsage: [UsageDailyItem]
    public let byModel: [UsageModelItem]
    public let byFolder: [UsageFolderItem]
    public let byAgent: [UsageAgentItem]
    public let unattributedVendorSessions: Int
    public let lastUpdated: Int64

    private enum CodingKeys: String, CodingKey {
        case scope
        case projectId, project_id
        case projectName, project_name
        case totalSessions, total_sessions
        case totalTokens, total_tokens
        case estimatedCost, estimated_cost
        case vendorEstimatedCost, vendor_estimated_cost
        case sessions
        case dailyUsage, daily_usage
        case byModel, by_model
        case byFolder, by_folder
        case byAgent, by_agent
        case unattributedVendorSessions, unattributed_vendor_sessions
        case lastUpdated, last_updated
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        scope = (try? c.decode(String.self, forKey: .scope)) ?? "global"
        projectId = (try? c.decode(String.self, forKey: .projectId))
            ?? (try? c.decode(String.self, forKey: .project_id))
            ?? ""
        projectName = (try? c.decode(String.self, forKey: .projectName))
            ?? (try? c.decode(String.self, forKey: .project_name))
            ?? "全局"
        totalSessions = (try? c.decode(Int.self, forKey: .totalSessions))
            ?? (try? c.decode(Int.self, forKey: .total_sessions))
            ?? 0
        totalTokens = (try? c.decode(UsageSourcedTokens.self, forKey: .totalTokens))
            ?? (try? c.decode(UsageSourcedTokens.self, forKey: .total_tokens))
            ?? UsageSourcedTokens()
        estimatedCost = (try? c.decodeIfPresent(Double.self, forKey: .estimatedCost))
            ?? (try? c.decodeIfPresent(Double.self, forKey: .estimated_cost))
        vendorEstimatedCost = (try? c.decodeIfPresent(Double.self, forKey: .vendorEstimatedCost))
            ?? (try? c.decodeIfPresent(Double.self, forKey: .vendor_estimated_cost))
        sessions = (try? c.decode([UsageSessionItem].self, forKey: .sessions)) ?? []
        dailyUsage = (try? c.decode([UsageDailyItem].self, forKey: .dailyUsage))
            ?? (try? c.decode([UsageDailyItem].self, forKey: .daily_usage))
            ?? []
        byModel = (try? c.decode([UsageModelItem].self, forKey: .byModel))
            ?? (try? c.decode([UsageModelItem].self, forKey: .by_model))
            ?? []
        byFolder = (try? c.decode([UsageFolderItem].self, forKey: .byFolder))
            ?? (try? c.decode([UsageFolderItem].self, forKey: .by_folder))
            ?? []
        byAgent = (try? c.decode([UsageAgentItem].self, forKey: .byAgent))
            ?? (try? c.decode([UsageAgentItem].self, forKey: .by_agent))
            ?? []
        unattributedVendorSessions = (try? c.decode(Int.self, forKey: .unattributedVendorSessions))
            ?? (try? c.decode(Int.self, forKey: .unattributed_vendor_sessions))
            ?? 0
        lastUpdated = (try? c.decode(Int64.self, forKey: .lastUpdated))
            ?? (try? c.decode(Int64.self, forKey: .last_updated))
            ?? 0
    }

    public var resolvedCost: Double? {
        if let estimatedCost { return estimatedCost }
        if let vendorEstimatedCost { return vendorEstimatedCost }
        let sessionSum = sessions.compactMap(\.cost).reduce(0, +)
        if sessionSum > 0 { return sessionSum }
        let modelSum = byModel.compactMap(\.cost).reduce(0, +)
        return modelSum > 0 ? modelSum : nil
    }

    public var cacheHitRatePercent: Double? {
        let counts = totalTokens.preferred
        let cacheRead = Double(counts.cacheReadTokens ?? 0)
        let input = Double(counts.inputTokens ?? 0)
        let cacheWrite = Double(counts.cacheWriteTokens ?? 0)
        let denom = cacheRead + input + cacheWrite
        guard denom > 0 else { return nil }
        return (cacheRead / denom) * 100.0
    }

    public var activeDaysCount: Int {
        dailyUsage.filter { $0.sessions > 0 || $0.tokens.preferred.resolvedTotal > 0 }.count
    }

    public var avgTokensPerSession: Int64 {
        guard totalSessions > 0 else { return 0 }
        return totalTokens.preferred.resolvedTotal / Int64(totalSessions)
    }
}

// MARK: - Plan Usage (`agent_plan_usage`)

public struct PlanUsageWindow: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let usedPercent: Double?
    public let windowMinutes: Int64?
    public let resetsAtMs: Int64?

    private enum CodingKeys: String, CodingKey {
        case id
        case usedPercent, used_percent
        case windowMinutes, window_minutes
        case resetsAtMs, resets_at_ms
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        usedPercent = (try? c.decodeIfPresent(Double.self, forKey: .usedPercent))
            ?? (try? c.decodeIfPresent(Double.self, forKey: .used_percent))
        windowMinutes = (try? c.decodeIfPresent(Int64.self, forKey: .windowMinutes))
            ?? (try? c.decodeIfPresent(Int64.self, forKey: .window_minutes))
        resetsAtMs = (try? c.decodeIfPresent(Int64.self, forKey: .resetsAtMs))
            ?? (try? c.decodeIfPresent(Int64.self, forKey: .resets_at_ms))
    }

    public var clampedUsedPercent: Int? {
        guard let usedPercent else { return nil }
        return max(0, min(100, Int(usedPercent.rounded())))
    }

    public var remainingPercent: Int? {
        guard let used = clampedUsedPercent else { return nil }
        return max(0, 100 - used)
    }

    public var localizedTitle: String {
        switch id {
        case "five_hour": return "5 小时窗口"
        case "seven_day": return "每周窗口（全部模型）"
        case "seven_day_opus": return "每周窗口（Opus）"
        case "seven_day_sonnet": return "每周窗口（Sonnet）"
        case "extra_usage": return "额外用量（本月）"
        case "primary": return "主限额窗口"
        case "secondary": return "次限额窗口"
        case "weekly": return "每周窗口"
        case "monthly": return "每月窗口"
        case "plan_period": return "滚动窗口"
        case "cursor_models": return "Cursor 模型"
        case "other_models": return "其它模型"
        case "gemini_five_hour": return "Gemini 5 小时"
        case "gemini_weekly": return "Gemini 每周"
        case "claude_gpt_five_hour": return "Claude/GPT 5 小时"
        case "claude_gpt_weekly": return "Claude/GPT 每周"
        case "argon_five_hour": return "Gemini 4 Argon 5 小时"
        case "argon_weekly": return "Gemini 4 Argon 每周"
        default:
            if let mins = windowMinutes, mins > 0 {
                if mins % 1440 == 0 {
                    return "\(mins / 1440) 天窗口"
                } else if mins % 60 == 0 {
                    return "\(mins / 60) 小时窗口"
                }
            }
            return id
        }
    }

    public func resetLabel(nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) -> String? {
        guard let resetsAtMs else { return nil }
        let diffMs = resetsAtMs - nowMs
        if diffMs <= 60_000 { return "即将重置" }
        let minutes = Int(ceil(Double(diffMs) / 60_000.0))
        if minutes < 60 { return "\(minutes) 分钟后重置" }
        let hours = Int(ceil(Double(minutes) / 60.0))
        if hours < 24 { return "\(hours) 小时后重置" }
        let days = Int(ceil(Double(hours) / 24.0))
        return "\(days) 天后重置"
    }
}

public struct PlanCredits: Decodable, Equatable, Sendable {
    public let balance: String?
    public let unlimited: Bool

    private enum CodingKeys: String, CodingKey {
        case balance, unlimited
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        balance = try? c.decodeIfPresent(String.self, forKey: .balance)
        unlimited = (try? c.decodeIfPresent(Bool.self, forKey: .unlimited)) ?? false
    }
}

public struct AgentPlanUsage: Decodable, Equatable, Sendable {
    public let planType: String?
    public let windows: [PlanUsageWindow]
    public let credits: PlanCredits?

    private enum CodingKeys: String, CodingKey {
        case planType, plan_type
        case windows, credits
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        planType = (try? c.decodeIfPresent(String.self, forKey: .planType))
            ?? (try? c.decodeIfPresent(String.self, forKey: .plan_type))
        windows = (try? c.decode([PlanUsageWindow].self, forKey: .windows)) ?? []
        credits = try? c.decodeIfPresent(PlanCredits.self, forKey: .credits)
    }
}

public enum PlanUsageResponse: Decodable, Equatable, Sendable {
    case ok(AgentPlanUsage)
    case unavailable(reason: String)
    case error(message: String)

    private enum CodingKeys: String, CodingKey {
        case type, usage, reason, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = (try? c.decode(String.self, forKey: .type))?.uppercased() ?? ""
        switch type {
        case "OK":
            let usage = try c.decode(AgentPlanUsage.self, forKey: .usage)
            self = .ok(usage)
        case "UNAVAILABLE":
            let reason = (try? c.decode(String.self, forKey: .reason)) ?? "UNSUPPORTED_AGENT"
            self = .unavailable(reason: reason)
        default:
            let message = (try? c.decode(String.self, forKey: .message)) ?? "读取失败"
            self = .error(message: message)
        }
    }

    public var unavailableDescription: String? {
        guard case .unavailable(let reason) = self else { return nil }
        switch reason.uppercased() {
        case "UNSUPPORTED_AGENT": return "该 Agent 不提供套餐额度信息"
        case "CLI_NOT_FOUND": return "未找到已安装的程序，请先在设置中安装并登录"
        case "NOT_LOGGED_IN": return "未检测到登录凭据，请先在设置中登录"
        case "TOKEN_EXPIRED": return "登录凭据已过期，请在设置中重新登录"
        default: return reason
        }
    }
}
