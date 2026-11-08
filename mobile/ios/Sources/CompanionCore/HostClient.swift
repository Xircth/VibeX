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
        optionID: String?,
        persist: Bool = false
    ) async throws {
        let response: [String: Any]
        if let optionID {
            var dict: [String: Any] = ["kind": "selected", "option_id": optionID]
            if persist { dict["persist"] = true }
            response = dict
        } else {
            response = ["kind": "cancelled"]
        }
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

    public func archiveConversation(conversationID: String) async throws {
        try await command("conversation_archive", [
            "conversationId": conversationID,
        ])
    }

    public func deleteConversation(conversationID: String) async throws {
        try await command("conversation_delete", [
            "conversationId": conversationID,
        ])
    }

    // MARK: - Collaboration Space (`collaboration_call`)

    public func collaborationCall<T: Decodable>(
        _ operation: String,
        input: [String: Any] = [:],
        as type: T.Type = T.self
    ) async throws -> T {
        try await call(
            "collaboration_call",
            args: [
                "capability": "collaboration",
                "operation": operation,
                "input": input,
            ],
            as: type
        )
    }

    public func collaborationCommand(_ operation: String, input: [String: Any] = [:]) async throws {
        let _: JSONValue = try await collaborationCall(operation, input: input, as: JSONValue.self)
    }

    public func collabSidebar(workspaceID: String) async throws -> [CollabSidebarItem] {
        struct Page: Decodable { let items: [CollabSidebarItem]? }
        return try await collaborationCall("thread.listSidebar", input: ["workspaceId": workspaceID], as: Page.self).items ?? []
    }

    public func collabContactGroups(workspaceID: String) async throws -> [CollabContactGroup] {
        struct Page: Decodable { let groups: [CollabContactGroup]? }
        let groups = try await collaborationCall("contactGroup.list", input: ["workspaceId": workspaceID], as: Page.self).groups ?? []
        return groups.sorted { $0.sortOrder < $1.sortOrder }
    }

    public func collabSpaces(workspaceID: String) async throws -> [CollabSpaceSummary] {
        struct Page: Decodable { let spaces: [CollabSpaceSummary]? }
        return try await collaborationCall("space.list", input: ["workspaceId": workspaceID], as: Page.self).spaces ?? []
    }

    public func collabSpaceMembers(spaceID: String) async throws -> [CollabSpaceMember] {
        struct Page: Decodable { let members: [CollabSpaceMember]? }
        return try await collaborationCall("space.listMembers", input: ["spaceId": spaceID], as: Page.self).members ?? []
    }

    public func collabMessages(spaceID: String, limit: Int = 200) async throws -> CollabMessagesPage {
        try await collaborationCall(
            "space.listMessages",
            input: ["spaceId": spaceID, "latest": true, "limit": limit],
            as: CollabMessagesPage.self
        )
    }

    public func collabPostMessage(
        spaceID: String,
        content: String,
        to: [String] = [],
        inReplyTo: String? = nil,
        delaySeconds: Int? = nil
    ) async throws {
        var input: [String: Any] = [
            "spaceId": spaceID,
            "content": content,
            "operationId": UUID().uuidString.lowercased(),
        ]
        if !to.isEmpty { input["to"] = to }
        if let inReplyTo, !inReplyTo.isEmpty { input["inReplyTo"] = inReplyTo }
        if let delaySeconds, delaySeconds > 0 {
            input["delaySeconds"] = delaySeconds
            try await collaborationCommand("space.post", input: input)
        } else {
            try await collaborationCommand("space.submit", input: input)
        }
    }

    public func collabReact(spaceID: String, messageID: String, emoji: String) async throws {
        try await collaborationCommand("space.react", input: [
            "spaceId": spaceID,
            "messageId": messageID,
            "emoji": emoji,
        ])
    }

    public func collabMarkRead(threadID: String, seq: Int? = nil) async throws {
        var input: [String: Any] = threadID.hasPrefix("direct:")
            ? ["threadId": threadID]
            : ["spaceId": threadID]
        if let seq { input["seq"] = seq }
        try await collaborationCommand("thread.markRead", input: input)
    }

    public func collabMarkUnread(threadID: String) async throws {
        let input: [String: Any] = threadID.hasPrefix("direct:")
            ? ["threadId": threadID]
            : ["spaceId": threadID]
        try await collaborationCommand("thread.markUnread", input: input)
    }

    public func collabCreateSpace(workspaceID: String, name: String) async throws -> CollabSpaceSummary {
        try await collaborationCall(
            "space.create",
            input: [
                "workspaceId": workspaceID,
                "name": name,
                "operationId": UUID().uuidString.lowercased(),
            ],
            as: CollabSpaceSummary.self
        )
    }

    public func collabCreateMember(
        workspaceID: String,
        name: String,
        agentID: String? = nil,
        roleID: String? = nil,
        personaPrompt: String? = nil,
        avatar: CollabBotAvatarConfig? = nil,
        color: String? = nil,
        isSupervisor: Bool = false
    ) async throws -> JSONValue {
        var input: [String: Any] = [
            "workspaceId": workspaceID,
            "nickname": name,
            "name": name,
            "operationId": UUID().uuidString.lowercased(),
            "isSupervisor": isSupervisor,
        ]
        if let agentID, !agentID.isEmpty { input["agentId"] = agentID }
        if let roleID, !roleID.isEmpty { input["roleId"] = roleID }
        if let personaPrompt, !personaPrompt.isEmpty { input["personaPrompt"] = personaPrompt }
        if let avatar {
            input["avatar"] = avatar.jsonString
            input["color"] = avatar.color
        } else if let color, !color.isEmpty {
            input["color"] = color
        }
        return try await collaborationCall("space.createMember", input: input, as: JSONValue.self)
    }

    public func collabAddMemberToSpace(
        spaceID: String,
        conversationID: String,
        nickname: String
    ) async throws {
        try await collaborationCommand("space.addMember", input: [
            "spaceId": spaceID,
            "conversationId": conversationID,
            "nickname": nickname,
            "operationId": UUID().uuidString.lowercased(),
        ])
    }

    public func collabResolveSession(memberID: String, threadID: String) async throws -> String? {
        struct Page: Decodable { let conversationId: String? }
        return try await collaborationCall(
            "member.session.resolve",
            input: ["memberId": memberID, "threadId": threadID],
            as: Page.self
        ).conversationId
    }

    public func collabResolveCard(
        cardID: String,
        decision: String? = nil,
        answer: String? = nil,
        declined: Bool = false
    ) async throws {
        var input: [String: Any] = [
            "cardId": cardID,
            "declined": declined,
        ]
        if let decision { input["decision"] = decision }
        if let answer { input["answer"] = answer }
        try await collaborationCommand("card.resolve", input: input)
    }

    public func collabCancelSpaceTurn(spaceID: String, memberID: String) async throws {
        try await collaborationCommand("space.cancelTurn", input: [
            "spaceId": spaceID,
            "memberId": memberID,
        ])
    }

    public func collabRoles() async throws -> [CollabRole] {
        struct Page: Decodable { let roles: [CollabRole]? }
        return try await collaborationCall("role.list", as: Page.self).roles ?? []
    }

    public func collabTeams() async throws -> [CollabTeam] {
        struct Page: Decodable { let teams: [CollabTeam]? }
        return try await collaborationCall("team.list", as: Page.self).teams ?? []
    }

    public func collabMemoryView(spaceID: String, memberID: String? = nil) async throws -> CollabMemoryView {
        var input: [String: Any] = ["spaceId": spaceID]
        if let memberID, !memberID.isEmpty { input["memberId"] = memberID }
        return try await collaborationCall("space.memory.view", input: input, as: CollabMemoryView.self)
    }

    public func collabCollectionItems(spaceID: String) async throws -> [CollabCollectionItem] {
        struct Page: Decodable { let items: [CollabCollectionItem]? }
        return try await collaborationCall("space.listCollection", input: ["spaceId": spaceID], as: Page.self).items ?? []
    }

    // MARK: - Kanban Board & Usage Dashboard

    public func kanbanWorkspaces(projectID: String) async throws -> [KanbanWorkspaceRecord] {
        try await call(
            "get_project_workspaces",
            args: ["projectId": projectID],
            as: [KanbanWorkspaceRecord].self
        )
    }

    public func kanbanSessionSummaries(workspaceID: String) async throws -> [KanbanSessionSummary] {
        try await call(
            "get_session_summaries",
            args: ["workspaceId": workspaceID],
            as: [KanbanSessionSummary].self
        )
    }

    public func kanbanAllSessions(workspaceIDs: [String]) async throws -> [KanbanSessionSummary] {
        let uniqueIDs = Array(NSOrderedSet(array: workspaceIDs.filter { !$0.isEmpty })) as? [String] ?? []
        var byID: [String: KanbanSessionSummary] = [:]
        for wsID in uniqueIDs {
            if let list = try? await kanbanSessionSummaries(workspaceID: wsID) {
                for item in list {
                    byID[item.id] = item
                }
            }
        }
        if byID.isEmpty {
            let recent: [ConversationListItem] = (try? await call(
                "conversation_list_recent",
                args: ["limit": 200],
                as: [ConversationListItem].self
            )) ?? []
            let allowed = Set(uniqueIDs.map { $0.lowercased() })
            for conv in recent where allowed.isEmpty || allowed.contains(conv.workspace_id.lowercased()) {
                let summary = KanbanSessionSummary(fromConversation: conv)
                byID[summary.id] = summary
            }
        }
        return byID.values.sorted {
            ($0.updatedDate ?? .distantPast) > ($1.updatedDate ?? .distantPast)
        }
    }

    public func updateSessionStatus(sessionID: String, status: KanbanSessionStatus) async throws {
        do {
            try await command("update_session_status", [
                "sessionId": sessionID,
                "status": status.rawValue,
            ])
        } catch {
            if status == .archived {
                try await archiveConversation(conversationID: sessionID)
            } else {
                try await command("conversation_set_status", [
                    "conversationId": sessionID,
                    "status": status.rawValue,
                ])
            }
        }
    }

    public func renameSession(sessionID: String, name: String?) async throws {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await command("rename_session", [
                "sessionId": sessionID,
                "name": (trimmed?.isEmpty == false ? trimmed! : NSNull()) as Any,
            ])
        } catch {
            try await command("conversation_rename", [
                "conversationId": sessionID,
                "title": trimmed ?? "",
            ])
        }
    }

    public func setSessionPinned(sessionID: String, pinned: Bool) async throws {
        do {
            try await command("set_session_pinned", [
                "sessionId": sessionID,
                "pinned": pinned,
            ])
        } catch {
            try await command("conversation_set_pinned", [
                "conversationId": sessionID,
                "pinned": pinned,
            ])
        }
    }

    public func markSessionViewed(sessionID: String) async throws {
        try await command("mark_session_viewed", [
            "sessionId": sessionID,
        ])
    }

    public func deleteKanbanSession(sessionID: String) async throws {
        do {
            try await command("delete_session", [
                "sessionId": sessionID,
            ])
        } catch {
            try await deleteConversation(conversationID: sessionID)
        }
    }

    public func forkConversation(conversationID: String) async throws -> String? {
        let res: JSONValue = try await call(
            "conversation_fork",
            args: ["conversationId": conversationID],
            as: JSONValue.self
        )
        return res["conversationId"]?.stringValue ?? res["conversation_id"]?.stringValue
    }

    public func projectUsageStatistics(
        scope: String,
        projectID: String? = nil,
        dateRange: UsageDateRange = .sevenDays
    ) async throws -> ProjectUsageStatistics {
        var args: [String: Any] = [
            "scope": scope,
            "dateRange": dateRange.rawValue,
        ]
        if let projectID, !projectID.isEmpty {
            args["projectId"] = projectID
        } else {
            args["projectId"] = NSNull()
        }
        return try await call(
            "get_project_usage_statistics",
            args: args,
            as: ProjectUsageStatistics.self
        )
    }

    public func agentPlanUsage(agentID: String) async throws -> PlanUsageResponse {
        try await call(
            "agent_plan_usage",
            args: ["agentId": agentID],
            as: PlanUsageResponse.self
        )
    }

    // MARK: - Settings / Skills / MCP / Plugins / System Info RPCs

    public func localSkills() async throws -> [LocalSkillItem] {
        try await call("scan_local_skills", as: [LocalSkillItem].self)
    }

    public func readLocalSkill(skillID: String) async throws -> LocalSkillContentItem {
        try await call(
            "read_local_skill",
            args: ["skillId": skillID],
            as: LocalSkillContentItem.self
        )
    }

    public func localMcpServers() async throws -> [LocalMcpServerItem] {
        try await call("mcp_scan_local", as: [LocalMcpServerItem].self)
    }

    public func userSystemInfo() async throws -> HostUserSystemInfo {
        try await call("get_user_system_info", as: HostUserSystemInfo.self)
    }

    public func pluginCatalog() async throws -> [PluginCatalogItem] {
        do {
            let res: PluginControlCatalogResponse = try await call(
                "plugin_control_catalog",
                as: PluginControlCatalogResponse.self
            )
            return res.plugins
        } catch {
            if let info = try? await userSystemInfo(), !info.plugins.isEmpty {
                return info.plugins
            }
            throw error
        }
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
