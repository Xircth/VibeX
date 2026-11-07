import Foundation

/// Row of `conversation_list_recent`; fields the phone does not show are not decoded.
/// Optional fields tolerate a Host that changes their encoding.
public struct ConversationListItem: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let workspace_id: String
    public let title: String?
    public let status: String?
    public let agent_id: String?
    public let model: String?
    public let message_count: Int
    public let updated_at: String

    private enum CodingKeys: String, CodingKey {
        case id, workspace_id, title, status, agent_id, model, message_count, updated_at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        workspace_id = try c.decode(String.self, forKey: .workspace_id)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        agent_id = try? c.decodeIfPresent(String.self, forKey: .agent_id)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        message_count = (try? c.decode(Int.self, forKey: .message_count)) ?? 0
        updated_at = try c.decode(String.self, forKey: .updated_at)
    }

    public var updatedAt: Date? { Self.parseDate(updated_at) }

    static func parseDate(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}

/// Row of `artifact_list`. The Host also sends absolute paths; they are deliberately not decoded.
public struct ArtifactListItem: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let conversation_id: String
    public let relative_path: String
    public let media_type: String
    public let revision: Int
    public let updated_at_unix_ms: Int64

    public var fileName: String { (relative_path as NSString).lastPathComponent }
    public var updatedAt: Date { Date(timeIntervalSince1970: Double(updated_at_unix_ms) / 1000) }
}

/// Entry of `conversation_workspace_tree` (one directory level, path relative to the workspace root).
public struct WorkspaceEntry: Decodable, Identifiable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let directory: Bool
    public var id: String { path }
}

/// One file an assistant turn changed, as reported by a `file_change_summary` row.
public struct FileChangeItem: Identifiable, Equatable, Sendable {
    public let path: String
    public let additions: Int?
    public let deletions: Int?
    /// The change rebuilt from the Agent's own Write/Edit calls, for workspaces without git;
    /// nil when the Host reported the change and the diff is fetched from it.
    public var hunks: [DiffHunk]? = nil
    public var id: String { path }
}

/// A file write or in-place edit taken from a tool call's input.
public struct ToolEdit: Equatable, Sendable {
    public let path: String
    /// The text being replaced; nil when the whole file was written.
    public let old: String?
    public let new: String
}

/// One tool call the Agent made, shown as a row of chips.
public struct ToolStep: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let status: String?
    /// The target of the call (file name, command, query) shown as the row's chip.
    public let preview: String?
    /// File writes/edits this call made, when its input describes them.
    public let edits: [ToolEdit]
    /// The call's action with its target removed, e.g. `Write` for `Write notes.txt`.
    public let label: String
    /// The first lines of the tool input, for the expanded row.
    public let detail: [String]

    public var isFinished: Bool {
        guard let status else { return false }
        return ["completed", "complete", "success", "done", "failed", "error"].contains(status.lowercased())
    }
}

/// One step of the Agent's plan/todo checklist (`plan` content block).
public struct PlanTask: Identifiable, Equatable, Sendable {
    public enum Status: Sendable { case pending, running, completed }

    public let id: Int
    public let label: String
    public let status: Status
    public let priority: String?
}

public struct TimelineItem: Identifiable, Equatable, Sendable {
    public enum Role: Sendable { case user, assistant }

    public let id: String
    public let role: Role
    public var text: String
    /// Reasoning prose the Agent produced before answering (assistant only).
    public var thinking: String = ""
    public var tools: [ToolStep] = []
    public var plan: [PlanTask] = []
    public var changes: [FileChangeItem] = []
    public var durationMs: Int?

    public var hasTrace: Bool { !thinking.isEmpty || !tools.isEmpty || !changes.isEmpty }
}

public extension Array where Element == TimelineItem {
    /// The most recent plan the Agent published; later plans replace earlier ones.
    var currentPlan: [PlanTask] { last { !$0.plan.isEmpty }?.plan ?? [] }
}

