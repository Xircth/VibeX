import CompanionCore
import SwiftUI

/// Expandable reasoning the Agent produced before answering.
/// Open while work is in progress, then settles and stays expandable.
struct ThinkingView: View {
    let item: TimelineItem
    let working: Bool
    @State private var manual: Bool?

    private var expanded: Bool { manual ?? working }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.4)) { manual = !expanded }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "sparkle")
                        .font(.system(size: 13))
                        .foregroundStyle(working ? Color.primary.opacity(0.7) : Color.secondary)
                    if working {
                        ShimmerText(text: workingLabel)
                    } else {
                        Text(doneLabel).foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .font(.system(size: 13, weight: .medium))
                .padding(.vertical, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                HStack(alignment: .top, spacing: 12) {
                    Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1)
                    VStack(alignment: .leading, spacing: 6) {
                        if !item.thinking.isEmpty {
                            Text(item.thinking)
                                .font(.system(size: 12.5))
                                .foregroundStyle(.secondary)
                                .lineSpacing(3)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .padding(.leading, 6)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var workingLabel: String { "思考中" }

    private var doneLabel: String {
        if let ms = item.durationMs, ms >= 1000 { return "思考了 \(ms / 1000) 秒" }
        return "已思考"
    }
}
