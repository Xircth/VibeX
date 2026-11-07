import SwiftUI

enum ComposerMenu: Equatable {
    case access, model, effort
}

struct PromptChoice: Identifiable, Equatable {
    let id: String
    var title: String
    var detail: String?
    var tag: String?
    var icon: String?
    var selected = false
    var enabled = true
}

struct PromptGroup: Identifiable, Equatable {
    var id: String { title }
    let title: String
    let choices: [PromptChoice]
}

struct PromptEffort: Equatable {
    let levels: [String]
    let index: Int
}

/// SwiftUI port of the web PromptBar: one rounded field, a tool row, and floating menus above it.
struct PromptBar: View {
    @Binding var draft: String
    @Binding var menu: ComposerMenu?
    let isRunning: Bool
    let busy: Bool
    let hasAlert: Bool
    let modelName: String?
    let modelChoices: [PromptChoice]
    let otherModelGroups: [PromptGroup]
    let otherAgentNote: String?
    let accessChoices: [PromptChoice]
    let extraChoices: [PromptChoice]
    let effort: PromptEffort?
    let send: () -> Void
    let stop: () -> Void
    let pickModel: (String) -> Void
    let pickAccess: (String) -> Void
    let pickExtra: (String) -> Void
    let setEffort: (Int) -> Void

    @FocusState private var focused: Bool

    private let spark = Color(red: 0.70, green: 0.62, blue: 1.0)
    private var armed: Bool {
        isRunning || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var effortAtMax: Bool {
        guard let effort else { return false }
        return effort.levels.count > 1 && effort.index == effort.levels.count - 1
    }

    var body: some View {
        VStack(spacing: 8) {
            if let menu {
                menuView(menu)
                    .padding(.horizontal, 12)
                    .transition(.scale(scale: 0.98, anchor: .bottom).combined(with: .opacity))
            }
            field
        }
        .animation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.18), value: menu)
    }

    // MARK: Field

    private var field: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("发消息", text: $draft, axis: .vertical)
                .lineLimit(1...5)
                .font(.system(size: 16))
                .focused($focused)
                .onChange(of: focused) { _, isFocused in if isFocused { menu = nil } }
                .onChange(of: draft) { _, _ in menu = nil }
            toolRow
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(alignment: .bottom) {
            // The dock runs to the screen edge so its colour and the home-indicator area are one surface.
            let dock = UnevenRoundedRectangle(topLeadingRadius: 20, topTrailingRadius: 20)
            ZStack {
                dock.fill(Color(.secondarySystemGroupedBackground))
                dock
                    .fill(RadialGradient(
                        colors: [spark.opacity(0.26), .clear],
                        center: .bottomLeading,
                        startRadius: 0,
                        endRadius: 220
                    ))
                    .opacity(effortAtMax ? 1 : 0)
                    .animation(.easeInOut(duration: 0.5), value: effortAtMax)
                dock.stroke(Color.primary.opacity(0.06))
            }
            .shadow(color: .black.opacity(0.06), radius: 8, y: -2)
            .ignoresSafeArea(edges: .bottom)
        }
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
    }

    private var toolRow: some View {
        HStack(spacing: 4) {
            ToolButton(icon: "plus", on: menu == .access, alert: hasAlert, label: "权限与模式") {
                toggle(.access)
            }
            if let modelName {
                PickPill(on: menu == .model, label: "选择模型") { toggle(.model) } content: {
                    Text(modelName).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold))
                }
            }
            if let effort {
                PickPill(on: menu == .effort, tint: effortAtMax ? spark : nil, label: "推理强度") {
                    toggle(.effort)
                } content: {
                    Image(systemName: "sparkles").font(.system(size: 12, weight: .semibold))
                    Text(effort.levels[effort.index])
                }
            }
            Spacer(minLength: 0)
            SendButton(armed: armed, running: isRunning, busy: busy, send: send, stop: stop)
        }
    }

    private func toggle(_ target: ComposerMenu) {
        focused = false
        menu = menu == target ? nil : target
    }

    // MARK: Menus

    @ViewBuilder
    private func menuView(_ kind: ComposerMenu) -> some View {
        Group {
            switch kind {
            case .access:
                MenuList(rows: accessChoices + extraChoices, empty: "Agent 没有提供权限设置") { id in
                    if accessChoices.contains(where: { $0.id == id }) { pickAccess(id) } else { pickExtra(id) }
                }
            case .model:
                MenuList(
                    rows: modelChoices,
                    groups: otherModelGroups,
                    footnote: otherAgentNote,
                    empty: "电脑端没有配置可选模型",
                    select: pickModel
                )
                .frame(maxWidth: 240)
            case .effort:
                if let effort {
                    EffortMenu(effort: effort, atMax: effortAtMax, spark: spark, change: setEffort)
                        .frame(maxWidth: 260)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Controls

private struct ToolButton: View {
    let icon: String
    let on: Bool
    var alert = false
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .rotationEffect(.degrees(on ? 45 : 0))
                .frame(width: 28, height: 28)
                .background(on ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(on ? Color.primary : Color.primary.opacity(0.6))
                .overlay(alignment: .topTrailing) {
                    if alert { Circle().fill(.orange).frame(width: 8, height: 8).offset(x: 1, y: -1) }
                }
                .animation(.spring(duration: 0.25), value: on)
        }
        .buttonStyle(PressStyle(scale: 0.94))
        .accessibilityLabel(label)
    }
}

private struct PickPill<Content: View>: View {
    let on: Bool
    var tint: Color?
    let label: String
    let action: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4, content: content)
                .font(.system(size: 12, weight: .medium))
                .padding(.horizontal, 8)
                .frame(height: 28)
                .background(on ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(tint ?? (on ? Color.primary : Color.primary.opacity(0.7)))
        }
        .buttonStyle(PressStyle(scale: 0.96))
        .accessibilityLabel(label)
    }
}

private struct PressStyle: ButtonStyle {
    let scale: CGFloat

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.16), value: configuration.isPressed)
    }
}

