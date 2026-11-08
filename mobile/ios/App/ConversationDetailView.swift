import CompanionCore
import SwiftUI

struct ConversationDetailView: View {
    @State private var model: ConversationModel
    @State private var draft = ""
    @State private var menu: ComposerMenu?
    @State private var panel: DetailPanel?
    @State private var created: ConversationListItem?
    @State private var diffChange: FileChangeItem?

    // Scroll safe-zone & floating bottom indicator state
    @State private var distanceFromBottom: CGFloat = 0
    @State private var userDetachedFromBottom = false
    @State private var isUserDraggingScroll = false
    @State private var unreadMessageUpdates = 0
    @State private var hasPerformedInitialScroll = false

    private let bottomSafeZoneThreshold: CGFloat = 110

    private var isInBottomSafeZone: Bool {
        !userDetachedFromBottom && !isUserDraggingScroll && distanceFromBottom <= bottomSafeZoneThreshold
    }

    var onToggleSidebar: (() -> Void)?
    var onReturnToLanding: (() -> Void)?

    init(
        client: HostClient,
        conversation: ConversationListItem,
        onToggleSidebar: (() -> Void)? = nil,
        onReturnToLanding: (() -> Void)? = nil
    ) {
        _model = State(initialValue: ConversationModel(client: client, conversation: conversation))
        self.onToggleSidebar = onToggleSidebar
        self.onReturnToLanding = onReturnToLanding
    }

