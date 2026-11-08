import Foundation

// MARK: - Bot Avatar & Shape System (Desktop Parity)

public enum BotAvatarShape: String, CaseIterable, Codable, Equatable, Sendable, Identifiable {
    case circle
    case cloud
    case squircle
    case sparkle
    case clover
    case heart
    case pebble
    case droplet
    case capsule
    case triangle
    case pentagon
    case star
    case hexagon

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .circle: return "圆形"
        case .cloud: return "云朵"
        case .squircle: return "超椭圆"
        case .sparkle: return "星芒"
        case .clover: return "四叶草"
        case .heart: return "爱心"
        case .pebble: return "鹅卵石"
        case .droplet: return "水滴"
        case .capsule: return "胶囊"
        case .triangle: return "三角形"
        case .pentagon: return "五边形"
        case .star: return "星章"
        case .hexagon: return "六边形"
        }
    }
}

public enum BotAvatarExpression: String, CaseIterable, Codable, Equatable, Sendable {
    case neutral
    case attentive
    case happy
    case laughing
    case excited
    case surprised
    case confused
    case curious
    case suspicious
    case sleepy
    case sad
    case scared
    case angry
    case proud
    case shy
    case unimpressed
}

public struct BotAvatarColorPreset: Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let hex: String

    public init(id: String, label: String, hex: String) {
        self.id = id
        self.label = label
        self.hex = hex
    }
}

public struct CollabBotAvatarConfig: Codable, Equatable, Hashable, Sendable {
    public var color: String
    public var shape: BotAvatarShape
    public var expression: BotAvatarExpression

    public init(
        color: String,
        shape: BotAvatarShape = .circle,
        expression: BotAvatarExpression = .neutral
    ) {
        self.color = Self.normalizeHexColor(color)
        self.shape = shape
        self.expression = expression
    }

    public static let defaultMaster = CollabBotAvatarConfig(
        color: "#000000",
        shape: .circle,
        expression: .neutral
    )

    public static let colorPresets: [BotAvatarColorPreset] = [
        BotAvatarColorPreset(id: "ink", label: "墨黑", hex: "#000000"),
        BotAvatarColorPreset(id: "brown", label: "棕色", hex: "#9a6433"),
        BotAvatarColorPreset(id: "red", label: "红色", hex: "#fa2d37"),
        BotAvatarColorPreset(id: "orange", label: "橙色", hex: "#ff6b0a"),
        BotAvatarColorPreset(id: "amber", label: "琥珀", hex: "#f99408"),
        BotAvatarColorPreset(id: "green", label: "绿色", hex: "#09b866"),
        BotAvatarColorPreset(id: "turquoise", label: "青绿", hex: "#0db49b"),
        BotAvatarColorPreset(id: "blue", label: "蓝色", hex: "#1584ff"),
        BotAvatarColorPreset(id: "purple", label: "紫色", hex: "#8b52ff"),
        BotAvatarColorPreset(id: "pink", label: "粉色", hex: "#ff2994"),
        BotAvatarColorPreset(id: "grey", label: "灰色", hex: "#8c8c8c"),
    ]

