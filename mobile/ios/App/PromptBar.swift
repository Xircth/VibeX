import PhotosUI
import SwiftUI
import UIKit

enum ComposerMenu: Equatable {
    case access
    case plusModel
    case plusMode
    case plusPerms
    case model
    case effort

    var isBottomDrawer: Bool {
        switch self {
        case .access, .plusModel, .plusMode, .plusPerms:
            return true
        case .model, .effort:
            return false
        }
    }
}

struct PromptChoice: Identifiable, Equatable {
    let id: String
    var title: String
    var detail: String?
    var tag: String?
    var icon: String?
    /// Agent whose brand mark leads the row (model choices).
    var agentID: String?
    var selected = false
    var enabled = true
}

struct PromptGroup: Identifiable, Equatable {
    var id: String { title }
    let title: String
    var agentID: String?
    let choices: [PromptChoice]
}

struct PromptEffort: Equatable {
    let levels: [String]
    let index: Int
}

struct AttachedImageItem: Identifiable, Equatable {
    let id = UUID()
    let token: String
    var image: UIImage
    let fileName: String

    static func == (lhs: AttachedImageItem, rhs: AttachedImageItem) -> Bool {
        lhs.id == rhs.id && lhs.token == rhs.token && lhs.fileName == rhs.fileName
    }
}

/// SwiftUI port of the PromptBar: one rounded dock, a tool row, floating menus for inline pills,
/// and an expandable bottom action drawer when tapping `+`.
struct PromptBar: View {
    @Binding var draft: String
    @Binding var menu: ComposerMenu?
    let isRunning: Bool
    let busy: Bool
    let hasAlert: Bool
    let modelName: String?
    var agentID: String?
    let modelChoices: [PromptChoice]
    let otherModelGroups: [PromptGroup]
    let otherAgentNote: String?
    let accessChoices: [PromptChoice]
    let extraChoices: [PromptChoice]
    let effort: PromptEffort?
    var openFiles: (() -> Void)? = nil
    let send: () -> Void
    let stop: () -> Void
    let pickModel: (String) -> Void
    let pickAccess: (String) -> Void
    let pickExtra: (String) -> Void
    let setEffort: (Int) -> Void

    @FocusState private var focused: Bool
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var attachedImages: [AttachedImageItem] = []
    @State private var previewingAttached: AttachedImageItem?
    @State private var showPhotoPicker = false
    @State private var showCameraSheet = false

    private let spark = Color(red: 0.70, green: 0.62, blue: 1.0)
    private var armed: Bool {
        isRunning || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachedImages.isEmpty
    }
    private var effortAtMax: Bool {
        guard let effort else { return false }
        return effort.levels.count > 1 && effort.index == effort.levels.count - 1
    }
    private var isPlusOpen: Bool {
        menu?.isBottomDrawer == true
    }

