import CompanionCore
import SwiftUI

private struct SpinnerRing: View {
    let label: String
    var active = false
    @State private var spinning = false

    var body: some View {
        ZStack {
            Circle().stroke(Color.primary.opacity(0.15), lineWidth: 2)
            if active {
                Circle()
                    .trim(from: 0, to: 0.28)
                    .stroke(Color.secondary, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(spinning ? 360 : 0))
                    .animation(.linear(duration: 1.1).repeatForever(autoreverses: false), value: spinning)
            }
            Text(label).font(.system(size: 10.5, weight: .semibold)).monospacedDigit()
        }
        .frame(width: 24, height: 24)
        .onAppear { spinning = true }
    }
}

private struct DoneBadge: View {
    var body: some View {
        Image(systemName: "checkmark")
            .font(.system(size: 11, weight: .heavy))
            .foregroundStyle(.white)
            .frame(width: 22, height: 22)
            .background(Color.green, in: Circle())
            .transition(.scale(scale: 0.5).combined(with: .opacity))
    }
}

/// The Agent's plan as capsule rows: status badge, label, step counter and a status pill; rows expand for details.
struct TaskRowsView: View {
    let tasks: [PlanTask]
    @State private var open: Set<Int> = []

    var body: some View {
        VStack(spacing: 8) {
            ForEach(tasks) { task in row(task) }
        }
        .animation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.3), value: open)
        .animation(.easeOut(duration: 0.25), value: tasks)
    }

    private func row(_ task: PlanTask) -> some View {
        let isOpen = open.contains(task.id)
        return VStack(spacing: 0) {
            Button {
                if isOpen { open.remove(task.id) } else { open.insert(task.id) }
            } label: {
                HStack(spacing: 10) {
                    badge(task)
                    Text(task.label).font(.system(size: 13, weight: .medium)).lineLimit(1)
                    Spacer(minLength: 4)
                    Text("\(task.id + 1)/\(tasks.count)")
                        .font(.system(size: 12.5))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    if task.status == .completed {
                        Text("已完成")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(.green)
                            .padding(.horizontal, 8)
                            .frame(height: 22)
                            .background(Color.green.opacity(0.12), in: Capsule())
                    }
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(isOpen ? 180 : 0))
                }
                .padding(.horizontal, 10)
                .frame(height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isOpen {
                HStack(alignment: .top, spacing: 10) {
                    Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1).padding(.leading, 21)
                    VStack(alignment: .leading, spacing: 6) {
                        detail("状态", statusText(task.status))
                        if let priority = task.priority { detail("优先级", priorityText(priority)) }
                    }
                    .padding(.trailing, 12)
                }
                .padding(.bottom, 10)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: isOpen ? 14 : 22))
        .overlay(RoundedRectangle(cornerRadius: isOpen ? 14 : 22).stroke(Color.primary.opacity(0.06)))
        .clipShape(RoundedRectangle(cornerRadius: isOpen ? 14 : 22))
    }

    @ViewBuilder
    private func badge(_ task: PlanTask) -> some View {
        switch task.status {
        case .completed: DoneBadge()
        case .running: SpinnerRing(label: "\(task.id + 1)", active: true)
        case .pending: SpinnerRing(label: "\(task.id + 1)")
        }
    }

    private func detail(_ name: String, _ value: String) -> some View {
        HStack {
            Text(name).foregroundStyle(.secondary)
            Spacer()
            Text(value).foregroundStyle(.tertiary)
        }
        .font(.system(size: 12))
    }

    private func statusText(_ status: PlanTask.Status) -> String {
        switch status {
        case .completed: "已完成"
        case .running: "进行中"
        case .pending: "待开始"
        }
    }

    private func priorityText(_ priority: String) -> String {
        switch priority {
        case "high": "高"
        case "medium": "中"
        case "low": "低"
        default: priority
        }
    }
}

/// Where the plan lives on the conversation page: a capsule above the prompt bar that opens the full list.
struct TaskDock: View {
    let tasks: [PlanTask]
    let running: Bool
    @State private var expanded = false

    private var completed: Int { tasks.filter { $0.status == .completed }.count }
    private var current: PlanTask? { tasks.first { $0.status == .running } ?? tasks.first { $0.status == .pending } }
    private var finished: Bool { completed == tasks.count }

    var body: some View {
        VStack(spacing: 8) {
            if expanded {
                ScrollView { TaskRowsView(tasks: tasks).padding(.vertical, 2) }
                    .frame(maxHeight: 260)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.scale(scale: 0.98, anchor: .bottom).combined(with: .opacity))
            }
            Button {
                withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.3)) { expanded.toggle() }
            } label: {
                HStack(spacing: 10) {
                    if finished {
                        DoneBadge()
                    } else if running {
                        PixelLoader()
                    } else {
                        Image(systemName: "list.bullet").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    Text("任务 \(completed)/\(tasks.count)").font(.system(size: 13, weight: .semibold)).monospacedDigit()
                    Text(finished ? "已全部完成" : (current?.label ?? ""))
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .padding(.horizontal, 14)
                .frame(height: 40)
                .background(Color(.secondarySystemGroupedBackground), in: Capsule())
                .overlay(Capsule().stroke(Color.primary.opacity(0.06)))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }
}
