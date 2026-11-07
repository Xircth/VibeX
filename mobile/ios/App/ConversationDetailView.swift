import CompanionCore
import SwiftUI

struct ConversationDetailView: View {
    @State private var model: ConversationModel
    @State private var draft = ""
    @State private var menu: ComposerMenu?
    @State private var panel: DetailPanel?
    @State private var created: ConversationListItem?
    @State private var diffChange: FileChangeItem?

    init(client: HostClient, conversation: ConversationListItem) {
        _model = State(initialValue: ConversationModel(client: client, conversation: conversation))
    }

    var body: some View {
        VStack(spacing: 0) {
            messages
                .overlay {
                    if menu != nil {
                        Color.clear.contentShape(Rectangle()).onTapGesture { menu = nil }
                    }
                }
            if !model.items.currentPlan.isEmpty {
                TaskDock(tasks: model.items.currentPlan, running: model.session.isTurnRunning)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
            if let question = model.session.pendingQuestions.first {
                ApprovalCard(request: question) { content in
                    await model.respond(to: question, content: content)
                }
                .id(question.id)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
            if let prompt = model.session.pendingPermissions.first {
                PermissionBanner(prompt: prompt) { option in
                    Task { await model.respond(to: prompt, option: option) }
                }
            }
            if let message = model.actionError {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
            }
            promptBar.padding(.top, 8)
        }
        .navigationTitle(model.conversation.title ?? "未命名对话")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Menu("新对话", systemImage: "square.and.pencil") {
                        ForEach(model.newConversationAgents) { agent in
                            Button {
                                Task { created = await model.createConversation(agentID: agent.id) }
                            } label: {
                                AgentMenuLabel(agentID: agent.id, hostName: agent.displayName)
                            }
                        }
                    }
                    Button("浏览文件", systemImage: "folder") { panel = .files }
                    Button("代码差异", systemImage: "plus.forwardslash.minus") { panel = .changes }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("更多")
            }
        }
        .sheet(item: $panel) { panel in
            switch panel {
            case .files:
                FileBrowserView(client: model.client, workspaceID: model.conversation.workspace_id)
            case .changes:
                DiffListView(client: model.client, workspaceID: model.conversation.workspace_id)
            }
        }
        .sheet(item: $diffChange) { change in
            if let hunks = change.hunks {
                NavigationStack {
                    DiffFileView(
                        client: model.client,
                        workspaceID: model.conversation.workspace_id,
                        diff: FileDiff(path: change.path, hunks: hunks)
                    )
                }
            } else {
                FileDiffSheet(client: model.client, workspaceID: model.conversation.workspace_id, path: change.path)
            }
        }
        .onDisappear {
            dismissKeyboard()
            model.stopActivity()
        }
        .navigationDestination(item: $created) { ConversationDetailView(client: model.client, conversation: $0) }
        .background { Color(.systemGroupedBackground).ignoresSafeArea() }
        .task {
            while !Task.isCancelled {
                await model.reload()
                try? await Task.sleep(for: .seconds(model.session.isTurnRunning ? 0.6 : 4))
            }
        }
        .onChange(of: menu) { _, kind in
            if kind == .model || kind == .plusModel { Task { await model.refreshCatalog() } }
        }
    }

    // MARK: Prompt bar

    private var promptBar: some View {
        PromptBar(
            draft: $draft,
            menu: $menu,
            isRunning: model.session.isTurnRunning,
            busy: model.busy,
            hasAlert: !model.session.pendingPermissions.isEmpty,
            modelName: model.currentModelLabel,
            agentID: model.conversation.agent_id,
            modelChoices: modelChoices,
            otherModelGroups: otherModelGroups,
            otherAgentNote: otherModelGroups.isEmpty
                ? nil
                : "此对话使用 \(model.currentAgent?.displayName ?? "当前 Agent")，换 Agent 请新建对话",
            accessChoices: model.accessModes.map {
                PromptChoice(
                    id: $0.id,
                    title: $0.label,
                    detail: $0.description,
                    icon: "shield",
                    selected: $0.id == model.currentAccessModeID
                )
            },
            extraChoices: model.extraOptions.map {
                PromptChoice(id: "option:" + $0.key, title: $0.label, tag: $0.currentLabel, icon: "slider.horizontal.3")
            },
            effort: effort,
            openFiles: { panel = .files },
            send: {
                let text = draft
                Task { if await model.send(text) { draft = "" } }
            },
            stop: { Task { await model.cancelTurn() } },
            pickModel: { id in
                guard let (option, choice) = findModelChoice(id) else { return }
                menu = nil
                Task { await model.set(option, to: choice) }
            },
            pickAccess: { id in
                guard let mode = model.accessModes.first(where: { $0.id == id }) else { return }
                menu = nil
                Task { await model.setMode(mode) }
            },
            pickExtra: { id in
                guard let option = model.extraOptions.first(where: { "option:" + $0.key == id }),
                      let next = nextChoice(of: option)
                else { return }
                Task { await model.set(option, to: next) }
            },
            setEffort: { index in
                guard let option = model.effortOption, option.choices.indices.contains(index),
                      index != effort?.index
                else { return }
                Task { await model.set(option, to: option.choices[index]) }
            }
        )
    }

