import Foundation
import Testing
@testable import CompanionCore

private struct StubTransport: HttpTransport {
    let status: Int
    let reply: String
    func execute(
        method: String, url: String, headers: [String: String], body: Data?
    ) async throws -> HttpExchange {
        HttpExchange(status: status, body: Data(reply.utf8))
    }
}

private func client(_ status: Int, _ body: String) throws -> HostClient {
    HostClient(
        origin: try HostOrigin.parse("http://192.168.1.2:17891"),
        accessToken: "t",
        transport: StubTransport(status: status, reply: body)
    )
}

@Test func callDecodesConversationList() async throws {
    let json = """
    {"operation_id":"o","data":[{"id":"c1","workspace_id":"w","title":null,"status":"idle","model":"m","message_count":2,"created_at":"2026-11-06T14:00:00Z","updated_at":"2026-11-06T14:59:55.123456Z","extra":1}]}
    """
    let items: [ConversationListItem] = try await client(200, json).call("conversation_list_recent")
    #expect(items.count == 1)
    #expect(items[0].title == nil)
    #expect(items[0].updatedAt != nil)
}

@Test func callSurfacesServerMessage() async throws {
    let body = "{\"code\":\"forbidden\",\"message\":\"principal lacks artifact.read\",\"retryable\":false,\"operation_id\":\"o\"}"
    await #expect(throws: HostError.server(status: 403, message: "principal lacks artifact.read")) {
        let _: [ArtifactListItem] = try await client(403, body).call("artifact_list")
    }
}

@Test func timelineReadsMessageTurnsFromTranscriptRows() throws {
    let raw = """
    [
      {"row_id":"u1","revision":1,"row":{"kind":"message_turn","phase":"done","turn":{"id":"t1","role":"user","blocks":[{"type":"text","text":"你好"}]}}},
      {"row_id":"a1","revision":2,"row":{"kind":"message_turn","phase":"done","turn":{"id":"t2","role":"assistant","blocks":[{"type":"thinking","text":"hm"},{"type":"text","text":"你好，Sara！"},{"type":"tool_use","tool_name":"ls"}]}}},
      {"row_id":"a1","revision":1,"row":{"kind":"message_turn","phase":"streaming","turn":{"id":"t2","role":"assistant","blocks":[{"type":"text","text":"你好"}]}}},
      {"row_id":"s1","revision":1,"row":{"kind":"message_turn","phase":"done","turn":{"id":"t3","role":"system","blocks":[{"type":"text","text":"x"}]}}},
      {"row_id":"p1","revision":1,"row":{"kind":"permission_request","request":{}}}
    ]
    """
    let rows = try JSONDecoder().decode([JSONValue].self, from: Data(raw.utf8))
    let items = TimelineBuilder.build(fromRows: rows)
    #expect(items.map(\.text) == ["你好", "你好，Sara！"])
    #expect(items.map(\.role) == [.user, .assistant])
}

