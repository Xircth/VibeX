import AudioToolbox
import CompanionCore
import Foundation
import Observation
import SwiftUI
import UIKit
import UserNotifications

enum AttentionToastKind: Equatable {
    case permission(PermissionPrompt)
    case question(PendingQuestion)
    case completed
    case failed(String)

    var accentColor: Color {
        switch self {
        case .permission, .question, .failed:
            return Color(red: 0.96, green: 0.20, blue: 0.20)
        case .completed:
            return Color(red: 0.35, green: 0.72, blue: 0.06)
        }
    }

    var badgeIcon: String {
        switch self {
        case .permission, .question, .failed:
            return "exclamationmark"
        case .completed:
            return "checkmark"
        }
    }

    var durationSeconds: TimeInterval {
        switch self {
        case .permission, .question:
            return 30
        case .completed, .failed:
            return 14
        }
    }
}

struct CompanionAttentionToast: Identifiable, Equatable {
    let id: String
    let conversation: ConversationListItem
    let projectName: String
    let title: String
    let subtitle: String
    let kind: AttentionToastKind
    let createdAt: Date
}

@MainActor
@Observable
final class CompanionAttentionCenter {
    var activeToast: CompanionAttentionToast?
    var pendingNavigationConversation: ConversationListItem?
    var actionBusy = false
    var actionError: String?

    @ObservationIgnored private var eventsByConversation: [String: [RemoteEvent]] = [:]
    @ObservationIgnored private var lastSequenceByConversation: [String: Int64] = [:]
    @ObservationIgnored private var sessionsByConversation: [String: SessionState] = [:]
    @ObservationIgnored private var wasRunningByConversation: [String: Bool] = [:]
    @ObservationIgnored private var initializedConversations: Set<String> = []
    @ObservationIgnored private var handledEventIDs: Set<String> = []
    @ObservationIgnored private var didRequestNotificationPermission = false

    func requestNotificationPermissionIfNeeded() {
        guard !didRequestNotificationPermission else { return }
        didRequestNotificationPermission = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func poll(client: HostClient) async {
        requestNotificationPermissionIfNeeded()

        async let conversationsTask = try? client.call(
            "conversation_list_recent",
            args: ["sinceDays": 30, "limit": 20],
            as: [ConversationListItem].self
        )
        async let projectsTask = try? client.projects()
        let (conversationsOpt, projectsOpt) = await (conversationsTask, projectsTask)
        guard let conversations = conversationsOpt else { return }
        let projects = projectsOpt ?? []
        let groups = ProjectGroup.make(conversations: conversations, projects: projects)

        func resolveProjectName(for conv: ConversationListItem) -> String {
            if let group = groups.first(where: { g in g.conversations.contains(where: { $0.id == conv.id }) }),
               group.id != "other",
               !group.name.isEmpty {
                return group.name
            }
            return "VibeX"
        }

        let candidates = Array(conversations.prefix(6))
        for conv in candidates {
            let isFirstSnapshot = !initializedConversations.contains(conv.id)
            let previouslyRunning = wasRunningByConversation[conv.id] ?? false
            let seq = lastSequenceByConversation[conv.id] ?? 0

            guard let cache = try? await client.offlineConversation(id: conv.id, afterSequence: seq) else {
                continue
            }

            let fresh = cache.events ?? []
            var allEvents = eventsByConversation[conv.id] ?? []
            if !fresh.isEmpty {
                allEvents.append(contentsOf: fresh)
                eventsByConversation[conv.id] = allEvents
            }
            let confirmedSeq = max(seq, cache.confirmed_through)
            lastSequenceByConversation[conv.id] = confirmedSeq

            let state = SessionStateBuilder.build(from: allEvents)
            sessionsByConversation[conv.id] = state
            initializedConversations.insert(conv.id)
            wasRunningByConversation[conv.id] = state.isTurnRunning

            let project = resolveProjectName(for: conv)
            let sessionTitle = (conv.title?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap {
                $0.isEmpty ? nil : $0
            } ?? "未命名对话"

            // Auto-clear active toast if its permission/question was resolved on desktop or detail view
            if let current = activeToast, current.conversation.id == conv.id {
                switch current.kind {
                case let .permission(prompt):
                    if !state.pendingPermissions.contains(where: { $0.id == prompt.id }) {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.84)) {
                            activeToast = nil
                        }
                    }
                case let .question(question):
                    if !state.pendingQuestions.contains(where: { $0.id == question.id }) {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.84)) {
                            activeToast = nil
                        }
                    }
                case .completed, .failed:
                    break
                }
            }

