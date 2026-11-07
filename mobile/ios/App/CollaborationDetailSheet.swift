import CompanionCore
import SwiftUI

struct CollaborationDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: HostClient
    let workspaceID: String
    let item: CollabSidebarItem
    let members: [CollabSpaceMember]
    let allSidebarItems: [CollabSidebarItem]
    let contactGroups: [CollabContactGroup]
    let onOpenConversation: (ConversationListItem) -> Void
    let onChanged: () async -> Void

    enum Tab: String {
        case primary
        case memoryAndCollection
        case settings
    }

    @State private var selectedTab: Tab = .primary
    @State private var liveMembers: [CollabSpaceMember] = []
    @State private var leadMemberID: String = ""
    @State private var showingCreateForGroup = false

    // Memory & Collection state
    @State private var assetKind: AssetKind = .facts
    @State private var facts: [CollabMemoryFact] = []
    @State private var topics: [CollabMemoryTopic] = []
    @State private var collectionItems: [CollabCollectionItem] = []
    @State private var newFactContent = ""
    @State private var newFactScope = "thread"
    @State private var newTopicSlug = ""
    @State private var newTopicTitle = ""
    @State private var newTopicContent = ""
    @State private var newCollectionName = ""
    @State private var newCollectionText = ""
    @State private var newCollectionNote = ""

    // Settings / Customize state
    @State private var nameDraft = ""
    @State private var personaDraft = ""
    @State private var agentID = ""
    @State private var modeID = ""
    @State private var writeAccess = "write_isolated"
    @State private var isSupervisor = false
    @State private var selectedColor = ""
    @State private var avatarDraft: CollabBotAvatarConfig = .defaultMaster
    @State private var errorMessage: String?

    enum AssetKind: String, CaseIterable, Identifiable {
        case facts = "记忆"
        case topics = "主题"
        case collection = "收藏"
        var id: String { rawValue }
    }

    private var spaceID: String { item.targetSpaceId }
    private var memberIdentityID: String? { item.member?.resolvedIdentityId }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("详情", selection: $selectedTab) {
                    Text(item.isGroup ? "成员" : "定制").tag(Tab.primary)
                    Text("记忆与收藏").tag(Tab.memoryAndCollection)
                    Text(item.isGroup ? "设置" : "会话").tag(Tab.settings)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

                switch selectedTab {
                case .primary:
                    if item.isGroup {
                        groupMembersView
                    } else {
                        assistantCustomizeView
                    }
                case .memoryAndCollection:
                    memoryAndCollectionView
                case .settings:
                    if item.isGroup {
                        groupSettingsView
                    } else {
                        assistantSessionView
                    }
                }
            }
            .navigationTitle(item.isGroup ? "群组详情" : "助手详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .sheet(isPresented: $showingCreateForGroup) {
            CreateAssistantSheet(
                client: client,
                workspaceID: workspaceID,
                targetSpaceID: spaceID,
                onCreated: {
                    await loadDetails()
                    await onChanged()
                }
            )
        }
        .task {
            nameDraft = item.displayName
            isSupervisor = item.member?.isSupervisor ?? false
            selectedColor = (item.isGroup ? item.tagColor : item.member?.color) ?? ""
            avatarDraft = item.member?.botAvatar ?? CollabBotAvatarConfig.derive(seed: item.displayName)
            newFactScope = item.isGroup ? "thread" : "private"
            liveMembers = members.filter(\.isAgent)
            await loadDetails()
        }
    }

    // MARK: - Group Members Tab

    private var candidateAssistants: [CollabSidebarItem] {
        let existingConvIDs = Set(liveMembers.compactMap(\.conversationId))
        let existingNames = Set(liveMembers.map { $0.nickname.lowercased() })
        return allSidebarItems.filter { candidate in
            guard candidate.isDirect, let m = candidate.member, let convID = m.conversationId, !convID.isEmpty else {
                return false
            }
            return !existingConvIDs.contains(convID) && !existingNames.contains(m.name.lowercased())
        }
    }

    private var groupMembersView: some View {
        List {
            Section {
                Button {
                    showingCreateForGroup = true
                } label: {
                    Label("新建助手并拉入本群", systemImage: "person.badge.plus")
                }

                if !candidateAssistants.isEmpty {
                    Menu {
                        ForEach(candidateAssistants) { candidate in
                            Button(candidate.displayName) {
                                addExistingAssistant(candidate)
                            }
                        }
                    } label: {
                        Label("添加已有工作区助手入群", systemImage: "plus.circle")
                    }
                }
            }

            Section("群内助手 (\(liveMembers.count))") {
                if liveMembers.isEmpty {
                    Text("本群还没有助手成员")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(liveMembers) { member in
                        let isLead = !leadMemberID.isEmpty
                            && (member.memberId == leadMemberID || member.identityMemberId == leadMemberID)
                        HStack(spacing: 10) {
                            MemberBotAvatarView(
                                config: member.botAvatar,
                                size: 34,
                                isLead: isLead,
                                isSupervisor: member.isSupervisor
                            )

                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(member.nickname)
                                        .font(.system(size: 14, weight: .medium))
                                    if isLead {
                                        Text("群负责人")
                                            .font(.system(size: 10, weight: .semibold))
                                            .foregroundStyle(.blue)
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 1.5)
                                            .background(Capsule().fill(Color.blue.opacity(0.14)))
                                    }
                                }
                            }
                            Spacer()
                            Menu {
                                Button {
                                    openMemberConversation(member)
                                } label: {
                                    Label("查看本群会话", systemImage: "terminal")
                                }
                                Button {
                                    setGroupLead(member)
                                } label: {
                                    Label("设为群负责人", systemImage: "star")
                                }
                                Divider()
                                Button(role: .destructive) {
                                    removeMemberFromGroup(member)
                                } label: {
                                    Label("移出本群", systemImage: "person.badge.minus")
                                }
                            } label: {
                                Image(systemName: "ellipsis.circle")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Assistant Customize Tab

    private var assistantCustomizeView: some View {
        Form {
            Section("基本信息") {
                TextField("助手名称", text: $nameDraft)
                MemberBotAvatarPicker(value: $avatarDraft)
                    .padding(.vertical, 4)
                Toggle("设为主管（置顶）", isOn: $isSupervisor)
            }

            Section("会话与人设配置") {
                if !agentID.isEmpty {
                    LabeledContent("Agent", value: agentID)
                }
                Picker("工作区写入策略", selection: $writeAccess) {
                    Text("独立工作区隔离 (write_isolated)").tag("write_isolated")
                    Text("串行写入主工作区 (write_serialized)").tag("write_serialized")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("人设提示词 (Persona Prompt)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $personaDraft)
                        .frame(minHeight: 90)
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(.red).font(.footnote)
                }
            }

            Section {
                Button("保存配置") {
                    saveAssistantCustomization()
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: - Memory, Topics & Collection Tab

    private var memoryAndCollectionView: some View {
        List {
            Section {
                Picker("资产类别", selection: $assetKind) {
                    ForEach(AssetKind.allCases) { kind in
                        Text(kind.rawValue).tag(kind)
                    }
                }
                .pickerStyle(.segmented)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 4, trailing: 0))

            switch assetKind {
            case .facts:
                Section("新增记忆") {
                    TextField("输入长期事实或偏好…", text: $newFactContent, axis: .vertical)
                        .lineLimit(1...3)
                    Picker("作用域", selection: $newFactScope) {
                        if item.isGroup {
                            Text("本群").tag("thread")
                        } else {
                            Text("私聊").tag("private")
                        }
                        Text("全局").tag("global")
                    }
                    Button("添加记忆") { addFact() }
                        .disabled(newFactContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                Section("已存记忆 (\(facts.count))") {
                    if facts.isEmpty {
                        Text("暂无记忆条目").foregroundStyle(.secondary)
                    } else {
                        ForEach(facts) { fact in
                            HStack(alignment: .top, spacing: 8) {
                                Text(fact.scopeLabel)
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(.blue)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(Color.blue.opacity(0.12)))
                                Text(fact.content)
                                    .font(.system(size: 13))
                                Spacer()
                            }
                            .swipeActions {
                                Button(role: .destructive) {
                                    deleteFact(fact)
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                        }
                    }
                }

            case .topics:
                Section("新增/更新知识主题") {
                    TextField("主题标识 (如 arch-notes)", text: $newTopicSlug)
                        .textInputAutocapitalization(.never)
                    TextField("标题", text: $newTopicTitle)
                    TextField("正文内容…", text: $newTopicContent, axis: .vertical)
                        .lineLimit(2...5)
                    Button("保存主题") { writeTopic() }
                        .disabled(
                            newTopicSlug.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || newTopicContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        )
                }

                Section("主题列表 (\(topics.count))") {
                    if topics.isEmpty {
                        Text("暂无主题文档").foregroundStyle(.secondary)
                    } else {
                        ForEach(topics) { topic in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(topic.title)
                                    .font(.system(size: 14, weight: .medium))
                                Text(topic.topic)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                if let preview = topic.preview ?? topic.content, !preview.isEmpty {
                                    Text(preview)
                                        .font(.system(size: 12))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(3)
                                }
                            }
                            .swipeActions {
                                Button(role: .destructive) {
                                    deleteTopic(topic)
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                        }
                    }
                }

            case .collection:
                Section("新增文本收藏") {
                    TextField("标题（可选）", text: $newCollectionName)
                    TextField("收藏内容…", text: $newCollectionText, axis: .vertical)
                        .lineLimit(2...5)
                    TextField("备注（可选）", text: $newCollectionNote)
                    Button("加入收藏") { addCollectionItem() }
                        .disabled(newCollectionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                Section("空间收藏 (\(collectionItems.count))") {
                    if collectionItems.isEmpty {
                        Text("暂无收藏条目").foregroundStyle(.secondary)
                    } else {
                        ForEach(collectionItems) { entry in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(entry.name)
                                        .font(.system(size: 14, weight: .medium))
                                    Spacer()
                                    Text(entry.creatorNickname)
                                        .font(.system(size: 11))
                                        .foregroundStyle(.secondary)
                                }
                                if let text = entry.textContent, !text.isEmpty {
                                    Text(text)
                                        .font(.system(size: 12))
                                        .foregroundStyle(.primary)
                                        .lineLimit(4)
                                }
                                if !entry.note.isEmpty {
                                    Text("备注：\(entry.note)")
                                        .font(.system(size: 11))
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .swipeActions {
                                Button(role: .destructive) {
                                    deleteCollectionItem(entry)
                                } label: {
                                    Label("删除", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Group Settings & Assistant Session Tabs

    private var groupSettingsView: some View {
        Form {
            Section("群组名称与标签") {
                TextField("群组名称", text: $nameDraft)
                Picker("群标签颜色", selection: $selectedColor) {
                    Text("无").tag("")
                    ForEach(CollabTagPalette.presets, id: \.id) { preset in
                        Text(preset.label).tag(preset.id)
                    }
                }
                Button("保存修改") {
                    saveGroupSettings()
                }
            }

            Section {
                Button("删除此群组", role: .destructive) {
                    deleteGroup()
                }
            }
        }
    }

    private var assistantSessionView: some View {
        Form {
            Section("底层 Agent 会话") {
                Text("每个助手在当前聊天中对应一条持久化的底层 Agent 会话，包含完整的工具调用轨迹、文件变更差异与权限控制。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                Button {
                    openDirectAssistantSession()
                } label: {
                    Label("打开底层对话详情", systemImage: "terminal")
                }
            }
        }
    }

    // MARK: - Data & Mutation Helpers

    private func loadDetails() async {
        if item.isGroup {
            if let loaded = try? await client.collabSpaceMembers(spaceID: spaceID) {
                liveMembers = loaded.filter(\.isAgent)
            }
            if let spaces = try? await client.collabSpaces(workspaceID: workspaceID),
               let match = spaces.first(where: { $0.spaceId == spaceID })
            {
                leadMemberID = match.leadMemberId ?? ""
            }
        } else if let mid = memberIdentityID {
            struct ConfigResponse: Decodable { let config: CollabMemberConfig? }
            if let resp = try? await client.collaborationCall(
                "member.config.get",
                input: ["memberId": mid],
                as: ConfigResponse.self
            ),
            let cfg = resp.config {
                agentID = cfg.agentId ?? item.member?.agent ?? ""
                modeID = cfg.modeId ?? ""
                personaDraft = cfg.personaPrompt ?? ""
            }
        }

        if let mem = try? await client.collabMemoryView(spaceID: spaceID, memberID: memberIdentityID) {
            facts = mem.facts
            topics = mem.topics
        }
        if let col = try? await client.collabCollectionItems(spaceID: spaceID) {
            collectionItems = col
        }
    }

    private func addExistingAssistant(_ candidate: CollabSidebarItem) {
        guard let m = candidate.member, let convID = m.conversationId else { return }
        Task {
            try? await client.collabAddMemberToSpace(
                spaceID: spaceID,
                conversationID: convID,
                nickname: candidate.displayName
            )
            await loadDetails()
            await onChanged()
        }
    }

    private func setGroupLead(_ member: CollabSpaceMember) {
        Task {
            try? await client.collaborationCommand("space.rename", input: [
                "spaceId": spaceID,
                "leadMemberId": member.memberId,
            ])
            leadMemberID = member.memberId
            await loadDetails()
            await onChanged()
        }
    }

    private func removeMemberFromGroup(_ member: CollabSpaceMember) {
        guard let convID = member.conversationId else { return }
        Task {
            try? await client.collaborationCommand("space.batchDelete", input: [
                "workspaceId": workspaceID,
                "operationId": UUID().uuidString.lowercased(),
                "spaceIds": [],
                "memberTargets": [[
                    "spaceId": spaceID,
                    "conversationId": convID,
                ]],
            ])
            await loadDetails()
            await onChanged()
        }
    }

    private func openMemberConversation(_ member: CollabSpaceMember) {
        Task {
            let resolved = (try? await client.collabResolveSession(
                memberID: member.resolvedIdentityId,
                threadID: spaceID
            )) ?? member.conversationId
            guard let convID = resolved, !convID.isEmpty else { return }
            emitConversation(id: convID, title: member.nickname)
        }
    }

    private func openDirectAssistantSession() {
        guard let mid = memberIdentityID else { return }
        Task {
            let resolved = (try? await client.collabResolveSession(
                memberID: mid,
                threadID: item.threadId
            )) ?? item.member?.conversationId
            guard let convID = resolved, !convID.isEmpty else { return }
            emitConversation(id: convID, title: item.displayName)
        }
    }

    private func emitConversation(id: String, title: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: [
            "id": id,
            "workspace_id": workspaceID,
            "title": title,
            "message_count": 0,
            "updated_at": ISO8601DateFormatter().string(from: Date()),
        ]),
        let conv = try? JSONDecoder().decode(ConversationListItem.self, from: data)
        else { return }
        onOpenConversation(conv)
    }

    private func saveAssistantCustomization() {
        guard let mid = memberIdentityID else { return }
        let trimmed = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task {
            do {
                try await client.collaborationCommand("member.update", input: [
                    "memberId": mid,
                    "name": trimmed,
                    "avatar": avatarDraft.jsonString,
                    "color": avatarDraft.color,
                ])
                try await client.collaborationCommand("member.config.update", input: [
                    "memberId": mid,
                    "modeId": modeID,
                    "personaPrompt": personaDraft,
                ])
                try await client.collaborationCommand("member.setWriteAccess", input: [
                    "memberId": mid,
                    "writeAccess": writeAccess,
                ])
                let supValue: Any = isSupervisor ? mid : NSNull()
                try await client.collaborationCommand("member.setSupervisor", input: [
                    "workspaceId": workspaceID,
                    "memberId": supValue,
                ])
                errorMessage = nil
                await onChanged()
                dismiss()
            } catch {
                errorMessage = describeHostFailure(error)
            }
        }
    }

    private func saveGroupSettings() {
        let trimmed = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Task {
            try? await client.collaborationCommand("space.rename", input: [
                "spaceId": spaceID,
                "name": trimmed,
            ])
            try? await client.collaborationCommand("thread.update", input: [
                "spaceId": spaceID,
                "tagColor": selectedColor,
            ])
            await onChanged()
            dismiss()
        }
    }

    private func deleteGroup() {
        Task {
            try? await client.collaborationCommand("space.batchDelete", input: [
                "workspaceId": workspaceID,
                "operationId": UUID().uuidString.lowercased(),
                "spaceIds": [spaceID],
                "memberTargets": [],
            ])
            await onChanged()
            dismiss()
        }
    }

    private func addFact() {
        let trimmed = newFactContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        newFactContent = ""
        Task {
            var input: [String: Any] = [
                "spaceId": spaceID,
                "content": trimmed,
                "scope": newFactScope,
            ]
            if let mid = memberIdentityID { input["memberId"] = mid }
            try? await client.collaborationCommand("space.memory.add", input: input)
            await loadDetails()
        }
    }

    private func deleteFact(_ fact: CollabMemoryFact) {
        Task {
            var input: [String: Any] = [
                "spaceId": spaceID,
                "factId": fact.id,
            ]
            if let mid = memberIdentityID { input["memberId"] = mid }
            try? await client.collaborationCommand("space.memory.delete", input: input)
            await loadDetails()
        }
    }

    private func writeTopic() {
        let slug = newTopicSlug.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = newTopicContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !slug.isEmpty, !body.isEmpty else { return }
        let title = newTopicTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        newTopicSlug = ""
        newTopicTitle = ""
        newTopicContent = ""
        Task {
            var input: [String: Any] = [
                "spaceId": spaceID,
                "topic": slug,
                "content": body,
            ]
            if !title.isEmpty { input["title"] = title }
            if let mid = memberIdentityID { input["memberId"] = mid }
            try? await client.collaborationCommand("space.memory.writeTopic", input: input)
            await loadDetails()
        }
    }

    private func deleteTopic(_ topic: CollabMemoryTopic) {
        Task {
            var input: [String: Any] = [
                "spaceId": spaceID,
                "topic": topic.topic,
            ]
            if let mid = memberIdentityID { input["memberId"] = mid }
            try? await client.collaborationCommand("space.memory.deleteTopic", input: input)
            await loadDetails()
        }
    }

    private func addCollectionItem() {
        let body = newCollectionText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        let name = newCollectionName.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = newCollectionNote.trimmingCharacters(in: .whitespacesAndNewlines)
        newCollectionName = ""
        newCollectionText = ""
        newCollectionNote = ""
        Task {
            var input: [String: Any] = [
                "spaceId": spaceID,
                "kind": "text",
                "content": body,
                "creatorNickname": "User",
            ]
            if !name.isEmpty { input["name"] = name }
            if !note.isEmpty { input["note"] = note }
            try? await client.collaborationCommand("space.addCollectionItem", input: input)
            await loadDetails()
        }
    }

    private func deleteCollectionItem(_ entry: CollabCollectionItem) {
        Task {
            try? await client.collaborationCommand("space.removeCollectionItem", input: [
                "spaceId": spaceID,
                "itemId": entry.id,
            ])
            await loadDetails()
        }
    }
}

// MARK: - Create Assistant Sheet

struct CreateAssistantSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: HostClient
    let workspaceID: String
    let targetSpaceID: String?
    let onCreated: () async -> Void

    @State private var name = ""
    @State private var roles: [CollabRole] = []
    @State private var agents: [CatalogAgent] = []
    @State private var selectedRoleID = ""
    @State private var selectedAgentID = ""
    @State private var personaPrompt = ""
    @State private var avatar: CollabBotAvatarConfig = .random()
    @State private var isSupervisor = false
    @State private var submitting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("助手信息") {
                    TextField("助手昵称（如 前端专家、架构师）", text: $name)
                    MemberBotAvatarPicker(value: $avatar)
                        .padding(.vertical, 4)
                    if targetSpaceID == nil {
                        Toggle("设为主管（置顶）", isOn: $isSupervisor)
                    }
                }

                if !roles.isEmpty {
                    Section("角色模板（可选）") {
                        Picker("基于角色创建", selection: $selectedRoleID) {
                            Text("不使用模板").tag("")
                            ForEach(roles) { role in
                                Text(role.name).tag(role.id)
                            }
                        }
                        .onChange(of: selectedRoleID) { _, rid in
                            if let matched = roles.first(where: { $0.id == rid }) {
                                if name.isEmpty { name = matched.name }
                                selectedAgentID = matched.agentId
                                personaPrompt = matched.personaPrompt
                            }
                        }
                    }
                }

                Section("Agent 与人设") {
                    if !agents.isEmpty {
                        Picker("Agent", selection: $selectedAgentID) {
                            ForEach(agents.filter(\.usable)) { agent in
                                Text(agent.displayName).tag(agent.id)
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("人设提示词（可选）")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextEditor(text: $personaPrompt)
                            .frame(minHeight: 80)
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red).font(.footnote)
                    }
                }
            }
            .navigationTitle(targetSpaceID == nil ? "新建助手" : "新建并拉入本群")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") { create() }
                        .disabled(submitting || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .task {
                roles = (try? await client.collabRoles()) ?? []
                let catalog = (try? await client.agentCatalog()) ?? []
                agents = catalog
                if selectedAgentID.isEmpty {
                    selectedAgentID = catalog.first(where: \.usable)?.id ?? ""
                }
            }
        }
    }

    private func create() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !submitting else { return }
        submitting = true
        Task {
            do {
                let created = try await client.collabCreateMember(
                    workspaceID: workspaceID,
                    name: trimmed,
                    agentID: selectedAgentID.isEmpty ? nil : selectedAgentID,
                    roleID: selectedRoleID.isEmpty ? nil : selectedRoleID,
                    personaPrompt: personaPrompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    avatar: avatar,
                    color: avatar.color,
                    isSupervisor: isSupervisor
                )
                if let targetSpaceID,
                   case .object(let dict) = created,
                   case .string(let convID)? = dict["conversation_id"],
                   !convID.isEmpty
                {
                    try await client.collabAddMemberToSpace(
                        spaceID: targetSpaceID,
                        conversationID: convID,
                        nickname: trimmed
                    )
                }
                await onCreated()
                dismiss()
            } catch {
                errorMessage = describeHostFailure(error)
                submitting = false
            }
        }
    }
}

// MARK: - Roles & Teams Management Sheet

struct RolesAndTeamsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let client: HostClient

    enum SectionKind: String, CaseIterable, Identifiable {
        case roles = "角色模板"
        case teams = "团队"
        var id: String { rawValue }
    }

    @State private var section: SectionKind = .roles
    @State private var roles: [CollabRole] = []
    @State private var teams: [CollabTeam] = []
    @State private var agents: [CatalogAgent] = []

    // New Role
    @State private var roleName = ""
    @State private var roleSummary = ""
    @State private var roleAgentID = ""
    @State private var roleTeamID = ""
    @State private var rolePersona = ""

    // New Team
    @State private var teamName = ""
    @State private var teamSummary = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("类别", selection: $section) {
                        ForEach(SectionKind.allCases) { item in
                            Text(item.rawValue).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())

                switch section {
                case .roles:
                    Section("新建角色模板") {
                        TextField("角色名称", text: $roleName)
                        TextField("一句话简介", text: $roleSummary)
                        if !agents.isEmpty {
                            Picker("默认 Agent", selection: $roleAgentID) {
                                ForEach(agents.filter(\.usable)) { agent in
                                    Text(agent.displayName).tag(agent.id)
                                }
                            }
                        }
                        if !teams.isEmpty {
                            Picker("所属团队", selection: $roleTeamID) {
                                Text("无团队").tag("")
                                ForEach(teams) { team in
                                    Text(team.name).tag(team.id)
                                }
                            }
                        }
                        TextField("人设提示词…", text: $rolePersona, axis: .vertical)
                            .lineLimit(2...4)
                        Button("创建角色") { createRole() }
                            .disabled(roleName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    Section("已有角色 (\(roles.count))") {
                        if roles.isEmpty {
                            Text("暂无角色模板").foregroundStyle(.secondary)
                        } else {
                            ForEach(roles) { role in
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(role.name).font(.system(size: 14, weight: .medium))
                                        Spacer()
                                        Text(role.agentId)
                                            .font(.system(size: 11, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                    }
                                    if !role.summary.isEmpty {
                                        Text(role.summary).font(.system(size: 12)).foregroundStyle(.secondary)
                                    }
                                }
                                .swipeActions {
                                    Button(role: .destructive) {
                                        deleteRole(role)
                                    } label: {
                                        Label("删除", systemImage: "trash")
                                    }
                                }
                            }
                        }
                    }

                case .teams:
                    Section("新建团队") {
                        TextField("团队名称", text: $teamName)
                        TextField("团队简介（可选）", text: $teamSummary)
                        Button("创建团队") { createTeam() }
                            .disabled(teamName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }

                    Section("已有团队 (\(teams.count))") {
                        if teams.isEmpty {
                            Text("暂无团队").foregroundStyle(.secondary)
                        } else {
                            ForEach(teams) { team in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(team.name).font(.system(size: 14, weight: .medium))
                                    if let sum = team.summary, !sum.isEmpty {
                                        Text(sum).font(.system(size: 12)).foregroundStyle(.secondary)
                                    }
                                }
                                .swipeActions {
                                    Button(role: .destructive) {
                                        deleteTeam(team)
                                    } label: {
                                        Label("删除", systemImage: "trash")
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("角色与团队")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .task { await reload() }
        }
    }

    private func reload() async {
        roles = (try? await client.collabRoles()) ?? []
        teams = (try? await client.collabTeams()) ?? []
        let catalog = (try? await client.agentCatalog()) ?? []
        agents = catalog
        if roleAgentID.isEmpty {
            roleAgentID = catalog.first(where: \.usable)?.id ?? "codex"
        }
    }

    private func createRole() {
        let name = roleName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            var input: [String: Any] = [
                "name": name,
                "summary": roleSummary.trimmingCharacters(in: .whitespacesAndNewlines),
                "personaPrompt": rolePersona.trimmingCharacters(in: .whitespacesAndNewlines),
                "agentId": roleAgentID.isEmpty ? "codex" : roleAgentID,
            ]
            if !roleTeamID.isEmpty { input["teamId"] = roleTeamID }
            try? await client.collaborationCommand("role.create", input: input)
            roleName = ""
            roleSummary = ""
            rolePersona = ""
            await reload()
        }
    }

    private func deleteRole(_ role: CollabRole) {
        Task {
            try? await client.collaborationCommand("role.delete", input: ["roleId": role.id])
            await reload()
        }
    }

    private func createTeam() {
        let name = teamName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            try? await client.collaborationCommand("team.create", input: [
                "name": name,
                "summary": teamSummary.trimmingCharacters(in: .whitespacesAndNewlines),
            ])
            teamName = ""
            teamSummary = ""
            await reload()
        }
    }

    private func deleteTeam(_ team: CollabTeam) {
        Task {
            try? await client.collaborationCommand("team.delete", input: ["teamId": team.id])
            await reload()
        }
    }
}
