import Foundation

public enum HostError: Error, Equatable, LocalizedError {
    case server(status: Int, message: String)
    case malformedResponse

    public var errorDescription: String? {
        switch self {
        case .server(let status, let message):
            return message.isEmpty ? "电脑返回错误（\(status)）" : message
        case .malformedResponse:
            return "电脑返回了无法识别的数据"
        }
    }
}

private struct CommandEnvelope<Payload: Decodable>: Decodable { let data: Payload }

/// Authenticated Remote Protocol v1 calls against one paired Host.
public struct HostClient: Sendable {
    private let origin: HostOrigin
    private let accessToken: String
    private let transport: HttpTransport

    public init(
        origin: HostOrigin,
        accessToken: String,
        transport: HttpTransport = URLSessionTransport()
    ) {
        self.origin = origin
        self.accessToken = accessToken
        self.transport = transport
    }

    public func call<T: Decodable>(
        _ command: String,
        args: [String: Any] = [:],
        as type: T.Type = T.self
    ) async throws -> T {
        let body = try JSONSerialization.data(
            withJSONObject: ["operation_id": UUID().uuidString.lowercased(), "args": args]
        )
        let exchange = try await transport.execute(
            method: "POST",
            url: origin.resolve("/api/v1/call/\(command)"),
            headers: headers(contentType: true),
            body: body
        )
        let data = try Self.successBody(exchange)
        guard let envelope = try? JSONDecoder().decode(CommandEnvelope<T>.self, from: data) else {
            throw HostError.malformedResponse
        }
        return envelope.data
    }

    public func offlineConversation(id: String, afterSequence: Int64 = 0) async throws
        -> OfflineConversationCache
    {
        let exchange = try await transport.execute(
            method: "GET",
            url: origin.resolve("/api/v1/conversations/\(id)/offline?after_sequence=\(afterSequence)"),
            headers: headers(contentType: false),
            body: nil
        )
        let data = try Self.successBody(exchange)
        guard let cache = try? JSONDecoder().decode(OfflineConversationCache.self, from: data) else {
            throw HostError.malformedResponse
        }
        return cache
    }

    /// Brings `state` up to date. The first call reads everything; later calls re-read only the
    /// tail, which is where a streaming answer grows, so polling stays cheap.
    public func refresh(_ state: inout TranscriptState) async throws {
        var start = max(0, state.nextIndex - 4)
        var end = state.nextIndex
        for _ in 0..<20 {
            var args: [String: Any] = ["conversationId": state.conversationID, "limit": 200]
            if start > 0 { args["cursor"] = String(start) }
            let page: JSONValue = try await call("conversation_timeline_page", args: args, as: JSONValue.self)
            let rows = page["rows"]?.arrayValue ?? []
            let pageStart = page["cursor"]?.stringValue.flatMap(Int.init) ?? start
            state.merge(rows)
            end = max(end, pageStart + rows.count)
            guard let next = page["next_cursor"]?.stringValue.flatMap(Int.init) else { break }
            start = next
        }
        state.nextIndex = end
    }

    /// Projects with the workspaces they own, for grouping conversations by project.
    public func projects() async throws -> [ProjectSummary] {
        try await call("conversation_projects", as: [ProjectSummary].self)
    }

    /// One directory level of the workspace; `path` is relative to its root ("" is the root).
    public func workspaceTree(workspaceID: String, path: String = "") async throws -> WorkspaceTree {
        try await call(
            "conversation_workspace_tree",
            args: ["workspaceId": workspaceID, "path": path],
            as: WorkspaceTree.self
        )
    }

    public func workspaceFile(workspaceID: String, path: String) async throws -> WorkspaceFile {
        try await call(
            "conversation_workspace_file",
            args: ["workspaceId": workspaceID, "path": path],
            as: WorkspaceFile.self
        )
    }

    /// Working tree against HEAD, one entry per changed file, with the unified diff parsed into hunks.
    public func workspaceDiff(workspaceID: String) async throws -> [FileDiff] {
        let entries: [WorkspaceDiffEntry] = try await call(
            "conversation_workspace_diff",
            args: ["workspaceId": workspaceID],
            as: [WorkspaceDiffEntry].self
        )
        return entries.map(FileDiff.init)
    }

    /// Creates an empty Conversation in the same workspace with the same Agent.
    public func createConversation(workspaceID: String, agentID: String) async throws -> ConversationListItem {
        try await call(
            "conversation_create",
            args: ["workspaceId": workspaceID, "agentId": agentID],
            as: ConversationListItem.self
        )
    }

    /// Starts (or resumes) the Agent session behind a Conversation so its modes and options can be read and changed.
    public func ensureSessionControls(conversationID: String) async throws -> SessionState {
        let snapshot: JSONValue = try await call(
            "conversation_ensure_session_controls",
            args: ["conversationId": conversationID],
            as: JSONValue.self
        )
        return SessionStateBuilder.controls(from: snapshot)
    }

    // MARK: Conversation writes (Companion scopes: conversation.write / .cancel / .permission)

    private func command(_ name: String, _ args: [String: Any]) async throws {
        let _: JSONValue = try await call(name, args: args, as: JSONValue.self)
    }

    public func sendMessage(
        conversationID: String,
        workspaceID: String,
        agentID: String,
        text: String
    ) async throws {
        try await command("conversation_input_submit", [
            "request": [
                "conversationId": conversationID,
                "payload": ["agentId": agentID, "workspaceId": workspaceID, "text": text],
            ] as [String: Any],
        ])
    }

    public func cancelTurn(conversationID: String) async throws {
        try await command("conversation_cancel_turn", [
            "request": ["conversationId": conversationID] as [String: Any],
        ])
    }

    /// `content` is the form answer; `nil` declines the question.
    public func respondQuestion(
        conversationID: String,
        questionID: String,
        content: JSONValue?
    ) async throws {
        let response: [String: Any] = content.map { ["action": "accept", "content": $0.foundationValue] }
            ?? ["action": "decline"]
        try await command("conversation_respond_question", [
            "request": [
                "conversationId": conversationID,
                "questionId": questionID,
                "response": response,
            ] as [String: Any],
        ])
    }

    public func respondPermission(
        conversationID: String,
        permissionID: String,
        optionID: String?
    ) async throws {
        let response: [String: Any] = optionID.map { ["kind": "selected", "option_id": $0] }
            ?? ["kind": "cancelled"]
        try await command("conversation_respond_permission", [
            "request": [
                "conversationId": conversationID,
                "permissionId": permissionID,
                "response": response,
            ] as [String: Any],
        ])
    }

    public func setSessionMode(conversationID: String, modeID: String) async throws {
        try await command("conversation_set_session_mode", [
            "conversationId": conversationID, "modeId": modeID,
        ])
    }

    public func setSessionConfigOption(
        conversationID: String,
        key: String,
        value: JSONValue
    ) async throws {
        try await command("conversation_set_session_config_option", [
            "conversationId": conversationID, "key": key, "value": value.foundationValue,
        ])
    }

    private func headers(contentType: Bool) -> [String: String] {
        var result = [
            "authorization": "Bearer \(accessToken)",
            PairingClient.protocolHeader: PairingClient.clientProtocolVersion,
        ]
        if contentType { result["content-type"] = "application/json" }
        return result
    }

    private static func successBody(_ exchange: HttpExchange) throws -> Data {
        guard (200...299).contains(exchange.status) else {
            struct Failure: Decodable { let message: String? }
            let message = (try? JSONDecoder().decode(Failure.self, from: exchange.body))?.message
            throw HostError.server(status: exchange.status, message: message ?? "")
        }
        return exchange.body
    }
}