    var body: some View {
        VStack(spacing: 8) {
            if let menu, !menu.isBottomDrawer {
                floatingMenuView(menu)
                    .padding(.horizontal, 12)
                    .transition(.scale(scale: 0.98, anchor: .bottom).combined(with: .opacity))
            }
            dockSurface
        }
        .animation(.spring(response: 0.28, dampingFraction: 0.86), value: menu)
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $selectedPhotoItems,
            maxSelectionCount: 4,
            matching: .images
        )
        .onChange(of: selectedPhotoItems) { _, items in
            guard !items.isEmpty else { return }
            Task { @MainActor in
                for (idx, item) in items.enumerated() {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let uiImage = UIImage(data: data)
                    {
                        let fileName = "image-\(idx + 1).jpg"
                        let token = AttachmentImageStore.shared.register(image: uiImage, fileName: fileName)
                        attachedImages.append(
                            AttachedImageItem(token: token, image: uiImage, fileName: fileName)
                        )
                    }
                }
                selectedPhotoItems.removeAll()
                menu = nil
            }
        }
        .sheet(isPresented: $showCameraSheet) {
            CameraCaptureSheet { captured in
                if let captured {
                    let fileName = "camera-photo.jpg"
                    let token = AttachmentImageStore.shared.register(image: captured, fileName: fileName)
                    attachedImages.append(
                        AttachedImageItem(token: token, image: captured, fileName: fileName)
                    )
                }
                menu = nil
            }
            .ignoresSafeArea()
        }
        .fullScreenCover(item: $previewingAttached) { item in
            ZoomableImagePreviewSheet(
                item: PreviewableImageItem(
                    id: item.token,
                    image: item.image,
                    urlString: nil,
                    title: item.fileName
                ),
                onUpdateImage: { updated in
                    AttachmentImageStore.shared.update(token: item.token, image: updated, fileName: item.fileName)
                    if let idx = attachedImages.firstIndex(where: { $0.id == item.id }) {
                        attachedImages[idx].image = updated
                    }
                }
            )
        }
    }

    // MARK: Dock Surface (Input Field + Bottom `+` Drawer)

    private var dockSurface: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                if !attachedImages.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(attachedImages) { item in
                                ZStack(alignment: .topTrailing) {
                                    Button {
                                        previewingAttached = item
                                    } label: {
                                        Image(uiImage: item.image)
                                            .resizable()
                                            .scaledToFill()
                                            .frame(width: 56, height: 56)
                                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                            .overlay(
                                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                                    .strokeBorder(Color.primary.opacity(0.12), lineWidth: 0.6)
                                            )
                                    }
                                    .buttonStyle(.plain)

                                    Button {
                                        withAnimation {
                                            attachedImages.removeAll { $0.id == item.id }
                                        }
                                    } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .font(.system(size: 16))
                                            .foregroundStyle(.white, Color.black.opacity(0.65))
                                    }
                                    .offset(x: 4, y: -4)
                                }
                            }
                        }
                        .padding(.top, 2)
                    }
                }

                TextField("发消息", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.system(size: 15.5))
                    .focused($focused)
                    .onChange(of: focused) { _, isFocused in
                        if isFocused { menu = nil }
                    }
                toolRow
            }
            .padding(.horizontal, 14)
            .padding(.top, 11)
            .padding(.bottom, 10)
            .contentShape(Rectangle())
            .onTapGesture { focused = true }

            if let menu, menu.isBottomDrawer {
                Divider().opacity(0.55)
                bottomDrawerContent(menu)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity)
        .background {
            let dock = RoundedRectangle(cornerRadius: 22, style: .continuous)
            ZStack {
                dock.fill(Color(.secondarySystemGroupedBackground))
                dock
                    .fill(RadialGradient(
                        colors: [spark.opacity(0.24), .clear],
                        center: .bottomLeading,
                        startRadius: 0,
                        endRadius: 220
                    ))
                    .opacity(effortAtMax ? 1 : 0)
                    .animation(.easeInOut(duration: 0.5), value: effortAtMax)
                dock.strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.7)
            }
            .shadow(color: .black.opacity(0.05), radius: 10, x: 0, y: 3)
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 8)
    }

    private var toolRow: some View {
        HStack(spacing: 6) {
            ToolButton(icon: "plus", on: isPlusOpen, alert: hasAlert, label: "更多功能") {
                focused = false
                menu = isPlusOpen ? nil : .access
            }
            if let modelName {
                PickPill(on: menu == .model || menu == .plusModel, label: "选择模型") {
                    toggle(.model)
                } content: {
                    if agentID != nil { AgentIconView(agent: agentID, size: 13.5) }
                    Text(modelName).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9.5, weight: .bold))
                }
            }
            if let effort {
                PickPill(on: menu == .effort || menu == .plusMode, tint: effortAtMax ? spark : nil, label: "推理强度") {
                    toggle(.effort)
                } content: {
                    Image(systemName: "sparkles").font(.system(size: 11.5, weight: .semibold))
                    Text(effort.levels[effort.index])
                }
            }
            Spacer(minLength: 0)
            SendButton(
                armed: armed,
                running: isRunning,
                busy: busy,
                send: {
                    if !attachedImages.isEmpty {
                        let tokenTag = attachedImages.map { "#\($0.token)" }.joined(separator: " ")
                        let marker = "[图片附件 ×\(attachedImages.count) \(tokenTag)]"
                        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            draft = marker
                        } else {
                            draft += "\n\(marker)"
                        }
                    }
                    attachedImages.removeAll()
                    menu = nil
                    send()
                },
                stop: stop
            )
        }
    }

    private func toggle(_ target: ComposerMenu) {
        focused = false
        menu = menu == target ? nil : target
    }

    // MARK: Bottom Drawer (`+` Action Grid & Sub-panels)

    @ViewBuilder
    private func bottomDrawerContent(_ kind: ComposerMenu) -> some View {
        switch kind {
        case .access:
            plusActionGrid
        case .plusModel:
            drawerSubpanel(title: "选择模型") {
                DrawerChoiceList(
                    rows: modelChoices,
                    groups: otherModelGroups,
                    footnote: otherAgentNote,
                    empty: "电脑端没有配置可选模型",
                    select: pickModel
                )
            }
        case .plusMode:
            drawerSubpanel(title: "模式与推理") {
                VStack(alignment: .leading, spacing: 12) {
                    if let effort {
                        EffortMenu(effort: effort, atMax: effortAtMax, spark: spark, change: setEffort)
                    }
                    let modeRows = modeAndExtraChoices
                    if !modeRows.isEmpty {
                        DrawerChoiceList(
                            rows: modeRows,
                            empty: "当前 Agent 无额外模式设置"
                        ) { id in
                            if accessChoices.contains(where: { $0.id == id }) {
                                pickAccess(id)
                            } else {
                                pickExtra(id)
                            }
                        }
                    } else if effort == nil {
                        Text("当前 Agent 没有提供模式设置")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 16)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        case .plusPerms:
            drawerSubpanel(title: "权限设置", accent: .orange) {
                DrawerChoiceList(
                    rows: accessChoices,
                    empty: "当前 Agent 没有提供权限设置",
                    select: pickAccess
                )
            }
        default:
            EmptyView()
        }
    }

    private var modeAndExtraChoices: [PromptChoice] {
        let planModes = accessChoices.filter {
            $0.id.localizedCaseInsensitiveContains("plan") || $0.title.localizedCaseInsensitiveContains("plan")
        }
        return planModes + extraChoices
    }

    private var plusActionGrid: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 16), count: 4)
        return LazyVGrid(columns: columns, spacing: 18) {
            PlusGridTile(title: "相册", systemImage: "photo") {
                showPhotoPicker = true
            }
            PlusGridTile(title: "拍摄", systemImage: "camera") {
                showCameraSheet = true
            }
            PlusGridTile(title: "文件", systemImage: "at") {
                menu = nil
                openFiles?()
            }
            PlusGridTile(title: "模型", systemImage: "cpu") {
                menu = .plusModel
            }
            PlusGridTile(title: "模式", customIcon: .botMode) {
                menu = .plusMode
            }
            PlusGridTile(
                title: "权限",
                systemImage: "exclamationmark.shield",
                tint: .orange,
                badge: hasAlert
            ) {
                menu = .plusPerms
            }
        }
        .padding(.horizontal, 22)
        .padding(.top, 18)
        .padding(.bottom, 16)
    }

    private func drawerSubpanel<Content: View>(
        title: String,
        accent: Color = .primary,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Button {
                    menu = .access
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 12, weight: .bold))
                        Text("返回")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
                    .padding(.trailing, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer()

                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(accent)

                Spacer()

                // Balance back button width
                Color.clear.frame(width: 44, height: 1)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)

            content()
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
        }
    }

    // MARK: Floating Menus (for inline model / effort pills)

    @ViewBuilder
    private func floatingMenuView(_ kind: ComposerMenu) -> some View {
        Group {
            switch kind {
            case .model:
                MenuList(
                    rows: modelChoices,
                    groups: otherModelGroups,
                    footnote: otherAgentNote,
                    empty: "电脑端没有配置可选模型",
                    select: pickModel
                )
                .frame(maxWidth: 250)
            case .effort:
                if let effort {
                    EffortMenu(effort: effort, atMax: effortAtMax, spark: spark, change: setEffort)
                        .frame(maxWidth: 260)
                }
            default:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Plus Action Grid Tile & Custom Bot Icon

private enum CustomTileGlyph {
    case botMode
}

private struct PlusGridTile: View {
    let title: String
    var systemImage: String? = nil
    var customIcon: CustomTileGlyph? = nil
    var tint: Color? = nil
    var badge: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color.primary.opacity(0.06))
                        .frame(width: 62, height: 62)

                    if let customIcon {
                        switch customIcon {
                        case .botMode:
                            BotModeGlyph()
                                .stroke(
                                    tint ?? Color.primary.opacity(0.82),
                                    style: StrokeStyle(lineWidth: 2.0, lineCap: .round, lineJoin: .round)
                                )
                                .frame(width: 26, height: 26)
                        }
                    } else if let systemImage {
                        Image(systemName: systemImage)
                            .font(.system(size: 23, weight: .regular))
                            .foregroundStyle(tint ?? Color.primary.opacity(0.82))
                    }
                }
                .overlay(alignment: .topTrailing) {
                    if badge {
                        Circle()
                            .fill(Color.orange)
                            .frame(width: 8, height: 8)
                            .offset(x: -2, y: 2)
                    }
                }

                Text(title)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(tint ?? .secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(scale: 0.94))
    }
}

