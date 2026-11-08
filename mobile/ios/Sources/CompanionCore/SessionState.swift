import Foundation

public struct PermissionOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let kind: String

    public init(id: String, label: String, kind: String) {
        self.id = id
        self.label = label
        self.kind = kind
    }

    public var isAllow: Bool {
        kind == "allow_once" || kind == "allow_always" || kind.hasPrefix("allow")
    }

    public var isReject: Bool {
        kind == "reject_once" || kind == "reject_always" || kind.hasPrefix("reject") || kind.hasPrefix("deny")
    }
}

public enum PermissionAllowScope: String, CaseIterable, Sendable {
    case once
    case session
    case always

    public var label: String {
        switch self {
        case .once: return "允许一次"
        case .session: return "本会话允许"
        case .always: return "始终允许"
        }
    }
}

public struct PermissionDiffPreview: Equatable, Sendable, Identifiable {
    public var id: String { "\(path)-\(oldText.hashValue)-\(newText.hashValue)" }
    public let path: String
    public let oldText: String
    public let newText: String

    public var isNewFile: Bool { oldText.isEmpty }

    public init(path: String, oldText: String, newText: String) {
        self.path = path
        self.oldText = oldText
        self.newText = newText
    }
}

public enum PermissionCategory: String, Equatable, Sendable {
    case terminal
    case file
    case web
    case tool

    public var label: String {
        switch self {
        case .terminal: return "终端命令"
        case .file: return "文件读写"
        case .web: return "网络访问"
        case .tool: return "工具调用"
        }
    }

    public var systemImage: String {
        switch self {
        case .terminal: return "terminal"
        case .file: return "doc.text"
        case .web: return "globe"
        case .tool: return "wrench.and.screwdriver"
        }
    }

    public static func from(kind: String?) -> PermissionCategory {
        let normalized = kind?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if ["execute", "command", "terminal", "shell", "bash"].contains(where: { normalized.contains($0) }) {
            return .terminal
        }
        if ["file", "read", "write", "edit", "delete", "move", "copy", "patch"].contains(where: { normalized.contains($0) }) {
            return .file
        }
        if ["web", "browser", "fetch", "http", "url"].contains(where: { normalized.contains($0) }) {
            return .web
        }
        return .tool
    }
}

public struct PermissionPrompt: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let options: [PermissionOption]
    public let kind: String?
    public let heading: String?
    public let subtitle: String?
    public let command: String?
    public let textBlocks: [String]
    public let diffs: [PermissionDiffPreview]
    public let locations: [String]

    public init(
        id: String,
        title: String,
        options: [PermissionOption],
        kind: String? = nil,
        heading: String? = nil,
        subtitle: String? = nil,
        command: String? = nil,
        textBlocks: [String] = [],
        diffs: [PermissionDiffPreview] = [],
        locations: [String] = []
    ) {
        self.id = id
        self.title = title
        self.options = options
        self.kind = kind
        self.heading = heading
        self.subtitle = subtitle
        self.command = command
        self.textBlocks = textBlocks
        self.diffs = diffs
        self.locations = locations
    }

    public var category: PermissionCategory {
        if kind != nil {
            return PermissionCategory.from(kind: kind)
        }
        if command != nil { return .terminal }
        if !diffs.isEmpty || !locations.isEmpty { return .file }
        return .tool
    }

    public var displayHeading: String {
        if let heading, !heading.isEmpty { return heading }
        return "需要权限确认"
    }

    public var displaySubtitle: String? {
        if let subtitle, !subtitle.isEmpty { return subtitle }
        if heading == nil, !title.isEmpty, title != command { return title }
        return nil
    }

    public func resolveAllowOption(for scope: PermissionAllowScope) -> PermissionOption? {
        let allowOnce = options.first { $0.kind == "allow_once" }
        let allowAlways = options.first { $0.kind == "allow_always" }
        let anyAllow = options.first { $0.isAllow }
        if scope == .once {
            return allowOnce ?? anyAllow
        }
        return allowAlways ?? allowOnce ?? anyAllow
    }

    public var rejectOption: PermissionOption? {
        options.first { $0.kind == "reject_once" }
            ?? options.first { $0.kind == "reject_always" }
            ?? options.first { $0.isReject }
    }
}

