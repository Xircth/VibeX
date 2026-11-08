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
            LockScreenTaskView(
                projectName: context.attributes.projectName,
                conversationTitle: context.attributes.conversationTitle,
                state: context.state,
                stale: context.isStale
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .activityBackgroundTint(Color.black.opacity(0.84))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 9) {
                        VibeXWidgetLogoView(phase: context.state.phase, size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 5) {
                                Text(context.attributes.projectName)
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                PhaseBadgePill(phase: context.state.phase, title: context.state.stageTitle)
                            }
                            Text(context.attributes.conversationTitle)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.white.opacity(0.62))
                                .lineLimit(1)
                        }
                    }
                    .padding(.leading, 4)
                    .padding(.top, 2)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    VibeXCircularProgressRing(
                        progress: context.state.progress,
                        phase: context.state.phase,
                        size: 36,
                        lineWidth: 3.2,
                        showLabel: true
                    )
                    .padding(.trailing, 4)
                    .padding(.top, 2)
                }

                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Image(systemName: phaseSymbol(context.state.phase))
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(phaseTint(context.state.phase))

                            Text(context.isStale && context.state.isRunning ? staleNote : context.state.stageSubtitle)
                                .font(.system(size: 13.5, weight: .medium))
                                .foregroundStyle(.white.opacity(0.92))
                                .lineLimit(1)

                            Spacer(minLength: 4)

                            if context.state.isRunning {
                                Text(context.state.startedAt, style: .timer)
                                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                                    .monospacedDigit()
                                    .foregroundStyle(.white.opacity(0.68))
                                    .frame(maxWidth: 54, alignment: .trailing)
                            } else {
                                Text(context.state.phase == .failed ? "需处理" : "100%")
                                    .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(phaseTint(context.state.phase))
                            }
                        }

                        TaskSmoothProgressBar(
                            progress: context.state.progress,
                            tint: phaseTint(context.state.phase)
                        )
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .padding(.top, 6)
                    .padding(.bottom, 2)
                }
            } compactLeading: {
                HStack(spacing: 5) {
                    VibeXWidgetLogoView(phase: context.state.phase, size: 20)
                    Text(shortCompactLabel(for: context.state))
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                }
            } compactTrailing: {
                VibeXCircularProgressRing(
                    progress: context.state.progress,
                    phase: context.state.phase,
                    size: 21,
                    lineWidth: 2.4,
                    showLabel: true
                )
            } minimal: {
                ZStack {
                    VibeXCircularProgressRing(
                        progress: context.state.progress,
                        phase: context.state.phase,
                        size: 22,
                        lineWidth: 2.2,
                        showLabel: false
                    )
                    VibeXWidgetLogoView(phase: context.state.phase, size: 13, showBadge: false)
                }
            }
        }
    }
}

private let staleNote = "后台守护中 · 点按进入 VibeX 查看最新进展"

private func shortCompactLabel(for state: TaskActivityAttributes.ContentState) -> String {
    switch state.phase {
    case .thinking: return "思考中"
    case .exploring: return "查阅中"
    case .developing: return "开发中"
    case .verifying: return "验证中"
    case .summarizing: return "总结中"
    case .waitingInput: return "待确认"
    case .completed: return "已完成"
    case .failed: return "异常"
    }
}

private func phaseTint(_ phase: VibeXActivityPhase) -> Color {
    switch phase {
    case .thinking:
        return Color(red: 0.64, green: 0.52, blue: 1.0)
    case .exploring:
        return Color(red: 0.35, green: 0.72, blue: 0.98)
    case .developing:
        return Color(red: 0.28, green: 0.62, blue: 1.0)
    case .verifying:
        return Color(red: 0.22, green: 0.82, blue: 0.72)
    case .summarizing:
        return Color(red: 0.45, green: 0.78, blue: 0.98)
    case .waitingInput:
        return Color(red: 0.98, green: 0.62, blue: 0.16)
    case .completed:
        return Color(red: 0.30, green: 0.82, blue: 0.44)
    case .failed:
        return Color(red: 0.96, green: 0.28, blue: 0.28)
    }
}

