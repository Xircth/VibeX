import ActivityKit
import CompanionCore
import Foundation
import UIKit

/// Global controller that mirrors the active VibeX Agent session into iOS Live Activities:
/// Dynamic Island on supporting iPhones and Lock Screen / Notification Center banner everywhere else.
/// Converts low-level Agent steps into clean, code-free activity phases ("代码开发中", "思考规划中",
/// "等待你确认", etc.) and drives a smooth circular progress ring (`0.0 ... 1.0`).
@MainActor
final class TaskActivityController {
    static let shared = TaskActivityController()

    private var activity: Activity<TaskActivityAttributes>?
    private var activeConversationID: String?
    private var lastState: TaskActivityAttributes.ContentState?

    private var runStart: Date?
    private var peakProgress: Double = 0.12
    private var lingerTask: Task<Void, Never>?
    private var lastPush = Date.distantPast
    private var background = UIBackgroundTaskIdentifier.invalid
    private var observer: NSObjectProtocol?

    /// How long the activity stays fresh without another push.
    private static let freshness: TimeInterval = 90

    init() {
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.holdBackgroundTime() }
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    private func holdBackgroundTime() {
        guard activity != nil, background == .invalid else { return }
        let app = UIApplication.shared
        background = app.beginBackgroundTask(withName: "VibeXLiveActivityKeepAlive") { [weak self] in
            Task { @MainActor in
                self?.releaseBackgroundTime()
            }
        }
    }

    private func releaseBackgroundTime() {
        guard background != .invalid else { return }
        UIApplication.shared.endBackgroundTask(background)
        background = .invalid
    }

    /// Synchronizes the Dynamic Island & Lock Screen Live Activity from either `ConversationModel`
    /// or the global `CompanionAttentionCenter` background poller.
    func sync(
        conversationID: String = "default",
        projectName: String = "VibeX",
        title: String,
        tasks: [PlanTask],
        latestToolName: String? = nil,
        stepCount: Int = 0,
        hasThinking: Bool = false,
        hasTextOutput: Bool = false,
        hasPendingApproval: Bool = false,
        approvalSummary: String? = nil,
        running: Bool
    ) {
        let completed = tasks.filter { $0.status == .completed }.count
        let planActive = !tasks.isEmpty && completed < tasks.count
        let effectivelyActive = running || planActive || hasPendingApproval

        guard effectivelyActive else {
            if activeConversationID == nil || activeConversationID == conversationID {
                finish()
            }
            return
        }

        lingerTask?.cancel()
        lingerTask = nil

        if activeConversationID != conversationID {
            activeConversationID = conversationID
            runStart = Date()
            peakProgress = 0.12
        } else if runStart == nil {
            runStart = Date()
            peakProgress = 0.12
        }

        let resolved = Self.resolveHumanStage(
            tasks: tasks,
            completed: completed,
            planActive: planActive,
            latestToolName: latestToolName,
            stepCount: stepCount,
            hasThinking: hasThinking,
            hasTextOutput: hasTextOutput,
            hasPendingApproval: hasPendingApproval,
            approvalSummary: approvalSummary
        )

        if resolved.progress > peakProgress {
            peakProgress = resolved.progress
        }
        let smoothProgress = planActive ? resolved.progress : max(peakProgress, resolved.progress)

        let state = TaskActivityAttributes.ContentState(
            phase: resolved.phase,
            stageTitle: resolved.stageTitle,
            stageSubtitle: resolved.stageSubtitle,
            progress: min(max(smoothProgress, 0.10), 0.96),
            completed: planActive ? completed : 0,
            total: planActive ? tasks.count : 0,
            stepCount: max(stepCount, completed),
            isRunning: running || hasPendingApproval,
            startedAt: runStart ?? Date()
        )

        guard state != lastState || Date().timeIntervalSince(lastPush) > Self.freshness / 3 else { return }
        lastState = state
        lastPush = Date()
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(Self.freshness))