            // 1. Check pending permission prompts
            if let prompt = state.pendingPermissions.first {
                let eventKey = "perm:\(conv.id):\(prompt.id)"
                if !handledEventIDs.contains(eventKey) {
                    handledEventIDs.insert(eventKey)
                    presentToast(
                        CompanionAttentionToast(
                            id: eventKey,
                            conversation: conv,
                            projectName: project,
                            title: "\(project)：需要权限批准",
                            subtitle: prompt.title,
                            kind: .permission(prompt),
                            createdAt: Date()
                        )
                    )
                }
            }

            // 2. Check pending question / plan implementation confirmation
            if let question = state.pendingQuestions.first {
                let eventKey = "question:\(conv.id):\(question.id)"
                if !handledEventIDs.contains(eventKey) {
                    handledEventIDs.insert(eventKey)
                    let subtitle = Self.questionSummary(question, fallback: sessionTitle)
                    presentToast(
                        CompanionAttentionToast(
                            id: eventKey,
                            conversation: conv,
                            projectName: project,
                            title: "\(project)：需要权限批准",
                            subtitle: subtitle,
                            kind: .question(question),
                            createdAt: Date()
                        )
                    )
                }
            }

            // 3. Check turn completion or failure (after initial snapshot)
            if !isFirstSnapshot {
                let terminalEvents = fresh.filter {
                    $0.kind == "turn_completed" || $0.kind == "turn_failed"
                }
                if let lastTerminal = terminalEvents.last {
                    let eventKey = "terminal:\(conv.id):\(lastTerminal.sequence)"
                    if !handledEventIDs.contains(eventKey) {
                        handledEventIDs.insert(eventKey)
                        if lastTerminal.kind == "turn_failed" {
                            let err = Self.extractFailureMessage(from: lastTerminal.payload)
                            presentToast(
                                CompanionAttentionToast(
                                    id: eventKey,
                                    conversation: conv,
                                    projectName: project,
                                    title: "\(project)：会话执行出错",
                                    subtitle: err,
                                    kind: .failed(err),
                                    createdAt: Date()
                                )
                            )
                        } else {
                            presentToast(
                                CompanionAttentionToast(
                                    id: eventKey,
                                    conversation: conv,
                                    projectName: project,
                                    title: "\(project)：会话已完成",
                                    subtitle: "\(sessionTitle) · \(project)",
                                    kind: .completed,
                                    createdAt: Date()
                                )
                            )
                        }
                    }
                } else if previouslyRunning && !state.isTurnRunning {
                    let eventKey = "done:\(conv.id):\(confirmedSeq)"
                    if !handledEventIDs.contains(eventKey) {
                        handledEventIDs.insert(eventKey)
                        presentToast(
                            CompanionAttentionToast(
                                id: eventKey,
                                conversation: conv,
                                projectName: project,
                                title: "\(project)：会话已完成",
                                subtitle: "\(sessionTitle) · \(project)",
                                kind: .completed,
                                createdAt: Date()
                            )
                        )
                    }
                }
            }
        }
    }

    private static func extractFailureMessage(from payload: JSONValue) -> String {
        if case let .object(dict) = payload {
            if case let .string(err)? = dict["error"], !err.isEmpty { return err }
            if case let .string(msg)? = dict["message"], !msg.isEmpty { return msg }
            if case let .object(data)? = dict["data"] {
                if case let .string(err)? = data["error"], !err.isEmpty { return err }
                if case let .string(msg)? = data["message"], !msg.isEmpty { return msg }
            }
        }
        return "任务执行异常中断"
    }

    private static func questionSummary(_ request: PendingQuestion, fallback: String) -> String {
        let forms = QuestionForm.questions(for: request)
        if let first = forms.first?.text.trimmingCharacters(in: .whitespacesAndNewlines), !first.isEmpty {
            return first
        }
        let prompt = request.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        return prompt.isEmpty ? fallback : prompt
    }

    func presentToast(_ toast: CompanionAttentionToast) {
        actionError = nil
        withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
            activeToast = toast
        }
        triggerFeedback(for: toast.kind)
        scheduleSystemNotification(for: toast)
    }

    func dismiss() {
        actionError = nil
        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
            activeToast = nil
        }
    }

    func openConversation(_ conversation: ConversationListItem) {
        dismiss()
        pendingNavigationConversation = conversation
    }

    func respondPermission(
        client: HostClient,
        conversationID: String,
        prompt: PermissionPrompt,
        option: PermissionOption?
    ) async {
        actionBusy = true
        actionError = nil
        defer { actionBusy = false }
        do {
            try await client.respondPermission(
                conversationID: conversationID,
                permissionID: prompt.id,
                optionID: option?.id
            )
            wasRunningByConversation[conversationID] = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        } catch {
            actionError = describeHostFailure(error)
        }
    }

    func respondQuestion(
        client: HostClient,
        conversationID: String,
        question: PendingQuestion,
        choice: QuestionChoice?,
        fallbackText: String? = nil
    ) async {
        actionBusy = true
        actionError = nil
        defer { actionBusy = false }
        do {
            let payload: JSONValue?
            if let choice {
                let forms = QuestionForm.questions(for: question)
                var answers: [String: QuestionAnswer] = [:]
                if let first = forms.first {
                    answers[first.id] = QuestionAnswer(selected: [choice.value], customText: "")
                }
                payload = QuestionForm.content(for: question, questions: forms, answers: answers)
            } else if let fallbackText {
                let forms = QuestionForm.questions(for: question)
                var answers: [String: QuestionAnswer] = [:]
                if let first = forms.first {
                    answers[first.id] = QuestionAnswer(selected: [], customText: fallbackText)
                }
                payload = QuestionForm.content(for: question, questions: forms, answers: answers)
            } else {
                payload = nil
            }
            try await client.respondQuestion(
                conversationID: conversationID,
                questionID: question.id,
                content: payload
            )
            wasRunningByConversation[conversationID] = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
        } catch {
            actionError = describeHostFailure(error)
        }
    }

    func sendQuickReply(
        client: HostClient,
        toast: CompanionAttentionToast,
        text: String
    ) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        actionBusy = true
        actionError = nil
        defer { actionBusy = false }
        do {
            let conv = toast.conversation
            if case let .question(question) = toast.kind {
                let forms = QuestionForm.questions(for: question)
                var answers: [String: QuestionAnswer] = [:]
                if let first = forms.first {
                    answers[first.id] = QuestionAnswer(selected: [], customText: trimmed)
                }
                let payload = QuestionForm.content(for: question, questions: forms, answers: answers)
                try await client.respondQuestion(
                    conversationID: conv.id,
                    questionID: question.id,
                    content: payload
                )
            } else {
                if case let .permission(prompt) = toast.kind {
                    let allowOption = prompt.options.first { $0.kind.hasPrefix("allow") } ?? prompt.options.first
                    try? await client.respondPermission(
                        conversationID: conv.id,
                        permissionID: prompt.id,
                        optionID: allowOption?.id
                    )
                }
                guard let agentID = conv.agent_id else {
                    actionError = "此对话未绑定 Agent"
                    return false
                }
                try await client.sendMessage(
                    conversationID: conv.id,
                    workspaceID: conv.workspace_id,
                    agentID: agentID,
                    text: trimmed
                )
            }
            wasRunningByConversation[conv.id] = true
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            dismiss()
            return true
        } catch {
            actionError = describeHostFailure(error)
            return false
        }
    }

    private func triggerFeedback(for kind: AttentionToastKind) {
        let generator = UINotificationFeedbackGenerator()
        switch kind {
        case .permission, .question:
            generator.notificationOccurred(.warning)
            AudioServicesPlaySystemSound(1007)
        case .completed:
            generator.notificationOccurred(.success)
            AudioServicesPlaySystemSound(1001)
        case .failed:
            generator.notificationOccurred(.error)
            AudioServicesPlaySystemSound(1005)
        }
    }

    private func scheduleSystemNotification(for toast: CompanionAttentionToast) {
        let content = UNMutableNotificationContent()
        content.title = toast.title
        content.body = toast.subtitle
        content.sound = .default
        content.userInfo = ["conversationId": toast.conversation.id]

        let request = UNNotificationRequest(
            identifier: "vibex.attention.\(toast.id)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}

struct CompanionToastOverlay: View {
    let client: HostClient
    @Bindable var center: CompanionAttentionCenter
    let onOpenConversation: (ConversationListItem) -> Void

    @State private var isReplying = false
    @State private var replyText = ""
    @State private var remainingFraction: CGFloat = 1.0
    @FocusState private var replyFocused: Bool

    var body: some View {
        if let toast = center.activeToast {
            VStack(spacing: 0) {
                toastCard(toast)
                    .padding(.horizontal, 12)
                    .padding(.top, 6)
                    .transition(.move(edge: .top).combined(with: .opacity))
                Spacer(minLength: 0)
            }
            .onChange(of: toast.id) { _, _ in
                isReplying = false
                replyText = ""
                remainingFraction = 1.0
            }
            .task(id: "\(toast.id)-\(isReplying)") {
                guard !isReplying else { return }
                let total = toast.kind.durationSeconds
                let interval = 0.1
                let steps = max(1, Int(total / interval))
                for step in 0...steps {
                    if Task.isCancelled || isReplying { return }
                    remainingFraction = max(0, 1.0 - CGFloat(step) / CGFloat(steps))
                    try? await Task.sleep(for: .milliseconds(100))
                }
                if !Task.isCancelled && !isReplying && center.activeToast?.id == toast.id {
                    center.dismiss()
                }
            }
        }
    }

    @ViewBuilder
    private func toastCard(_ toast: CompanionAttentionToast) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            // Header row matching DesktopToastWindow.tsx
            HStack(alignment: .top, spacing: 12) {
                ZStack(alignment: .bottomTrailing) {
                    Circle()
                        .fill(Color(.tertiarySystemFill))
                        .frame(width: 40, height: 40)
                        .overlay {
                            Image("vibex_logo_lite")
                                .resizable()
                                .interpolation(.high)
                                .scaledToFit()
                                .frame(width: 24, height: 24)
                        }

                    Circle()
                        .fill(toast.kind.accentColor)
                        .frame(width: 17, height: 17)
                        .overlay {
                            Image(systemName: toast.kind.badgeIcon)
                                .font(.system(size: 9, weight: .black))
                                .foregroundStyle(.white)
                        }
                        .overlay {
                            Circle().stroke(Color(.secondarySystemGroupedBackground), lineWidth: 2)
                        }
                        .offset(x: 2, y: 2)
                }

                VStack(alignment: .leading, spacing: 3) {
                    Text(toast.title)
                        .font(.system(size: 14.5, weight: .semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(toast.subtitle)
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Button {
                    center.dismiss()
                } label: {
                    ZStack {
                        Circle()
                            .stroke(toast.kind.accentColor.opacity(0.18), lineWidth: 2)
                            .frame(width: 26, height: 26)
                        Circle()
                            .trim(from: 0, to: remainingFraction)
                            .stroke(
                                toast.kind.accentColor,
                                style: StrokeStyle(lineWidth: 2, lineCap: .round)
                            )
                            .rotationEffect(.degrees(-90))
                            .frame(width: 26, height: 26)
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭提醒")
            }

            // Direct one-tap approval buttons for Permission or Question
            switch toast.kind {
            case let .permission(prompt):
                permissionActionsRow(toast: toast, prompt: prompt)
            case let .question(question):
                questionActionsRow(toast: toast, question: question)
            case .completed, .failed:
                EmptyView()
            }

            if let err = center.actionError {
                Text(err)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

            // Expandable inline quick reply or bottom action bar
            if isReplying {
                HStack(spacing: 8) {
                    TextField("输入回复内容并发送…", text: $replyText)
                        .font(.system(size: 13.5))
                        .textFieldStyle(.plain)
                        .focused($replyFocused)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            Capsule(style: .continuous)
                                .fill(Color(.tertiarySystemFill))
                        )
                        .onSubmit {
                            submitReply(toast)
                        }

                    Button {
                        isReplying = false
                        replyFocused = false
                    } label: {
                        Text("取消")
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 7)
                    }
                    .buttonStyle(.plain)

                    Button {
                        submitReply(toast)
                    } label: {
                        Text("发送")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 7)
                            .background(Capsule(style: .continuous).fill(Color.primary))
                    }
                    .buttonStyle(.plain)
                    .disabled(replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || center.actionBusy)
                }
            } else {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)

                    if case .completed = toast.kind {
                        Button {
                            UINotificationFeedbackGenerator().notificationOccurred(.success)
                            center.dismiss()
                        } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(toast.kind.accentColor)
                                Text("确认完成")
                                    .font(.system(size: 12.5, weight: .semibold))
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(toast.kind.accentColor.opacity(0.14))
                            )
                            .foregroundStyle(.primary)
                        }
                        .buttonStyle(.plain)
                    }

                    Button {
                        withAnimation(.smooth(duration: 0.18)) {
                            isReplying = true
                        }
                        replyFocused = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "bubble.left")
                                .font(.system(size: 11.5, weight: .semibold))
                            Text("快捷回复")
                                .font(.system(size: 12.5, weight: .medium))
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(
                            Capsule(style: .continuous)
                                .fill(Color(.tertiarySystemFill))
                        )
                        .overlay(
                            Capsule(style: .continuous)
                                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
                        )
                        .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)

                    Button {
                        onOpenConversation(toast.conversation)
                    } label: {
                        Text("打开会话")
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(Color(.systemBackground))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(Color.primary)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(.regularMaterial)
                .background(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .fill(Color(.secondarySystemGroupedBackground).opacity(0.92))
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(toast.kind.accentColor.opacity(0.28), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.14), radius: 18, x: 0, y: 8)
    }

    @ViewBuilder
    private func permissionActionsRow(toast: CompanionAttentionToast, prompt: PermissionPrompt) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(prompt.options) { option in
                    let allow = option.kind.hasPrefix("allow")
                    Button {
                        Task {
                            await center.respondPermission(
                                client: client,
                                conversationID: toast.conversation.id,
                                prompt: prompt,
                                option: option
                            )
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: allow ? "checkmark.shield.fill" : "xmark.circle")
                                .font(.system(size: 11.5, weight: .semibold))
                            Text(option.label)
                                .font(.system(size: 12.5, weight: .semibold))
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6.5)
                        .background(
                            Capsule(style: .continuous)
                                .fill(allow ? Color.accentColor : Color(.tertiarySystemFill))
                        )
                        .foregroundStyle(allow ? Color.white : Color.primary)
                    }
                    .buttonStyle(.plain)
                    .disabled(center.actionBusy)
                }
            }
        }
    }

    @ViewBuilder
    private func questionActionsRow(toast: CompanionAttentionToast, question: PendingQuestion) -> some View {
        let choices = Self.extractQuestionChoices(question)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                if choices.isEmpty {
                    Button {
                        Task {
                            await center.respondQuestion(
                                client: client,
                                conversationID: toast.conversation.id,
                                question: question,
                                choice: nil,
                                fallbackText: "Yes"
                            )
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 11.5, weight: .semibold))
                            Text("批准执行")
                                .font(.system(size: 12.5, weight: .semibold))
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6.5)
                        .background(Capsule(style: .continuous).fill(Color.accentColor))
                        .foregroundStyle(Color.white)
                    }
                    .buttonStyle(.plain)
                    .disabled(center.actionBusy)
                } else {
                    ForEach(choices.indices, id: \.self) { index in
                        let choice = choices[index]
                        let isPrimary = index == 0
                        Button {
                            Task {
                                await center.respondQuestion(
                                    client: client,
                                    conversationID: toast.conversation.id,
                                    question: question,
                                    choice: choice
                                )
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: isPrimary ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 11.5, weight: .semibold))
                                Text(choice.label)
                                    .font(.system(size: 12.5, weight: .semibold))
                                    .lineLimit(1)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6.5)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(isPrimary ? Color.accentColor : Color(.tertiarySystemFill))
                            )
                            .foregroundStyle(isPrimary ? Color.white : Color.primary)
                        }
                        .buttonStyle(.plain)
                        .disabled(center.actionBusy)
                    }
                }

                Button {
                    Task {
                        await center.respondQuestion(
                            client: client,
                            conversationID: toast.conversation.id,
                            question: question,
                            choice: nil
                        )
                    }
                } label: {
                    Text("拒绝")
                        .font(.system(size: 12.5, weight: .medium))
                        .padding(.horizontal, 11)
                        .padding(.vertical, 6.5)
                        .background(
                            Capsule(style: .continuous)
                                .fill(Color.red.opacity(0.12))
                        )
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
                .disabled(center.actionBusy)
            }
        }
    }

    private static func extractQuestionChoices(_ request: PendingQuestion) -> [QuestionChoice] {
        let forms = QuestionForm.questions(for: request)
        if let first = forms.first, !first.choices.isEmpty {
            return Array(first.choices.prefix(3))
        }
        return []
    }

    private func submitReply(_ toast: CompanionAttentionToast) {
        let text = replyText
        Task {
            if await center.sendQuickReply(client: client, toast: toast, text: text) {
                replyText = ""
                isReplying = false
            }
        }
    }
}