/// Cute rounded-square robot head with antenna, matching the "模式" icon in the mobile design.
private struct BotModeGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width
        let h = rect.height
        var p = Path()

        // Antenna stem + crossbar
        p.move(to: CGPoint(x: w * 0.50, y: h * 0.24))
        p.addLine(to: CGPoint(x: w * 0.50, y: h * 0.08))
        p.move(to: CGPoint(x: w * 0.36, y: h * 0.08))
        p.addLine(to: CGPoint(x: w * 0.64, y: h * 0.08))

        // Rounded head box
        let headRect = CGRect(x: w * 0.12, y: h * 0.24, width: w * 0.76, height: h * 0.66)
        p.addRoundedRect(in: headRect, cornerSize: CGSize(width: w * 0.20, height: h * 0.20))

        // Eyes
        p.move(to: CGPoint(x: w * 0.36, y: h * 0.48))
        p.addLine(to: CGPoint(x: w * 0.36, y: h * 0.53))
        p.move(to: CGPoint(x: w * 0.64, y: h * 0.48))
        p.addLine(to: CGPoint(x: w * 0.64, y: h * 0.53))

        // Smile arc
        p.move(to: CGPoint(x: w * 0.36, y: h * 0.69))
        p.addQuadCurve(
            to: CGPoint(x: w * 0.64, y: h * 0.69),
            control: CGPoint(x: w * 0.50, y: h * 0.77)
        )
        return p
    }
}