    public static func normalizeHexColor(_ value: String, fallback: String = "#1584ff") -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let raw = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        if raw.count == 6, raw.allSatisfy(\.isHexDigit) {
            return "#\(raw.lowercased())"
        }
        if raw.count == 3, raw.allSatisfy(\.isHexDigit) {
            let chars = Array(raw.lowercased())
            return "#\(chars[0])\(chars[0])\(chars[1])\(chars[1])\(chars[2])\(chars[2])"
        }
        return fallback
    }

    public static func hashSeed(_ input: String) -> UInt32 {
        var hash: UInt32 = 2_166_136_261
        for scalar in input.utf16 {
            hash ^= UInt32(scalar)
            hash = hash &* 16_777_619
        }
        return hash
    }

    public static func derive(seed: String) -> CollabBotAvatarConfig {
        let trimmed = seed.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.isEmpty ? "vibex-bot" : trimmed
        if normalized.lowercased() == "master" {
            return defaultMaster
        }
        let h1 = Int(hashSeed(normalized))
        let h2 = Int(hashSeed("\(normalized):shape"))
        let colors = colorPresets
        let shapes = BotAvatarShape.allCases
        return CollabBotAvatarConfig(
            color: colors[h1 % colors.count].hex,
            shape: shapes[h2 % shapes.count],
            expression: .neutral
        )
    }

    public static func random() -> CollabBotAvatarConfig {
        let color = colorPresets.randomElement()?.hex ?? "#1584ff"
        let shape = BotAvatarShape.allCases.randomElement() ?? .circle
        return CollabBotAvatarConfig(color: color, shape: shape, expression: .neutral)
    }

    public static func resolve(
        rawAvatar: String?,
        rawColor: String?,
        fallbackSeed: String
    ) -> CollabBotAvatarConfig {
        let base = derive(seed: fallbackSeed)
        var resolvedColor = base.color
        if let rawColor, !rawColor.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            resolvedColor = normalizeHexColor(rawColor, fallback: base.color)
        }
        var resolvedShape = base.shape
        var resolvedExpression: BotAvatarExpression = .neutral

        if let rawAvatar = rawAvatar?.trimmingCharacters(in: .whitespacesAndNewlines),
           !rawAvatar.isEmpty
        {
            if let shapeDirect = BotAvatarShape(rawValue: rawAvatar) {
                resolvedShape = shapeDirect
            } else if rawAvatar.hasPrefix("{"),
                      let data = rawAvatar.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            {
                if let c = obj["color"] as? String, !c.isEmpty {
                    resolvedColor = normalizeHexColor(c, fallback: resolvedColor)
                }
                if let s = obj["shape"] as? String, let shape = BotAvatarShape(rawValue: s) {
                    resolvedShape = shape
                }
                if let e = obj["expression"] as? String, let expr = BotAvatarExpression(rawValue: e) {
                    resolvedExpression = expr
                }
            }
        }
        return CollabBotAvatarConfig(
            color: resolvedColor,
            shape: resolvedShape,
            expression: resolvedExpression
        )
    }

    public var jsonString: String {
        "{\"color\":\"\(Self.normalizeHexColor(color))\",\"shape\":\"\(shape.rawValue)\",\"expression\":\"\(expression.rawValue)\"}"
    }
}

// MARK: - Sidebar & Contact Groups

public struct CollabSidebarMember: Decodable, Equatable, Sendable {
    public let memberId: String
    public let identityMemberId: String?
    public let name: String
    public let avatar: String?
    public let color: String?
    public let conversationId: String?
    public let agent: String?
    public let isSupervisor: Bool

    public var resolvedIdentityId: String {
        if let id = identityMemberId, !id.isEmpty { return id }
        return memberId
    }

    public var botAvatar: CollabBotAvatarConfig {
        CollabBotAvatarConfig.resolve(
            rawAvatar: avatar,
            rawColor: color,
            fallbackSeed: name.isEmpty ? resolvedIdentityId : name
        )
    }

    private enum CodingKeys: String, CodingKey {
        case member_id, identity_member_id, name, avatar, color, conversation_id, agent, is_supervisor
    }