    var body: some View {
        VStack(spacing: 0) {
            if onToggleSidebar != nil {
                embeddedHeaderBar
            }
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
                ApprovalCard(request: question, busy: model.busy) { content in
                    Task { await model.respond(to: question, content: content) }
                }
                .id(question.id)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
            if let prompt = model.session.pendingPermissions.first {
                PermissionBanner(prompt: prompt, busy: model.busy) { option, persist in
                    Task { await model.respond(to: prompt, option: option, persist: persist) }
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
        .toolbar(onToggleSidebar != nil ? .hidden : .visible, for: .navigationBar)
        .toolbar(onToggleSidebar != nil ? .visible : .hidden, for: .tabBar)
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
                if model.isActivelyStreaming {
                    try? await Task.sleep(for: .milliseconds(140))
                } else {
                    for _ in 0..<6 {
                        if Task.isCancelled || model.isActivelyStreaming { break }
                        try? await Task.sleep(for: .milliseconds(200))
                    }
                }
            }
        }
        .onChange(of: menu) { _, kind in
            if kind == .model || kind == .plusModel { Task { await model.refreshCatalog() } }
        }
    }

    private var embeddedHeaderBar: some View {
        HStack(spacing: 10) {
            Button {
                dismissKeyboard()
                onToggleSidebar?()
            } label: {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 16.5, weight: .medium))
                    .foregroundStyle(.primary)
                    .frame(width: 36, height: 36)
                    .background(
                        Circle()
                            .fill(Color(.secondarySystemGroupedBackground))
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("打开侧边栏")

            VStack(spacing: 1.5) {
                HStack(spacing: 5) {
                    if model.session.isTurnRunning {
                        Circle()
                            .fill(Color.orange)
                            .frame(width: 6.5, height: 6.5)
                    }
                    Text(model.conversation.title ?? "未命名对话")
                        .font(.system(size: 15.5, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }

                HStack(spacing: 4) {
                    AgentIconView(agent: model.conversation.agent_id, size: 11)
                    Text(model.currentModelLabel ?? AgentBrand.displayName(model.conversation.agent_id))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 6) {
                if let onReturnToLanding {
                    Button {
                        dismissKeyboard()
                        onReturnToLanding()
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 15.5, weight: .medium))
                            .foregroundStyle(.primary)
                            .frame(width: 36, height: 36)
                            .background(
                                Circle()
                                    .fill(Color(.secondarySystemGroupedBackground))
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("新建对话")
                }

                Menu {
                    Button("浏览项目文件", systemImage: "folder") { panel = .files }
                    Button("查看代码变更 (Diff)", systemImage: "plus.forwardslash.minus") { panel = .changes }
                    if let onReturnToLanding {
                        Divider()
                        Button("回到新对话工作台", systemImage: "sparkles") {
                            onReturnToLanding()
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 15.5, weight: .medium))
                        .foregroundStyle(.primary)
                        .frame(width: 36, height: 36)
                        .background(
                            Circle()
                                .fill(Color(.secondarySystemGroupedBackground))
                        )
                }
                .accessibilityLabel("更多操作")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(
            Color(.systemGroupedBackground)
                .overlay(alignment: .bottom) {
                    Divider().opacity(0.45)
                }
        )
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
                userDetachedFromBottom = false
                unreadMessageUpdates = 0
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
                GeometryReader { scrollGeo in
                    let containerWidth = max(0, scrollGeo.size.width)
                    let viewportHeight = max(0, scrollGeo.size.height)
                    let contentWidth = max(0, containerWidth - 28)
                    ScrollViewReader { proxy in
                        ZStack(alignment: .bottom) {
                            ScrollView(.vertical, showsIndicators: true) {
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
                                        .frame(width: contentWidth, alignment: .leading)
                                        .id(item.id)
                                    }
                                    if model.session.isTurnRunning && model.items.last?.role != .assistant {
                                        LoadingState(label: "正在思考").id("loading")
                                    }
                                    Color.clear
                                        .frame(height: 1)
                                        .id("conversation-bottom")
                                        .background(
                                            GeometryReader { bottomGeo in
                                                Color.clear.preference(
                                                    key: ConversationBottomMaxYKey.self,
                                                    value: bottomGeo.frame(in: .named("conversationScroll")).maxY
                                                )
                                            }
                                        )
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 12)
                                .frame(width: containerWidth, alignment: .leading)
                            }
                            .coordinateSpace(name: "conversationScroll")
                            .defaultScrollAnchor(.bottom)
                            .scrollDismissesKeyboard(.interactively)
                            .simultaneousGesture(
                                DragGesture(minimumDistance: 6)
                                    .onChanged { value in
                                        isUserDraggingScroll = true
                                        // Finger pulling down (positive translation.height) = scrolling upward away from bottom
                                        if value.translation.height > 10 {
                                            userDetachedFromBottom = true
                                        }
                                    }
                                    .onEnded { value in
                                        isUserDraggingScroll = false
                                        if value.translation.height < -24 && distanceFromBottom <= bottomSafeZoneThreshold {
                                            userDetachedFromBottom = false
                                            unreadMessageUpdates = 0
                                        }
                                    }
                            )
                            .onPreferenceChange(ConversationBottomMaxYKey.self) { bottomMaxY in
                                guard viewportHeight > 0, bottomMaxY > 0 else { return }
                                let delta = max(0, bottomMaxY - viewportHeight)
                                distanceFromBottom = delta
                                if delta <= 72 && !isUserDraggingScroll {
                                    if userDetachedFromBottom {
                                        userDetachedFromBottom = false
                                    }
                                    if unreadMessageUpdates != 0 {
                                        unreadMessageUpdates = 0
                                    }
                                } else if delta > bottomSafeZoneThreshold && isUserDraggingScroll {
                                    userDetachedFromBottom = true
                                }
                            }
                            .onAppear {
                                scrollToBottomImmediately(proxy: proxy)
                            }
                            .onChange(of: model.items.count) { oldCount, newCount in
                                guard newCount > oldCount else { return }
                                if !hasPerformedInitialScroll {
                                    scrollToBottomImmediately(proxy: proxy)
                                } else if isInBottomSafeZone {
                                    withAnimation(.smooth(duration: 0.2)) {
                                        proxy.scrollTo("conversation-bottom", anchor: .bottom)
                                    }
                                } else {
                                    unreadMessageUpdates += max(1, newCount - oldCount)
                                }
                            }
                            .onChange(of: model.items.last?.text.count) { _, _ in
                                guard model.isActivelyStreaming else { return }
                                if isInBottomSafeZone {
                                    proxy.scrollTo("conversation-bottom", anchor: .bottom)
                                } else if unreadMessageUpdates == 0 {
                                    unreadMessageUpdates = 1
                                }
                            }
                            .onChange(of: model.items.last?.segments.count) { oldSegs, newSegs in
                                guard model.isActivelyStreaming else { return }
                                if isInBottomSafeZone {
                                    withAnimation(.smooth(duration: 0.16)) {
                                        proxy.scrollTo("conversation-bottom", anchor: .bottom)
                                    }
                                } else if (newSegs ?? 0) > (oldSegs ?? 0) {
                                    unreadMessageUpdates += 1
                                }
                            }

                            if shouldShowScrollToBottomButton {
                                scrollToBottomButton(proxy: proxy)
                                    .padding(.bottom, 10)
                                    .transition(.move(edge: .bottom).combined(with: .opacity))
                            }
                        }
                        .animation(.spring(response: 0.26, dampingFraction: 0.86), value: shouldShowScrollToBottomButton)
                        .animation(.spring(response: 0.26, dampingFraction: 0.86), value: unreadMessageUpdates)
                    }
                }
            }
        } else if let message = model.loadError {
            LoadFailureView(message: message) { Task { await model.reload() } }
        } else {
            ProgressView().frame(maxHeight: .infinity)
        }
    }

    private var shouldShowScrollToBottomButton: Bool {
        distanceFromBottom > bottomSafeZoneThreshold || (userDetachedFromBottom && unreadMessageUpdates > 0)
    }

    private func scrollToBottomImmediately(proxy: ScrollViewProxy) {
        userDetachedFromBottom = false
        unreadMessageUpdates = 0
        proxy.scrollTo("conversation-bottom", anchor: .bottom)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            if !userDetachedFromBottom {
                proxy.scrollTo("conversation-bottom", anchor: .bottom)
                hasPerformedInitialScroll = true
            }
        }
    }

    @ViewBuilder
    private func scrollToBottomButton(proxy: ScrollViewProxy) -> some View {
        let showExtendedLabel = unreadMessageUpdates > 0 || model.session.isTurnRunning || distanceFromBottom > 360
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            userDetachedFromBottom = false
            isUserDraggingScroll = false
            unreadMessageUpdates = 0
            withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) {
                proxy.scrollTo("conversation-bottom", anchor: .bottom)
            }
        } label: {
            HStack(spacing: 6) {
                if model.session.isTurnRunning {
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 6.5, height: 6.5)
                }

                if showExtendedLabel {
                    if unreadMessageUpdates > 0 {
                        Text("\(unreadMessageUpdates) 条新动态")
                            .font(.system(size: 12, weight: .semibold))
                            .monospacedDigit()
                    } else if model.session.isTurnRunning {
                        Text("跟随最新回答")
                            .font(.system(size: 12, weight: .semibold))
                    } else {
                        Text("回到底部")
                            .font(.system(size: 12, weight: .medium))
                    }
                }

                Image(systemName: "arrow.down")
                    .font(.system(size: 12, weight: .bold))
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, showExtendedLabel ? 13 : 10)
            .frame(height: 34)
            .background(
                Capsule(style: .continuous)
                    .fill(.ultraThinMaterial)
                    .background(
                        Capsule(style: .continuous)
                            .fill(Color(.secondarySystemGroupedBackground).opacity(0.88))
                    )
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.75)
            )
            .shadow(color: .black.opacity(0.16), radius: 8, x: 0, y: 3)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("滚动到最底部")
    }
}