private struct SendButton: View {
    let armed: Bool
    let running: Bool
    let busy: Bool
    let send: () -> Void
    let stop: () -> Void

    var body: some View {
        Button(action: running ? stop : send) {
            SendGlyph(morph: running ? 1 : 0)
                .frame(width: 16, height: 16)
                .frame(width: 28, height: 28)
                .foregroundStyle(armed ? Color(.systemBackground) : Color.primary.opacity(0.35))
                .background(
                    armed ? Color.primary : Color.primary.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: 8)
                )
                .animation(.easeOut(duration: 0.2), value: armed)
        }
        .buttonStyle(PressStyle(scale: armed ? 0.96 : 1))
        .disabled(!armed || (busy && !running))
        .accessibilityLabel(running ? "停止" : "发送")
    }
}

// MARK: - Send glyph (arrow morphs into a stop square)

private let arrowPoints: [CGPoint] = [
    (12, 4.5), (18.5, 11), (14.25, 11), (14.25, 19.5), (9.75, 19.5), (9.75, 11), (5.5, 11),
].map { CGPoint(x: $0.0, y: $0.1) }

private let squarePoints: [CGPoint] = [
    (12, 6), (18, 6), (18, 12), (18, 18), (6, 18), (6, 12), (6, 6),
].map { CGPoint(x: $0.0, y: $0.1) }

private struct GlyphShape: Shape {
    var t: Double
    var animatableData: Double {
        get { t }
        set { t = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let scale = rect.width / 24
        var path = Path()
        for (i, (a, b)) in zip(arrowPoints, squarePoints).enumerated() {
            let point = CGPoint(
                x: (a.x + (b.x - a.x) * t) * scale,
                y: (a.y + (b.y - a.y) * t) * scale
            )
            i == 0 ? path.move(to: point) : path.addLine(to: point)
        }
        path.closeSubpath()
        return path
    }
}

/// Squash and tilt while morphing, peaking halfway through.
private struct GooEffect: GeometryEffect {
    var t: Double
    var direction: Double
    var animatableData: Double {
        get { t }
        set { t = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        let goo = sin(t * .pi)
        let sx = 1 - 0.12 * goo
        var transform = CGAffineTransform(translationX: size.width / 2, y: size.height / 2)
        transform = transform.rotated(by: direction * 8 * goo * .pi / 180)
        transform = transform.scaledBy(x: sx, y: 1 / sx)
        transform = transform.translatedBy(x: -size.width / 2, y: -size.height / 2)
        return ProjectionTransform(transform)
    }
}

private struct SendGlyph: View {
    let morph: Double

    var body: some View {
        GlyphShape(t: morph)
            .fill()
            .overlay(GlyphShape(t: morph).stroke(style: StrokeStyle(lineWidth: 1.33, lineJoin: .round)))
            .modifier(GooEffect(t: morph, direction: morph == 1 ? 1 : -1))
            .animation(.timingCurve(0.77, 0, 0.175, 1, duration: 0.24), value: morph)
    }
}

// MARK: - Menus

private struct MenuList: View {
    let rows: [PromptChoice]
    var groups: [PromptGroup] = []
    var footnote: String?
    let empty: String
    let select: (String) -> Void

    private var estimatedHeight: CGFloat {
        CGFloat(rows.count) * 36
            + groups.reduce(0) { $0 + 28 + CGFloat($1.choices.count) * 36 }
            + (footnote == nil ? 0 : 40)
    }