/// A question the Agent is waiting on (`question_requested`), before it is turned into a form.
public struct PendingQuestion: Equatable, Sendable, Identifiable {
    public let id: String
    public let prompt: String
    public let options: [String]
    public let schema: JSONValue?
}

public struct SessionMode: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let description: String?
}

public struct ConfigChoice: Equatable, Sendable, Identifiable {
    public let value: JSONValue
    public let label: String
    public let description: String?
    public var id: String { label + (value.displayText ?? "") }
}

public struct ConfigOption: Equatable, Sendable, Identifiable {
    public let key: String
    public let label: String
    public let category: String?
    public let value: JSONValue?
    public let choices: [ConfigChoice]
    public var id: String { key }

    public var currentLabel: String? {
        guard let value else { return nil }
        return choices.first(where: { $0.value == value })?.label ?? value.displayText
    }
}

/// What the phone may show and change for one Conversation, folded from its event log.
public struct SessionState: Equatable, Sendable {
    public var modes: [SessionMode] = []
    public var currentModeID: String?
    public var options: [ConfigOption] = []
    public var pendingPermissions: [PermissionPrompt] = []
    public var pendingQuestions: [PendingQuestion] = []
    public var isTurnRunning = false

    public init() {}

    public var currentModeLabel: String? {
        modes.first(where: { $0.id == currentModeID })?.label ?? currentModeID
    }

    public var modelOptions: [ConfigOption] { options.filter { $0.category == "model" } }

    /// Everything else the Agent advertises (reasoning effort, fast mode, ...), minus the mode picker.
    public var otherOptions: [ConfigOption] {
        options.filter { $0.category != "model" && $0.category != "mode" }
    }
}

public enum SessionStateBuilder {
    public static func build(from events: [RemoteEvent]) -> SessionState {
        var state = SessionState()
        var pending: [(id: String, prompt: PermissionPrompt)] = []
        var questions: [PendingQuestion] = []
        for event in events.sorted(by: { $0.sequence < $1.sequence }) {
            let payload = event.payload
            switch event.kind {
            case "session_mode_updated":
                state.currentModeID = payload.eventField("current")?.stringValue
                state.modes = (payload.eventField("modes")?.arrayValue ?? []).compactMap(mode)
            case "session_config_options_updated":
                state.options = (payload.eventField("options")?.arrayValue ?? []).compactMap(option)
            case "permission_requested":
                if let prompt = permission(payload) {
                    pending.removeAll { $0.id == prompt.id }
                    pending.append((prompt.id, prompt))
                }
            case "permission_responded":
                if let id = payload.eventField("permission_id")?.stringValue {
                    pending.removeAll { $0.id == id }
                }
            case "question_requested":
                if let question = pendingQuestion(payload) {
                    questions.removeAll { $0.id == question.id }
                    questions.append(question)
                }
            case "question_responded":
                if let id = payload.eventField("question_id")?.stringValue {
                    questions.removeAll { $0.id == id }
                }
            case "user_turn_started":
                state.isTurnRunning = true
            case "turn_completed", "turn_failed", "turn_cancelled", "turn_interrupted":
                state.isTurnRunning = false
                pending.removeAll()
                questions.removeAll()
            default:
                continue
            }
        }
        state.pendingPermissions = pending.map(\.prompt)
        state.pendingQuestions = questions
        return state
    }

    /// Controls of a live Agent session, as returned by `conversation_ensure_session_controls`.
    public static func controls(from snapshot: JSONValue) -> SessionState {
        var state = SessionState()
        state.modes = (snapshot["modes"]?.arrayValue ?? []).compactMap(mode)
        state.currentModeID = snapshot["current_mode"]?.stringValue
        state.options = (snapshot["config_options"]?.arrayValue ?? []).compactMap(option)
        return state
    }