        if let activity {
            Task { await activity.update(content) }
        } else {
            // Reattach to an existing system Live Activity if one is already running
            if let existing = Activity<TaskActivityAttributes>.activities.first {
                activity = existing
                Task { await existing.update(content) }
            } else {
                start(projectName: projectName, title: title, state: state)
            }
        }
    }

    private static func resolveHumanStage(
        tasks: [PlanTask],
        completed: Int,
        planActive: Bool,
        latestToolName: String?,
        stepCount: Int,
        hasThinking: Bool,
        hasTextOutput: Bool,
        hasPendingApproval: Bool,
        approvalSummary: String?
    ) -> (phase: VibeXActivityPhase, stageTitle: String, stageSubtitle: String, progress: Double) {
        let baseProgress: Double
        if planActive && !tasks.isEmpty {
            let raw = Double(completed) / Double(tasks.count)
            baseProgress = min(max(raw, 0.15), 0.94)
        } else {
            // Smooth asymptotic curve based on stepCount: 0 -> 0.18, 2 -> 0.42, 5 -> 0.66, 10 -> 0.82
            let stepFactor = 1.0 - exp(-Double(max(1, stepCount)) * 0.22)
            baseProgress = min(0.16 + stepFactor * 0.74, 0.92)
        }

        if hasPendingApproval {
            return (
                phase: .waitingInput,
                stageTitle: "等待你确认",
                stageSubtitle: approvalSummary ?? "需要批准操作权限或确认执行方案",
                progress: max(baseProgress, 0.55)
            )
        }

        if let tool = latestToolName?.lowercased(), !tool.isEmpty {
            if tool.contains("edit") || tool.contains("write") || tool.contains("patch")
                || tool.contains("create") || tool.contains("replace")
            {
                return (
                    phase: .developing,
                    stageTitle: "代码开发中",
                    stageSubtitle: "正在编写与修改项目模块",
                    progress: max(baseProgress, 0.58)
                )
            }
            if tool.contains("bash") || tool.contains("exec") || tool.contains("run")
                || tool.contains("shell") || tool.contains("terminal") || tool.contains("test")
                || tool.contains("check") || tool.contains("build")
            {
                return (
                    phase: .verifying,
                    stageTitle: "调试验证中",
                    stageSubtitle: "正在执行构建或测试验证",
                    progress: max(baseProgress, 0.74)
                )
            }
            if tool.contains("read") || tool.contains("search") || tool.contains("grep")
                || tool.contains("find") || tool.contains("list") || tool.contains("view")
                || tool.contains("tree") || tool.contains("glob")
            {
                return (
                    phase: .exploring,
                    stageTitle: "查阅项目中",
                    stageSubtitle: "正在检索项目结构与依赖关系",
                    progress: max(baseProgress, 0.36)
                )
            }
            return (
                phase: .developing,
                stageTitle: "代码开发中",
                stageSubtitle: "正在调用研发工具推进任务",
                progress: max(baseProgress, 0.50)
            )
        }

        if hasTextOutput {
            return (
                phase: .summarizing,
                stageTitle: "整理回复中",
                stageSubtitle: "正在生成总结与解决方案",
                progress: max(baseProgress, 0.88)
            )
        }

        if hasThinking {
            return (
                phase: .thinking,
                stageTitle: "思考规划中",
                stageSubtitle: "正在分析需求与梳理实现路径",
                progress: max(baseProgress, 0.24)
            )
        }

        return (
            phase: .thinking,
            stageTitle: "准备执行中",
            stageSubtitle: "VibeX 正在同步工作区状态",
            progress: 0.16
        )
    }

    /// Pushes the 100% completed state into the Dynamic Island / Lock Screen before dismissing.
    func finish(failedMessage: String? = nil) {
        runStart = nil
        peakProgress = 0.12
        guard activity != nil, lingerTask == nil, var done = lastState, done.isRunning else { return }
        done.isRunning = false
        if let failedMessage {
            done.phase = .failed
            done.stageTitle = "执行中断"
            done.stageSubtitle = failedMessage
        } else {
            done.phase = .completed
            done.stageTitle = "任务已完成"
            done.stageSubtitle = "全部开发步骤已执行完毕，点击查看结果"
            done.progress = 1.0
            if done.total > 0 {
                done.completed = done.total
            }
        }
        lastState = done
        guard let current = activity else { return }
        lingerTask = Task { [weak self] in
            let app = UIApplication.shared
            var bg = UIBackgroundTaskIdentifier.invalid
            bg = app.beginBackgroundTask { app.endBackgroundTask(bg) }
            await current.update(ActivityContent(state: done, staleDate: nil))
            try? await Task.sleep(for: .seconds(25))
            if !Task.isCancelled { self?.end(final: done, after: 45) }
            app.endBackgroundTask(bg)
        }
    }

    func stop() {
        lingerTask?.cancel()
        lingerTask = nil
        end(after: 0)
    }

    private func start(projectName: String, title: String, state: TaskActivityAttributes.ContentState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        activity = try? Activity.request(
            attributes: TaskActivityAttributes(
                projectName: projectName,
                conversationTitle: title
            ),
            content: ActivityContent(state: state, staleDate: Date().addingTimeInterval(Self.freshness))
        )
    }

    private func end(final: TaskActivityAttributes.ContentState? = nil, after seconds: TimeInterval) {
        guard let current = activity else { return }
        activity = nil
        activeConversationID = nil
        lastState = nil
        runStart = nil
        peakProgress = 0.12
        let content = final.map { ActivityContent(state: $0, staleDate: nil) }
        Task {
            await current.end(
                content,
                dismissalPolicy: seconds > 0 ? .after(Date().addingTimeInterval(seconds)) : .immediate
            )
        }
    }
}
