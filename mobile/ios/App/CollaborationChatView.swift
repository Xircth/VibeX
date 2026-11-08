import CompanionCore
import SwiftUI

struct CollaborationChatView: View {
    let client: HostClient
    let workspaceID: String
    let item: CollabSidebarItem
    let allSidebarItems: [CollabSidebarItem]
    let contactGroups: [CollabContactGroup]
    let onChanged: () async -> Void

    @State private var messages: [CollabSpaceMessage] = []
    @State private var scheduled: [CollabScheduledMessage] = []
    @State private var cards: [CollabCard] = []
    @State private var members: [CollabSpaceMember] = []
    @State private var loading = true
    @State private var errorMessage: String?

    // Composer state
    @State private var draftText = ""
    @State private var selectedMentions: [String] = []
    @State private var replyingTo: CollabSpaceMessage?
    @State private var delaySeconds: Int = 0
    @State private var sending = false

    // Sheets & navigation
    @State private var showingDetails = false
    @State private var openedConversation: ConversationListItem?
    @State private var cardAnswerDraft: [String: String] = [:]
    @State private var headerReactionTrigger: Int = 0

    private static let quickEmojis = ["👍", "❤️", "🎉", "🚀", "👀", "💡"]
    private static let delayOptions: [(label: String, seconds: Int)] = [
        ("立即发送", 0),
        ("30 秒后", 30),
        ("1 分钟后", 60),
        ("5 分钟后", 300),
        ("15 分钟后", 900),
    ]

    private var spaceID: String { item.targetSpaceId }

    private var agentMembers: [CollabSpaceMember] {
        members.filter(\.isAgent)
    }

    private var isChatActive: Bool {
        sending
            || messages.contains(where: \.streaming)
            || messages.contains { $0.receipts.contains(where: \.isProcessing) }
    }