    public init(
        memberId: String,
        identityMemberId: String? = nil,
        name: String,
        avatar: String? = nil,
        color: String? = nil,
        conversationId: String? = nil,
        agent: String? = nil,
        isSupervisor: Bool = false
    ) {
        self.memberId = memberId
        self.identityMemberId = identityMemberId
        self.name = name
        self.avatar = avatar
        self.color = color
        self.conversationId = conversationId
        self.agent = agent
        self.isSupervisor = isSupervisor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memberId = (try? c.decode(String.self, forKey: .member_id)) ?? ""
        identityMemberId = try? c.decodeIfPresent(String.self, forKey: .identity_member_id)
        name = (try? c.decode(String.self, forKey: .name)) ?? "助手"
        if let s = try? c.decodeIfPresent(String.self, forKey: .avatar) {
            avatar = s
        } else if let obj = try? c.decodeIfPresent(CollabBotAvatarConfig.self, forKey: .avatar) {
            avatar = obj.jsonString
        } else {
            avatar = nil
        }
        color = try? c.decodeIfPresent(String.self, forKey: .color)
        conversationId = try? c.decodeIfPresent(String.self, forKey: .conversation_id)
        agent = try? c.decodeIfPresent(String.self, forKey: .agent)
        isSupervisor = (try? c.decode(Bool.self, forKey: .is_supervisor)) ?? false
    }
}

public struct CollabLastMessage: Decodable, Equatable, Sendable {
    public let seq: Int?
    public let preview: String?
    public let origin: String?
    public let createdAt: String?

    private enum CodingKeys: String, CodingKey {
        case seq, preview, origin, created_at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try? c.decodeIfPresent(Int.self, forKey: .seq)
        preview = try? c.decodeIfPresent(String.self, forKey: .preview)
        origin = try? c.decodeIfPresent(String.self, forKey: .origin)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .created_at)
    }
}

public struct CollabSidebarItem: Decodable, Identifiable, Equatable, Hashable, Sendable {
    public let kind: String // "group" or "dm"
    public let threadId: String
    public let spaceId: String?
    public let name: String
    public let tagColor: String?
    public let lastMessage: CollabLastMessage?
    public let lastActivityAt: String?
    public let unreadCount: Int
    public let membersPreview: [CollabSidebarMember]
    public let memberCount: Int
    public let member: CollabSidebarMember?
    public let groupId: String?

    public var id: String { threadId }
    public var isGroup: Bool { kind == "group" }
    public var isDirect: Bool { kind == "dm" }

    /// The spaceId used by `space.listMessages`, `space.post`, `space.submit`, etc.
    public var targetSpaceId: String {
        if isDirect { return threadId }
        return spaceId ?? threadId
    }

    public var displayName: String {
        if isDirect, let memberName = member?.name, !memberName.isEmpty {
            return memberName
        }
        return name.isEmpty ? (isGroup ? "未命名群组" : "助手") : name
    }

    public var activityDate: Date? {
        guard let raw = lastActivityAt ?? lastMessage?.createdAt else { return nil }
        return ConversationListItem.parseDate(raw)
    }

    public static func == (lhs: CollabSidebarItem, rhs: CollabSidebarItem) -> Bool {
        lhs.threadId == rhs.threadId
            && lhs.name == rhs.name
            && lhs.tagColor == rhs.tagColor
            && lhs.unreadCount == rhs.unreadCount
            && lhs.lastMessage == rhs.lastMessage
            && lhs.memberCount == rhs.memberCount
            && lhs.member == rhs.member
            && lhs.groupId == rhs.groupId
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(threadId)
    }

    private enum CodingKeys: String, CodingKey {
        case kind, thread_id, space_id, name, tag_color, last_message, last_activity_at
        case unread_count, members_preview, member_count, member, group_id
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "group"
        threadId = (try? c.decode(String.self, forKey: .thread_id)) ?? ""
        spaceId = try? c.decodeIfPresent(String.self, forKey: .space_id)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        tagColor = try? c.decodeIfPresent(String.self, forKey: .tag_color)
        lastMessage = try? c.decodeIfPresent(CollabLastMessage.self, forKey: .last_message)
        lastActivityAt = try? c.decodeIfPresent(String.self, forKey: .last_activity_at)
        unreadCount = (try? c.decode(Int.self, forKey: .unread_count)) ?? 0
        membersPreview = (try? c.decode([CollabSidebarMember].self, forKey: .members_preview)) ?? []
        memberCount = (try? c.decode(Int.self, forKey: .member_count)) ?? 0
        member = try? c.decodeIfPresent(CollabSidebarMember.self, forKey: .member)
        groupId = try? c.decodeIfPresent(String.self, forKey: .group_id)
    }
}

