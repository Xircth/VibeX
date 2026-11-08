import CompanionCore
import Foundation
import Observation

@MainActor
@Observable
final class ConversationModel {
    let client: HostClient
    let conversation: ConversationListItem

    private(set) var items: [TimelineItem] = []
    private var transcript: TranscriptState
    private let activity = TaskActivityController()
    private var events: [RemoteEvent] = []
    private var lastSequence: Int64 = 0
    private(set) var session = SessionState()
    private(set) var agents: [CatalogAgent] = []
    /// Choices shown immediately while the Host confirms them; dropped once the Host answers.
    private(set) var optionOverrides: [String: JSONValue] = [:]
    private(set) var modeOverride: String?
    private var liveControls: SessionState?
    private var controlsRequested = false
    private(set) var hasLoaded = false
    private(set) var loadError: String?
    private(set) var busy = false
    private(set) var boostPollingUntil: Date = .distantPast
    var actionError: String?

    var isActivelyStreaming: Bool {
        session.isTurnRunning || Date() < boostPollingUntil
    }

    init(client: HostClient, conversation: ConversationListItem) {
        self.client = client
        self.conversation = conversation
        self.transcript = TranscriptState(conversationID: conversation.id)
    }

    func reload() async {
        let initialTranscript = transcript
        let currentClient = client
        let convID = conversation.id
        let seq = lastSequence

        async let refreshedTranscriptResult: Result<TranscriptState, Error> = {
            var state = initialTranscript
            do {
                try await currentClient.refresh(&state)
                return .success(state)
            } catch {
                return .failure(error)
            }
        }()

        async let offlineCacheResult: OfflineConversationCache? = try? currentClient.offlineConversation(
            id: convID,
            afterSequence: seq
        )

        let transcriptResult = await refreshedTranscriptResult
        let cache = await offlineCacheResult

        switch transcriptResult {
        case .success(let state):
            transcript = state
            items = state.items
            hasLoaded = true
            loadError = nil
        case .failure(let error) where error is CancellationError:
            return
        case .failure(let error):
            loadError = describeHostFailure(error)
            return
        }

        // Mode, model, permission and question state come from the control-plane events; a failure keeps the last state.
        if let cache {
            let fresh = cache.events ?? []
            events += fresh
            lastSequence = max(lastSequence, cache.confirmed_through)
            session = SessionStateBuilder.build(from: events)
        }
        await applyLiveControls()
        if agents.isEmpty { await refreshCatalog() }
        let step = items.last?.tools.last.map { tool in
            tool.preview.map { "\(tool.name) \($0)" } ?? tool.name
        }
        activity.sync(title: conversation.title ?? "对话", tasks: items.currentPlan, step: step, running: session.isTurnRunning)
    }

    func stopActivity() { activity.stop() }

    /// Brings the Agent session up (once per visit) so its modes and options exist even before the first message.
    private func applyLiveControls() async {
        if !controlsRequested {
            controlsRequested = true
            await ensureLiveControls()
        }
        guard let live = liveControls else { return }
        if session.modes.isEmpty {
            session.modes = live.modes
            session.currentModeID = session.currentModeID ?? live.currentModeID
        }
        if session.options.isEmpty { session.options = live.options }
    }

    private func ensureLiveControls() async {
        do {
            liveControls = try await client.ensureSessionControls(conversationID: conversation.id)
        } catch is CancellationError {
            return
        } catch {
            // Only worth a message when the user acts; reading stays on the saved controls.
        }
    }

    /// Runs a session-control change, starting the Agent session first if the Host says it is not running.
    private func changingSession(_ action: () async throws -> Void) async throws {
        do {
            try await action()
        } catch HostError.server(_, let message) where message.localizedCaseInsensitiveContains("was not found") {
            liveControls = try await client.ensureSessionControls(conversationID: conversation.id)
            try await action()
        }
    }

    /// Agents and their models are whatever the desktop has configured in its Agent settings.
    func refreshCatalog() async {
        if let latest = try? await client.agentCatalog() { agents = latest }
    }

    var currentAgent: CatalogAgent? { agents.first { $0.id == conversation.agent_id } }

    /// Live session controls win; before the Agent has reported any, fall back to the desktop's saved ones.
    var modelOptions: [ConfigOption] {
        session.modelOptions.isEmpty ? (currentAgent?.modelOptions ?? []) : session.modelOptions
    }