private func phaseSymbol(_ phase: VibeXActivityPhase) -> String {
    switch phase {
    case .thinking: return "sparkles"
    case .exploring: return "magnifyingglass"
    case .developing: return "hammer.fill"
    case .verifying: return "checkmark.shield.fill"
    case .summarizing: return "text.Justify.left"
    case .waitingInput: return "bell.badge.fill"
    case .completed: return "checkmark.circle.fill"
    case .failed: return "exclamationmark.triangle.fill"
    }
}

// MARK: - Lock Screen Live Activity Banner

private struct LockScreenTaskView: View {
    let projectName: String
    let conversationTitle: String
    let state: TaskActivityAttributes.ContentState
    let stale: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 13) {
            VibeXWidgetLogoView(phase: state.phase, size: 42)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(projectName)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .lineLimit(1)

                    PhaseBadgePill(phase: state.phase, title: state.stageTitle)

                    Spacer(minLength: 4)

                    if state.isRunning {
                        Text(state.startedAt, style: .timer)
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .monospacedDigit()
                            .foregroundStyle(.white.opacity(0.65))
                    }
                }

                Text(stale && state.isRunning ? staleNote : state.stageSubtitle)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.88))
                    .lineLimit(1)

                HStack(spacing: 8) {
                    Text(conversationTitle)
                        .font(.system(size: 11))
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)

                    if state.total > 0 {
                        Text("· 计划 \(state.completed)/\(state.total)")
                            .font(.system(size: 11, weight: .medium))
                            .monospacedDigit()
                            .foregroundStyle(.white.opacity(0.65))
                    } else if state.stepCount > 0 {
                        Text("· 已推进 \(state.stepCount) 步")
                            .font(.system(size: 11, weight: .medium))
                            .monospacedDigit()
                            .foregroundStyle(.white.opacity(0.65))
                    }
                }
            }

            VibeXCircularProgressRing(
                progress: state.progress,
                phase: state.phase,
                size: 44,
                lineWidth: 3.8,
                showLabel: true
            )
        }
    }
}

// MARK: - Phase Badge Pill

private struct PhaseBadgePill: View {
    let phase: VibeXActivityPhase
    let title: String

    var body: some View {
        let tint = phaseTint(phase)
        HStack(spacing: 3.5) {
            Circle()
                .fill(tint)
                .frame(width: 5.5, height: 5.5)
            Text(title)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(tint)
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2.5)
        .background(
            Capsule(style: .continuous)
                .fill(tint.opacity(0.16))
        )
        .overlay(
            Capsule(style: .continuous)
                .strokeBorder(tint.opacity(0.32), lineWidth: 0.6)
        )
    }
}

// MARK: - Circular Progress Ring (`圆形进度条`)

private struct VibeXCircularProgressRing: View {
    let progress: Double
    let phase: VibeXActivityPhase
    let size: CGFloat
    let lineWidth: CGFloat
    var showLabel: Bool = true

    private var clampedProgress: Double {
        if phase == .completed { return 1.0 }
        return min(max(progress, 0.08), 0.99)
    }

    private var percentageInt: Int {
        if phase == .completed { return 100 }
        return Int((clampedProgress * 100).rounded())
    }