public struct CollabContactGroup: Decodable, Identifiable, Equatable, Sendable {
    public let groupId: String
    public let workspaceId: String
    public let name: String
    public let sortOrder: Int

    public var id: String { groupId }

    private enum CodingKeys: String, CodingKey {
        case group_id, workspace_id, name, sort_order
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        groupId = (try? c.decode(String.self, forKey: .group_id)) ?? ""
        workspaceId = (try? c.decode(String.self, forKey: .workspace_id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        sortOrder = (try? c.decode(Int.self, forKey: .sort_order)) ?? 0
    }
}

// MARK: - Space Members & Roles

public struct CollabSpaceSummary: Decodable, Identifiable, Equatable, Sendable {
    public let spaceId: String
    public let name: String
    public let leadMemberId: String?

    public var id: String { spaceId }

    private enum CodingKeys: String, CodingKey {
        case space_id, name, lead_member_id
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spaceId = (try? c.decode(String.self, forKey: .space_id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        leadMemberId = try? c.decodeIfPresent(String.self, forKey: .lead_member_id)
    }
}

public struct CollabSpaceMember: Decodable, Identifiable, Equatable, Sendable {
    public let memberId: String
    public let identityMemberId: String?
    public let nickname: String
    public let kind: String
    public let avatar: String?
    public let color: String?
    public let conversationId: String?
    public let isSupervisor: Bool

    public var id: String { memberId.isEmpty ? (conversationId ?? nickname) : memberId }
    public var isAgent: Bool { kind.isEmpty || kind == "agent" }
    public var resolvedIdentityId: String {
        if let id = identityMemberId, !id.isEmpty { return id }
        return memberId
    }

    public var botAvatar: CollabBotAvatarConfig {
        CollabBotAvatarConfig.resolve(
            rawAvatar: avatar,
            rawColor: color,
            fallbackSeed: nickname.isEmpty ? resolvedIdentityId : nickname
        )
    }

    private enum CodingKeys: String, CodingKey {
        case member_id, identity_member_id, nickname, kind, avatar, color, conversation_id, is_supervisor
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memberId = (try? c.decode(String.self, forKey: .member_id)) ?? ""
        identityMemberId = try? c.decodeIfPresent(String.self, forKey: .identity_member_id)
        nickname = (try? c.decode(String.self, forKey: .nickname)) ?? "助手"
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "agent"
        if let s = try? c.decodeIfPresent(String.self, forKey: .avatar) {
            avatar = s
        } else if let obj = try? c.decodeIfPresent(CollabBotAvatarConfig.self, forKey: .avatar) {
            avatar = obj.jsonString
        } else {
            avatar = nil
        }
        color = try? c.decodeIfPresent(String.self, forKey: .color)
        conversationId = try? c.decodeIfPresent(String.self, forKey: .conversation_id)
        isSupervisor = (try? c.decode(Bool.self, forKey: .is_supervisor)) ?? false
    }
}

public struct CollabRole: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let teamId: String?
    public let summary: String
    public let personaPrompt: String
    public let agentId: String
    public let modeId: String?
    public let configValues: [String: String]

    public init(
        id: String,
        name: String,
        teamId: String? = nil,
        summary: String = "",
        personaPrompt: String = "",
        agentId: String,
        modeId: String? = nil,
        configValues: [String: String] = [:]
    ) {
        self.id = id
        self.name = name
        self.teamId = teamId
        self.summary = summary
        self.personaPrompt = personaPrompt
        self.agentId = agentId
        self.modeId = modeId
        self.configValues = configValues
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, team_id, summary, persona_prompt, agent_id, mode_id, config_values
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        teamId = try? c.decodeIfPresent(String.self, forKey: .team_id)
        summary = (try? c.decode(String.self, forKey: .summary)) ?? ""
        personaPrompt = (try? c.decode(String.self, forKey: .persona_prompt)) ?? ""
        agentId = (try? c.decode(String.self, forKey: .agent_id)) ?? ""
        modeId = try? c.decodeIfPresent(String.self, forKey: .mode_id)
        configValues = (try? c.decode([String: String].self, forKey: .config_values)) ?? [:]
    }
}

public struct CollabTeam: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let summary: String?