    static func mode(_ item: JSONValue) -> SessionMode? {
        guard let id = item["id"]?.stringValue else { return nil }
        return SessionMode(
            id: id,
            label: item["label"]?.stringValue ?? id,
            description: item["description"]?.stringValue
        )
    }

    static func option(_ item: JSONValue) -> ConfigOption? {
        guard let key = item["key"]?.stringValue else { return nil }
        let category = item["category"]?.stringValue
        let choices = (item["choices"]?.arrayValue ?? []).compactMap { choice -> ConfigChoice? in
            guard let value = choice["value"] else { return nil }
            let rawLabel = choice["label"]?.stringValue ?? value.displayText ?? ""
            return ConfigChoice(
                value: value,
                label: normalizedChoiceLabel(rawLabel, value: value, key: key, category: category),
                description: choice["description"]?.stringValue
            )
        }
        return ConfigOption(
            key: key,
            label: item["label"]?.stringValue ?? key,
            category: category,
            value: item["value"],
            choices: choices
        )
    }

    private static func normalizedChoiceLabel(
        _ rawLabel: String,
        value: JSONValue,
        key: String,
        category: String?
    ) -> String {
        let trimmed = rawLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return value.displayText ?? "" }
        if category == "model" || key == "model",
           let first = trimmed.first, first.isNumber,
           let slug = value.stringValue?.lowercased(), slug.hasPrefix("gpt-")
        {
            return "GPT-\(trimmed)"
        }
        return trimmed
    }

    private static func pendingQuestion(_ payload: JSONValue) -> PendingQuestion? {
        guard let request = payload.eventField("request"),
              let id = request["question_id"]?.stringValue
        else { return nil }
        var schema = request["schema"]
        if case .null? = schema { schema = nil }
        return PendingQuestion(
            id: id,
            prompt: request["prompt"]?.stringValue ?? "",
            options: (request["options"]?.arrayValue ?? []).compactMap(\.stringValue),
            schema: schema
        )
    }

    private static func permission(_ payload: JSONValue) -> PermissionPrompt? {
        guard let wrapper = payload.eventField("request"),
              let id = wrapper["permission_id"]?.stringValue
        else { return nil }
        let request = wrapper["request"] ?? wrapper
        let options = (request["options"]?.arrayValue ?? []).compactMap { item -> PermissionOption? in
            guard let optionID = item["id"]?.stringValue else { return nil }
            return PermissionOption(
                id: optionID,
                label: item["label"]?.stringValue ?? optionID,
                kind: item["kind"]?.stringValue ?? "unknown"
            )
        }
        let rawTitle = request["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = (rawTitle?.isEmpty == false ? rawTitle! : "权限请求")
        let details = request["details"] ?? wrapper["details"]
        let parsed = parsePermissionDetail(details, requestTitle: rawTitle)
        return PermissionPrompt(
            id: id,
            title: title,
            options: options,
            kind: parsed.kind,
            heading: parsed.heading,
            subtitle: parsed.subtitle,
            command: parsed.command,
            textBlocks: parsed.textBlocks,
            diffs: parsed.diffs,
            locations: parsed.locations
        )
    }

    private struct ParsedPermissionDetail {
        var kind: String?
        var heading: String?
        var subtitle: String?
        var command: String?
        var textBlocks: [String] = []
        var diffs: [PermissionDiffPreview] = []
        var locations: [String] = []
    }

    private static func parsePermissionDetail(_ details: JSONValue?, requestTitle: String?) -> ParsedPermissionDetail {
        let trimmedRequestTitle = (requestTitle?.isEmpty == false) ? requestTitle : nil
        guard let record = details, case .object = record else {
            return ParsedPermissionDetail(subtitle: trimmedRequestTitle)
        }
        let fields: JSONValue
        if let inner = record["fields"], case .object = inner {
            fields = inner
        } else {
            fields = record
        }
        let kind = fields["kind"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let rawInput = fields["rawInput"] ?? record["rawInput"]
        let command = extractPermissionCommand(from: rawInput)
        let (heading, subtitle) = resolvePermissionHeadings(
            record: record,
            fields: fields,
            rawInput: rawInput,
            requestTitle: trimmedRequestTitle,
            command: command
        )

        var diffs: [PermissionDiffPreview] = []
        var textBlocks: [String] = []
        for block in fields["content"]?.arrayValue ?? [] {
            if block["type"]?.stringValue == "diff" {
                let path = block["path"]?.stringValue ?? "(file)"
                let oldText = block["oldText"]?.stringValue ?? ""
                let newText = block["newText"]?.stringValue ?? ""
                diffs.append(PermissionDiffPreview(path: path, oldText: oldText, newText: newText))
                continue
            }
            if let text = (block["text"]?.stringValue ?? block["content"]?["text"]?.stringValue)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !text.isEmpty
            {
                textBlocks.append(text)
            }
        }

        let locations = (fields["locations"]?.arrayValue ?? []).compactMap { loc -> String? in
            guard let path = loc["path"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !path.isEmpty
            else { return nil }
            return path
        }

        return ParsedPermissionDetail(
            kind: kind,
            heading: heading,
            subtitle: subtitle,
            command: (diffs.isEmpty && textBlocks.isEmpty) ? command : nil,
            textBlocks: textBlocks,
            diffs: diffs,
            locations: locations
        )
    }

    private static func extractPermissionCommand(from rawInput: JSONValue?) -> String? {
        guard let rawInput else { return nil }
        for key in ["command", "cmd", "script"] {
            if let str = rawInput[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !str.isEmpty {
                return str
            }
            if let arr = rawInput[key]?.arrayValue {
                let joined = arr.compactMap(\.stringValue).joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
                if !joined.isEmpty { return joined }
            }
        }
        return nil
    }

    private static func extractShellCommandLabel(from rawInput: JSONValue?, command: String?) -> String? {
        guard let rawInput else { return nil }
        for key in ["description", "title", "summary"] {
            if let label = rawInput[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
               !label.isEmpty,
               label != command
            {
                return label
            }
        }
        return nil
    }

    private static func resolvePermissionHeadings(
        record: JSONValue,
        fields: JSONValue,
        rawInput: JSONValue?,
        requestTitle: String?,
        command: String?
    ) -> (heading: String?, subtitle: String?) {
        let meta = record["_meta"] ?? fields["_meta"]
        let claudeCode = meta?["claudeCode"]
        let air = meta?["jetbrains"]?["air"]
        let permission = meta?["permission"] ?? air?["permission"]

        let claudeTitle = nonEmpty(claudeCode?["title"]?.stringValue) ?? nonEmpty(air?["commandTitle"]?.stringValue)
        let permissionTitle = nonEmpty(permission?["title"]?.stringValue)
        let metaHeadingRaw = claudeTitle ?? permissionTitle

        let metaHeading: String?
        if let metaHeadingRaw, let command, metaHeadingRaw == command {
            metaHeading = extractShellCommandLabel(from: rawInput, command: command)
        } else {
            metaHeading = metaHeadingRaw
        }

        if let metaHeading {
            return (metaHeading, nil)
        }

        let toolCallTitle = nonEmpty(fields["title"]?.stringValue) ?? nonEmpty(record["title"]?.stringValue)
        let fallbackCandidate = requestTitle ?? toolCallTitle
        let subtitle: String?
        if let fallbackCandidate, let command, fallbackCandidate == command {
            subtitle = extractShellCommandLabel(from: rawInput, command: command)
        } else {
            subtitle = fallbackCandidate
        }
        return (nil, subtitle)
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
