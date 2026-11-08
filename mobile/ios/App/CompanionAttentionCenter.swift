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
final class CompanionAttentionCenter: NSObject, UNUserNotificationCenterDelegate {
    var activeToast: CompanionAttentionToast?
    var pendingNavigationConversation: ConversationListItem?
    var actionBusy = false
    var actionError: String?

    @ObservationIgnored private var eventsByConversation: [String: [RemoteEvent]] = [:]
    @ObservationIgnored private var lastSequenceByConversation: [String: Int64] = [:]
    @ObservationIgnored private var sessionsByConversation: [String: SessionState] = [:]
    @ObservationIgnored private var conversationsByID: [String: ConversationListItem] = [:]
    @ObservationIgnored private var wasRunningByConversation: [String: Bool] = [:]
    @ObservationIgnored private var initializedConversations: Set<String> = []
    @ObservationIgnored private var handledEventIDs: Set<String> = []
    @ObservationIgnored private var didRequestNotificationPermission = false
    @ObservationIgnored private var currentClient: HostClient?
    @ObservationIgnored private var backgroundTaskID: UIBackgroundTaskIdentifier = .invalid
    @ObservationIgnored private var lifecycleObservers: [NSObjectProtocol] = []

    override init() {
        super.init()
        setupNotificationCategoriesAndDelegate()
        setupBackgroundKeepAliveObservers()
    }

    private func setupNotificationCategoriesAndDelegate() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let allowOnce = UNNotificationAction(
            identifier: "VIBEX_ALLOW_ONCE",
            title: "允许本次",
            options: [.authenticationRequired]
        )
        let allowSession = UNNotificationAction(
            identifier: "VIBEX_ALLOW_SESSION",
            title: "本会话允许",
            options: [.authenticationRequired]
        )
        let rejectPerm = UNNotificationAction(
            identifier: "VIBEX_REJECT_PERM",
            title: "拒绝",
            options: [.destructive]
        )
        let permCategory = UNNotificationCategory(
            identifier: "VIBEX_PERMISSION_CATEGORY",
            actions: [allowOnce, allowSession, rejectPerm],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )

        let confirmQuestion = UNNotificationAction(
            identifier: "VIBEX_CONFIRM_QUESTION",
            title: "批准执行",
            options: [.authenticationRequired]
        )
        let replyQuestion = UNTextInputNotificationAction(
            identifier: "VIBEX_REPLY_QUESTION",
            title: "快捷回复…",
            options: [.authenticationRequired],
            textInputButtonTitle: "发送",
            textInputPlaceholder: "输入给 Agent 的回复…"
        )
        let rejectQuestion = UNNotificationAction(
            identifier: "VIBEX_REJECT_QUESTION",
            title: "拒绝",
            options: [.destructive]
        )
        let questionCategory = UNNotificationCategory(
            identifier: "VIBEX_QUESTION_CATEGORY",
            actions: [confirmQuestion, replyQuestion, rejectQuestion],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )

        let openSession = UNNotificationAction(
            identifier: "VIBEX_OPEN_SESSION",
            title: "打开对话",
            options: [.foreground]
        )
        let completedCategory = UNNotificationCategory(
            identifier: "VIBEX_COMPLETED_CATEGORY",
            actions: [openSession],
            intentIdentifiers: [],
            options: []
        )

