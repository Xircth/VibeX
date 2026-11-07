import CompanionCore
import SwiftUI

/// An agent run as compact rows: tool calls collapsed by default, then file-diff chips for the edits.
struct ToolChipsView: View {
    let item: TimelineItem
    let working: Bool
    let openDiff: (FileChangeItem) -> Void

    @State private var runOpen = false
    @State private var openRows: Set<String> = []

    private var anyToolRunning: Bool {
        working && item.tools.contains(where: { !$0.isFinished })
    }

    private var latestToolSummary: String? {
        guard let last = item.tools.last else { return nil }
        if let preview = last.preview, !preview.isEmpty {
            return "\(last.label) \(preview)"
        }
        return last.label
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !item.tools.isEmpty {
                Button {
                    withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.28)) {
                        runOpen.toggle()
                    }
                } label: {
                    HStack(spacing: 7) {
                        if anyToolRunning {
                            ProgressView()
                                .controlSize(.mini)
                        } else {
                            Image(systemName: "wrench.and.screwdriver")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                        }

                        Text(anyToolRunning ? "正在执行工具 (\(item.tools.count))" : "\(item.tools.count) 次工具调用")
                            .font(.system(size: 12.5, weight: .medium))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)

                        if !runOpen, let summary = latestToolSummary {
                            Text("·")
                                .foregroundStyle(.quaternary)
                            Text(summary)
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }

                        Spacer(minLength: 4)

                        Image(systemName: "chevron.right")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(runOpen ? 90 : 0))
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

                if runOpen {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(item.tools) { tool in toolRow(tool) }
                    }
                    .padding(.leading, 4)
                    .padding(.top, 2)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }

            if !item.changes.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(item.changes.prefix(Self.visibleChanges)) { change in
                        Button { openDiff(change) } label: {
                            HStack(spacing: 6) {
                                Image(systemName: FileGlyph.symbol(for: change.path))
                                    .font(.system(size: 10.5))
                                    .foregroundStyle(.secondary)
                                Text((change.path as NSString).lastPathComponent).lineLimit(1)
                                if let additions = change.additions {
                                    Text("+\(additions)").foregroundStyle(.green)
                                }
                                if let deletions = change.deletions, deletions > 0 {
                                    Text("−\(deletions)").foregroundStyle(.red)
                                }
                            }
                            .font(.system(size: 11.5, design: .monospaced))
                            .padding(.horizontal, 9)
                            .frame(height: 28)
                            .background(
                                Color(.secondarySystemGroupedBackground),
                                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("查看 \(change.path) 的差异")
                    }
                    if item.changes.count > Self.visibleChanges {
                        Text("+\(item.changes.count - Self.visibleChanges)")
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .frame(height: 28)
                            .padding(.horizontal, 6)
                    }
                }
                .padding(.top, 2)
            }
        }
    }

    private static let visibleChanges = 6

    private func toolRow(_ tool: ToolStep) -> some View {
        let isOpen = openRows.contains(tool.id)
        return VStack(alignment: .leading, spacing: 3) {
            Button {
                withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.25)) {
                    if isOpen { openRows.remove(tool.id) } else { openRows.insert(tool.id) }
                }
            } label: {
                HStack(spacing: 8) {
                    ZStack {
                        if tool.isFinished || !working {
                            Image(systemName: icon(for: tool.name)).font(.system(size: 11.5))
                        } else {
                            ProgressView().controlSize(.mini)
                        }
                    }
                    .foregroundStyle(.secondary)
                    .frame(width: 16)

                    Text(tool.label)
                        .font(.system(size: 12.5, weight: .semibold))
                        .lineLimit(1)
                        .fixedSize()

                    if let preview = tool.preview, !preview.isEmpty {
                        Text(preview)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .padding(.horizontal, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(height: 26)
                            .background(
                                Color(.secondarySystemGroupedBackground),
                                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .stroke(Color.primary.opacity(0.06), lineWidth: 0.5)
                            )
                    } else {
                        Spacer(minLength: 0)
                    }

                    if !tool.detail.isEmpty {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(isOpen ? 90 : 0))
                    }
                }
                .frame(minHeight: 30)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isOpen && !tool.detail.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(tool.detail.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(.leading, 12)
                .padding(.vertical, 3)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Color.primary.opacity(0.14)).frame(width: 1.5)
                }
                .padding(.leading, 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func icon(for name: String) -> String {
        let lowered = name.lowercased()
        if lowered.contains("read") || lowered.contains("view") { return "doc.text" }
        if lowered.contains("edit") || lowered.contains("write") || lowered.contains("patch") { return "pencil" }
        if lowered.contains("run") || lowered.contains("bash") || lowered.contains("exec") || lowered.contains("shell") {
            return "terminal"
        }
        if lowered.contains("search") || lowered.contains("grep") || lowered.contains("find") { return "magnifyingglass" }
        return "wrench.and.screwdriver"
    }
}

/// Wraps its children onto new lines when a row is full.
private struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(width: proposal.width ?? .infinity, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(width: bounds.width, subviews: subviews)
        for (index, origin) in result.origins.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + origin.x, y: bounds.minY + origin.y), proposal: .unspecified)
        }
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var origins: [CGPoint] = []
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            origins.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + rowHeight), origins)
    }
}