    var body: some View {
        let tint = phaseTint(phase)
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.14), lineWidth: lineWidth)

            Circle()
                .trim(from: 0, to: clampedProgress)
                .stroke(
                    AngularGradient(
                        colors: [tint.opacity(0.75), tint],
                        center: .center,
                        startAngle: .degrees(-90),
                        endAngle: .degrees(270)
                    ),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))

            if showLabel {
                if phase == .completed {
                    Image(systemName: "checkmark")
                        .font(.system(size: size * 0.34, weight: .bold))
                        .foregroundStyle(tint)
                } else if phase == .waitingInput {
                    Image(systemName: "exclamationmark")
                        .font(.system(size: size * 0.36, weight: .heavy))
                        .foregroundStyle(tint)
                } else if phase == .failed {
                    Image(systemName: "xmark")
                        .font(.system(size: size * 0.34, weight: .bold))
                        .foregroundStyle(tint)
                } else {
                    Text("\(percentageInt)%")
                        .font(.system(size: max(8.5, size * 0.25), weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.white)
                }
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Vector VibeX Brand Logo for Widget & Dynamic Island

private struct VibeXWidgetLogoView: View {
    let phase: VibeXActivityPhase
    let size: CGFloat
    var showBadge: Bool = true

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Canvas { context, canvasSize in
                let w = canvasSize.width
                let h = canvasSize.height
                let corner = w * 0.24
                let rect = CGRect(x: 0, y: 0, width: w, height: h)
                let bgPath = Path(roundedRect: rect, cornerRadius: corner, style: .continuous)
                context.fill(bgPath, with: .color(Color(red: 0.11, green: 0.11, blue: 0.13)))
                context.stroke(
                    bgPath,
                    with: .color(Color.white.opacity(0.16)),
                    lineWidth: max(0.6, w * 0.03)
                )

                let p1 = CGPoint(x: w * 0.27, y: h * 0.27)
                let p2 = CGPoint(x: w * 0.73, y: h * 0.73)
                let p3 = CGPoint(x: w * 0.73, y: h * 0.27)
                let p4 = CGPoint(x: w * 0.27, y: h * 0.73)
                let center = CGPoint(x: w * 0.5, y: h * 0.5)

                var diag1 = Path()
                diag1.move(to: p1)
                diag1.addLine(to: p2)

                var diag2 = Path()
                diag2.move(to: p3)
                diag2.addLine(to: p4)

                let strokeW = max(1.4, w * 0.085)
                context.stroke(
                    diag1,
                    with: .color(.white),
                    style: StrokeStyle(lineWidth: strokeW, lineCap: .round)
                )
                context.stroke(
                    diag2,
                    with: .color(.white),
                    style: StrokeStyle(lineWidth: strokeW, lineCap: .round)
                )

                let nodeR = max(1.6, w * 0.085)
                for pt in [p1, p2, p3, p4] {
                    let nodeRect = CGRect(
                        x: pt.x - nodeR,
                        y: pt.y - nodeR,
                        width: nodeR * 2,
                        height: nodeR * 2
                    )
                    context.fill(Path(ellipseIn: nodeRect), with: .color(.white))
                }

                let centerOuterR = max(2.2, w * 0.13)
                let centerInnerR = max(1.0, w * 0.055)
                context.fill(
                    Path(ellipseIn: CGRect(
                        x: center.x - centerOuterR,
                        y: center.y - centerOuterR,
                        width: centerOuterR * 2,
                        height: centerOuterR * 2
                    )),
                    with: .color(.white)
                )
                context.fill(
                    Path(ellipseIn: CGRect(
                        x: center.x - centerInnerR,
                        y: center.y - centerInnerR,
                        width: centerInnerR * 2,
                        height: centerInnerR * 2
                    )),
                    with: .color(Color(red: 0.11, green: 0.11, blue: 0.13))
                )
            }
            .frame(width: size, height: size)

            if showBadge {
                let badgeSize = max(7, size * 0.28)
                Circle()
                    .fill(phaseTint(phase))
                    .frame(width: badgeSize, height: badgeSize)
                    .overlay(
                        Circle()
                            .stroke(Color.black, lineWidth: max(1, size * 0.045))
                    )
                    .offset(x: 1.5, y: 1.5)
            }
        }
    }
}

private struct TaskSmoothProgressBar: View {
    let progress: Double
    let tint: Color

    var body: some View {
        GeometryReader { proxy in
            let clamped = min(max(progress, 0.06), 1.0)
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.white.opacity(0.14))
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [tint.opacity(0.8), tint],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: proxy.size.width * clamped)
            }
        }
        .frame(height: 4.5)
    }
}