// MARK: - Camera Capture Fallback Sheet

private struct CameraCaptureSheet: UIViewControllerRepresentable {
    let onFinish: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish)
    }

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let onFinish: (UIImage?) -> Void
        init(onFinish: @escaping (UIImage?) -> Void) { self.onFinish = onFinish }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            let image = info[.originalImage] as? UIImage
            onFinish(image)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onFinish(nil)
        }
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
                .font(.system(size: 14.5, weight: .semibold))
                .rotationEffect(.degrees(on ? 45 : 0))
                .frame(width: 30, height: 30)
                .background(
                    on ? Color.primary.opacity(0.14) : Color.primary.opacity(0.055),
                    in: Circle()
                )
                .foregroundStyle(on ? Color.primary : Color.primary.opacity(0.75))
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
            HStack(spacing: 5, content: content)
                .font(.system(size: 12.5, weight: .medium))
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(
                    on ? Color.primary.opacity(0.12) : Color.primary.opacity(0.05),
                    in: Capsule(style: .continuous)
                )
                .foregroundStyle(tint ?? (on ? Color.primary : Color.primary.opacity(0.8)))
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
                .frame(width: 15, height: 15)
                .frame(width: 30, height: 30)
                .foregroundStyle(armed ? Color(.systemBackground) : Color.primary.opacity(0.32))
                .background(
                    armed ? Color.primary : Color.primary.opacity(0.07),
                    in: Circle()
                )
                .animation(.easeOut(duration: 0.2), value: armed)
        }
        .buttonStyle(PressStyle(scale: armed ? 0.95 : 1))
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

// MARK: - Menus & Lists

private struct DrawerChoiceList: View {
    let rows: [PromptChoice]
    var groups: [PromptGroup] = []
    var footnote: String?
    let empty: String
    let select: (String) -> Void

    private var estimatedHeight: CGFloat {
        CGFloat(rows.count) * 40
            + groups.reduce(0) { $0 + 30 + CGFloat($1.choices.count) * 40 }
            + (footnote == nil ? 0 : 40)
    }

    var body: some View {
        if rows.isEmpty && groups.isEmpty {
            Text(empty)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
        } else {
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(rows) { row in
                        MenuRow(row: row) { select(row.id) }
                    }
                    ForEach(groups) { group in
                        HStack(spacing: 5) {
                            if group.agentID != nil { AgentIconView(agent: group.agentID, size: 12) }
                            Text(group.title)
                        }
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
            .frame(maxHeight: min(estimatedHeight, 240))
        }
    }
}

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
                            HStack(spacing: 5) {
                                if group.agentID != nil { AgentIconView(agent: group.agentID, size: 12) }
                                Text(group.title)
                            }
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
                if row.agentID != nil {
                    AgentIconView(agent: row.agentID, size: 16)
                        .frame(width: 20)
                        .opacity(row.enabled ? 1 : 0.5)
                } else if let icon = row.icon {
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
        @State private var menu: ComposerMenu? = .access
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
