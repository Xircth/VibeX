import ActivityKit
import CompanionCore
import Foundation
import UIKit

/// Mirrors the Agent's task list into a Live Activity: Dynamic Island where the iPhone has one,
/// Lock Screen everywhere else. iOS only lets the app change it while the app is running, so it
/// follows the plan while the app is open and keeps its last state once the app is suspended.
@MainActor
final class TaskActivityController {
    private var activity: Activity<TaskActivityAttributes>?
    private var lastState: TaskActivityAttributes.ContentState?

    private var runStart: Date?
    private var lingerTask: Task<Void, Never>?
    private var lastPush = Date.distantPast
    private var background = UIBackgroundTaskIdentifier.invalid
    private var observer: NSObjectProtocol?

    /// How long the activity stays fresh without another push; past it the widget says syncing paused.
    private static let freshness: TimeInterval = 45

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

    /// iOS suspends the app shortly after it leaves the foreground; ask for the extra time it grants
    /// so the activity keeps following a run that is still going.
    private func holdBackgroundTime() {
        guard activity != nil, background == .invalid else { return }
        let app = UIApplication.shared
        background = app.beginBackgroundTask { [weak self] in self?.releaseBackgroundTime() }
    }

    private func releaseBackgroundTime() {
        guard background != .invalid else { return }
        UIApplication.shared.endBackgroundTask(background)
        background = .invalid
    }

    /// `tasks` is the Agent's published plan; without an unfinished plan the activity follows the
    /// run itself and shows `step` (the latest tool call) with an elapsed timer.
    func sync(title: String, tasks: [PlanTask], step: String?, running: Bool) {
        let completed = tasks.filter { $0.status == .completed }.count
        let planActive = !tasks.isEmpty && completed < tasks.count
        guard running || planActive else {
            finish()
            return
        }
        lingerTask?.cancel()
        lingerTask = nil
        if runStart == nil { runStart = Date() }
        let current = tasks.first { $0.status == .running } ?? tasks.first { $0.status == .pending }
        let state = TaskActivityAttributes.ContentState(
            completed: planActive ? completed : 0,
            total: planActive ? tasks.count : 0,
            currentTask: planActive ? (current?.label ?? "") : (step ?? "处理中"),
            isRunning: running,
            startedAt: runStart ?? Date()
        )
        guard state != lastState || Date().timeIntervalSince(lastPush) > Self.freshness / 3 else { return }
        lastState = state
        lastPush = Date()
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(Self.freshness))
        if let activity {
            Task { await activity.update(content) }
        } else {
            start(title: title, state: state)
        }
    }

    /// The Dynamic Island only shows live activities, so the finished state is pushed while the
    /// activity is still live and held for a moment before it is ended.
    private func finish() {
        runStart = nil
        guard activity != nil, lingerTask == nil, var done = lastState, done.isRunning else { return }
        done.isRunning = false
        lastState = done
        guard let current = activity else { return }
        lingerTask = Task { [weak self] in
            let app = UIApplication.shared
            var background = UIBackgroundTaskIdentifier.invalid
            background = app.beginBackgroundTask { app.endBackgroundTask(background) }
            await current.update(ActivityContent(state: done, staleDate: nil))
            try? await Task.sleep(for: .seconds(20))
            if !Task.isCancelled { self?.end(final: done, after: 30) }
            app.endBackgroundTask(background)
        }
    }

    func stop() {
        lingerTask?.cancel()
        lingerTask = nil
        end(after: 0)
    }

    private func start(title: String, state: TaskActivityAttributes.ContentState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        activity = try? Activity.request(
            attributes: TaskActivityAttributes(conversationTitle: title),
            content: ActivityContent(state: state, staleDate: Date().addingTimeInterval(Self.freshness))
        )
    }

    private func end(final: TaskActivityAttributes.ContentState? = nil, after seconds: TimeInterval) {
        guard let current = activity else { return }
        activity = nil
        lastState = nil
        runStart = nil
        let content = final.map { ActivityContent(state: $0, staleDate: nil) }
        Task {
            await current.end(
                content,
                dismissalPolicy: seconds > 0 ? .after(Date().addingTimeInterval(seconds)) : .immediate
            )
        }
    }
}