    private enum CodingKeys: String, CodingKey {
        case id, name, summary
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
    }
}

// MARK: - Messages, Receipts, Reactions, Cards, & Scheduled

public struct CollabDeliveryReceipt: Decodable, Identifiable, Equatable, Sendable {
    public let conversationId: String?
    public let nickname: String?
    public let delivered: String?
    public let state: String?
    public let turnId: String?

    public var id: String { "\(conversationId ?? "")-\(nickname ?? "")-\(effectiveState)" }

    public var effectiveState: String {
        if let state, !state.isEmpty { return state }
        return delivered ?? "queued"
    }

    public var stateLabel: String {
        switch effectiveState {
        case "queued", "dispatched": return "排队中"
        case "processing": return "处理中"
        case "replied": return "已回复"
        case "passed": return "已略过"
        case "timed_out": return "超时"
        case "cancelled": return "已取消"
        case "failed": return "失败"
        case "limit_reached": return "达上限"
        default: return effectiveState
        }
    }

    public var isProcessing: Bool {
        effectiveState == "processing" || effectiveState == "queued"
    }

    private enum CodingKeys: String, CodingKey {
        case conversation_id, nickname, delivered, state, turn_id
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try? c.decodeIfPresent(String.self, forKey: .conversation_id)
        nickname = try? c.decodeIfPresent(String.self, forKey: .nickname)
        delivered = try? c.decodeIfPresent(String.self, forKey: .delivered)
        state = try? c.decodeIfPresent(String.self, forKey: .state)
        turnId = try? c.decodeIfPresent(String.self, forKey: .turn_id)
    }
}

public struct CollabReaction: Decodable, Equatable, Sendable {
    public let emoji: String
    public let actor: String
}

public struct CollabMessageEnvelope: Decodable, Equatable, Sendable {
    public let id: String?
    public let sender: String
    public let content: String
    public let summary: String?
    public let to: [String]
    public let published: String?
    public let conversationId: String?
    public let reactions: [CollabReaction]

    public var isFromUser: Bool {
        let lower = sender.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lower == "person" || lower == "user" || sender == "你" || sender == "用户"
    }

    public var isSystem: Bool {
        sender.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "system"
    }

    public var displaySender: String {
        if isFromUser { return "你" }
        if isSystem { return "系统" }
        return sender.isEmpty ? "助手" : sender
    }

    public var recipientLabels: [String] {
        to.compactMap { raw in
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return nil }
            let lower = trimmed.lowercased()
            if lower == "person" || lower == "user" || trimmed == "你" || trimmed == "用户" {
                return nil
            }
            return trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, sender, content, summary, to, published, conversation_id, conversationId, reactions
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        sender = (try? c.decode(String.self, forKey: .sender)) ?? ""
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        to = (try? c.decode([String].self, forKey: .to)) ?? []
        published = try? c.decodeIfPresent(String.self, forKey: .published)
        conversationId = (try? c.decodeIfPresent(String.self, forKey: .conversation_id))
            ?? (try? c.decodeIfPresent(String.self, forKey: .conversationId))
        reactions = (try? c.decode([CollabReaction].self, forKey: .reactions)) ?? []
    }
}

public struct CollabSpaceMessage: Decodable, Identifiable, Equatable, Sendable {
    public let rawId: String?
    public let seq: Int
    public let origin: String?
    public let inReplyTo: String?
    public let streaming: Bool
    public let receipts: [CollabDeliveryReceipt]
    public let envelope: CollabMessageEnvelope

