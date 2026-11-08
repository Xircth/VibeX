import CompanionCore
import SwiftUI

/// Expandable reasoning the Agent produced before answering.
/// Collapsed by default; tap to inspect the full reasoning trace.
struct ThinkingView: View {
    let text: String
    let durationMs: Int?
    let working: Bool
    @State private var expanded = false

    init(text: String, durationMs: Int? = nil, working: Bool) {
        self.text = text
        self.durationMs = durationMs
        self.working = working
    }

    init(item: TimelineItem, working: Bool) {
        self.text = item.thinking
        self.durationMs = item.durationMs
        self.working = working
    }

    private var previewLine: String? {
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return lines.last
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.3)) {
                    expanded.toggle()
                }
            } label: {
                HStack(spacing: 7) {
                    if working {
                        ProgressView()
                            .controlSize(.mini)
                    } else {
                        Image(systemName: "sparkles")
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }

                    if working {
                        ShimmerText(text: workingLabel)
                            .font(.system(size: 12.5, weight: .medium))
                    } else {
                        Text(doneLabel)
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(.secondary)
                    }

                    if !expanded, let previewLine {
                        Text("·")
                            .foregroundStyle(.quaternary)
                        Text(previewLine)
                            .font(.system(size: 12))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

                    Spacer(minLength: 4)

                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(Color(.secondarySystemGroupedBackground))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded && !text.isEmpty {
                HStack(alignment: .top, spacing: 10) {
                    Capsule()
                        .fill(Color.primary.opacity(0.16))
                        .frame(width: 2)
                    Text(text)
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var workingLabel: String { "思考中" }

    private var doneLabel: String {
        if let ms = durationMs, ms >= 1000 { return "已思考 \(ms / 1000) 秒" }
        return "已思考"
    }
}