private struct ConversationBottomMaxYKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
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

    private var lastTextSegmentID: String? {
        item.segments.last { segment in
            if case .text = segment { return true }
            return false
        }?.id
    }

    var body: some View {
        switch item.role {
        case .user:
            let extracted = AttachmentImageStore.shared.extractUserAttachments(from: item.text)
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: 6) {
                    if !extracted.items.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(extracted.items) { imgItem in
                                MarkdownImageFrameView(
                                    src: imgItem.urlString ?? imgItem.id,
                                    alt: imgItem.title,
                                    fixedImage: imgItem.image
                                )
                            }
                        }
                    }
                    if !extracted.cleanText.isEmpty {
                        Text(extracted.cleanText)
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
                }
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

                if item.segments.isEmpty {
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
                } else {
                    ForEach(item.segments) { segment in
                        segmentView(segment, streaming: streaming)
                    }
                    if !item.changes.isEmpty {
                        ToolChipsView(
                            tools: [],
                            changes: item.changes,
                            working: false,
                            openDiff: openDiff
                        )
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func segmentView(_ segment: TimelineSegment, streaming: Bool) -> some View {
        let isLastSegment = segment.id == item.segments.last?.id
        switch segment {
        case let .thinking(_, text):
            ThinkingView(
                text: text,
                durationMs: item.durationMs,
                working: streaming && isLastSegment
            )
        case let .tools(_, tools):
            ToolChipsView(
                tools: tools,
                changes: [],
                working: streaming && isLastSegment,
                openDiff: openDiff
            )
        case let .text(id, text):
            let isLastText = id == lastTextSegmentID
            StreamingMessageText(
                text: text,
                streaming: streaming && isLastSegment,
                showCopyButton: isLastText,
                copyPayload: item.text
            )
            .padding(.top, 2)
        }
    }
}

/// SwiftUI port of VibeX desktop's `PermissionRequestCard.tsx`:
/// displays the permission category badge, resolved heading & subtitle, structured tool-call preview
/// (expandable diffs, shell command, file paths), and progressive scope actions (`拒绝` + `[ 允许 | ▾ ]`).
private struct PermissionBanner: View {
    let prompt: PermissionPrompt
    let busy: Bool
    let respond: (PermissionOption?, Bool) -> Void

    @State private var expandedDiffIDs: Set<String> = []

    var body: some View {
        let primaryAllow = prompt.resolveAllowOption(for: .once)
        let rejectOption = prompt.rejectOption

        VStack(alignment: .leading, spacing: 10) {
            // 1. Category type row (`permissionTypeFor`)
            HStack(spacing: 6) {
                Image(systemName: prompt.category.systemImage)
                    .font(.system(size: 12, weight: .semibold))
                Text(prompt.category.label)
                    .font(.system(size: 12, weight: .medium))
            }
            .foregroundStyle(.secondary)

            // 2. Heading (`detail.heading ?? t('permissionRequestCard.title')`)
            Text(prompt.displayHeading)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.primary)

            // 3. Preview block (`permission-request-preview`)
            if prompt.displaySubtitle != nil
                || !prompt.diffs.isEmpty
                || !prompt.textBlocks.isEmpty
                || prompt.command != nil
                || !prompt.locations.isEmpty
            {
                VStack(alignment: .leading, spacing: 6) {
                    if let subtitle = prompt.displaySubtitle {
                        Text(subtitle)
                            .font(.system(size: 13.5))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    ForEach(prompt.diffs) { diff in
                        diffPreviewRow(diff)
                    }

                    ForEach(Array(prompt.textBlocks.enumerated()), id: \.offset) { _, blockText in
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(blockText)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(.primary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(Color(.tertiarySystemGroupedBackground))
                        )
                    }

                    if let command = prompt.command, !command.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(command)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(.primary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(Color(.tertiarySystemGroupedBackground))
                        )
                    }

                    if !prompt.locations.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(prompt.locations, id: \.self) { path in
                                Text(path)
                                    .font(.system(size: 11.5, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                        }
                        .padding(.top, 2)
                    }
                }
            }

            // 4. Progressive Action Footer (`拒绝` + split `[ 允许 | ▾ ]`)
            HStack(spacing: 8) {
                Spacer(minLength: 0)

                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    respond(rejectOption, false)
                } label: {
                    Text("拒绝")
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 13)
                        .frame(height: 30)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color(.tertiarySystemGroupedBackground))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.7)
                        )
                }
                .buttonStyle(.plain)
                .disabled(busy)

                if let primaryAllow {
                    HStack(spacing: 0) {
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            respond(primaryAllow, false)
                        } label: {
                            HStack(spacing: 5) {
                                if busy {
                                    ProgressView().controlSize(.mini).tint(Color(.systemBackground))
                                }
                                Text("允许")
                                    .font(.system(size: 12.5, weight: .semibold))
                            }
                            .foregroundStyle(Color(.systemBackground))
                            .padding(.leading, 13)
                            .padding(.trailing, 10)
                            .frame(height: 30)
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)

                        Rectangle()
                            .fill(Color(.systemBackground).opacity(0.22))
                            .frame(width: 0.8, height: 18)

                        Menu {
                            ForEach(PermissionAllowScope.allCases, id: \.rawValue) { scope in
                                if let opt = prompt.resolveAllowOption(for: scope) {
                                    Button {
                                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                        respond(opt, scope != .once)
                                    } label: {
                                        Text(scope.label)
                                    }
                                }
                            }
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10.5, weight: .bold))
                                .foregroundStyle(Color(.systemBackground))
                                .frame(width: 28, height: 30)
                                .contentShape(Rectangle())
                        }
                        .disabled(busy)
                    }
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.primary)
                    )
                } else {
                    ForEach(prompt.options) { option in
                        Button {
                            respond(option, false)
                        } label: {
                            Text(option.label)
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(Color(.systemBackground))
                                .padding(.horizontal, 12)
                                .frame(height: 30)
                                .background(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .fill(Color.primary)
                                )
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                    }
                }
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.75)
        )
        .shadow(color: .black.opacity(0.05), radius: 8, y: 2)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private func diffPreviewRow(_ diff: PermissionDiffPreview) -> some View {
        let isOpen = expandedDiffIDs.contains(diff.id)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.spring(response: 0.25, dampingFraction: 0.86)) {
                    if isOpen {
                        expandedDiffIDs.remove(diff.id)
                    } else {
                        expandedDiffIDs.insert(diff.id)
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                    Text(diff.path)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 6)
                    Text(diff.isNewFile ? "新文件" : "已修改")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isOpen {
                VStack(alignment: .leading, spacing: 6) {
                    if !diff.isNewFile {
                        diffPane(label: "修改前", text: diff.oldText, isAddition: false)
                    }
                    diffPane(label: diff.isNewFile ? "文件内容" : "修改后", text: diff.newText, isAddition: true)
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 8)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Color(.tertiarySystemGroupedBackground))
        )
    }

    private func diffPane(label: String, text: String, isAddition: Bool) -> some View {
        let tint: Color = isAddition ? .green : .red
        return VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            ScrollView([.horizontal, .vertical], showsIndicators: false) {
                Text(text)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
            }
            .frame(maxHeight: 140, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(tint.opacity(0.10))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .strokeBorder(tint.opacity(0.28), lineWidth: 0.6)
            )
        }
    }
}
