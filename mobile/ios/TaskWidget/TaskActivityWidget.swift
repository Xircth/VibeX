import ActivityKit
import SwiftUI
import WidgetKit

@main
struct VibeXTaskWidgetBundle: WidgetBundle {
    var body: some Widget { TaskActivityWidget() }
}

struct TaskActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TaskActivityAttributes.self) { context in
            LockScreenTaskView(title: context.attributes.conversationTitle, state: context.state, stale: context.isStale)
                .padding(16)
                .activityBackgroundTint(Color(.systemBackground).opacity(0.85))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    TaskRing(state: context.state, size: 30).padding(.leading, 6).padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ProgressLabel(state: context.state, size: 17).padding(.trailing, 6).padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(context.attributes.conversationTitle)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Text(context.isStale && context.state.isRunning ? staleNote : context.state.currentTask)
                            .font(.system(size: 15, weight: .medium))
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if context.state.total > 0 { TaskProgressBar(state: context.state).padding(.top, 2) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .padding(.top, 6)
                }
            } compactLeading: {
                TaskRing(state: context.state, size: 18)
            } compactTrailing: {
                ProgressLabel(state: context.state, size: 13)
            } minimal: {
                TaskRing(state: context.state, size: 18)
            }
        }
    }
}

private let staleNote = "已暂停同步，打开 App 查看最新进度"

private struct LockScreenTaskView: View {
    let title: String
    let state: TaskActivityAttributes.ContentState
    let stale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                TaskRing(state: state, size: 24)
                Text(title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                Spacer()
                ProgressLabel(state: state, size: 14).foregroundStyle(.secondary)
            }
            Text(stale && state.isRunning ? staleNote : state.currentTask)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .lineLimit(2)
            if state.total > 0 { TaskProgressBar(state: state) }
        }
    }
}

/// `completed/total` for a task list, otherwise the elapsed time of the run.
private struct ProgressLabel: View {
    let state: TaskActivityAttributes.ContentState
    let size: CGFloat

    var body: some View {
        Group {
            if state.total > 0 {
                Text("\(state.completed)/\(state.total)")
            } else if state.isRunning {
                Text(state.startedAt, style: .timer).frame(maxWidth: 52, alignment: .trailing)
            } else {
                Text("完成")
            }
        }
        .font(.system(size: size, weight: .semibold))
        .monospacedDigit()
    }
}

private struct TaskRing: View {
    let state: TaskActivityAttributes.ContentState
    let size: CGFloat

    private var fraction: Double {
        state.total == 0 ? 0 : Double(state.completed) / Double(state.total)
    }

    var body: some View {
        if state.total == 0 && state.isRunning {
            ProgressView().frame(width: size, height: size)
        } else {
            ring
        }
    }

    private var ring: some View {
        ZStack {
            Circle().stroke(Color.primary.opacity(0.18), lineWidth: 2.5)
            Circle()
                .trim(from: 0, to: max(0.04, fraction))
                .stroke(finished ? Color.green : Color.primary, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            if finished {
                Image(systemName: "checkmark").font(.system(size: size * 0.4, weight: .bold)).foregroundStyle(.green)
            }
        }
        .frame(width: size, height: size)
    }

    private var finished: Bool { !state.isRunning && state.completed >= state.total }
}

private struct TaskProgressBar: View {
    let state: TaskActivityAttributes.ContentState

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.15))
                Capsule()
                    .fill(Color.primary)
                    .frame(width: proxy.size.width * (state.total == 0 ? 0 : Double(state.completed) / Double(state.total)))
            }
        }
        .frame(height: 4)
    }
}