public enum TimelineBuilder {
    /// Messages from `conversation_timeline_page` rows (the JSONL transcript is the Host's
    /// history authority, ADR-0082). Rows that are not user/assistant turns are skipped.
    public static func build(fromRows rows: [JSONValue]) -> [TimelineItem] {
        var order: [String] = []
        var latest: [String: (revision: Double, item: TimelineItem)] = [:]
        var changes: [String: [FileChangeItem]] = [:]
        var lastAssistant: String?
        for row in rows {
            if row["row"]?["kind"]?.stringValue == "file_change_summary", let owner = lastAssistant {
                for file in row["row"]?["summary"]?["files"]?.arrayValue ?? [] {
                    guard let path = file["path"]?.stringValue else { continue }
                    func count(_ key: String) -> Int? {
                        if case .number(let value)? = file[key] { return Int(value) }
                        return nil
                    }
                    var list = changes[owner] ?? []
                    list.removeAll { $0.path == path }
                    list.append(FileChangeItem(path: path, additions: count("additions"), deletions: count("deletions")))
                    changes[owner] = list
                }
                continue
            }
            guard let rowID = row["row_id"]?.stringValue,
                  row["row"]?["kind"]?.stringValue == "message_turn",
                  let turn = row["row"]?["turn"],
                  let role = role(turn["role"]?.stringValue)
            else { continue }
            if role == .assistant { lastAssistant = rowID }
            var item = TimelineItem(id: rowID, role: role, text: "")
            var texts: [String] = []
            var thoughts: [String] = []
            for (index, block) in (turn["blocks"]?.arrayValue ?? []).enumerated() {
                switch block["type"]?.stringValue {
                case "text":
                    if let text = block["text"]?.stringValue { texts.append(text) }
                case "thinking":
                    if role == .assistant, let text = block["text"]?.stringValue { thoughts.append(text) }
                case "tool_use":
                    guard role == .assistant, let name = block["tool_name"]?.stringValue else { continue }
                    let input = ToolInput(block["input_preview"]?.stringValue)
                    item.tools.append(ToolStep(
                        id: block["tool_use_id"]?.stringValue ?? "\(rowID)-\(index)",
                        name: name,
                        status: block["status"]?.stringValue,
                        preview: input.target,
                        edits: input.edits,
                        label: input.label(for: name),
                        detail: input.detail
                    ))
                case "plan":
                    guard role == .assistant else { continue }
                    item.plan = (block["entries"]?.arrayValue ?? []).enumerated().compactMap { offset, entry in
                        guard let label = entry["content"]?.stringValue else { return nil }
                        let status: PlanTask.Status
                        switch entry["status"]?.stringValue {
                        case "completed": status = .completed
                        case "in_progress": status = .running
                        default: status = .pending
                        }
                        return PlanTask(id: offset, label: label, status: status, priority: entry["priority"]?.stringValue)
                    }
                default:
                    continue
                }
            }
            item.text = texts.joined(separator: "\n")
            item.thinking = thoughts.joined(separator: "\n\n")
            if case .number(let value)? = turn["duration_ms"] { item.durationMs = Int(value) }
            let hasText = !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            guard hasText || item.hasTrace || !item.plan.isEmpty else { continue }
            var revision = 0.0
            if case .number(let value)? = row["revision"] { revision = value }
            if let known = latest[rowID], known.revision > revision { continue }
            if latest[rowID] == nil { order.append(rowID) }
            latest[rowID] = (revision, item)
        }
        return order.compactMap {
            guard var item = latest[$0]?.item else { return nil }
            item.changes = changes[item.id] ?? []
            if item.changes.isEmpty { item.changes = Self.changes(fromEdits: item.tools.flatMap(\.edits)) }
            return item
        }
    }

    /// One change per file, in the order the Agent first touched it, from its Write/Edit inputs.
    private static func changes(fromEdits edits: [ToolEdit]) -> [FileChangeItem] {
        var order: [String] = []
        var hunks: [String: [DiffHunk]] = [:]
        for edit in edits {
            if hunks[edit.path] == nil { order.append(edit.path) }
            let id = hunks[edit.path]?.count ?? 0
            let rows: [DiffLine]
            if let old = edit.old {
                rows = lines(of: old).map { DiffLine(id: 0, kind: .removed, text: $0, oldNumber: nil, newNumber: nil) }
                    + lines(of: edit.new).map { DiffLine(id: 0, kind: .added, text: $0, oldNumber: nil, newNumber: nil) }
            } else {
                rows = lines(of: edit.new).map { DiffLine(id: 0, kind: .added, text: $0, oldNumber: nil, newNumber: nil) }
            }
            let numbered = rows.enumerated().map {
                DiffLine(id: $0.offset, kind: $0.element.kind, text: $0.element.text, oldNumber: nil, newNumber: nil)
            }
            hunks[edit.path, default: []].append(
                DiffHunk(id: id, header: edit.old == nil ? "新文件内容" : "修改", lines: numbered)
            )
        }
        return order.map { path in
            let all = hunks[path] ?? []
            let rows = all.flatMap(\.lines)
            return FileChangeItem(
                path: path,
                additions: rows.filter { $0.kind == .added }.count,
                deletions: rows.filter { $0.kind == .removed }.count,
                hunks: all
            )
        }
    }

    private static func lines(of text: String) -> [String] {
        var rows = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if rows.last == "" { rows.removeLast() }
        return rows
    }

    private static func role(_ value: String?) -> TimelineItem.Role? {
        switch value {
        case "user": return .user
        case "assistant": return .assistant
        default: return nil
        }
    }
}