    public var id: String {
        let candidate = (rawId ?? envelope.id ?? "").replacingOccurrences(of: "vibex://space-message/", with: "")
        return candidate.isEmpty ? "seq-\(seq)" : candidate
    }

    public var isFromUser: Bool {
        origin == "user" || envelope.isFromUser
    }

    /// Grouped emoji reactions -> (emoji, count, userReacted).
    public var groupedReactions: [(emoji: String, count: Int, byUser: Bool)] {
        var order: [String] = []
        var counts: [String: Int] = [:]
        var byUser: Set<String> = []
        for r in envelope.reactions {
            if counts[r.emoji] == nil { order.append(r.emoji) }
            counts[r.emoji, default: 0] += 1
            if r.actor.lowercased() == "person" || r.actor.lowercased() == "user" {
                byUser.insert(r.emoji)
            }
        }
        return order.map { ($0, counts[$0] ?? 1, byUser.contains($0)) }
    }

    private enum CodingKeys: String, CodingKey {
        case id, seq, origin, in_reply_to, inReplyTo, streaming, receipts, envelope
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        rawId = try? c.decodeIfPresent(String.self, forKey: .id)
        seq = (try? c.decode(Int.self, forKey: .seq)) ?? 0
        origin = try? c.decodeIfPresent(String.self, forKey: .origin)
        inReplyTo = (try? c.decodeIfPresent(String.self, forKey: .in_reply_to))
            ?? (try? c.decodeIfPresent(String.self, forKey: .inReplyTo))
        streaming = (try? c.decode(Bool.self, forKey: .streaming)) ?? false
        receipts = (try? c.decode([CollabDeliveryReceipt].self, forKey: .receipts)) ?? []
        envelope = try c.decode(CollabMessageEnvelope.self, forKey: .envelope)
    }
}

public struct CollabScheduledMessage: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let spaceId: String
    public let content: String
    public let deliverAt: String
    public let status: String?

    private enum CodingKeys: String, CodingKey {
        case id, delayed_input_id, space_id, content, deliver_at, status
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id))
            ?? (try? c.decodeIfPresent(String.self, forKey: .delayed_input_id))
            ?? UUID().uuidString
        spaceId = (try? c.decode(String.self, forKey: .space_id)) ?? ""
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        deliverAt = (try? c.decode(String.self, forKey: .deliver_at)) ?? ""
        status = try? c.decodeIfPresent(String.self, forKey: .status)
    }
}

public struct CollabCard: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String // "ask" or "approval"
    public let status: String // "pending" or "resolved"
    public let action: String?
    public let command: String?
    public let reason: String?
    public let question: String?
    public let options: [String]

    public var isPending: Bool { status == "pending" }

    private enum CodingKeys: String, CodingKey {
        case id, kind, status, payload
    }

    private enum PayloadKeys: String, CodingKey {
        case action, command, reason, question, options
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "ask"
        status = (try? c.decode(String.self, forKey: .status)) ?? "pending"
        if let p = try? c.nestedContainer(keyedBy: PayloadKeys.self, forKey: .payload) {
            action = try? p.decodeIfPresent(String.self, forKey: .action)
            command = try? p.decodeIfPresent(String.self, forKey: .command)
            reason = try? p.decodeIfPresent(String.self, forKey: .reason)
            question = try? p.decodeIfPresent(String.self, forKey: .question)
            options = (try? p.decode([String].self, forKey: .options)) ?? []
        } else {
            action = nil
            command = nil
            reason = nil
            question = nil
            options = []
        }
    }
}

public struct CollabMessagesPage: Decodable, Equatable, Sendable {
    public let messages: [CollabSpaceMessage]
    public let scheduled: [CollabScheduledMessage]
    public let cards: [CollabCard]
    public let conversationId: String?

    private enum CodingKeys: String, CodingKey {
        case messages, scheduled, cards, conversationId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = (try? c.decode([CollabSpaceMessage].self, forKey: .messages)) ?? []
        scheduled = (try? c.decode([CollabScheduledMessage].self, forKey: .scheduled)) ?? []
        cards = (try? c.decode([CollabCard].self, forKey: .cards)) ?? []
        conversationId = try? c.decodeIfPresent(String.self, forKey: .conversationId)
    }
}