        center.setNotificationCategories([permCategory, questionCategory, completedCategory])
    }

    private func setupBackgroundKeepAliveObservers() {
        let bgObs = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.beginBackgroundPollingGuard()
            }
        }
        let fgObs = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.endBackgroundPollingGuard()
            }
        }
        lifecycleObservers = [bgObs, fgObs]
    }

    private func beginBackgroundPollingGuard() {
        guard backgroundTaskID == .invalid else { return }
        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "VibeXBackgroundAttentionMonitor") { [weak self] in
            Task { @MainActor in
                self?.endBackgroundPollingGuard()
            }
        }
    }

    private func endBackgroundPollingGuard() {
        guard backgroundTaskID != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTaskID)
        backgroundTaskID = .invalid
    }

    func requestNotificationPermissionIfNeeded() {
        guard !didRequestNotificationPermission else { return }
        didRequestNotificationPermission = true
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound, .badge]
        ) { _, _ in }
    }

    func poll(client: HostClient) async {
        currentClient = client
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
        var syncedLiveActivityInThisPoll = false

        for conv in candidates {
            conversationsByID[conv.id] = conv
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

            let hasPendingApproval = !state.pendingPermissions.isEmpty || !state.pendingQuestions.isEmpty
            if !syncedLiveActivityInThisPoll && (state.isTurnRunning || hasPendingApproval) {
                syncedLiveActivityInThisPoll = true
                let approvalSummary: String? = if let perm = state.pendingPermissions.first {
                    perm.title
                } else if let q = state.pendingQuestions.first {
                    Self.questionSummary(q, fallback: "等待确认执行方案")
                } else {
                    nil
                }
                let recentToolKind = Self.inferLatestToolKind(from: allEvents)
                let stepCount = max(1, allEvents.count / 6)
                TaskActivityController.shared.sync(
                    conversationID: conv.id,
                    projectName: project,
                    title: sessionTitle,
                    tasks: [],
                    latestToolName: recentToolKind,
                    stepCount: stepCount,
                    hasThinking: true,
                    hasTextOutput: false,
                    hasPendingApproval: hasPendingApproval,
                    approvalSummary: approvalSummary,
                    running: state.isTurnRunning
                )
            }

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
                            TaskActivityController.shared.finish(failedMessage: err)
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
                            TaskActivityController.shared.finish()
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
                        TaskActivityController.shared.finish()
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

    private static func inferLatestToolKind(from events: [RemoteEvent]) -> String? {
        for event in events.suffix(12).reversed() {
            if case let .object(dict) = event.payload {
                if case let .string(tool)? = dict["tool_name"] ?? dict["name"] ?? dict["title"] {
                    return tool
                }
                if case let .object(data)? = dict["data"],
                   case let .string(tool)? = data["tool_name"] ?? data["name"] ?? data["title"]
                {
                    return tool
                }
            }
        }
        return nil
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
        content.interruptionLevel = .timeSensitive
        content.relevanceScore = 1.0

        var info: [String: String] = [
            "conversationId": toast.conversation.id,
            "projectName": toast.projectName,
        ]
        switch toast.kind {
        case let .permission(prompt):
            content.categoryIdentifier = "VIBEX_PERMISSION_CATEGORY"
            info["permissionId"] = prompt.id
            if let allowOnce = prompt.resolveAllowOption(for: .once)?.id {
                info["allowOnceOptionId"] = allowOnce
            }
            if let allowSession = prompt.resolveAllowOption(for: .session)?.id {
                info["allowSessionOptionId"] = allowSession
            }
            if let reject = prompt.rejectOption?.id {
                info["rejectOptionId"] = reject
            }
        case let .question(question):
            content.categoryIdentifier = "VIBEX_QUESTION_CATEGORY"
            info["questionId"] = question.id
        case .completed, .failed:
            content.categoryIdentifier = "VIBEX_COMPLETED_CATEGORY"
        }
        content.userInfo = info

        let request = UNNotificationRequest(
            identifier: "vibex.attention.\(toast.id)",
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // When app is in foreground we already show CompanionToastOverlay; only play sound/list
        completionHandler([.list])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let convID = userInfo["conversationId"] as? String
        let permID = userInfo["permissionId"] as? String
        let allowOnceID = userInfo["allowOnceOptionId"] as? String
        let allowSessionID = userInfo["allowSessionOptionId"] as? String
        let rejectID = userInfo["rejectOptionId"] as? String
        let questionID = userInfo["questionId"] as? String
        let actionID = response.actionIdentifier
        let textReply = (response as? UNTextInputNotificationResponse)?.userText

        Task { @MainActor in
            guard let convID else {
                completionHandler()
                return
            }
            if let client = self.currentClient {
                switch actionID {
                case "VIBEX_ALLOW_ONCE":
                    if let permID {
                        try? await client.respondPermission(
                            conversationID: convID,
                            permissionID: permID,
                            optionID: allowOnceID
                        )
                        self.dismiss()
                    }
                case "VIBEX_ALLOW_SESSION":
                    if let permID {
                        try? await client.respondPermission(
                            conversationID: convID,
                            permissionID: permID,
                            optionID: allowSessionID ?? allowOnceID
                        )
                        self.dismiss()
                    }
                case "VIBEX_REJECT_PERM":
                    if let permID {
                        try? await client.respondPermission(
                            conversationID: convID,
                            permissionID: permID,
                            optionID: rejectID
                        )
                        self.dismiss()
                    }
                case "VIBEX_CONFIRM_QUESTION":
                    if let questionID,
                       let state = self.sessionsByConversation[convID],
                       let q = state.pendingQuestions.first(where: { $0.id == questionID })
                    {
                        let forms = QuestionForm.questions(for: q)
                        let firstChoice = forms.first?.choices.first
                        await self.respondQuestion(
                            client: client,
                            conversationID: convID,
                            question: q,
                            choice: firstChoice,
                            fallbackText: firstChoice == nil ? "Yes" : nil
                        )
                    }
                case "VIBEX_REPLY_QUESTION":
                    if let questionID,
                       let textReply,
                       !textReply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                       let state = self.sessionsByConversation[convID],
                       let q = state.pendingQuestions.first(where: { $0.id == questionID })
                    {
                        await self.respondQuestion(
                            client: client,
                            conversationID: convID,
                            question: q,
                            choice: nil,
                            fallbackText: textReply
                        )
                    }
                case "VIBEX_REJECT_QUESTION":
                    if let questionID {
                        try? await client.respondQuestion(
                            conversationID: convID,
                            questionID: questionID,
                            content: nil
                        )
                        self.dismiss()
                    }
                default:
                    if let conv = self.conversationsByID[convID] {
                        self.openConversation(conv)
                    }
                }
            }
            completionHandler()
        }
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
