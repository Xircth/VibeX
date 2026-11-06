import SwiftUI

struct BranchedItem: Identifiable, Equatable {
    let id: String
    let label: String
    var icon: String?
}

struct BranchedSection: Identifiable, Equatable {
    let id: String
    let label: String
    let children: [BranchedItem]
}

/// SwiftUI port of the web BranchedMenu: sections fold open, each child hangs off a drawn branch.
struct BranchedMenu: View {
    let sections: [BranchedSection]
    @Binding var active: String
    var onSelect: ((String) -> Void)?
    @State private var open: Set<String>
    @Namespace private var marker

    private let pad: CGFloat = 6
    private let rowHeight: CGFloat = 36
    private let indent: CGFloat = 40
    private let trunk: CGFloat = 14
    private let radius: CGFloat = 10
    private let lineWidth: CGFloat = 1.5

    init(
        sections: [BranchedSection],
        active: Binding<String>,
        initiallyOpen: Set<String>? = nil,
        onSelect: ((String) -> Void)? = nil
    ) {
        self.sections = sections
        _active = active
        self.onSelect = onSelect
        _open = State(initialValue: initiallyOpen ?? Set(sections.map(\.id)))
    }

    private var line: Color { Color.primary.opacity(0.2) }
    private var muted: Color { Color.primary.opacity(0.55) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(sections) { section in
                sectionView(section)
            }
        }
        .padding(.leading, 14)
        .background(alignment: .topLeading) {
            Rectangle()
                .fill(LinearGradient(
                    stops: [.init(color: line, location: 0), .init(color: line, location: 0.55), .init(color: .clear, location: 1)],
                    startPoint: .top,
                    endPoint: .bottom
                ))
                .frame(width: 2)
                .padding(.top, 8)
        }
    }

    private func sectionView(_ section: BranchedSection) -> some View {
        let isOpen = open.contains(section.id)
        let holdsActive = section.children.contains { $0.id == active }
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.3)) {
                    if isOpen { open.remove(section.id) } else { open.insert(section.id) }
                }
            } label: {
                Text(section.label)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(isOpen ? Color.primary : muted)
                    .padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(alignment: .leading) {
                if holdsActive && isOpen {
                    Rectangle()
                        .fill(Color.primary)
                        .frame(width: 2, height: 16)
                        .offset(x: -14)
                        .matchedGeometryEffect(id: "marker", in: marker)
                }
            }
            if isOpen {
                tree(section)
                    .clipped()
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private func rowY(_ k: Int) -> CGFloat { pad + CGFloat(k) * rowHeight + rowHeight / 2 }

    private func tree(_ section: BranchedSection) -> some View {
        let kids = section.children
        let height = pad * 2 + CGFloat(kids.count) * rowHeight
        let endX = indent - 8
        let r = min(radius, rowHeight / 2 - 2)
        return ZStack(alignment: .topLeading) {
            Path { p in
                p.move(to: CGPoint(x: trunk, y: 0))
                p.addLine(to: CGPoint(x: trunk, y: rowY(kids.count - 1) - r))
            }
            .stroke(line, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
            ForEach(Array(kids.enumerated()), id: \.element.id) { k, kid in
                branch(k: k, endX: endX, r: r, from: rowY(k) - r)
                    .stroke(line, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                branch(k: k, endX: endX, r: r, from: 0)
                    .trim(from: 0, to: kid.id == active ? 1 : 0)
                    .stroke(Color.primary, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                    .animation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.4), value: active)
            }
            VStack(spacing: 0) {
                ForEach(kids) { kid in
                    Button {
                        active = kid.id
                        onSelect?(kid.id)
                    } label: {
                        HStack(spacing: 8) {
                            if let icon = kid.icon {
                                Image(systemName: icon).font(.system(size: 14))
                            }
                            Text(kid.label).lineLimit(1)
                        }
                        .font(.system(size: 14, weight: kid.id == active ? .medium : .regular))
                        .foregroundStyle(kid.id == active ? Color.primary : muted)
                        .padding(.leading, indent)
                        .frame(maxWidth: .infinity, minHeight: rowHeight, maxHeight: rowHeight, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, pad)
        }
        .frame(height: height)
    }

    private func branch(k: Int, endX: CGFloat, r: CGFloat, from startY: CGFloat) -> Path {
        let y = rowY(k)
        return Path { p in
            p.move(to: CGPoint(x: trunk, y: startY))
            p.addLine(to: CGPoint(x: trunk, y: y - r))
            p.addQuadCurve(to: CGPoint(x: trunk + r, y: y), control: CGPoint(x: trunk, y: y))
            p.addLine(to: CGPoint(x: endX, y: y))
        }
    }
}

#Preview {
    struct Demo: View {
        @State private var active = "src"
        var body: some View {
            BranchedMenu(
                sections: [
                    BranchedSection(id: "dirs", label: "目录", children: [
                        BranchedItem(id: "src", label: "src", icon: "folder"),
                        BranchedItem(id: "docs", label: "docs", icon: "folder"),
                    ]),
                    BranchedSection(id: "files", label: "文件", children: [
                        BranchedItem(id: "readme", label: "README.md", icon: "doc.text"),
                    ]),
                ],
                active: $active
            )
            .padding()
        }
    }
    return Demo()
}
