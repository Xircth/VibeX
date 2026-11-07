import CompanionCore
import SwiftUI

/// An agent run as compact rows: tool calls with inline chips, then file-diff chips for the edits.
struct ToolChipsView: View {
    let item: TimelineItem
    let working: Bool
    let openDiff: (FileChangeItem) -> Void

    @State private var runOpen = true
    @State private var openRows: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !item.tools.isEmpty {
                Button {
                    withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.3)) { runOpen.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .bold))
                            .rotationEffect(.degrees(runOpen ? 0 : -90))
                        Text("\(item.tools.count) 次工具调用").monospacedDigit()
                    }
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if runOpen {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(item.tools) { tool in toolRow(tool) }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            if !item.changes.isEmpty {
                Divider().padding(.top, 8)
                FlowLayout(spacing: 6) {
                    ForEach(item.changes.prefix(Self.visibleChanges)) { change in
                        Button { openDiff(change) } label: {
                            HStack(spacing: 8) {
                                Text((change.path as NSString).lastPathComponent).lineLimit(1)
                                if let additions = change.additions { Text("+\(additions)").foregroundStyle(.green) }
                                if let deletions = change.deletions, deletions > 0 {
                                    Text("−\(deletions)").foregroundStyle(.red)
                                }
                            }
                            .font(.system(size: 12, design: .monospaced))
                            .padding(.horizontal, 10)
                            .frame(height: 30)
                            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Color.primary.opacity(0.08)))
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
        return VStack(alignment: .leading, spacing: 2) {
            Button {
                withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.3)) {
                    if isOpen { openRows.remove(tool.id) } else { openRows.insert(tool.id) }
                }
            } label: {
                HStack(spacing: 8) {
                    ZStack {
                        if tool.isFinished || !working {
                            Image(systemName: icon(for: tool.name)).font(.system(size: 12))
                        } else {
                            ProgressView().controlSize(.mini)
                        }
                    }
                    .foregroundStyle(.tertiary)
                    .frame(width: 16)
                    Text(tool.label)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                        .fixedSize()
                    Text(tool.preview ?? " ")
                        .font(.system(size: 12.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.horizontal, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .frame(height: 30)
                        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Color.primary.opacity(0.06)))
                        .opacity(tool.preview == nil ? 0 : 1)
                }
                .frame(minHeight: 34)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isOpen && !tool.detail.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(tool.detail.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(.leading, 12)
                .padding(.vertical, 2)
                .overlay(alignment: .leading) { Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 1) }
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