    var body: some View {
        MenuSurface {
            if rows.isEmpty && groups.isEmpty {
                Text(empty)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(height: 36)
                    .padding(.horizontal, 8)
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(rows) { row in MenuRow(row: row) { select(row.id) } }
                        ForEach(groups) { group in
                            Text(group.title)
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 8)
                                .padding(.top, 8)
                            ForEach(group.choices) { row in MenuRow(row: row) {} }
                        }
                        if let footnote {
                            Text(footnote)
                                .font(.system(size: 11))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(8)
                        }
                    }
                }
                .frame(height: min(estimatedHeight, 300))
            }
        }
    }
}

private struct MenuRow: View {
    let row: PromptChoice
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let icon = row.icon {
                    Image(systemName: icon)
                        .font(.system(size: 14))
                        .frame(width: 20)
                        .foregroundStyle(.secondary)
                }
                Text(row.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                if let detail = row.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if let tag = row.tag {
                    Text(tag).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .heavy))
                    .opacity(row.selected ? 1 : 0)
            }
            .padding(.horizontal, 8)
            .frame(height: 36)
            .contentShape(Rectangle())
            .foregroundStyle(row.enabled ? Color.primary : Color.primary.opacity(0.4))
        }
        .buttonStyle(RowStyle())
        .disabled(!row.enabled)
    }
}

private struct RowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                configuration.isPressed ? Color.primary.opacity(0.08) : .clear,
                in: RoundedRectangle(cornerRadius: 8)
            )
    }
}

private struct MenuSurface<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(4)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.06)))
            .shadow(color: .black.opacity(0.08), radius: 10, y: 2)
    }
}

private struct EffortMenu: View {
    let effort: PromptEffort
    let atMax: Bool
    let spark: Color
    let change: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("推理强度").foregroundStyle(.secondary)
                Text(effort.levels[effort.index]).fontWeight(.medium)
                Spacer()
            }
            .font(.system(size: 13))
            HStack {
                Text("更快")
                Spacer()
                Text("更强")
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .padding(.top, 12)
            EffortSlider(levels: effort.levels.count, index: effort.index, atMax: atMax, spark: spark, change: change)
                .padding(.top, 8)
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.06)))
        .shadow(color: .black.opacity(0.08), radius: 10, y: 2)
    }
}

private struct EffortSlider: View {
    let levels: Int
    let index: Int
    let atMax: Bool
    let spark: Color
    let change: (Int) -> Void

    private let edge: CGFloat = 11

    var body: some View {
        GeometryReader { geo in
            let usable = max(1, geo.size.width - 2 * edge)
            let steps = CGFloat(max(1, levels - 1))
            let x = { (i: Int) in edge + usable * CGFloat(i) / steps }
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule()
                    .fill(atMax ? spark.opacity(0.35) : Color.primary.opacity(0.18))
                    .frame(width: index == levels - 1 ? geo.size.width : x(index) + 7)
                ForEach(0..<levels, id: \.self) { i in
                    Circle().fill(Color.primary.opacity(0.3)).frame(width: 4, height: 4)
                        .position(x: x(i), y: geo.size.height / 2)
                }
                RoundedRectangle(cornerRadius: 7)
                    .fill(atMax ? spark : Color.primary)
                    .frame(width: 14, height: 28)
                    .shadow(color: .black.opacity(0.25), radius: 3, y: 2)
                    .offset(x: x(index) - 7)
            }
            .animation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.22), value: index)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0).onChanged { value in
                    let k = (value.location.x - edge) / usable
                    change(min(levels - 1, max(0, Int((k * steps).rounded()))))
                }
            )
        }
        .frame(height: 22)
        .sensoryFeedback(.selection, trigger: index)
    }
}

#Preview {
    struct Demo: View {
        @State private var draft = ""
        @State private var menu: ComposerMenu?
        @State private var effort = 4

        var body: some View {
            VStack {
                Spacer()
                PromptBar(
                    draft: $draft,
                    menu: $menu,
                    isRunning: false,
                    busy: false,
                    hasAlert: true,
                    modelName: "gpt-6-sol",
                    modelChoices: [
                        PromptChoice(id: "a", title: "gpt-6-astra", tag: "Fast"),
                        PromptChoice(id: "b", title: "gpt-6-sol", tag: "Flagship", selected: true),
                    ],
                    otherModelGroups: [],
                    otherAgentNote: nil,
                    accessChoices: [
                        PromptChoice(id: "1", title: "逐项批准", detail: "编辑和命令前都先询问", icon: "shield"),
                        PromptChoice(id: "2", title: "完全访问", detail: "不做任何检查", icon: "shield", selected: true),
                    ],
                    extraChoices: [],
                    effort: PromptEffort(levels: ["低", "中", "高", "超高", "最大"], index: effort),
                    send: {},
                    stop: {},
                    pickModel: { _ in },
                    pickAccess: { _ in },
                    pickExtra: { _ in },
                    setEffort: { effort = $0 }
                )
            }
        }
    }
    return Demo()
}
