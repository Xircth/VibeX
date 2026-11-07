import Foundation

public struct PermissionOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let kind: String
}

public struct PermissionPrompt: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let options: [PermissionOption]
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
        let choices = (item["choices"]?.arrayValue ?? []).compactMap { choice -> ConfigChoice? in
            guard let value = choice["value"] else { return nil }
            return ConfigChoice(
                value: value,
                label: choice["label"]?.stringValue ?? value.displayText ?? "",
                description: choice["description"]?.stringValue
            )
        }
        return ConfigOption(
            key: key,
            label: item["label"]?.stringValue ?? key,
            category: item["category"]?.stringValue,
            value: item["value"],
            choices: choices
        )
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
        let request = wrapper["request"]
        let options = (request?["options"]?.arrayValue ?? []).compactMap { item -> PermissionOption? in
            guard let optionID = item["id"]?.stringValue else { return nil }
            return PermissionOption(
                id: optionID,
                label: item["label"]?.stringValue ?? optionID,
                kind: item["kind"]?.stringValue ?? "unknown"
            )
        }
        return PermissionPrompt(id: id, title: request?["title"]?.stringValue ?? "权限请求", options: options)
    }
}