@Test func refreshReadsEverythingOnceThenOnlyTheTail() async throws {
    final class Pager: HttpTransport, @unchecked Sendable {
        private let lock = NSLock()
        private(set) var cursors: [String?] = []
        private var assistantText = "r"
        func grow() { lock.withLock { assistantText += "r" } }
        func execute(
            method: String, url: String, headers: [String: String], body: Data?
        ) async throws -> HttpExchange {
            let args = (body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["args"] as? [String: Any]
            let cursor = args?["cursor"] as? String
            let text = lock.withLock { () -> String in cursors.append(cursor); return assistantText }
            func row(_ id: String, _ role: String, _ text: String, _ revision: Int) -> String {
                "{\"row_id\":\"\(id)\",\"revision\":\(revision),\"row\":{\"kind\":\"message_turn\",\"phase\":\"done\",\"turn\":{\"id\":\"\(id)\",\"role\":\"\(role)\",\"blocks\":[{\"type\":\"text\",\"text\":\"\(text)\"}]}}}"
            }
            let json: String
            switch cursor {
            case nil:
                json = "{\"operation_id\":\"o\",\"data\":{\"cursor\":\"0\",\"rows\":[\(row("u", "user", "q", 1))],\"next_cursor\":\"1\"}}"
            case "1":
                json = "{\"operation_id\":\"o\",\"data\":{\"cursor\":\"1\",\"rows\":[\(row("a", "assistant", text, text.count))],\"next_cursor\":null}}"
            default: // tail re-read from index max(0, 2 - 4) = 0
                json = "{\"operation_id\":\"o\",\"data\":{\"cursor\":\"0\",\"rows\":[\(row("u", "user", "q", 1)),\(row("a", "assistant", text, text.count))],\"next_cursor\":null}}"
            }
            return HttpExchange(status: 200, body: Data(json.utf8))
        }
    }
    let pager = Pager()
    let host = HostClient(
        origin: try HostOrigin.parse("http://192.168.1.2:17891"),
        accessToken: "t",
        transport: pager
    )
    var state = TranscriptState(conversationID: "c")
    try await host.refresh(&state)
    #expect(state.items.map(\.text) == ["q", "r"])
    pager.grow()
    try await host.refresh(&state)
    #expect(state.items.map(\.text) == ["q", "rr"])
    #expect(state.items.count == 2)
}

@Test func assistantTurnKeepsThinkingAndToolSteps() throws {
    let raw = """
    [{"row_id":"a","revision":1,"row":{"kind":"message_turn","phase":"done","turn":{"id":"a","role":"assistant","duration_ms":4200,"blocks":[
      {"type":"thinking","text":"先看看文件"},
      {"type":"tool_use","tool_use_id":"t1","tool_name":"Read","status":"completed","input_preview":"src/main.rs\\nmore"},
      {"type":"tool_use","tool_name":"Edit","status":"in_progress"},
      {"type":"text","text":"改好了"}]}}},
     {"row_id":"b","revision":1,"row":{"kind":"message_turn","phase":"streaming","turn":{"id":"b","role":"assistant","blocks":[{"type":"thinking","text":"想一想"}]}}}]
    """
    let rows = try JSONDecoder().decode([JSONValue].self, from: Data(raw.utf8))
    let items = TimelineBuilder.build(fromRows: rows)
    #expect(items.count == 2)
    #expect(items[0].text == "改好了" && items[0].thinking == "先看看文件")
    #expect(items[0].tools.map(\.name) == ["Read", "Edit"])
    #expect(items[0].tools[0].preview == "src/main.rs" && items[0].tools[0].isFinished)
    #expect(!items[0].tools[1].isFinished && items[0].durationMs == 4200)
    #expect(items[1].text.isEmpty && items[1].hasTrace)
}

@Test func toolStepsShowTargetNotRawJSON() throws {
    let raw = """
    [{"row_id":"a","revision":1,"row":{"kind":"message_turn","phase":"done","turn":{"id":"a","role":"assistant","blocks":[
      {"type":"tool_use","tool_use_id":"w","tool_name":"Write notes.txt","input_preview":"{\\"file_path\\":\\"/tmp/ws/notes.txt\\",\\"content\\":\\"one\\\\ntwo\\"}"},
      {"type":"tool_use","tool_use_id":"b","tool_name":"ls -l notes.txt","input_preview":"{\\"command\\":\\"ls -l notes.txt\\"}"},
      {"type":"text","text":"ok"}]}}}]
    """
    let rows = try JSONDecoder().decode([JSONValue].self, from: Data(raw.utf8))
    let tools = TimelineBuilder.build(fromRows: rows)[0].tools
    #expect(tools[0].preview == "notes.txt" && tools[0].label == "Write")
    #expect(tools[0].detail.first?.hasPrefix("content: one") == true)
    #expect(tools[1].preview == "ls -l notes.txt" && tools[1].label == "ls")
}

@Test func writeAndEditCallsBecomeDiffChipsWithoutGit() throws {
    let raw = """
    [{"row_id":"a","revision":1,"row":{"kind":"message_turn","phase":"done","turn":{"id":"a","role":"assistant","blocks":[
      {"type":"tool_use","tool_use_id":"w","tool_name":"Write","input_preview":"{\\"file_path\\":\\"/ws/n.txt\\",\\"content\\":\\"a\\\\nb\\\\nc\\"}"},
      {"type":"tool_use","tool_use_id":"e","tool_name":"Edit","input_preview":"{\\"file_path\\":\\"/ws/n.txt\\",\\"old_string\\":\\"b\\",\\"new_string\\":\\"B\\\\nB2\\"}"},
      {"type":"text","text":"ok"}]}}}]
    """
    let rows = try JSONDecoder().decode([JSONValue].self, from: Data(raw.utf8))
    let change = try #require(TimelineBuilder.build(fromRows: rows)[0].changes.first)
    #expect(change.path == "/ws/n.txt" && change.additions == 5 && change.deletions == 1)
    #expect(change.hunks?.count == 2)
}

@Test func conversationsGroupByProjectAndKeepStrays() throws {
    func item(_ id: String, _ workspace: String, _ updated: String) -> String {
        "{\"id\":\"\(id)\",\"workspace_id\":\"\(workspace)\",\"message_count\":0,\"updated_at\":\"\(updated)\"}"
    }
    let raw = "[" + [
        item("1", "W1", "2026-11-06T10:00:00Z"),
        item("2", "W2", "2026-11-06T12:00:00Z"),
        item("3", "W1", "2026-11-06T11:00:00Z"),
        item("4", "ZZ", "2026-11-06T13:00:00Z"),
    ].joined(separator: ",") + "]"
    let conversations = try JSONDecoder().decode([ConversationListItem].self, from: Data(raw.utf8))
    let projects = [
        ProjectSummary(id: "p1", name: "webhub", workspaceIds: ["w1"]),
        ProjectSummary(id: "p2", name: "测试 hub", workspaceIds: ["W2"]),
    ]
    let groups = ProjectGroup.make(conversations: conversations, projects: projects)
    #expect(groups.map(\.name) == ["测试 hub", "webhub", "其他"])
    #expect(groups[1].conversations.map(\.id) == ["1", "3"])
    #expect(groups[2].conversations.map(\.id) == ["4"])
}

@Test func sessionStateFoldsModesOptionsAndPendingPermission() throws {
    let raw = """
    [
      {"sequence":1,"kind":"session_mode_updated","payload":{"current":"full","modes":[{"id":"ro","label":"Read-only"},{"id":"full","label":"完全访问"}]}},
      {"sequence":2,"kind":"session_config_options_updated","payload":{"options":[
        {"key":"model","label":"Model","category":"model","value":"a","choices":[{"value":"a","label":"Model A"},{"value":"b","label":"Model B"}]},
        {"key":"effort","label":"Reasoning effort","category":"thought_level","value":"low","choices":[{"value":"low","label":"低"}]}]}},
      {"sequence":3,"kind":"user_turn_started","payload":{}},
      {"sequence":4,"kind":"permission_requested","payload":{"request":{"permission_id":"p1","request":{"id":"p1","title":"Run ls","options":[{"id":"o1","label":"允许一次","kind":"allow_once"},{"id":"o2","label":"拒绝","kind":"reject_once"}]}}}},
      {"sequence":5,"kind":"permission_requested","payload":{"request":{"permission_id":"p2","request":{"id":"p2","title":"Write file","options":[]}}}},
      {"sequence":6,"kind":"permission_responded","payload":{"permission_id":"p2","response":{}}}
    ]
    """
    let events = try JSONDecoder().decode([RemoteEvent].self, from: Data(raw.utf8))
    let state = SessionStateBuilder.build(from: events)
    #expect(state.currentModeLabel == "完全访问")
    #expect(state.modelOptions.first?.currentLabel == "Model A")
    #expect(state.otherOptions.map(\.key) == ["effort"])
    #expect(state.isTurnRunning)
    #expect(state.pendingPermissions.map(\.id) == ["p1"])
    #expect(state.pendingPermissions[0].options.map(\.kind) == ["allow_once", "reject_once"])
}

@Test func sessionStateClearsTurnAndPermissionsOnTerminalEvent() throws {
    let raw = """
    [
      {"sequence":1,"kind":"user_turn_started","payload":{}},
      {"sequence":2,"kind":"permission_requested","payload":{"request":{"permission_id":"p1","request":{"id":"p1","title":"t","options":[]}}}},
      {"sequence":3,"kind":"turn_cancelled","payload":{}}
    ]
    """
    let events = try JSONDecoder().decode([RemoteEvent].self, from: Data(raw.utf8))
    let state = SessionStateBuilder.build(from: events)
    #expect(!state.isTurnRunning)
    #expect(state.pendingPermissions.isEmpty)
}

private final class RecordingTransport: HttpTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var lastBody: [String: Any] = [:]
    private(set) var lastURL = ""
    func execute(
        method: String, url: String, headers: [String: String], body: Data?
    ) async throws -> HttpExchange {
        lock.withLock {
            lastURL = url
            lastBody = (body.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
        }
        return HttpExchange(status: 200, body: Data("{\"operation_id\":\"o\",\"data\":null}".utf8))
    }
}

@Test func writeCommandsUseHostArgumentShapes() async throws {
    let transport = RecordingTransport()
    let host = HostClient(
        origin: try HostOrigin.parse("http://192.168.1.2:17891"),
        accessToken: "t",
        transport: transport
    )
    try await host.sendMessage(conversationID: "c", workspaceID: "w", agentID: "a", text: "hi")
    #expect(transport.lastURL.hasSuffix("/api/v1/call/conversation_input_submit"))
    let request = (transport.lastBody["args"] as? [String: Any])?["request"] as? [String: Any]
    let payload = request?["payload"] as? [String: Any]
    #expect(request?["conversationId"] as? String == "c")
    #expect(payload?["agentId"] as? String == "a")
    #expect(payload?["workspaceId"] as? String == "w")
    #expect(payload?["text"] as? String == "hi")

    try await host.respondPermission(conversationID: "c", permissionID: "p", optionID: "o1")
    let permission = ((transport.lastBody["args"] as? [String: Any])?["request"] as? [String: Any])
    let response = permission?["response"] as? [String: Any]
    #expect(response?["kind"] as? String == "selected")
    #expect(response?["option_id"] as? String == "o1")

    try await host.setSessionMode(conversationID: "c", modeID: "ro")
    let args = transport.lastBody["args"] as? [String: Any]
    #expect(args?["modeId"] as? String == "ro")

    try await host.setSessionConfigOption(conversationID: "c", key: "model", value: .string("b"))
    #expect((transport.lastBody["args"] as? [String: Any])?["value"] as? String == "b")
}

@Test func catalogListsDesktopAgentsWithTheirModels() throws {
    let raw = """
    {"projects":[],"workspaces":[],"agents":[
      {"id":"codex","ready":true,"usable":true,"displayName":"Codex","currentMode":"full",
       "sessionModes":[{"id":"ro","label":"Read-only","description":"只读"},{"id":"full","label":"完全访问"}],
       "sessionConfig":[{"key":"model","label":"Model","category":"model","value":"gpt-6-sol","choices":[{"value":"gpt-6-astra","label":"gpt-6-astra"},{"value":"gpt-6-sol","label":"gpt-6-sol"}]}]},
      {"id":"grok","ready":true,"usable":false,"displayName":"Grok"}
    ]}
    """
    let catalog = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
    let agents = AgentCatalogParser.agents(from: catalog)
    #expect(agents.map(\.displayName) == ["Codex", "Grok"])
    #expect(agents[0].usable && !agents[1].usable)
    #expect(agents[0].modelOptions.first?.currentLabel == "gpt-6-sol")
    #expect(agents[0].modes.first?.description == "只读")
    #expect(agents[0].currentModeID == "full")
}

@Test func liveControlsSnapshotYieldsModesAndOptions() throws {
    let raw = """
    {"modes":[{"id":"ro","label":"Read-only"}],"current_mode":"ro","config_options":[
      {"key":"effort","label":"Effort","category":"thought_level","value":"low","choices":[{"value":"low","label":"低"},{"value":"high","label":"高"}]}]}
    """
    let snapshot = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
    let state = SessionStateBuilder.controls(from: snapshot)
    #expect(state.currentModeID == "ro")
    #expect(state.modes.map(\.label) == ["Read-only"])
    #expect(state.otherOptions.map(\.key) == ["effort"])
}

@Test func unifiedDiffParsesHunksWithLineNumbers() {
    let text = """
    diff --git a/a.rs b/a.rs
    index 1..2 100644
    --- a/a.rs
    +++ b/a.rs
    @@ -10,3 +10,4 @@ fn main() {
     keep
    -old
    +new
    +extra
     tail
    \\ No newline at end of file
    @@ -40 +41 @@
    -x
    +y
    """
    let hunks = UnifiedDiff.parse(text)
    #expect(hunks.count == 2)
    let first = hunks[0].lines
    #expect(first.map(\.kind) == [.context, .removed, .added, .added, .context])
    #expect(first[1].oldNumber == 11 && first[1].newNumber == nil)
    #expect(first[2].newNumber == 11 && first[3].newNumber == 12)
    #expect(first[4].oldNumber == 12 && first[4].newNumber == 13)
    #expect(hunks[1].lines[0].oldNumber == 40 && hunks[1].lines[1].newNumber == 41)
}

@Test func workspaceDiffCallsHostAndKeepsCounts() async throws {
    let reply = """
    {"operation_id":"o","data":[
      {"path":"a.rs","status":"M","diff":"@@ -1 +1,2 @@\\n-a\\n+b\\n+c\\n","is_binary":false,"is_image":false,"truncated":false},
      {"path":"new.txt","status":"?","diff":"","is_binary":false,"is_image":false,"truncated":false},
      {"path":"logo.png","status":"M","diff":"","is_binary":true,"is_image":true,"truncated":false}]}
    """
    let diffs = try await client(200, reply).workspaceDiff(workspaceID: "w")
    #expect(diffs.map(\.path) == ["a.rs", "new.txt", "logo.png"])
    #expect(diffs[0].additions == 2 && diffs[0].deletions == 1)
    #expect(diffs[1].change == .untracked && diffs[1].needsContent)
    #expect(!diffs[2].needsContent)
    let added = FileDiff.additions(of: "x\ny\n")
    #expect(added.first?.lines.map(\.newNumber) == [1, 2])
}

@Test func workspaceTreeAndFileDecode() async throws {
    let tree = try await client(200, "{\"operation_id\":\"o\",\"data\":{\"path\":\"src\",\"entries\":[{\"name\":\"main.rs\",\"path\":\"src/main.rs\",\"directory\":false}],\"truncated\":false}}")
        .workspaceTree(workspaceID: "w", path: "src")
    #expect(tree.entries.first?.path == "src/main.rs")
    let file = try await client(200, "{\"operation_id\":\"o\",\"data\":{\"path\":\"a\",\"size\":3,\"binary\":false,\"truncated\":false,\"content\":\"abc\"}}")
        .workspaceFile(workspaceID: "w", path: "a")
    #expect(file.content == "abc")
}

@Test func workspaceEntriesAndCreatedConversationDecode() async throws {
    let created = """
    {"operation_id":"o","data":{"id":"c2","workspace_id":"w","title":null,"agent_id":"codex","message_count":0,"updated_at":"2026-11-06T14:00:00Z"}}
    """
    let host = try client(200, created)
    let item = try await host.createConversation(workspaceID: "w", agentID: "codex")
    #expect(item.id == "c2" && item.agent_id == "codex")
}

@Test func questionFormsFollowTheDesktopAnswerShapes() throws {
    func decode(_ text: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }
    // plain options
    let plain = PendingQuestion(id: "q", prompt: "继续吗", options: ["是", "否"], schema: nil)
    let plainForm = QuestionForm.questions(for: plain)
    #expect(plainForm.count == 1 && plainForm[0].choices.map(\.label) == ["是", "否"])
    let picked = QuestionForm.content(for: plain, questions: plainForm, answers: ["answer": QuestionAnswer(selected: [.string("是")])])
    #expect(picked == .object(["answer": .string("是")]))
    #expect(QuestionForm.content(for: plain, questions: plainForm, answers: [:]) == nil)

    // schema properties, including a multi-select and a custom companion
    let schema = try decode("""
    {"type":"object","properties":{
      "scope":{"title":"范围","type":"string","enum":["a","b"]},
      "tags":{"title":"标签","type":"array","items":{"enum":["x","y"]}},
      "note":{"type":"string"},"note_custom":{"type":"string"}}}
    """)
    let withSchema = PendingQuestion(id: "q2", prompt: "", options: [], schema: schema)
    let forms = QuestionForm.questions(for: withSchema)
    #expect(forms.map(\.id) == ["note", "scope", "tags"])
    #expect(forms.first { $0.id == "tags" }?.multiSelect == true)
    let content = QuestionForm.content(for: withSchema, questions: forms, answers: [
        "scope": QuestionAnswer(selected: [.string("b")]),
        "tags": QuestionAnswer(selected: [.string("x"), .string("y")], customText: ""),
        "note": QuestionAnswer(customText: "补充"),
    ])
    #expect(content?["scope"] == .string("b"))
    #expect(content?["tags"] == .array([.string("x"), .string("y")]))
    #expect(content?["note_custom"] == .string("补充"))

    // x-vibex-questions answer by id with labels
    let vibex = try decode("""
    {"x-vibex-questions":[{"id":"n","header":"数量","question":"几个？","options":[{"label":"三个"},{"label":"五个"}],"multiSelect":false}]}
    """)
    let request = PendingQuestion(id: "q3", prompt: "", options: [], schema: vibex)
    let steps = QuestionForm.questions(for: request)
    let answer = QuestionForm.content(for: request, questions: steps, answers: ["n": QuestionAnswer(selected: [.string("三个")])])
    #expect(answer?["answers"]?.arrayValue?.first?["labels"] == .array([.string("三个")]))
}

@Test func sessionStateTracksPendingQuestions() throws {
    let raw = """
    [{"sequence":1,"kind":"question_requested","payload":{"request":{"question_id":"q1","prompt":"选哪个","options":["甲","乙"]}}},
     {"sequence":2,"kind":"question_requested","payload":{"request":{"question_id":"q2","prompt":"再选","options":[]}}},
     {"sequence":3,"kind":"question_responded","payload":{"question_id":"q1","response":{}}}]
    """
    let events = try JSONDecoder().decode([RemoteEvent].self, from: Data(raw.utf8))
    let state = SessionStateBuilder.build(from: events)
    #expect(state.pendingQuestions.map(\.id) == ["q2"])
}

@Test func latestPlanBecomesTheCurrentTaskList() throws {
    let raw = """
    [{"row_id":"a","revision":1,"row":{"kind":"message_turn","phase":"done","turn":{"id":"a","role":"assistant","blocks":[
       {"type":"plan","entries":[{"content":"读代码","status":"completed"},{"content":"写测试","status":"pending"}]}]}}},
     {"row_id":"b","revision":1,"row":{"kind":"message_turn","phase":"streaming","turn":{"id":"b","role":"assistant","blocks":[
       {"type":"plan","entries":[{"content":"读代码","status":"completed"},{"content":"写测试","status":"in_progress","priority":"high"},{"content":"提交","status":"pending"}]},
       {"type":"text","text":"进行中"}]}}}]
    """
    let rows = try JSONDecoder().decode([JSONValue].self, from: Data(raw.utf8))
    let items = TimelineBuilder.build(fromRows: rows)
    let plan = items.currentPlan
    #expect(plan.map(\.label) == ["读代码", "写测试", "提交"])
    #expect(plan.map(\.status) == [.completed, .running, .pending])
    #expect(plan[1].priority == "high")
    #expect(items[0].plan.count == 2)
}

@Test func changedFilesAttachToTheAssistantTurnBeforeThem() throws {
    let raw = """
    [{"row_id":"a","revision":1,"row":{"kind":"message_turn","phase":"done","turn":{"id":"a","role":"assistant","blocks":[
       {"type":"tool_use","tool_name":"Edit","input_preview":"a.rs\\nline2\\nline3\\nline4\\nline5"},{"type":"text","text":"好了"}]}}},
     {"row_id":"f","revision":1,"row":{"kind":"file_change_summary","summary":{"source":"git","files":[
       {"path":"a.rs","change_kind":"modified","additions":3,"deletions":1}]}}}]
    """
    let rows = try JSONDecoder().decode([JSONValue].self, from: Data(raw.utf8))
    let item = try #require(TimelineBuilder.build(fromRows: rows).first)
    #expect(item.changes.map(\.path) == ["a.rs"] && item.changes[0].additions == 3)
    #expect(item.tools[0].detail == ["a.rs", "line2", "line3", "line4"])
}