    var body: some View {
        VStack(spacing: 0) {
            if !scheduled.isEmpty {
                scheduledBanner
            }

            messageStream

            if !cards.filter(\.isPending).isEmpty {
                pendingCardsStack
            }

            composerBar
        }
        .navigationTitle(item.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button {
                    headerReactionTrigger += 1
                } label: {
                    HStack(spacing: 8) {
                        if item.isGroup {
                            let groupAvatars = (agentMembers.isEmpty ? item.membersPreview.map(\.botAvatar) : agentMembers.map(\.botAvatar))
                            CollabGroupAvatarView(
                                avatars: groupAvatars.isEmpty
                                    ? [CollabBotAvatarConfig.derive(seed: item.displayName)]
                                    : groupAvatars,
                                tagColorHex: item.tagColor,
                                size: 28,
                                sessionActive: isChatActive
                            )
                        } else {
                            let dmAvatar = item.member?.botAvatar
                                ?? CollabBotAvatarConfig.derive(seed: item.displayName)
                            MemberBotAvatarView(
                                config: dmAvatar,
                                size: 28,
                                animated: true,
                                sessionActive: isChatActive,
                                isSupervisor: item.member?.isSupervisor == true,
                                reactionTrigger: headerReactionTrigger
                            )
                        }

                        Text(item.displayName)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)

                        if item.isGroup, item.memberCount > 0 {
                            Text("(\(item.memberCount))")
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .buttonStyle(.plain)
            }
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 12) {
                    if item.isDirect, let member = item.member {
                        Button {
                            openMemberSession(memberID: member.resolvedIdentityId, fallbackConvID: member.conversationId, title: item.displayName)
                        } label: {
                            Image(systemName: "terminal")
                        }
                        .accessibilityLabel("打开助手会话")
                    }
                    Button {
                        showingDetails = true
                    } label: {
                        Image(systemName: item.isGroup ? "person.3" : "slider.horizontal.3")
                    }
                    .accessibilityLabel(item.isGroup ? "群组详情" : "助手详情")
                }
            }
        }
        .sheet(isPresented: $showingDetails) {
            CollaborationDetailSheet(
                client: client,
                workspaceID: workspaceID,
                item: item,
                members: members,
                allSidebarItems: allSidebarItems,
                contactGroups: contactGroups,
                onOpenConversation: { conv in
                    showingDetails = false
                    openedConversation = conv
                },
                onChanged: {
                    await reload()
                    await onChanged()
                }
            )
        }
        .navigationDestination(item: $openedConversation) { conv in
            ConversationDetailView(client: client, conversation: conv)
        }
        .onDisappear {
            dismissKeyboard()
        }
        .task {
            try? await client.collabMarkRead(threadID: item.threadId)
            while !Task.isCancelled {
                await reload()
                try? await Task.sleep(for: .seconds(2.5))
            }
        }
    }

    // MARK: - Message Stream

    @ViewBuilder
    private var messageStream: some View {
        if loading && messages.isEmpty && errorMessage == nil {
            Spacer()
            ProgressView()
            Spacer()
        } else if let errorMessage, messages.isEmpty {
            Spacer()
            LoadFailureView(message: errorMessage) { Task { await reload() } }
            Spacer()
        } else if messages.isEmpty {
            Spacer()
            ContentUnavailableView {
                Label(item.isGroup ? "群里还没有消息" : "还没有私聊消息", systemImage: "bubble.left.and.bubble.right")
            } description: {
                Text(item.isGroup ? "用下方输入框发送消息，可 @ 指定助手协同处理" : "在下方输入内容即可与 \(item.displayName) 对话")
            }
            Spacer()
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(messages) { message in
                            CollabMessageRow(
                                message: message,
                                allMessages: messages,
                                isGroup: item.isGroup,
                                senderAvatar: resolveSenderAvatar(for: message),
                                quickEmojis: Self.quickEmojis,
                                onTapSender: {
                                    openSenderSession(for: message)
                                },
                                onReply: {
                                    withAnimation { replyingTo = message }
                                },
                                onReact: { emoji in
                                    react(to: message, emoji: emoji)
                                },
                                onCollect: {
                                    collectMessage(message)
                                },
                                onDistill: {
                                    distillMessage(message)
                                },
                                onCancelReceiptTurn: { receipt in
                                    cancelTurn(for: receipt)
                                }
                            )
                            .id(message.id)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: messages.last?.id) { _, lastID in
                    if let lastID {
                        withAnimation(.easeOut(duration: 0.2)) {
                            proxy.scrollTo(lastID, anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Scheduled Messages Banner

    private var scheduledBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(scheduled) { item in
                HStack(spacing: 8) {
                    Image(systemName: "clock.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.content)
                            .font(.system(size: 12, weight: .medium))
                            .lineLimit(1)
                        Text("定时投递：\(item.deliverAt)")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("取消") {
                        cancelScheduled(item)
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.red)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.orange.opacity(0.1))
            }
        }
    }

    // MARK: - Pending Approval & Ask Cards

    private var pendingCardsStack: some View {
        VStack(spacing: 8) {
            ForEach(cards.filter(\.isPending)) { card in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Image(systemName: card.kind == "approval" ? "checkmark.shield.fill" : "questionmark.circle.fill")
                            .foregroundStyle(card.kind == "approval" ? .orange : .blue)
                        Text(card.kind == "approval" ? "待审批请求" : "助手提问")
                            .font(.system(size: 13, weight: .semibold))
                        Spacer()
                    }
                    if let text = card.question ?? card.reason ?? card.action ?? card.command {
                        Text(text)
                            .font(.system(size: 13))
                            .foregroundStyle(.primary)
                    }
                    if card.kind == "approval" {
                        HStack(spacing: 8) {
                            Button {
                                resolveCard(card, decision: "approved", answer: nil, declined: false)
                            } label: {
                                Text("批准")
                                    .font(.system(size: 13, weight: .medium))
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)

                            Button(role: .destructive) {
                                resolveCard(card, decision: "rejected", answer: nil, declined: true)
                            } label: {
                                Text("拒绝")
                                    .font(.system(size: 13, weight: .medium))
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                        }
                    } else {
                        if !card.options.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(card.options, id: \.self) { opt in
                                        Button(opt) {
                                            resolveCard(card, decision: nil, answer: opt, declined: false)
                                        }
                                        .font(.system(size: 12, weight: .medium))
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 5)
                                        .background(Capsule().fill(Color.blue.opacity(0.12)))
                                    }
                                }
                            }
                        }
                        HStack(spacing: 8) {
                            TextField(
                                "输入回答…",
                                text: Binding(
                                    get: { cardAnswerDraft[card.id] ?? "" },
                                    set: { cardAnswerDraft[card.id] = $0 }
                                )
                            )
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size: 13))

                            Button("发送") {
                                let ans = (cardAnswerDraft[card.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !ans.isEmpty else { return }
                                resolveCard(card, decision: nil, answer: ans, declined: false)
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)

                            Button("跳过") {
                                resolveCard(card, decision: nil, answer: nil, declined: true)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(.secondarySystemGroupedBackground))
                        .shadow(color: .black.opacity(0.06), radius: 6, y: 2)
                )
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    // MARK: - Composer Bar

    private var composerBar: some View {
        VStack(spacing: 6) {
            Divider()

            if let reply = replyingTo {
                HStack(spacing: 8) {
                    Image(systemName: "arrowshape.turn.up.left.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                    Text("回复 \(reply.envelope.displaySender)：\(reply.envelope.content)")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    Button {
                        withAnimation { replyingTo = nil }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.top, 4)
            }

            if item.isGroup && !agentMembers.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        mentionChip(name: "全体成员", label: "@全体成员", avatar: nil)
                        ForEach(agentMembers) { member in
                            mentionChip(
                                name: member.nickname,
                                label: "@\(member.nickname)",
                                avatar: member.botAvatar
                            )
                        }
                    }
                    .padding(.horizontal, 14)
                }
            }

            if let errorMessage, !messages.isEmpty {
                Text(errorMessage)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 14)
            }

            HStack(alignment: .bottom, spacing: 8) {
                if item.isGroup {
                    Menu {
                        ForEach(Self.delayOptions, id: \.seconds) { option in
                            Button {
                                delaySeconds = option.seconds
                            } label: {
                                HStack {
                                    Text(option.label)
                                    if delaySeconds == option.seconds {
                                        Image(systemName: "checkmark")
                                    }
                                }
                            }
                        }
                    } label: {
                        Image(systemName: delaySeconds > 0 ? "clock.badge.checkmark.fill" : "clock")
                            .font(.system(size: 17))
                            .foregroundStyle(delaySeconds > 0 ? Color.orange : Color.secondary)
                            .frame(width: 32, height: 34)
                    }
                    .accessibilityLabel("定时发送")
                }

                TextField(
                    item.isGroup ? "发送群消息（可点上方 @ 提及助手）…" : "给 \(item.displayName) 发消息…",
                    text: $draftText,
                    axis: .vertical
                )
                .lineLimit(1...5)
                .font(.system(size: 14))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color(.secondarySystemGroupedBackground))
                )

                Button {
                    sendMessage()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                        .foregroundStyle(canSend ? Color.blue : Color.secondary.opacity(0.4))
                }
                .disabled(!canSend)
                .accessibilityLabel("发送")
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
        .background(Color(.systemBackground))
    }

    private func mentionChip(name: String, label: String, avatar: CollabBotAvatarConfig?) -> some View {
        let isSelected = selectedMentions.contains(name)
        return Button {
            if isSelected {
                selectedMentions.removeAll { $0 == name }
            } else {
                selectedMentions.append(name)
                if !draftText.contains("@\(name)") {
                    draftText = (draftText.isEmpty ? "" : draftText + " ") + "@\(name) "
                }
            }
        } label: {
            HStack(spacing: 5) {
                if let avatar {
                    MemberBotAvatarView(config: avatar, size: 17)
                }
                Text(label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(isSelected ? .white : .primary)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(
                Capsule()
                    .fill(isSelected ? Color.blue : Color.primary.opacity(0.07))
            )
        }
        .buttonStyle(.plain)
    }

    private func resolveSenderAvatar(for message: CollabSpaceMessage) -> CollabBotAvatarConfig {
        if item.isDirect, let dmMember = item.member {
            return dmMember.botAvatar
        }
        if let matched = agentMembers.first(where: {
            $0.nickname == message.envelope.sender || $0.conversationId == message.envelope.conversationId
        }) {
            return matched.botAvatar
        }
        if let preview = item.membersPreview.first(where: {
            $0.name == message.envelope.sender || $0.conversationId == message.envelope.conversationId
        }) {
            return preview.botAvatar
        }
        return CollabBotAvatarConfig.derive(seed: message.envelope.displaySender)
    }

    private var canSend: Bool {
        !sending && !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Network Operations

    private func reload() async {
        do {
            async let pageTask = client.collabMessages(spaceID: spaceID)
            async let membersTask = item.isGroup ? client.collabSpaceMembers(spaceID: spaceID) : []
            let page = try await pageTask
            let loadedMembers = (try? await membersTask) ?? []
            messages = page.messages
            scheduled = page.scheduled
            cards = page.cards
            members = loadedMembers
            errorMessage = nil
        } catch {
            errorMessage = describeHostFailure(error)
        }
        loading = false
    }

    private func sendMessage() {
        let text = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        let recipients = selectedMentions
        let replyID = replyingTo?.id
        let delay = delaySeconds > 0 ? delaySeconds : nil

        draftText = ""
        selectedMentions = []
        replyingTo = nil
        delaySeconds = 0

        Task {
            do {
                try await client.collabPostMessage(
                    spaceID: spaceID,
                    content: text,
                    to: recipients,
                    inReplyTo: replyID,
                    delaySeconds: delay
                )
                errorMessage = nil
                await reload()
                await onChanged()
            } catch {
                errorMessage = describeHostFailure(error)
            }
            sending = false
        }
    }

    private func react(to message: CollabSpaceMessage, emoji: String) {
        Task {
            try? await client.collabReact(spaceID: spaceID, messageID: message.id, emoji: emoji)
            await reload()
        }
    }

    private func collectMessage(_ message: CollabSpaceMessage) {
        Task {
            try? await client.collaborationCommand("space.addCollectionItem", input: [
                "spaceId": spaceID,
                "kind": "text",
                "name": "\(message.envelope.displaySender) 的消息",
                "content": message.envelope.content,
                "creatorNickname": "User",
            ])
        }
    }

    private func distillMessage(_ message: CollabSpaceMessage) {
        Task {
            try? await client.collaborationCommand("space.memory.distillMessage", input: [
                "spaceId": spaceID,
                "messageId": message.id,
                "content": message.envelope.content,
            ])
        }
    }

    private func cancelTurn(for receipt: CollabDeliveryReceipt) {
        guard let matched = agentMembers.first(where: {
            $0.conversationId == receipt.conversationId || $0.nickname == receipt.nickname
        }) else { return }
        Task {
            try? await client.collabCancelSpaceTurn(spaceID: spaceID, memberID: matched.memberId)
            await reload()
        }
    }

    private func cancelScheduled(_ scheduledItem: CollabScheduledMessage) {
        Task {
            try? await client.collaborationCommand("space.cancelScheduledMessage", input: [
                "spaceId": spaceID,
                "id": scheduledItem.id,
            ])
            await reload()
        }
    }

    private func resolveCard(_ card: CollabCard, decision: String?, answer: String?, declined: Bool) {
        Task {
            try? await client.collabResolveCard(
                cardID: card.id,
                decision: decision,
                answer: answer,
                declined: declined
            )
            cardAnswerDraft[card.id] = nil
            await reload()
        }
    }

    private func openSenderSession(for message: CollabSpaceMessage) {
        guard !message.isFromUser, !message.envelope.isSystem else { return }
        if let convID = message.envelope.conversationId, !convID.isEmpty {
            openConversation(id: convID, title: message.envelope.displaySender)
            return
        }
        if let matched = agentMembers.first(where: { $0.nickname == message.envelope.sender }) {
            openMemberSession(
                memberID: matched.resolvedIdentityId,
                fallbackConvID: matched.conversationId,
                title: matched.nickname
            )
        }
    }

    private func openMemberSession(memberID: String, fallbackConvID: String?, title: String) {
        Task {
            let resolved = (try? await client.collabResolveSession(memberID: memberID, threadID: item.threadId)) ?? fallbackConvID
            guard let convID = resolved, !convID.isEmpty else { return }
            openConversation(id: convID, title: title)
        }
    }

    private func openConversation(id: String, title: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [
            "id": id,
            "workspace_id": workspaceID,
            "title": title,
            "message_count": 0,
            "updated_at": ISO8601DateFormatter().string(from: Date()),
        ]),
        let item = try? JSONDecoder().decode(ConversationListItem.self, from: data)
        else { return }
        openedConversation = item
    }
}

// MARK: - Single Message Row

private struct CollabMessageRow: View {
    let message: CollabSpaceMessage
    let allMessages: [CollabSpaceMessage]
    let isGroup: Bool
    let senderAvatar: CollabBotAvatarConfig
    let quickEmojis: [String]
    let onTapSender: () -> Void
    let onReply: () -> Void
    let onReact: (String) -> Void
    let onCollect: () -> Void
    let onDistill: () -> Void
    let onCancelReceiptTurn: (CollabDeliveryReceipt) -> Void

    private var repliedMessage: CollabSpaceMessage? {
        guard let replyID = message.inReplyTo, !replyID.isEmpty else { return nil }
        let clean = replyID.replacingOccurrences(of: "vibex://space-message/", with: "")
        return allMessages.first { $0.id == clean }
    }

    private var senderColor: Color {
        Color(collabHex: senderAvatar.color) ?? CollabTagPalette.hashColor(message.envelope.displaySender)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if message.isFromUser {
                Spacer(minLength: 36)
            } else {
                Button(action: onTapSender) {
                    MemberBotAvatarView(
                        config: senderAvatar,
                        size: 32,
                        animated: true,
                        sessionActive: message.streaming
                    )
                }
                .buttonStyle(.plain)
            }

            VStack(alignment: message.isFromUser ? .trailing : .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Button(action: onTapSender) {
                        Text(message.envelope.displaySender)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(message.isFromUser ? .secondary : senderColor)
                    }
                    .buttonStyle(.plain)

                    ForEach(message.envelope.recipientLabels, id: \.self) { target in
                        Text("@\(target)")
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(.blue)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.blue.opacity(0.12)))
                    }

                    if message.streaming {
                        ProgressView()
                            .controlSize(.mini)
                    }
                }

                if let replied = repliedMessage {
                    HStack(spacing: 5) {
                        Rectangle()
                            .fill(Color.secondary.opacity(0.4))
                            .frame(width: 2, height: 14)
                        Text("\(replied.envelope.displaySender)：\(replied.envelope.content)")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.primary.opacity(0.05))
                    )
                }

                Text(message.envelope.content)
                    .font(.system(size: 14))
                    .foregroundStyle(message.isFromUser ? .white : .primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(message.isFromUser ? Color.blue : Color(.secondarySystemGroupedBackground))
                    )
                    .textSelection(.enabled)
                    .contextMenu {
                        ForEach(quickEmojis, id: \.self) { emoji in
                            Button("\(emoji) 表情回应") { onReact(emoji) }
                        }
                        Divider()
                        Button {
                            onReply()
                        } label: {
                            Label("回复", systemImage: "arrowshape.turn.up.left")
                        }
                        Button {
                            UIPasteboard.general.string = message.envelope.content
                        } label: {
                            Label("复制内容", systemImage: "doc.on.doc")
                        }
                        Button {
                            onCollect()
                        } label: {
                            Label("加入空间收藏", systemImage: "bookmark")
                        }
                        Button {
                            onDistill()
                        } label: {
                            Label("提炼到空间记忆", systemImage: "brain")
                        }
                        if !message.isFromUser && !message.envelope.isSystem {
                            Divider()
                            Button {
                                onTapSender()
                            } label: {
                                Label("打开该助手会话", systemImage: "terminal")
                            }
                        }
                    }

                // Reactions bar
                let reactions = message.groupedReactions
                if !reactions.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(reactions, id: \.emoji) { r in
                            Button {
                                onReact(r.emoji)
                            } label: {
                                HStack(spacing: 3) {
                                    Text(r.emoji)
                                        .font(.system(size: 12))
                                    Text("\(r.count)")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(r.byUser ? .blue : .secondary)
                                }
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(
                                    Capsule()
                                        .fill(r.byUser ? Color.blue.opacity(0.15) : Color.primary.opacity(0.06))
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                // Delivery Receipts (for user messages in group/direct chats)
                if message.isFromUser && !message.receipts.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(message.receipts) { receipt in
                            HStack(spacing: 4) {
                                Circle()
                                    .fill(receiptColor(receipt.effectiveState))
                                    .frame(width: 6, height: 6)
                                if let nick = receipt.nickname, !nick.isEmpty {
                                    Text(nick)
                                        .font(.system(size: 10, weight: .medium))
                                }
                                Text(receipt.stateLabel)
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                                if isGroup && receipt.isProcessing {
                                    Button {
                                        onCancelReceiptTurn(receipt)
                                    } label: {
                                        Image(systemName: "stop.circle.fill")
                                            .font(.system(size: 11))
                                            .foregroundStyle(.red)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(
                                Capsule()
                                    .fill(Color.primary.opacity(0.05))
                            )
                        }
                    }
                }
            }

            if !message.isFromUser {
                Spacer(minLength: 36)
            }
        }
    }

    private func receiptColor(_ state: String) -> Color {
        switch state {
        case "replied": return .green
        case "processing": return .blue
        case "queued", "dispatched": return .orange
        case "failed", "timed_out": return .red
        default: return .secondary
        }
    }
}
