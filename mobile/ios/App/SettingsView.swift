import CompanionCore
import SwiftUI

struct SettingsView: View {
    @Environment(ServerStore.self) private var servers
    @Environment(AppAppearanceStore.self) private var appearance
    @Environment(\.colorScheme) private var colorScheme

    private var effectiveIsDark: Bool {
        switch appearance.themeMode {
        case .dark: return true
        case .light: return false
        case .system: return colorScheme == .dark
        }
    }

    var body: some View {
        NavigationStack {
            List {
                // 1. 个人资料
                Section {
                    NavigationLink {
                        ProfileSettingsDetailView()
                    } label: {
                        HStack(spacing: 12) {
                            MemberBotAvatarView(
                                config: appearance.avatarConfig,
                                size: 46,
                                animated: true
                            )
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(appearance.userName)
                                        .font(.subheadline.weight(.semibold))
                                        .foregroundStyle(.primary)
                                    Text(appearance.userHandle)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Text(appearance.userRoleTitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                if !appearance.userBio.isEmpty {
                                    Text(appearance.userBio)
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))
                }

                // 2. 已配对的电脑 & 3. 技能
                Section {
                    NavigationLink {
                        PairedComputersSettingsView()
                    } label: {
                        HStack(spacing: 10) {
                            settingsIconBadge(
                                systemImage: "desktopcomputer",
                                tint: .blue
                            )
                            VStack(alignment: .leading, spacing: 1) {
                                Text("已配对的电脑")
                                    .font(.subheadline.weight(.medium))
                                Text(pairedComputerSubtitle)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 6)
                            if servers.activeProfile != nil {
                                HStack(spacing: 4) {
                                    Circle()
                                        .fill(Color.green)
                                        .frame(width: 6.5, height: 6.5)
                                    Text("已连接")
                                        .font(.caption2.weight(.medium))
                                        .foregroundStyle(.secondary)
                                }
                            } else {
                                Text("去配对")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14))

                    NavigationLink {
                        SkillsHubSettingsView()
                    } label: {
                        HStack(spacing: 10) {
                            settingsIconBadge(
                                systemImage: "sparkles.rectangle.stack.fill",
                                tint: .purple
                            )
                            VStack(alignment: .leading, spacing: 1) {
                                Text("技能")
                                    .font(.subheadline.weight(.medium))
                                Text("技能 · MCP · 插件 · 子代理")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14))
                }

                // 4. 主题 & 5. 字体 & 6. 通知
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 10) {
                            settingsIconBadge(
                                systemImage: appearance.themeMode.icon,
                                tint: .indigo
                            )
                            VStack(alignment: .leading, spacing: 1) {
                                Text("主题")
                                    .font(.subheadline.weight(.medium))
                                Text(appearance.themeMode.subtitle)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(appearance.themeMode.title)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Color.accentColor)
                        }

                        HStack(spacing: 8) {
                            ForEach(AppThemeMode.allCases) { mode in
                                let isSelected = appearance.themeMode == mode
                                Button {
                                    appearance.setThemeModeWithTopRightReveal(mode)
                                } label: {
                                    HStack(spacing: 5) {
                                        Image(systemName: mode.icon)
                                            .font(.system(size: 12, weight: .semibold))
                                            .foregroundStyle(isSelected ? Color.white : Color.primary)
                                        Text(mode.title)
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(isSelected ? Color.white : Color.primary)
                                    }
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 7)
                                    .background(
                                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                                            .fill(
                                                isSelected
                                                    ? Color.accentColor
                                                    : Color.secondary.opacity(0.11)
                                            )
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14))

                    NavigationLink {
                        FontSettingsDetailView()
                    } label: {
                        HStack(spacing: 10) {
                            settingsIconBadge(
                                systemImage: "textformat.size",
                                tint: .orange
                            )
                            VStack(alignment: .leading, spacing: 1) {
                                Text("字体")
                                    .font(.subheadline.weight(.medium))
                                Text("字号大小与字体样式")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("\(appearance.fontStylePreset.shortTitle) · \(appearance.fontSizePreset.title)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14))

                    NavigationLink {
                        NotificationSettingsDetailView()
                    } label: {
                        HStack(spacing: 10) {
                            settingsIconBadge(
                                systemImage: "bell.badge.fill",
                                tint: .red
                            )
                            VStack(alignment: .leading, spacing: 1) {
                                Text("通知")
                                    .font(.subheadline.weight(.medium))
                                Text("任务完成、审批与协作消息提醒")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(appearance.systemNotificationStatusText)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14))
                }

                // 7. 关于 VibeX & 当前版本
                Section {
                    NavigationLink {
                        AboutVibeXDetailView()
                    } label: {
                        HStack(spacing: 10) {
                            settingsIconBadge(
                                systemImage: "info.circle.fill",
                                tint: .teal
                            )
                            Text("关于 VibeX")
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Text("本地优先 AI 研发平台")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14))

                    HStack(spacing: 10) {
                        settingsIconBadge(
                            systemImage: "checkmark.seal.fill",
                            tint: .green
                        )
                        Text("当前版本")
                            .font(.subheadline.weight(.medium))
                        Spacer()
                        Text(currentVersionLabel)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    .listRowInsets(EdgeInsets(top: 7, leading: 14, bottom: 7, trailing: 14))
                }
            }
            .listSectionSpacing(10)
            .contentMargins(.top, 6, for: .scrollContent)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        let nextMode: AppThemeMode = effectiveIsDark ? .light : .dark
                        appearance.setThemeModeWithTopRightReveal(nextMode)
                    } label: {
                        Image(systemName: effectiveIsDark ? "sun.max.fill" : "moon.stars.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(effectiveIsDark ? .yellow : .primary)
                    }
                    .accessibilityLabel("切换深浅色主题")
                }
            }
        }
    }

    private var pairedComputerSubtitle: String {
        if let active = servers.activeProfile {
            return "\(active.serverName) · 共 \(servers.profiles.count) 台历史设备"
        }
        return "查看历史配对电脑或配对新的电脑"
    }

    private var currentVersionLabel: String {
        if let active = servers.activeProfile {
            return "v\(active.serverVersion) (协议 v\(active.protocolVersion))"
        }
        return "v0.4.2"
    }

    private func settingsIconBadge(systemImage: String, tint: Color) -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(tint.opacity(0.14))
                .frame(width: 28, height: 28)
            Image(systemName: systemImage)
                .font(.system(size: 13.5, weight: .semibold))
                .foregroundStyle(tint)
        }
    }
}

// MARK: - 1. 个人资料详情页

struct ProfileSettingsDetailView: View {
    @Environment(AppAppearanceStore.self) private var appearance
    @Environment(ServerStore.self) private var servers
    @State private var hostInfo: HostUserSystemInfo?

    var body: some View {
        @Bindable var bindableAppearance = appearance
        Form {
            Section {
                VStack(spacing: 14) {
                    MemberBotAvatarView(
                        config: appearance.avatarConfig,
                        size: 76,
                        animated: true
                    )
                    Text(appearance.userName)
                        .font(.title3.weight(.bold))
                    Text(appearance.userRoleTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)

                MemberBotAvatarPicker(
                    value: Binding(
                        get: { appearance.avatarConfig },
                        set: { appearance.avatarConfig = $0 }
                    )
                )
            } header: {
                Text("动态角色头像 (11 种配色 · 13 种形状)")
            }

            Section("基本信息") {
                LabeledContent("昵称") {
                    TextField("输入昵称", text: $bindableAppearance.userName)
                        .multilineTextAlignment(.trailing)
                }
                LabeledContent("标识 (Handle)") {
                    TextField("@handle", text: $bindableAppearance.userHandle)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                LabeledContent("头衔 / 角色") {
                    TextField("头衔", text: $bindableAppearance.userRoleTitle)
                        .multilineTextAlignment(.trailing)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("个人简介")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    TextField("介绍一下你的工作流...", text: $bindableAppearance.userBio, axis: .vertical)
                        .lineLimit(2...4)
                }
            }

            if let active = servers.activeProfile {
                Section("当前绑定工作站环境") {
                    LabeledContent("工作站名称", value: active.serverName)
                    LabeledContent("本机设备名", value: active.deviceName)
                    if let env = hostInfo?.environment {
                        LabeledContent("操作系统", value: "\(env.osType) (\(env.bitness))")
                        LabeledContent("处理器架构", value: env.osArchitecture)
                    }
                }
            }
        }
        .navigationTitle("个人资料")
        .navigationBarTitleDisplayMode(.inline)
        .scrollDismissesKeyboard(.interactively)
        .onDisappear {
            dismissKeyboard()
        }
        .task {
            if let client = servers.activeClient() {
                hostInfo = try? await client.userSystemInfo()
            }
        }
    }
}

// MARK: - 2. 已配对的电脑（历史配对 + 配对新的电脑）

struct PairedComputersSettingsView: View {
    @Environment(ServerStore.self) private var servers
    @State private var showingPairSheet = false

    var body: some View {
        List {
            Section {
                Button {
                    showingPairSheet = true
                } label: {
                    HStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(Color.accentColor.opacity(0.14))
                                .frame(width: 40, height: 40)
                            Image(systemName: "qrcode.viewfinder")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(Color.accentColor)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text("配对新的电脑")
                                .font(.headline)
                                .foregroundStyle(.primary)
                            Text("扫描桌面端二维码、粘贴邀请码或手动输入地址")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "plus.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Color.accentColor)
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Text("新增连接")
            }

            Section {
                if servers.profiles.isEmpty {
                    ContentUnavailableView(
                        "暂无历史配对电脑",
                        systemImage: "desktopcomputer.trianglebadge.exclamationmark",
                        description: Text("点击上方「配对新的电脑」连接你的 VibeX 桌面端。")
                    )
                    .padding(.vertical, 16)
                } else {
                    ForEach(servers.profiles) { profile in
                        let isActive = servers.activeProfile?.id == profile.id
                        NavigationLink {
                            ServerDetailView(profile: profile)
                        } label: {
                            HStack(spacing: 12) {
                                ZStack {
                                    Circle()
                                        .fill(isActive ? Color.green.opacity(0.15) : Color.secondary.opacity(0.12))
                                        .frame(width: 38, height: 38)
                                    Image(systemName: isActive ? "laptopcomputer.and.iphone" : "desktopcomputer")
                                        .font(.system(size: 16, weight: .semibold))
                                        .foregroundStyle(isActive ? Color.green : Color.secondary)
                                }

                                VStack(alignment: .leading, spacing: 4) {
                                    HStack(spacing: 6) {
                                        Text(profile.serverName)
                                            .font(.body.weight(.semibold))
                                        if isActive {
                                            Text("当前连接")
                                                .font(.caption2.weight(.semibold))
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(
                                                    Capsule().fill(Color.green.opacity(0.16))
                                                )
                                                .foregroundStyle(Color.green)
                                        }
                                    }
                                    Text(profile.origin)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(.secondary)
                                    Text("设备：\(profile.deviceName) · VibeX v\(profile.serverVersion)")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }

                                Spacer()

                                if !isActive {
                                    Button("连接") {
                                        servers.setActive(profile.id)
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                servers.remove(profile.id)
                            } label: {
                                Label("移除", systemImage: "trash")
                            }
                        }
                    }
                }
            } header: {
                Text("历史配对的电脑 (\(servers.profiles.count))")
            } footer: {
                Text("点击任意电脑可查看连接诊断详情，左滑可移除历史配对记录。")
            }
        }
        .navigationTitle("已配对的电脑")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingPairSheet) {
            NavigationStack {
                PairView()
            }
        }
    }
}

// MARK: - 3. 技能中心（技能 / MCP / 插件 / 子代理）

enum SkillsHubSegment: String, CaseIterable, Identifiable {
    case skills = "技能"
    case mcp = "MCP"
    case plugins = "插件"
    case subagents = "子代理"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .skills: return "sparkles"
        case .mcp: return "server.rack"
        case .plugins: return "puzzlepiece.extension.fill"
        case .subagents: return "person.2.badge.gearshape.fill"
        }
    }
}

struct SkillsHubSettingsView: View {
    @Environment(ServerStore.self) private var servers
    @State private var selectedSegment: SkillsHubSegment = .skills
    @State private var searchQuery = ""
    @FocusState private var isSearchFocused: Bool
    @State private var searchBarGlobalFrame: CGRect = .zero

    @State private var skills: [LocalSkillItem] = []
    @State private var mcpServers: [LocalMcpServerItem] = []
    @State private var plugins: [PluginCatalogItem] = []
    @State private var roles: [CollabRole] = []
    @State private var agents: [CatalogAgent] = []

    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var selectedSkillForDetail: LocalSkillItem?

    var body: some View {
        VStack(spacing: 0) {
            // Top 4-tab segment bar: 技能 · MCP · 插件 · 子代理
            VStack(spacing: 10) {
                HStack(spacing: 8) {
                    ForEach(SkillsHubSegment.allCases) { segment in
                        let isSelected = selectedSegment == segment
                        Button {
                            withAnimation(.snappy(duration: 0.22)) {
                                selectedSegment = segment
                            }
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: segment.icon)
                                    .font(.system(size: 12, weight: .semibold))
                                Text(segment.rawValue)
                                    .font(.subheadline.weight(.semibold))
                                Text("\(count(for: segment))")
                                    .font(.caption2.monospacedDigit())
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 1)
                                    .background(
                                        Capsule().fill(
                                            isSelected
                                                ? Color.white.opacity(0.24)
                                                : Color.secondary.opacity(0.14)
                                        )
                                    )
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .background(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(isSelected ? Color.accentColor : Color(.secondarySystemGroupedBackground))
                            )
                            .foregroundStyle(isSelected ? Color.white : Color.primary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 14)

                // Search bar
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 14))
                        .foregroundStyle(isSearchFocused ? Color.accentColor : Color.secondary)
                    TextField("搜索\(selectedSegment.rawValue)...", text: $searchQuery)
                        .font(.subheadline)
                        .focused($isSearchFocused)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                    if !searchQuery.isEmpty {
                        Button {
                            searchQuery = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    if isSearchFocused || !searchQuery.isEmpty {
                        Button {
                            withAnimation(.easeOut(duration: 0.18)) {
                                isSearchFocused = false
                                searchQuery = ""
                            }
                            dismissKeyboard()
                        } label: {
                            Text("取消")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Color.accentColor)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    GeometryReader { geo in
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color(.secondarySystemGroupedBackground))
                            .onAppear { searchBarGlobalFrame = geo.frame(in: .global) }
                            .onChange(of: geo.frame(in: .global)) { _, f in searchBarGlobalFrame = f }
                    }
                )
                .padding(.horizontal, 14)
            }
            .padding(.vertical, 10)
            .background(Color(.systemGroupedBackground))

            if isLoading && skills.isEmpty && mcpServers.isEmpty && plugins.isEmpty && roles.isEmpty {
                Spacer()
                ProgressView("正在同步\(selectedSegment.rawValue)目录...")
                Spacer()
            } else {
                List {
                    if let errorMessage {
                        Section {
                            Text(errorMessage)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }

                    switch selectedSegment {
                    case .skills:
                        skillsListContent
                    case .mcp:
                        mcpListContent
                    case .plugins:
                        pluginsListContent
                    case .subagents:
                        subagentsListContent
                    }
                }
                .listStyle(.insetGrouped)
                .scrollDismissesKeyboard(.immediately)
                .refreshable {
                    await reloadAll()
                }
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("技能与扩展")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear {
            dismissKeyboard()
        }
        .onReceive(NotificationCenter.default.publisher(for: .vibexTapOutsideInput)) { note in
            guard isSearchFocused || !searchQuery.isEmpty else { return }
            if let locationValue = note.userInfo?["location"] as? NSValue {
                let point = locationValue.cgPointValue
                if !searchBarGlobalFrame.insetBy(dx: -8, dy: -8).contains(point) {
                    withAnimation(.easeOut(duration: 0.18)) {
                        isSearchFocused = false
                        searchQuery = ""
                    }
                    dismissKeyboard()
                }
            }
        }
        .task {
            await reloadAll()
        }
        .sheet(item: $selectedSkillForDetail) { skill in
            if let client = servers.activeClient() {
                LocalSkillDetailSheet(skill: skill, client: client)
            }
        }
    }

    private func count(for segment: SkillsHubSegment) -> Int {
        switch segment {
        case .skills: return skills.count
        case .mcp: return mcpServers.count
        case .plugins: return plugins.count
        case .subagents: return roles.count + agents.count
        }
    }

    @ViewBuilder
    private var skillsListContent: some View {
        let filtered = filteredSkills
        if filtered.isEmpty {
            ContentUnavailableView(
                "暂无匹配的技能",
                systemImage: "sparkles",
                description: Text("桌面端安装的本地与全局 Agent 技能将在此显示。")
            )
        } else {
            Section("已安装技能 (\(filtered.count))") {
                ForEach(filtered) { skill in
                    Button {
                        selectedSkillForDetail = skill
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                Image(systemName: "sparkles")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(.purple)
                                Text(skill.name)
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Spacer()
                                if skill.global {
                                    Text("全局")
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Capsule().fill(Color.purple.opacity(0.14)))
                                        .foregroundStyle(.purple)
                                }
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            if let desc = skill.description, !desc.isEmpty {
                                Text(desc)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            if !skill.apps.isEmpty {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 6) {
                                        ForEach(skill.apps, id: \.self) { app in
                                            Text(app)
                                                .font(.caption2.monospaced())
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(
                                                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                                                        .fill(Color.secondary.opacity(0.12))
                                                )
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private var mcpListContent: some View {
        let filtered = filteredMcpServers
        if filtered.isEmpty {
            ContentUnavailableView(
                "暂无 MCP 服务",
                systemImage: "server.rack",
                description: Text("在桌面端配置的本地或远程 MCP 服务器会同步显示在此处。")
            )
        } else {
            Section("已配置 MCP 服务 (\(filtered.count))") {
                ForEach(filtered) { server in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            Image(systemName: "server.rack")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.blue)
                            Text(server.id)
                                .font(.body.weight(.semibold))
                            Spacer()
                            Text(server.transportLabel)
                                .font(.caption2.monospaced().weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(Color.blue.opacity(0.14)))
                                .foregroundStyle(.blue)
                            if server.global {
                                Text("全局")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(Color.green.opacity(0.14)))
                                    .foregroundStyle(.green)
                            }
                        }
                        Text(server.commandSummary)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        if !server.apps.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    ForEach(server.apps, id: \.self) { app in
                                        Text(app)
                                            .font(.caption2.monospaced())
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(
                                                RoundedRectangle(cornerRadius: 5, style: .continuous)
                                                    .fill(Color.secondary.opacity(0.12))
                                            )
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    @ViewBuilder
    private var pluginsListContent: some View {
        let filtered = filteredPlugins
        if filtered.isEmpty {
            ContentUnavailableView(
                "暂无已安装插件",
                systemImage: "puzzlepiece.extension",
                description: Text("在 VibeX 桌面端插件中心安装的插件将显示在此处。")
            )
        } else {
            Section("已安装插件 (\(filtered.count))") {
                ForEach(filtered) { plugin in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            Image(systemName: "puzzlepiece.extension.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(plugin.enabled ? .orange : .secondary)
                            Text(plugin.name)
                                .font(.body.weight(.semibold))
                            Text("v\(plugin.version)")
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                            Spacer()
                            Text(plugin.enabled ? "已启用" : "已停用")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(
                                    Capsule().fill(
                                        plugin.enabled
                                            ? Color.green.opacity(0.15)
                                            : Color.secondary.opacity(0.14)
                                    )
                                )
                                .foregroundStyle(plugin.enabled ? .green : .secondary)
                        }
                        if let desc = plugin.description, !desc.isEmpty {
                            Text(desc)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        HStack(spacing: 10) {
                            Label(plugin.builtin ? "内置插件" : plugin.sourceKind, systemImage: "shippingbox")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            if !plugin.skills.isEmpty {
                                Label("\(plugin.skills.count) 项技能", systemImage: "sparkles")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            if plugin.mcpCount > 0 {
                                Label("\(plugin.mcpCount) 个 MCP", systemImage: "server.rack")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    @ViewBuilder
    private var subagentsListContent: some View {
        let matchedRoles = filteredRoles
        let matchedAgents = filteredAgents

        if matchedRoles.isEmpty && matchedAgents.isEmpty {
            ContentUnavailableView(
                "暂无子代理与角色",
                systemImage: "person.2.badge.gearshape",
                description: Text("协作空间角色与已启用的子代理执行器将在此展示。")
            )
        } else {
            if !matchedRoles.isEmpty {
                Section("子代理角色预设 (\(matchedRoles.count))") {
                    ForEach(matchedRoles) { role in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                Image(systemName: "person.crop.circle.badge.Checkmark")
                                    .foregroundStyle(.indigo)
                                Text(role.name)
                                    .font(.body.weight(.semibold))
                                if let team = role.teamId, !team.isEmpty {
                                    Text(team)
                                        .font(.caption2.weight(.medium))
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(Capsule().fill(Color.indigo.opacity(0.14)))
                                        .foregroundStyle(.indigo)
                                }
                                Spacer()
                                Text(role.agentId)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                            let desc = role.summary.isEmpty ? role.personaPrompt : role.summary
                            if !desc.isEmpty {
                                Text(desc)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }

            if !matchedAgents.isEmpty {
                Section("可用 Agent 执行引擎 (\(matchedAgents.count))") {
                    ForEach(matchedAgents) { agent in
                        HStack(spacing: 10) {
                            Circle()
                                .fill(agent.usable ? Color.green : Color.orange)
                                .frame(width: 8, height: 8)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(agent.displayName)
                                    .font(.body.weight(.medium))
                                Text(agent.id)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(agent.usable ? "就绪" : "未就绪")
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(
                                    Capsule().fill(
                                        agent.usable
                                            ? Color.green.opacity(0.15)
                                            : Color.orange.opacity(0.15)
                                    )
                                )
                                .foregroundStyle(agent.usable ? .green : .orange)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    private var filteredSkills: [LocalSkillItem] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return skills }
        return skills.filter {
            $0.name.lowercased().contains(q)
                || ($0.description?.lowercased().contains(q) ?? false)
                || $0.id.lowercased().contains(q)
        }
    }

    private var filteredMcpServers: [LocalMcpServerItem] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return mcpServers }
        return mcpServers.filter {
            $0.id.lowercased().contains(q)
                || $0.commandSummary.lowercased().contains(q)
        }
    }

    private var filteredPlugins: [PluginCatalogItem] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return plugins }
        return plugins.filter {
            $0.name.lowercased().contains(q)
                || ($0.description?.lowercased().contains(q) ?? false)
                || $0.id.lowercased().contains(q)
        }
    }

    private var filteredRoles: [CollabRole] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return roles }
        return roles.filter {
            $0.name.lowercased().contains(q)
                || $0.personaPrompt.lowercased().contains(q)
                || $0.agentId.lowercased().contains(q)
        }
    }

    private var filteredAgents: [CatalogAgent] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return agents }
        return agents.filter {
            $0.displayName.lowercased().contains(q)
                || $0.id.lowercased().contains(q)
        }
    }

    private func reloadAll() async {
        guard let client = servers.activeClient() else {
            errorMessage = "当前未连接电脑，请先配对电脑后查看技能与扩展。"
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        async let fetchedSkills = try? client.localSkills()
        async let fetchedMcp = try? client.localMcpServers()
        async let fetchedPlugins = try? client.pluginCatalog()
        async let fetchedRoles = try? client.collabRoles()
        async let fetchedCatalog = try? client.agentCatalog()

        if let s = await fetchedSkills { skills = s }
        if let m = await fetchedMcp { mcpServers = m }
        if let p = await fetchedPlugins { plugins = p }
        if let r = await fetchedRoles { roles = r }
        if let c = await fetchedCatalog { agents = c }
    }
}

struct LocalSkillDetailSheet: View {
    let skill: LocalSkillItem
    let client: HostClient

    @Environment(\.dismiss) private var dismiss
    @State private var content: LocalSkillContentItem?
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(skill.name)
                                .font(.title3.weight(.bold))
                            Spacer()
                            if skill.global {
                                Text("全局技能")
                                    .font(.caption.weight(.semibold))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Capsule().fill(Color.purple.opacity(0.15)))
                                    .foregroundStyle(.purple)
                            }
                        }
                        if let desc = skill.description, !desc.isEmpty {
                            Text(desc)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        if !skill.path.isEmpty {
                            Text(skill.path)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .padding(14)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color(.secondarySystemGroupedBackground))
                    )

                    if isLoading {
                        HStack {
                            Spacer()
                            ProgressView("读取 SKILL.md...")
                            Spacer()
                        }
                        .padding(.vertical, 32)
                    } else if let content, !content.content.isEmpty {
                        Text(content.content)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .background(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(Color(.secondarySystemGroupedBackground))
                            )
                    } else {
                        Text("未能读取到技能内容")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(16)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle(skill.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .task {
                isLoading = true
                content = try? await client.readLocalSkill(skillID: skill.id)
                isLoading = false
            }
        }
    }
}

// MARK: - 5. 字体设置页（字号大小 + 字体样式）

struct FontSettingsDetailView: View {
    @Environment(AppAppearanceStore.self) private var appearance

    var body: some View {
        List {
            Section("实时预览") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text("VibeX 字体与排版预览")
                            .font(.system(size: appearance.fontSizePreset.pointPreviewSize + 2, weight: .semibold, design: appearance.fontStylePreset.fontDesign))
                        Spacer()
                        Text("\(appearance.fontSizePreset.title) · \(appearance.fontSizePreset.scaleLabel)")
                            .font(.caption.monospacedDigit())
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Capsule().fill(Color.accentColor.opacity(0.14)))
                            .foregroundStyle(Color.accentColor)
                    }

                    Text("支持多智能体协作空间、四列看板与实时代码审查。The quick brown fox jumps over the lazy dog.")
                        .font(.system(size: appearance.fontSizePreset.pointPreviewSize, design: appearance.fontStylePreset.fontDesign))
                        .foregroundStyle(.primary)

                    Text("let session = try await client.createConversation(agentId: \"claude_code\")")
                        .font(.system(size: max(12, appearance.fontSizePreset.pointPreviewSize - 2), design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.secondary.opacity(0.10))
                        )
                }
                .padding(.vertical, 6)
            }

            Section("字号大小") {
                HStack(spacing: 8) {
                    ForEach(AppFontSizePreset.allCases) { preset in
                        let isSelected = appearance.fontSizePreset == preset
                        Button {
                            withAnimation(.snappy(duration: 0.2)) {
                                appearance.fontSizePreset = preset
                            }
                        } label: {
                            VStack(spacing: 4) {
                                Text(preset.title)
                                    .font(.subheadline.weight(.semibold))
                                Text(preset.scaleLabel)
                                    .font(.caption2.monospacedDigit())
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(isSelected ? Color.accentColor : Color.secondary.opacity(0.10))
                            )
                            .foregroundStyle(isSelected ? Color.white : Color.primary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 4)
            }

            Section("字体样式") {
                ForEach(AppFontStylePreset.allCases) { style in
                    let isSelected = appearance.fontStylePreset == style
                    Button {
                        withAnimation(.snappy(duration: 0.2)) {
                            appearance.fontStylePreset = style
                        }
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(style.title)
                                    .font(.system(.body, design: style.fontDesign).weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text(style.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if isSelected {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(Color.accentColor)
                                    .font(.title3)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .navigationTitle("字体")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - 6. 通知设置页

struct NotificationSettingsDetailView: View {
    @Environment(AppAppearanceStore.self) private var appearance

    var body: some View {
        @Bindable var bindableAppearance = appearance
        Form {
            Section("系统推送权限") {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("iOS 系统通知状态")
                            .font(.body.weight(.medium))
                        Text(appearance.systemNotificationStatusText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("请求/刷新权限") {
                        Task {
                            await appearance.requestSystemNotificationPermission()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                }
            }

            Section("事件提醒") {
                Toggle("任务完成通知", isOn: $bindableAppearance.notifyTurnCompleted)
                Toggle("权限审批与提问提醒", isOn: $bindableAppearance.notifyApprovalRequired)
                Toggle("协作空间 @ 与新消息通知", isOn: $bindableAppearance.notifyCollabMessages)
            }

            Section("声音与触感") {
                Toggle("消息提示音", isOn: $bindableAppearance.notificationSound)
                Toggle("触感震动反馈 (Haptics)", isOn: $bindableAppearance.hapticFeedback)
            }
        }
        .navigationTitle("通知")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await appearance.refreshNotificationAuthorizationStatus()
        }
    }
}

// MARK: - 7. 关于 VibeX 详情页

struct AboutVibeXDetailView: View {
    @Environment(ServerStore.self) private var servers

    var body: some View {
        List {
            Section {
                VStack(spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .fill(
                                LinearGradient(
                                    colors: [Color.accentColor, Color.indigo],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                            .frame(width: 72, height: 72)
                        Image(systemName: "sparkles")
                            .font(.system(size: 32, weight: .bold))
                            .foregroundStyle(.white)
                    }
                    Text("VibeX Companion")
                        .font(.title3.weight(.bold))
                    Text("本地优先的多智能体研发工作台 iOS 伴侣端")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }

            Section("版本与协议信息") {
                LabeledContent("iOS 客户端版本", value: "v0.4.2")
                LabeledContent("远程通讯协议", value: "Remote Protocol v1")
                if let active = servers.activeProfile {
                    LabeledContent("已连接桌面端", value: active.serverName)
                    LabeledContent("桌面端版本", value: "v\(active.serverVersion)")
                    LabeledContent("桌面端地址", value: active.origin)
                }
            }

            Section("核心能力") {
                Label("实时同步桌面端项目与会话流", systemImage: "bubble.left.and.bubble.right.fill")
                Label("四列敏捷看板与 Token 用量统计", systemImage: "square.grid.2x2.fill")
                Label("多 Bot 协作空间与动态 3D 表情头像", systemImage: "person.2.fill")
                Label("工作区文件树浏览与代码预览", systemImage: "folder.fill")
            }
        }
        .navigationTitle("关于 VibeX")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    SettingsView()
        .environment(ServerStore(defaults: UserDefaults(suiteName: "preview")!))
        .environment(AppAppearanceStore(defaults: UserDefaults(suiteName: "preview")!))
}