    var otherOptions: [ConfigOption] {
        session.otherOptions.isEmpty ? (currentAgent?.otherOptions ?? []) : session.otherOptions
    }

    var accessModes: [SessionMode] {
        session.modes.isEmpty ? (currentAgent?.modes ?? []) : session.modes
    }

    var currentAccessModeID: String? {
        modeOverride ?? session.currentModeID ?? currentAgent?.currentModeID
    }

    func value(of option: ConfigOption) -> JSONValue? { optionOverrides[option.key] ?? option.value }

    /// Reasoning effort is shown as a slider; any remaining options (fast mode, ...) go in the + menu.
    var effortOption: ConfigOption? {
        otherOptions.first {
            $0.category == "thought_level" || $0.key.localizedCaseInsensitiveContains("effort")
                || $0.key.localizedCaseInsensitiveContains("reasoning")
        }
    }

    var extraOptions: [ConfigOption] { otherOptions.filter { $0.key != effortOption?.key } }

    var currentModelLabel: String? {
        guard let option = modelOptions.first else { return conversation.model }
        let value = value(of: option)
        return option.choices.first { $0.value == value }?.label ?? option.currentLabel ?? conversation.model
    }

    /// Other usable Agents with models: shown for reference, a conversation keeps its Agent.
    var otherAgentsWithModels: [CatalogAgent] {
        agents.filter { $0.usable && $0.id != conversation.agent_id && !$0.modelOptions.isEmpty }
    }

    func send(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard let agentID = conversation.agent_id else {
            actionError = "此对话没有绑定 Agent，无法发送"
            return false
        }
        boostPollingUntil = Date().addingTimeInterval(25)
        session.isTurnRunning = true
        return await perform {
            try await client.sendMessage(
                conversationID: conversation.id,
                workspaceID: conversation.workspace_id,
                agentID: agentID,
                text: trimmed
            )
        }
    }

    /// Agents that can start a new conversation in this workspace.
    var newConversationAgents: [CatalogAgent] { agents.filter(\.usable) }

    /// A new empty conversation in the same workspace; defaults to the current Agent.
    func createConversation(agentID: String? = nil) async -> ConversationListItem? {
        guard let agentID = agentID ?? conversation.agent_id else {
            actionError = "此对话没有绑定 Agent，无法新建"
            return nil
        }
        do {
            let created = try await client.createConversation(
                workspaceID: conversation.workspace_id,
                agentID: agentID
            )
            actionError = nil
            return created
        } catch {
            actionError = describeHostFailure(error)
            return nil
        }
    }

    func cancelTurn() async {
        _ = await perform { try await client.cancelTurn(conversationID: conversation.id) }
    }

    func respond(to prompt: PermissionPrompt, option: PermissionOption?, persist: Bool = false) async {
        boostPollingUntil = Date().addingTimeInterval(25)
        session.isTurnRunning = true
        _ = await perform {
            try await client.respondPermission(
                conversationID: conversation.id,
                permissionID: prompt.id,
                optionID: option?.id,
                persist: persist
            )
        }
    }

    /// `content` nil declines the question.
    func respond(to question: PendingQuestion, content: JSONValue?) async {
        boostPollingUntil = Date().addingTimeInterval(25)
        session.isTurnRunning = true
        _ = await perform {
            try await client.respondQuestion(
                conversationID: conversation.id,
                questionID: question.id,
                content: content
            )
        }
    }

    func setMode(_ mode: SessionMode) async {
        modeOverride = mode.id
        let applied = await perform {
            try await changingSession {
                try await client.setSessionMode(conversationID: conversation.id, modeID: mode.id)
            }
        }
        if !applied || modeOverride == mode.id { modeOverride = nil }
    }

    func set(_ option: ConfigOption, to choice: ConfigChoice) async {
        optionOverrides[option.key] = choice.value
        _ = await perform {
            try await changingSession {
                try await client.setSessionConfigOption(
                    conversationID: conversation.id,
                    key: option.key,
                    value: choice.value
                )
            }
        }
        optionOverrides[option.key] = nil
    }

    private func perform(_ action: () async throws -> Void) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            try await action()
            actionError = nil
            await reload()
            return true
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }
}