/// A tool call's raw input preview (usually JSON) turned into a chip target and detail lines.
struct ToolInput {
    let target: String?
    let detail: [String]
    var edits: [ToolEdit] = []

    private static let targetKeys = ["file_path", "path", "command", "cmd", "pattern", "query", "url", "description"]

    init(_ raw: String?) {
        guard let raw, !raw.isEmpty else {
            target = nil
            detail = []
            return
        }
        guard let data = raw.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            target = Self.clip(raw.split(separator: "\n").first.map(String.init) ?? raw, 60)
            detail = Self.lines(raw)
            return
        }
        if let path = (object["file_path"] ?? object["path"]) as? String {
            if let content = object["content"] as? String {
                edits = [ToolEdit(path: path, old: nil, new: content)]
            } else if let old = object["old_string"] as? String, let new = object["new_string"] as? String {
                edits = [ToolEdit(path: path, old: old, new: new)]
            } else if let list = object["edits"] as? [[String: Any]] {
                edits = list.compactMap { entry in
                    guard let old = entry["old_string"] as? String, let new = entry["new_string"] as? String else { return nil }
                    return ToolEdit(path: path, old: old, new: new)
                }
            }
        }
        let key = Self.targetKeys.first { object[$0] is String }
        let value = key.flatMap { object[$0] as? String }
        if let key, let value {
            target = Self.clip(key.hasSuffix("path") ? (value as NSString).lastPathComponent : value, 60)
        } else {
            target = nil
        }
        detail = object.keys.sorted().compactMap { name -> [String]? in
            guard name != key, let text = Self.text(object[name]), !text.isEmpty else { return nil }
            let rows = Self.lines(text)
            guard let first = rows.first else { return nil }
            return ["\(name): \(first)"] + rows.dropFirst().prefix(1)
        }.flatMap { $0 }.prefix(4).map { $0 }
    }

    /// The action word(s) of `name` once the target is taken out of it.
    func label(for name: String) -> String {
        guard let target, !target.isEmpty else { return name }
        let stripped = name.replacingOccurrences(of: target, with: "").trimmingCharacters(in: .whitespaces)
        if stripped.isEmpty || stripped == name { return stripped.isEmpty ? Self.verb(name) : name }
        return stripped
    }

    private static func verb(_ name: String) -> String {
        name.split(separator: " ").first.map(String.init) ?? name
    }

    private static func text(_ value: Any?) -> String? {
        switch value {
        case let value as String: return value
        case let value as NSNumber: return value.stringValue
        case let value?: return (try? JSONSerialization.data(withJSONObject: value)).flatMap { String(data: $0, encoding: .utf8) }
        default: return nil
        }
    }

    private static func lines(_ raw: String) -> [String] {
        raw.split(separator: "\n").prefix(4).map {
            clip(String($0).trimmingCharacters(in: .whitespaces), 80)
        }
    }

    private static func clip(_ value: String, _ limit: Int) -> String {
        value.count > limit ? String(value.prefix(limit)) + "…" : value
    }
}

/// A project and the workspaces whose conversations belong to it.
public struct ProjectSummary: Decodable, Identifiable, Equatable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let workspaceIds: [String]

    public init(id: String, name: String, workspaceIds: [String]) {
        self.id = id
        self.name = name
        self.workspaceIds = workspaceIds
    }
}

/// Conversations bucketed by project, newest activity first.
public struct ProjectGroup: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let conversations: [ConversationListItem]

    public init(id: String, name: String, conversations: [ConversationListItem]) {
        self.id = id
        self.name = name
        self.conversations = conversations
    }

    public var latest: Date? { conversations.compactMap(\.updatedAt).max() }

    /// Projects that have conversations, most recently active first; conversations whose
    /// workspace belongs to no known project fall into one trailing "其他" group.
    public static func make(conversations: [ConversationListItem], projects: [ProjectSummary]) -> [ProjectGroup] {
        var owner: [String: ProjectSummary] = [:]
        for project in projects {
            for workspace in project.workspaceIds { owner[workspace.lowercased()] = project }
        }
        var buckets: [String: [ConversationListItem]] = [:]
        var names: [String: String] = [:]
        for conversation in conversations {
            let project = owner[conversation.workspace_id.lowercased()]
            let key = project?.id ?? "other"
            buckets[key, default: []].append(conversation)
            names[key] = project?.name ?? "其他"
        }
        let groups = buckets.map { ProjectGroup(id: $0.key, name: names[$0.key] ?? "其他", conversations: $0.value) }
        return groups.sorted {
            if $0.id == "other" { return false }
            if $1.id == "other" { return true }
            return ($0.latest ?? .distantPast) > ($1.latest ?? .distantPast)
        }
    }
}