    private var modelChoices: [PromptChoice] {
        model.modelOptions.flatMap { option in
            option.choices.map {
                PromptChoice(
                    id: option.key + "|" + $0.id,
                    title: $0.label,
                    tag: $0.description,
                    agentID: model.conversation.agent_id,
                    selected: $0.value == model.value(of: option)
                )
            }
        }
    }

    private var otherModelGroups: [PromptGroup] {
        model.otherAgentsWithModels.map { agent in
            PromptGroup(
                title: AgentBrand.displayName(agent.id, hostName: agent.displayName),
                agentID: agent.id,
                choices: agent.modelOptions.flatMap(\.choices).map {
                    PromptChoice(id: agent.id + "|" + $0.id, title: $0.label, agentID: agent.id, enabled: false)
                }
            )
        }
    }

    private func findModelChoice(_ id: String) -> (ConfigOption, ConfigChoice)? {
        for option in model.modelOptions {
            if let choice = option.choices.first(where: { option.key + "|" + $0.id == id }) {
                return (option, choice)
            }
        }
        return nil
    }

    private var effort: PromptEffort? {
        guard let option = model.effortOption, option.choices.count > 1 else { return nil }
        let value = model.value(of: option)
        let index = option.choices.firstIndex { $0.value == value } ?? 0
        return PromptEffort(levels: option.choices.map(\.label), index: index)
    }

    private func nextChoice(of option: ConfigOption) -> ConfigChoice? {
        guard !option.choices.isEmpty else { return nil }
        let value = model.value(of: option)
        let current = option.choices.firstIndex { $0.value == value } ?? -1
        return option.choices[(current + 1) % option.choices.count]
    }

    // MARK: Messages

    @ViewBuilder
    private var messages: some View {
        if model.hasLoaded {
            if model.items.isEmpty {
                ContentUnavailableView("还没有消息", systemImage: "text.bubble")
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            ForEach(model.items) { item in
                                MessageRow(
                                    item: item,
                                    agentID: model.conversation.agent_id,
                                    modelName: model.currentModelLabel,
                                    isLast: item.id == model.items.last?.id,
                                    running: model.session.isTurnRunning,
                                    openDiff: { diffChange = $0 }
                                )
                                .id(item.id)
                            }
                            if model.session.isTurnRunning && model.items.last?.role != .assistant {
                                LoadingState(label: "正在思考").id("loading")
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: model.items.last) { _, last in
                        if let last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                    }
                }
            }
        } else if let message = model.loadError {
            LoadFailureView(message: message) { Task { await model.reload() } }
        } else {
            ProgressView().frame(maxHeight: .infinity)
        }
    }
}

extension String: @retroactive Identifiable {
    public var id: String { self }
}

enum DetailPanel: String, Identifiable {
    case files, changes
    var id: String { rawValue }
}

private struct MessageRow: View {
    let item: TimelineItem
    let agentID: String?
    let modelName: String?
    let isLast: Bool
    let running: Bool
    let openDiff: (FileChangeItem) -> Void

    var body: some View {
        switch item.role {
        case .user:
            HStack {
                Spacer(minLength: 48)
                Text(item.text)
                    .font(.system(size: 15))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        UnevenRoundedRectangle(
                            topLeadingRadius: 16,
                            bottomLeadingRadius: 16,
                            bottomTrailingRadius: 5,
                            topTrailingRadius: 16
                        )
                        .fill(Color.accentColor.opacity(0.16))
                    )
            }
        case .assistant:
            let streaming = running && isLast
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    AgentIconView(agent: agentID, size: 15)
                        .frame(width: 22, height: 22)
                        .background(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(Color(.secondarySystemGroupedBackground))
                        )
                    Text(AgentBrand.displayName(agentID))
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(.primary)
                    if let modelName, !modelName.isEmpty, modelName != AgentBrand.displayName(agentID) {
                        Text(modelName)
                            .font(.system(size: 11.5))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    if streaming {
                        Circle()
                            .fill(Color.orange)
                            .frame(width: 6, height: 6)
                    }
                    Spacer()
                }

                if !item.thinking.isEmpty {
                    ThinkingView(item: item, working: streaming && item.text.isEmpty)
                }
                if !item.tools.isEmpty || !item.changes.isEmpty {
                    ToolChipsView(item: item, working: streaming, openDiff: openDiff)
                }
                if !item.text.isEmpty {
                    StreamingMessageText(text: item.text, streaming: streaming)
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct PermissionBanner: View {
    let prompt: PermissionPrompt
    let respond: (PermissionOption?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(prompt.title, systemImage: "exclamationmark.shield")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.orange)
            ForEach(prompt.options) { option in
                let allow = option.kind.hasPrefix("allow")
                Button { respond(option) } label: {
                    Text(option.label)
                        .font(.subheadline)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            (allow ? Color.accentColor : Color.secondary).opacity(0.14),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                }
                .buttonStyle(.plain)
                .foregroundStyle(allow ? Color.accentColor : Color.secondary)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.1))
    }
}