// MARK: - Memory & Collection

public struct CollabMemoryFact: Decodable, Identifiable, Equatable, Sendable {
    public let id: Int
    public let content: String
    public let scope: String
    public let origin: String

    public var scopeLabel: String {
        if scope == "global" { return "全局" }
        if scope == "private" { return "私聊" }
        if scope.hasPrefix("thread:") || scope == "thread" { return "本群" }
        return scope
    }

    private enum CodingKeys: String, CodingKey {
        case id, content, scope, origin
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(Int.self, forKey: .id)) ?? 0
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        scope = (try? c.decode(String.self, forKey: .scope)) ?? "thread"
        origin = (try? c.decode(String.self, forKey: .origin)) ?? "user"
    }
}

public struct CollabMemoryTopic: Decodable, Identifiable, Equatable, Sendable {
    public let topic: String
    public let title: String
    public let preview: String?
    public let content: String?

    public var id: String { topic }

    private enum CodingKeys: String, CodingKey {
        case topic, title, summary, preview, content
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        topic = (try? c.decode(String.self, forKey: .topic)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)) ?? topic
        preview = (try? c.decodeIfPresent(String.self, forKey: .preview))
            ?? (try? c.decodeIfPresent(String.self, forKey: .summary))
        content = try? c.decodeIfPresent(String.self, forKey: .content)
    }
}

public struct CollabMemoryView: Decodable, Equatable, Sendable {
    public let facts: [CollabMemoryFact]
    public let topics: [CollabMemoryTopic]

    private enum CodingKeys: String, CodingKey {
        case facts, topics
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        facts = (try? c.decode([CollabMemoryFact].self, forKey: .facts)) ?? []
        topics = (try? c.decode([CollabMemoryTopic].self, forKey: .topics)) ?? []
    }
}

public struct CollabCollectionItem: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let spaceId: String
    public let creatorNickname: String
    public let kind: String
    public let name: String
    public let note: String
    public let textContent: String?
    public let createdAt: String

    private enum CodingKeys: String, CodingKey {
        case id, space_id, creator_nickname, item_kind, kind, file_name, name, note, text_content, created_at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        spaceId = (try? c.decode(String.self, forKey: .space_id)) ?? ""
        creatorNickname = (try? c.decode(String.self, forKey: .creator_nickname)) ?? "User"
        kind = (try? c.decodeIfPresent(String.self, forKey: .item_kind))
            ?? (try? c.decodeIfPresent(String.self, forKey: .kind))
            ?? "text"
        name = (try? c.decodeIfPresent(String.self, forKey: .name))
            ?? (try? c.decodeIfPresent(String.self, forKey: .file_name))
            ?? "未命名收藏"
        note = (try? c.decode(String.self, forKey: .note)) ?? ""
        textContent = try? c.decodeIfPresent(String.self, forKey: .text_content)
        createdAt = (try? c.decode(String.self, forKey: .created_at)) ?? ""
    }
}

public struct CollabMemberConfig: Decodable, Equatable, Sendable {
    public let agentId: String?
    public let modeId: String?
    public let personaPrompt: String?

    private enum CodingKeys: String, CodingKey {
        case agent_id, agentId, mode_id, modeId, persona_prompt, personaPrompt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = (try? c.decodeIfPresent(String.self, forKey: .agent_id))
            ?? (try? c.decodeIfPresent(String.self, forKey: .agentId))
        modeId = (try? c.decodeIfPresent(String.self, forKey: .mode_id))
            ?? (try? c.decodeIfPresent(String.self, forKey: .modeId))
        personaPrompt = (try? c.decodeIfPresent(String.self, forKey: .persona_prompt))
            ?? (try? c.decodeIfPresent(String.self, forKey: .personaPrompt))
    }
}
