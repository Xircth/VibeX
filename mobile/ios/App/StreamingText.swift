import SwiftUI
import UIKit

// MARK: - Attachment Image Store & Preview Item

struct PreviewableImageItem: Identifiable, Equatable {
    let id: String
    let image: UIImage?
    let urlString: String?
    let title: String

    init(id: String = UUID().uuidString, image: UIImage? = nil, urlString: String? = nil, title: String = "图片预览") {
        self.id = id
        self.image = image
        self.urlString = urlString
        self.title = title
    }

    static func == (lhs: PreviewableImageItem, rhs: PreviewableImageItem) -> Bool {
        lhs.id == rhs.id && lhs.urlString == rhs.urlString && lhs.title == rhs.title
    }
}

/// Keeps user-attached `UIImage`s in memory (and caches decoded data-URLs) so user bubbles,
/// Markdown images, and the zoomable lightbox can render and annotate them natively.
@MainActor
final class AttachmentImageStore {
    static let shared = AttachmentImageStore()
    private var images: [String: (image: UIImage, fileName: String)] = [:]

    func register(image: UIImage, fileName: String) -> String {
        let token = "att-\(UUID().uuidString.prefix(8).lowercased())"
        images[token] = (image, fileName)
        return token
    }

    func update(token: String, image: UIImage, fileName: String) {
        images[token] = (image, fileName)
    }

    func lookup(token: String) -> (image: UIImage, fileName: String)? {
        images[token]
    }

    func latestImages(limit: Int) -> [(token: String, image: UIImage, fileName: String)] {
        Array(images.map { (token: $0.key, image: $0.value.image, fileName: $0.value.fileName) }.suffix(limit))
    }

    /// Parses attachment markers like `[图片附件: photo.jpg #att-1a2b3c4d]` or legacy `[图片附件 ×N]`
    /// from the beginning of a user message, returning extracted preview items and the remaining text.
    func extractUserAttachments(from text: String) -> (items: [PreviewableImageItem], cleanText: String) {
        var found: [PreviewableImageItem] = []
        var remainingLines: [String] = []
        let lines = text.components(separatedBy: "\n")

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("[图片附件"), trimmed.hasSuffix("]") {
                // Extract all `#att-xxxxxxxx` tokens on this line
                let pattern = #"#(att-[a-z0-9]+)"#
                if let regex = try? NSRegularExpression(pattern: pattern) {
                    let ns = trimmed as NSString
                    let matches = regex.matches(in: trimmed, range: NSRange(location: 0, length: ns.length))
                    for match in matches where match.numberOfRanges > 1 {
                        let token = ns.substring(with: match.range(at: 1))
                        if let entry = lookup(token: token) {
                            found.append(
                                PreviewableImageItem(
                                    id: token,
                                    image: entry.image,
                                    urlString: nil,
                                    title: entry.fileName
                                )
                            )
                        }
                    }
                }
                if found.isEmpty {
                    // Fallback placeholder item when legacy `[图片附件 ×N]` has no cached token
                    found.append(
                        PreviewableImageItem(
                            id: trimmed,
                            image: nil,
                            urlString: nil,
                            title: trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
                        )
                    )
                }
            } else {
                remainingLines.append(line)
            }
        }

        let cleaned = remainingLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return (found, cleaned)
    }

    static func decodeImage(from src: String) -> UIImage? {
        let trimmed = src.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("att-"), let entry = AttachmentImageStore.shared.lookup(token: trimmed) {
            return entry.image
        }
        if trimmed.hasPrefix("data:image/"),
           let comma = trimmed.firstIndex(of: ",")
        {
            let base64 = String(trimmed[trimmed.index(after: comma)...])
            if let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) {
                return UIImage(data: data)
            }
        }
        if trimmed.hasPrefix("file://"),
           let url = URL(string: trimmed),
           let data = try? Data(contentsOf: url)
        {
            return UIImage(data: data)
        }
        if trimmed.hasPrefix("/"),
           FileManager.default.fileExists(atPath: trimmed),
           let data = try? Data(contentsOf: URL(fileURLWithPath: trimmed))
        {
            return UIImage(data: data)
        }
        return nil
    }
}

// MARK: - Zoomable Image Preview (`ZoomableImagePreview.tsx` + `ImagePreviewToolbar.tsx`)

enum ImageAnnotationTool: String, Equatable {
    case view
    case rect
    case ellipse
    case triangle
    case brush
}

struct ImageAnnotationItem: Identifiable, Equatable {
    enum Kind: Equatable {
        case rect(start: CGPoint, end: CGPoint)
        case ellipse(start: CGPoint, end: CGPoint)
        case triangle(start: CGPoint, end: CGPoint)
        case brush(points: [CGPoint])
    }

    let id = UUID()
    var kind: Kind
    var color: Color
    var lineWidth: CGFloat
}

/// Full-screen lightbox and annotation studio matching VibeX desktop's `ZoomableImagePreview` + `ImagePreviewDialog`.
struct ZoomableImagePreviewSheet: View {
    let item: PreviewableImageItem
    var onUpdateImage: ((UIImage) -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var loadedImage: UIImage?
    @State private var isLoading = false
    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    // Annotation state matching `ImagePreviewToolbar.tsx`
    @State private var tool: ImageAnnotationTool = .view
    @State private var activeMarkKind: ImageAnnotationTool = .rect
    @State private var selectedColor: Color = Color(red: 0.94, green: 0.27, blue: 0.27)
    @State private var strokeWidth: CGFloat = 3.5
    @State private var history: [[ImageAnnotationItem]] = [[]]
    @State private var historyIndex: Int = 0
    @State private var draftAnnotation: ImageAnnotationItem?
    @State private var chromeVisible = true
    @State private var copiedToast = false
    @State private var savedToast = false

    private static let presetColors: [Color] = [
        Color(red: 0.94, green: 0.27, blue: 0.27), // Red
        Color(red: 0.96, green: 0.62, blue: 0.04), // Amber
        Color(red: 0.06, green: 0.73, blue: 0.51), // Emerald
        Color(red: 0.23, green: 0.51, blue: 0.96), // Blue
        Color(red: 0.66, green: 0.33, blue: 0.97), // Purple
        Color.white,
    ]

    private static let zoomPresets: [CGFloat] = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]

    private var annotations: [ImageAnnotationItem] {
        guard history.indices.contains(historyIndex) else { return [] }
        return history[historyIndex]
    }

    private var visibleAnnotations: [ImageAnnotationItem] {
        if let draftAnnotation {
            return annotations + [draftAnnotation]
        }
        return annotations
    }

    private var canUndo: Bool { historyIndex > 0 }
    private var canRedo: Bool { historyIndex + 1 < history.count }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Dot-grid backdrop matching `zoomableImagePreview.css`
            GeometryReader { geo in
                Canvas { context, size in
                    let spacing: CGFloat = 22
                    let dotRadius: CGFloat = 0.8
                    var y: CGFloat = spacing / 2
                    while y < size.height {
                        var x: CGFloat = spacing / 2
                        while x < size.width {
                            let rect = CGRect(x: x - dotRadius, y: y - dotRadius, width: dotRadius * 2, height: dotRadius * 2)
                            context.fill(Path(ellipseIn: rect), with: .color(.white.opacity(0.11)))
                            x += spacing
                        }
                        y += spacing
                    }
                }
                .ignoresSafeArea()

                if let uiImage = loadedImage ?? item.image {
                    imageCanvas(uiImage: uiImage, viewportSize: geo.size)
                } else if isLoading {
                    VStack(spacing: 12) {
                        ProgressView().tint(.white)
                        Text("正在加载图片…")
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "photo")
                            .font(.system(size: 38, weight: .light))
                            .foregroundStyle(.white.opacity(0.55))
                        Text(item.title)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(.white.opacity(0.85))
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }

            // Top Chrome Bar
            VStack {
                topBar
                Spacer()
                if let uiImage = loadedImage ?? item.image {
                    bottomToolbar(uiImage: uiImage)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            if copiedToast || savedToast {
                VStack {
                    Text(copiedToast ? "已复制图片到剪贴板" : "已保存到相册")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(.ultraThinMaterial, in: Capsule())
                        .padding(.top, 64)
                    Spacer()
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .preferredColorScheme(.dark)
        .task {
            await loadImageIfNeeded()
        }
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            Button {
                if let uiImage = loadedImage ?? item.image, !annotations.isEmpty, let onUpdateImage {
                    onUpdateImage(renderAnnotatedImage(base: uiImage))
                }
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                if let uiImage = loadedImage ?? item.image {
                    Text("\(Int(uiImage.size.width * uiImage.scale)) × \(Int(uiImage.size.height * uiImage.scale)) px · \(Int(round(scale * 100)))%")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.65))
                }
            }

            Spacer(minLength: 8)

            if let uiImage = loadedImage ?? item.image {
                Button {
                    let finalImage = annotations.isEmpty ? uiImage : renderAnnotatedImage(base: uiImage)
                    UIPasteboard.general.image = finalImage
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation { copiedToast = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        withAnimation { copiedToast = false }
                    }
                } label: {
                    Image(systemName: copiedToast ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(copiedToast ? .green : .white)
                        .frame(width: 34, height: 34)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .buttonStyle(.plain)

                Button {
                    let finalImage = annotations.isEmpty ? uiImage : renderAnnotatedImage(base: uiImage)
                    UIImageWriteToSavedPhotosAlbum(finalImage, nil, nil, nil)
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    withAnimation { savedToast = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        withAnimation { savedToast = false }
                    }
                } label: {
                    Image(systemName: savedToast ? "checkmark" : "square.and.arrow.down")
                        .font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(savedToast ? .green : .white)
                        .frame(width: 34, height: 34)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func imageCanvas(uiImage: UIImage, viewportSize: CGSize) -> some View {
        let fitted = fittedImageSize(for: uiImage.size, in: viewportSize)
        return ZStack {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFit()
                .frame(width: fitted.width, height: fitted.height)
                .overlay {
                    Canvas { context, size in
                        for ann in visibleAnnotations {
                            drawAnnotation(ann, in: &context, size: size)
                        }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                .shadow(color: .black.opacity(0.45), radius: 18, y: 6)
                .scaleEffect(scale)
                .offset(offset)
                .gesture(canvasDragGesture(in: fitted))
                .simultaneousGesture(
                    MagnificationGesture()
                        .onChanged { value in
                            guard tool == .view else { return }
                            scale = min(max(0.25, lastScale * value), 6.0)
                        }
                        .onEnded { _ in
                            lastScale = scale
                            if scale <= 1.0 {
                                withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                                    offset = .zero
                                    lastOffset = .zero
                                }
                            }
                        }
                )
                .onTapGesture(count: 2) {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                        if abs(scale - 1.0) > 0.08 {
                            scale = 1.0
                            lastScale = 1.0
                            offset = .zero
                            lastOffset = .zero
                        } else {
                            scale = 2.4
                            lastScale = 2.4
                        }
                    }
                }
        }
        .frame(width: viewportSize.width, height: viewportSize.height)
    }

    private func canvasDragGesture(in fittedSize: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                if tool == .view {
                    offset = CGSize(
                        width: lastOffset.width + value.translation.width,
                        height: lastOffset.height + value.translation.height
                    )
                } else {
                    let normStart = CGPoint(
                        x: min(max(0, value.startLocation.x / max(1, fittedSize.width)), 1),
                        y: min(max(0, value.startLocation.y / max(1, fittedSize.height)), 1)
                    )
                    let normCur = CGPoint(
                        x: min(max(0, value.location.x / max(1, fittedSize.width)), 1),
                        y: min(max(0, value.location.y / max(1, fittedSize.height)), 1)
                    )
                    switch tool {
                    case .rect:
                        draftAnnotation = ImageAnnotationItem(
                            kind: .rect(start: normStart, end: normCur),
                            color: selectedColor,
                            lineWidth: strokeWidth
                        )
                    case .ellipse:
                        draftAnnotation = ImageAnnotationItem(
                            kind: .ellipse(start: normStart, end: normCur),
                            color: selectedColor,
                            lineWidth: strokeWidth
                        )
                    case .triangle:
                        draftAnnotation = ImageAnnotationItem(
                            kind: .triangle(start: normStart, end: normCur),
                            color: selectedColor,
                            lineWidth: strokeWidth
                        )
                    case .brush:
                        if var existing = draftAnnotation, case .brush(var pts) = existing.kind {
                            pts.append(normCur)
                            existing.kind = .brush(points: pts)
                            draftAnnotation = existing
                        } else {
                            draftAnnotation = ImageAnnotationItem(
                                kind: .brush(points: [normStart, normCur]),
                                color: selectedColor,
                                lineWidth: strokeWidth + 1.5
                            )
                        }
                    case .view:
                        break
                    }
                }
            }
            .onEnded { _ in
                if tool == .view {
                    lastOffset = offset
                } else if let draftAnnotation {
                    var next = annotations
                    next.append(draftAnnotation)
                    let trimmedHistory = Array(history.prefix(historyIndex + 1)) + [next]
                    history = trimmedHistory
                    historyIndex = trimmedHistory.count - 1
                    self.draftAnnotation = nil
                }
            }
    }

    private func bottomToolbar(uiImage _: UIImage) -> some View {
        VStack(spacing: 8) {
            if chromeVisible && tool != .view {
                // Color & shape sub-bar
                HStack(spacing: 10) {
                    if tool == .rect || tool == .ellipse || tool == .triangle {
                        ForEach([
                            (ImageAnnotationTool.rect, "square"),
                            (ImageAnnotationTool.ellipse, "circle"),
                            (ImageAnnotationTool.triangle, "triangle"),
                        ], id: \.0.rawValue) { kind, icon in
                            Button {
                                activeMarkKind = kind
                                tool = kind
                            } label: {
                                Image(systemName: icon)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(tool == kind ? .black : .white)
                                    .frame(width: 28, height: 28)
                                    .background(tool == kind ? Color.white : Color.white.opacity(0.12), in: Circle())
                            }
                            .buttonStyle(.plain)
                        }
                        Divider().frame(height: 16).overlay(.white.opacity(0.2))
                    }

                    ForEach(Array(Self.presetColors.enumerated()), id: \.offset) { _, color in
                        Button {
                            selectedColor = color
                        } label: {
                            Circle()
                                .fill(color)
                                .frame(width: 20, height: 20)
                                .overlay(
                                    Circle()
                                        .strokeBorder(Color.white, lineWidth: selectedColor == color ? 2.2 : 0.6)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(.ultraThinMaterial, in: Capsule())
            }

            HStack(spacing: 6) {
                if chromeVisible {
                    toolbarToolButton(
                        icon: "arrow.up.and.down.and.arrow.left.and.right",
                        active: tool == .view
                    ) {
                        tool = .view
                    }

                    toolbarToolButton(
                        icon: activeMarkKind == .ellipse ? "circle" : (activeMarkKind == .triangle ? "triangle" : "square"),
                        active: tool == .rect || tool == .ellipse || tool == .triangle
                    ) {
                        tool = activeMarkKind
                    }

                    toolbarToolButton(
                        icon: "paintbrush.pointed",
                        active: tool == .brush
                    ) {
                        tool = .brush
                    }

                    Divider().frame(height: 18).overlay(.white.opacity(0.2))

                    Button {
                        if canUndo { historyIndex -= 1 }
                    } label: {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(canUndo ? .white : .white.opacity(0.3))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canUndo)

                    Button {
                        if canRedo { historyIndex += 1 }
                    } label: {
                        Image(systemName: "arrow.uturn.forward")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(canRedo ? .white : .white.opacity(0.3))
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canRedo)

                    Divider().frame(height: 18).overlay(.white.opacity(0.2))

                    Menu {
                        ForEach(Self.zoomPresets, id: \.self) { preset in
                            Button("\(Int(preset * 100))%") {
                                withAnimation(.spring(response: 0.26, dampingFraction: 0.86)) {
                                    scale = preset
                                    lastScale = preset
                                    if preset == 1.0 {
                                        offset = .zero
                                        lastOffset = .zero
                                    }
                                }
                            }
                        }
                    } label: {
                        Text("\(Int(round(scale * 100)))%")
                            .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8)
                            .frame(height: 28)
                            .background(Color.white.opacity(0.12), in: Capsule())
                    }

                    Button {
                        withAnimation(.spring(response: 0.26, dampingFraction: 0.86)) {
                            scale = 1.0
                            lastScale = 1.0
                            offset = .zero
                            lastOffset = .zero
                        }
                    } label: {
                        Image(systemName: "arrow.up.left.and.down.right.magnifyingglass")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(.plain)
                }

                Button {
                    withAnimation(.spring(response: 0.25, dampingFraction: 0.86)) {
                        chromeVisible.toggle()
                    }
                } label: {
                    Image(systemName: chromeVisible ? "chevron.down.2" : "chevron.up.2")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
        }
    }

    private func toolbarToolButton(icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(active ? .black : .white)
                .frame(width: 30, height: 30)
                .background(active ? Color.white : Color.clear, in: Circle())
        }
        .buttonStyle(.plain)
    }

    private func fittedImageSize(for imageSize: CGSize, in viewport: CGSize) -> CGSize {
        let maxW = max(1, viewport.width - 24)
        let maxH = max(1, viewport.height - 140)
        guard imageSize.width > 0, imageSize.height > 0 else {
            return CGSize(width: maxW, height: maxH)
        }
        let ratio = min(maxW / imageSize.width, maxH / imageSize.height)
        return CGSize(width: imageSize.width * ratio, height: imageSize.height * ratio)
    }

    private func drawAnnotation(_ ann: ImageAnnotationItem, in context: inout GraphicsContext, size: CGSize) {
        let style = StrokeStyle(lineWidth: ann.lineWidth, lineCap: .round, lineJoin: .round)
        switch ann.kind {
        case .rect(let s, let e):
            let rect = CGRect(
                x: min(s.x, e.x) * size.width,
                y: min(s.y, e.y) * size.height,
                width: abs(e.x - s.x) * size.width,
                height: abs(e.y - s.y) * size.height
            )
            context.stroke(Path(roundedRect: rect, cornerRadius: 4), with: .color(ann.color), style: style)
        case .ellipse(let s, let e):
            let rect = CGRect(
                x: min(s.x, e.x) * size.width,
                y: min(s.y, e.y) * size.height,
                width: abs(e.x - s.x) * size.width,
                height: abs(e.y - s.y) * size.height
            )
            context.stroke(Path(ellipseIn: rect), with: .color(ann.color), style: style)
        case .triangle(let s, let e):
            let minX = min(s.x, e.x) * size.width
            let maxX = max(s.x, e.x) * size.width
            let minY = min(s.y, e.y) * size.height
            let maxY = max(s.y, e.y) * size.height
            var path = Path()
            path.move(to: CGPoint(x: (minX + maxX) / 2, y: minY))
            path.addLine(to: CGPoint(x: maxX, y: maxY))
            path.addLine(to: CGPoint(x: minX, y: maxY))
            path.closeSubpath()
            context.stroke(path, with: .color(ann.color), style: style)
        case .brush(let points):
            guard let first = points.first else { return }
            var path = Path()
            path.move(to: CGPoint(x: first.x * size.width, y: first.y * size.height))
            for pt in points.dropFirst() {
                path.addLine(to: CGPoint(x: pt.x * size.width, y: pt.y * size.height))
            }
            context.stroke(path, with: .color(ann.color.opacity(0.88)), style: style)
        }
    }

    private func renderAnnotatedImage(base: UIImage) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: base.size)
        return renderer.image { _ in
            base.draw(in: CGRect(origin: .zero, size: base.size))
            guard let cg = UIGraphicsGetCurrentContext() else { return }
            let scaleFactor = max(base.size.width, base.size.height) / 360.0
            for ann in annotations {
                cg.saveGState()
                cg.setStrokeColor(UIColor(ann.color).cgColor)
                cg.setLineWidth(ann.lineWidth * max(1, scaleFactor))
                cg.setLineCap(.round)
                cg.setLineJoin(.round)
                switch ann.kind {
                case .rect(let s, let e):
                    let rect = CGRect(
                        x: min(s.x, e.x) * base.size.width,
                        y: min(s.y, e.y) * base.size.height,
                        width: abs(e.x - s.x) * base.size.width,
                        height: abs(e.y - s.y) * base.size.height
                    )
                    cg.stroke(rect)
                case .ellipse(let s, let e):
                    let rect = CGRect(
                        x: min(s.x, e.x) * base.size.width,
                        y: min(s.y, e.y) * base.size.height,
                        width: abs(e.x - s.x) * base.size.width,
                        height: abs(e.y - s.y) * base.size.height
                    )
                    cg.strokeEllipse(in: rect)
                case .triangle(let s, let e):
                    let minX = min(s.x, e.x) * base.size.width
                    let maxX = max(s.x, e.x) * base.size.width
                    let minY = min(s.y, e.y) * base.size.height
                    let maxY = max(s.y, e.y) * base.size.height
                    cg.beginPath()
                    cg.move(to: CGPoint(x: (minX + maxX) / 2, y: minY))
                    cg.addLine(to: CGPoint(x: maxX, y: maxY))
                    cg.addLine(to: CGPoint(x: minX, y: maxY))
                    cg.closePath()
                    cg.strokePath()
                case .brush(let points):
                    if let first = points.first {
                        cg.beginPath()
                        cg.move(to: CGPoint(x: first.x * base.size.width, y: first.y * base.size.height))
                        for pt in points.dropFirst() {
                            cg.addLine(to: CGPoint(x: pt.x * base.size.width, y: pt.y * base.size.height))
                        }
                        cg.strokePath()
                    }
                }
                cg.restoreGState()
            }
        }
    }

    private func loadImageIfNeeded() async {
        if item.image != nil { return }
        guard let raw = item.urlString?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return }
        if let decoded = AttachmentImageStore.decodeImage(from: raw) {
            loadedImage = decoded
            return
        }
        guard let url = URL(string: raw), url.scheme == "http" || url.scheme == "https" else { return }
        isLoading = true
        defer { isLoading = false }
        if let (data, _) = try? await URLSession.shared.data(from: url),
           let img = UIImage(data: data)
        {
            loadedImage = img
        }
    }
}

// MARK: - Inline Image Frame (`.conv-md-image-frame`)

struct MarkdownImageFrameView: View {
    let src: String
    let alt: String
    var fixedImage: UIImage? = nil

    @State private var loadedImage: UIImage?
    @State private var previewItem: PreviewableImageItem?

    var body: some View {
        let displayImage = fixedImage ?? loadedImage ?? AttachmentImageStore.decodeImage(from: src)
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            previewItem = PreviewableImageItem(
                id: src.isEmpty ? alt : src,
                image: displayImage,
                urlString: src.isEmpty ? nil : src,
                title: alt.isEmpty ? ((src as NSString).lastPathComponent.isEmpty ? "图片预览" : (src as NSString).lastPathComponent) : alt
            )
        } label: {
            if let displayImage {
                VStack(alignment: .leading, spacing: 0) {
                    Image(uiImage: displayImage)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 320, maxHeight: 280)
                        .background(Color(.tertiarySystemGroupedBackground))

                    if !alt.isEmpty {
                        HStack(spacing: 6) {
                            Image(systemName: "photo")
                                .font(.system(size: 10.5, weight: .medium))
                                .foregroundStyle(.secondary)
                            Text(alt)
                                .font(.system(size: 11.5))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color(.secondarySystemGroupedBackground))
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.75)
                )
            } else {
                // `.conv-md-image-placeholder`
                HStack(spacing: 6) {
                    Image(systemName: "photo")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text(alt.isEmpty ? (src as NSString).lastPathComponent : alt)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    Capsule()
                        .fill(Color(.secondarySystemGroupedBackground))
                )
                .overlay(
                    Capsule()
                        .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.75)
                )
            }
        }
        .buttonStyle(.plain)
        .task(id: src) {
            guard fixedImage == nil, loadedImage == nil else { return }
            if let decoded = AttachmentImageStore.decodeImage(from: src) {
                loadedImage = decoded
                return
            }
            guard let url = URL(string: src), url.scheme == "http" || url.scheme == "https" else { return }
            if let (data, _) = try? await URLSession.shared.data(from: url),
               let img = UIImage(data: data)
            {
                loadedImage = img
            }
        }
        .fullScreenCover(item: $previewItem) { item in
            ZoomableImagePreviewSheet(item: item)
        }
    }
}

// MARK: - VibeX Conversation Markdown Component (`AstryxMarkdown.tsx` + `conv-markdown.css`)

struct StreamingMessageText: View {
    let text: String
    let isStreaming: Bool
    let showCopyButton: Bool
    let copyPayload: String?

    @State private var displayedText: String
    @State private var targetText: String
    @State private var animationTask: Task<Void, Never>?
    @State private var copiedMessage = false

    init(
        text: String,
        streaming: Bool,
        showCopyButton: Bool = true,
        copyPayload: String? = nil
    ) {
        self.text = text
        self.isStreaming = streaming
        self.showCopyButton = showCopyButton
        self.copyPayload = copyPayload
        _displayedText = State(initialValue: text)
        _targetText = State(initialValue: text)
    }

    init(
        text: String,
        isStreaming: Bool,
        showCopyButton: Bool = true,
        copyPayload: String? = nil
    ) {
        self.init(
            text: text,
            streaming: isStreaming,
            showCopyButton: showCopyButton,
            copyPayload: copyPayload
        )
    }

    var body: some View {
        let blocks = MarkdownBlockParser.parse(displayedText)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                let isLastBlock = index == blocks.count - 1
                MarkdownBlockView(
                    block: block,
                    showCursor: isStreaming && isLastBlock
                )
            }
            if blocks.isEmpty && isStreaming {
                StreamingCursorPill()
            }
            if !isStreaming && showCopyButton && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                HStack {
                    Button {
                        UIPasteboard.general.string = copyPayload ?? text
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.easeInOut(duration: 0.15)) { copiedMessage = true }
                        Task {
                            try? await Task.sleep(for: .milliseconds(1200))
                            withAnimation(.easeInOut(duration: 0.15)) { copiedMessage = false }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: copiedMessage ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 11, weight: .medium))
                            if copiedMessage {
                                Text("已复制")
                                    .font(.system(size: 11, weight: .medium))
                            }
                        }
                        .foregroundStyle(copiedMessage ? .green : .secondary.opacity(0.75))
                        .padding(.vertical, 2)
                    }
                    .buttonStyle(.plain)
                    Spacer()
                }
                .padding(.top, 2)
            }
        }
        .textSelection(.enabled)
        .onChange(of: text) { _, newValue in
            targetText = newValue
            if !isStreaming {
                animationTask?.cancel()
                displayedText = newValue
                return
            }
            startSmoothCatchUpIfNeeded()
        }
        .onChange(of: isStreaming) { _, streaming in
            if !streaming {
                animationTask?.cancel()
                displayedText = targetText
            }
        }
        .onDisappear {
            animationTask?.cancel()
        }
    }

    private func startSmoothCatchUpIfNeeded() {
        if !targetText.hasPrefix(displayedText) {
            displayedText = targetText
            return
        }
        guard animationTask == nil else { return }
        animationTask = Task { @MainActor in
            defer { animationTask = nil }
            while !Task.isCancelled {
                let currentCount = displayedText.count
                let targetCount = targetText.count
                let remaining = targetCount - currentCount
                guard remaining > 0 else { break }

                let step: Int
                if remaining > 160 {
                    step = max(24, remaining / 3)
                } else if remaining > 48 {
                    step = max(8, remaining / 4)
                } else if remaining > 14 {
                    step = 4
                } else {
                    step = 2
                }

                let nextCount = min(targetCount, currentCount + step)
                if let endIdx = targetText.index(targetText.startIndex, offsetBy: nextCount, limitedBy: targetText.endIndex) {
                    displayedText = String(targetText[..<endIdx])
                } else {
                    displayedText = targetText
                }
                try? await Task.sleep(for: .milliseconds(16))
            }
        }
    }
}

private struct StreamingCursorPill: View {
    @State private var blink = false

    var body: some View {
        RoundedRectangle(cornerRadius: 1.5, style: .continuous)
            .fill(Color.accentColor)
            .frame(width: 3, height: 15)
            .opacity(blink ? 0.2 : 0.95)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.48).repeatForever(autoreverses: true)) {
                    blink = true
                }
            }
    }
}

// MARK: - Block AST (`conv-markdown`)

enum MarkdownAlertKind: String, Equatable {
    case note = "NOTE"
    case tip = "TIP"
    case important = "IMPORTANT"
    case warning = "WARNING"
    case caution = "CAUTION"

    var title: String {
        switch self {
        case .note: return "说明"
        case .tip: return "提示"
        case .important: return "重要"
        case .warning: return "注意"
        case .caution: return "警告"
        }
    }

    var icon: String {
        switch self {
        case .note: return "info.circle.fill"
        case .tip: return "lightbulb.fill"
        case .important: return "exclamationmark.bubble.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .caution: return "flame.fill"
        }
    }

    var tint: Color {
        switch self {
        case .note: return .blue
        case .tip: return .green
        case .important: return .purple
        case .warning: return .orange
        case .caution: return .red
        }
    }
}

enum MarkdownTableAlignment: Equatable {
    case leading, center, trailing
}

enum MarkdownBlock {
    case heading(level: Int, text: String)
    case paragraph(text: String)
    case codeBlock(language: String, code: String)
    case bulletList(items: [String])
    case numberedList(items: [(number: Int, text: String)])
    case taskList(items: [(checked: Bool, text: String)])
    case blockquote(text: String)
    case alert(kind: MarkdownAlertKind, text: String)
    case table(headers: [String], alignments: [MarkdownTableAlignment], rows: [[String]])
    case image(alt: String, src: String)
    case mathBlock(tex: String)
    case divider
}

enum MarkdownBlockParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        guard !source.isEmpty else { return [] }
        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var i = 0

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                i += 1
                continue
            }

            // 1. Display Math Block `$$ ... $$`
            if trimmed.hasPrefix("$$") {
                if trimmed.count > 4, trimmed.hasSuffix("$$") {
                    let inner = String(trimmed.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespacesAndNewlines)
                    blocks.append(.mathBlock(tex: inner))
                    i += 1
                    continue
                }
                i += 1
                var texLines: [String] = []
                while i < lines.count {
                    let cur = lines[i].trimmingCharacters(in: .whitespaces)
                    if cur.hasSuffix("$$") {
                        let tail = String(cur.dropLast(2)).trimmingCharacters(in: .whitespaces)
                        if !tail.isEmpty { texLines.append(tail) }
                        i += 1
                        break
                    }
                    texLines.append(lines[i])
                    i += 1
                }
                blocks.append(.mathBlock(tex: texLines.joined(separator: "\n")))
                continue
            }

            // 2. Fenced Code Block ```lang
            if trimmed.hasPrefix("```") {
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                i += 1
                var codeLines: [String] = []
                while i < lines.count {
                    let cur = lines[i]
                    if cur.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                        i += 1
                        break
                    }
                    codeLines.append(cur)
                    i += 1
                }
                blocks.append(.codeBlock(language: lang, code: codeLines.joined(separator: "\n")))
                continue
            }

            // 3. Horizontal rule
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                blocks.append(.divider)
                i += 1
                continue
            }

            // 4. Standalone Markdown Image `![alt](src)`
            if let img = parseStandaloneImage(trimmed) {
                blocks.append(.image(alt: img.alt, src: img.src))
                i += 1
                continue
            }

            // 5. Heading `#` .. `######`
            if let (level, headingText) = parseHeading(trimmed) {
                blocks.append(.heading(level: level, text: headingText))
                i += 1
                continue
            }

            // 6. GFM Table
            if i + 1 < lines.count,
               trimmed.contains("|"),
               let alignments = parseTableDelimiterRow(lines[i + 1].trimmingCharacters(in: .whitespaces))
            {
                let headers = splitTableCells(trimmed, expectedCount: alignments.count)
                i += 2
                var rows: [[String]] = []
                while i < lines.count {
                    let rowLine = lines[i].trimmingCharacters(in: .whitespaces)
                    guard !rowLine.isEmpty, rowLine.contains("|") else { break }
                    rows.append(splitTableCells(rowLine, expectedCount: headers.count))
                    i += 1
                }
                blocks.append(.table(headers: headers, alignments: alignments, rows: rows))
                continue
            }

            // 7. Blockquote or GitHub Alert `> [!NOTE]`
            if trimmed.hasPrefix(">") {
                var quoteLines: [String] = []
                while i < lines.count {
                    let cur = lines[i].trimmingCharacters(in: .whitespaces)
                    guard cur.hasPrefix(">") else { break }
                    var content = String(cur.dropFirst())
                    if content.hasPrefix(" ") { content.removeFirst() }
                    quoteLines.append(content)
                    i += 1
                }
                if let first = quoteLines.first,
                   let alertKind = parseAlertTag(first)
                {
                    let body = Array(quoteLines.dropFirst()).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                    blocks.append(.alert(kind: alertKind, text: body))
                } else {
                    blocks.append(.blockquote(text: quoteLines.joined(separator: "\n")))
                }
                continue
            }

            // 8. Task List `- [ ]` / `- [x]`
            if let firstTask = parseTaskItem(trimmed) {
                var items: [(checked: Bool, text: String)] = [firstTask]
                i += 1
                while i < lines.count {
                    let cur = lines[i].trimmingCharacters(in: .whitespaces)
                    guard let nextTask = parseTaskItem(cur) else { break }
                    items.append(nextTask)
                    i += 1
                }
                blocks.append(.taskList(items: items))
                continue
            }

            // 9. Bullet List `- ` / `* ` / `+ `
            if let firstBullet = parseBulletItem(trimmed) {
                var items: [String] = [firstBullet]
                i += 1
                while i < lines.count {
                    let cur = lines[i].trimmingCharacters(in: .whitespaces)
                    if parseTaskItem(cur) != nil { break }
                    guard let next = parseBulletItem(cur) else { break }
                    items.append(next)
                    i += 1
                }
                blocks.append(.bulletList(items: items))
                continue
            }

            // 10. Numbered List `1. `
            if let firstNum = parseNumberedItem(trimmed) {
                var items: [(number: Int, text: String)] = [firstNum]
                i += 1
                while i < lines.count {
                    let cur = lines[i].trimmingCharacters(in: .whitespaces)
                    guard let next = parseNumberedItem(cur) else { break }
                    items.append(next)
                    i += 1
                }
                blocks.append(.numberedList(items: items))
                continue
            }

            // 11. Paragraph
            var paraLines: [String] = [line]
            i += 1
            while i < lines.count {
                let nextLine = lines[i]
                let nextTrim = nextLine.trimmingCharacters(in: .whitespaces)
                if nextTrim.isEmpty
                    || nextTrim.hasPrefix("```")
                    || nextTrim.hasPrefix("$$")
                    || nextTrim == "---"
                    || nextTrim == "***"
                    || nextTrim == "___"
                    || parseStandaloneImage(nextTrim) != nil
                    || parseHeading(nextTrim) != nil
                    || nextTrim.hasPrefix(">")
                    || parseTaskItem(nextTrim) != nil
                    || parseBulletItem(nextTrim) != nil
                    || parseNumberedItem(nextTrim) != nil
                    || (i + 1 < lines.count && nextTrim.contains("|") && parseTableDelimiterRow(lines[i + 1].trimmingCharacters(in: .whitespaces)) != nil)
                {
                    break
                }
                paraLines.append(nextLine)
                i += 1
            }
            blocks.append(.paragraph(text: paraLines.joined(separator: "\n")))
        }

        return blocks
    }

    private static func parseHeading(_ line: String) -> (Int, String)? {
        var count = 0
        for ch in line {
            if ch == "#" { count += 1 } else { break }
        }
        guard (1...6).contains(count), line.count > count else { return nil }
        let idx = line.index(line.startIndex, offsetBy: count)
        guard line[idx] == " " else { return nil }
        return (count, String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces))
    }

    private static func parseAlertTag(_ line: String) -> MarkdownAlertKind? {
        let trimmed = line.trimmingCharacters(in: .whitespaces).uppercased()
        guard trimmed.hasPrefix("[!"), trimmed.hasSuffix("]") else { return nil }
        let raw = String(trimmed.dropFirst(2).dropLast())
        return MarkdownAlertKind(rawValue: raw)
    }

    private static func parseTaskItem(_ line: String) -> (checked: Bool, text: String)? {
        for prefix in ["- [ ] ", "* [ ] ", "+ [ ] "] {
            if line.hasPrefix(prefix) {
                return (false, String(line.dropFirst(prefix.count)))
            }
        }
        for prefix in ["- [x] ", "- [X] ", "* [x] ", "* [X] ", "+ [x] ", "+ [X] "] {
            if line.hasPrefix(prefix) {
                return (true, String(line.dropFirst(prefix.count)))
            }
        }
        return nil
    }

    private static func parseBulletItem(_ line: String) -> String? {
        for prefix in ["- ", "* ", "+ ", "• "] {
            if line.hasPrefix(prefix) {
                return String(line.dropFirst(prefix.count))
            }
        }
        return nil
    }

    private static func parseNumberedItem(_ line: String) -> (Int, String)? {
        guard let dotIndex = line.firstIndex(of: ".") else { return nil }
        let numPart = line[..<dotIndex]
        guard !numPart.isEmpty, numPart.allSatisfy(\.isNumber), let num = Int(numPart) else { return nil }
        let afterDot = line.index(after: dotIndex)
        guard afterDot < line.endIndex, line[afterDot] == " " else { return nil }
        let textPart = String(line[line.index(after: afterDot)...])
        return (num, textPart)
    }

    private static func parseStandaloneImage(_ line: String) -> (alt: String, src: String)? {
        guard line.hasPrefix("![") && line.hasSuffix(")"),
              let mid = line.range(of: "](")
        else { return nil }
        let alt = String(line[line.index(line.startIndex, offsetBy: 2)..<mid.lowerBound])
        let src = String(line[mid.upperBound..<line.index(before: line.endIndex)]).trimmingCharacters(in: .whitespaces)
        guard !src.isEmpty, !src.contains(" ") else { return nil }
        return (alt, src)
    }

    private static func parseTableDelimiterRow(_ line: String) -> [MarkdownTableAlignment]? {
        guard line.contains("|") && line.contains("-") else { return nil }
        let rawCells = splitRawCells(line)
        guard !rawCells.isEmpty else { return nil }
        var alignments: [MarkdownTableAlignment] = []
        for cell in rawCells {
            let c = cell.trimmingCharacters(in: .whitespaces)
            guard !c.isEmpty else { return nil }
            let core = c.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard core.count >= 1, core.allSatisfy({ $0 == "-" }) else { return nil }
            let starts = c.hasPrefix(":")
            let ends = c.hasSuffix(":")
            if starts && ends {
                alignments.append(.center)
            } else if ends {
                alignments.append(.trailing)
            } else {
                alignments.append(.leading)
            }
        }
        return alignments
    }

    private static func splitTableCells(_ line: String, expectedCount: Int) -> [String] {
        var cells = splitRawCells(line).map { $0.trimmingCharacters(in: .whitespaces) }
        if cells.count < expectedCount {
            cells.append(contentsOf: Array(repeating: "", count: expectedCount - cells.count))
        } else if cells.count > expectedCount && expectedCount > 0 {
            cells = Array(cells.prefix(expectedCount))
        }
        return cells
    }

    private static func splitRawCells(_ line: String) -> [String] {
        var s = line.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") { s.removeLast() }
        return s.components(separatedBy: "|")
    }
}

// MARK: - Block View Renderer (`AstryxMarkdown` + `conv-markdown.css`)

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let showCursor: Bool

    var body: some View {
        switch block {
        case .heading(let level, let text):
            HStack(alignment: .lastTextBaseline, spacing: 4) {
                Text(Self.inlineAttributed(text))
                    .font(.system(size: headingSize(level), weight: .semibold))
                    .tracking(0.1)
                    .foregroundStyle(.primary)
                if showCursor { StreamingCursorPill() }
            }
            .padding(.top, level <= 2 ? 3 : 1)

        case .paragraph(let text):
            HStack(alignment: .lastTextBaseline, spacing: 3) {
                Text(Self.inlineAttributed(text))
                    .font(.system(size: 14.5))
                    .lineSpacing(4.5)
                    .foregroundStyle(.primary)
                if showCursor { StreamingCursorPill() }
            }

        case .codeBlock(let language, let code):
            VibeXMarkdownCodeSwitch(language: language, code: code)

        case .bulletList(let items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•")
                            .font(.system(size: 14.5, weight: .bold))
                            .foregroundStyle(.secondary)
                            .frame(width: 10, alignment: .center)
                        HStack(alignment: .lastTextBaseline, spacing: 3) {
                            Text(Self.inlineAttributed(item))
                                .font(.system(size: 14.5))
                                .lineSpacing(4)
                                .foregroundStyle(.primary)
                            if showCursor && idx == items.count - 1 {
                                StreamingCursorPill()
                            }
                        }
                    }
                }
            }
            .padding(.vertical, 2)

        case .numberedList(let items):
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, entry in
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text("\(entry.number).")
                            .font(.system(size: 13.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(.secondary)
                        HStack(alignment: .lastTextBaseline, spacing: 3) {
                            Text(Self.inlineAttributed(entry.text))
                                .font(.system(size: 14.5))
                                .lineSpacing(4)
                                .foregroundStyle(.primary)
                            if showCursor && idx == items.count - 1 {
                                StreamingCursorPill()
                            }
                        }
                    }
                }
            }
            .padding(.vertical, 2)

        case .taskList(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: item.checked ? "checkmark.square.fill" : "square")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(item.checked ? Color.accentColor : .secondary)
                        HStack(alignment: .lastTextBaseline, spacing: 3) {
                            Text(Self.inlineAttributed(item.text))
                                .font(.system(size: 14.5))
                                .lineSpacing(4)
                                .strikethrough(item.checked, color: .secondary)
                                .foregroundStyle(item.checked ? .secondary : .primary)
                            if showCursor && idx == items.count - 1 {
                                StreamingCursorPill()
                            }
                        }
                    }
                }
            }
            .padding(.vertical, 2)

        case .blockquote(let text):
            // Matches `.conv-markdown :where(blockquote)` in `conv-markdown.css`:
            // padding 6px 10px, border 1px solid var(--conv-border-subtle), background var(--conv-surface-control), border-radius 8px
            Text(Self.inlineAttributed(text))
                .font(.system(size: 14))
                .lineSpacing(4)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color(.secondarySystemGroupedBackground))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
                )

        case .alert(let kind, let text):
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Image(systemName: kind.icon)
                        .font(.system(size: 12.5, weight: .semibold))
                    Text(kind.title)
                        .font(.system(size: 12.5, weight: .semibold))
                }
                .foregroundStyle(kind.tint)

                if !text.isEmpty {
                    Text(Self.inlineAttributed(text))
                        .font(.system(size: 13.5))
                        .lineSpacing(3.5)
                        .foregroundStyle(.primary.opacity(0.9))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(kind.tint.opacity(0.08))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(kind.tint.opacity(0.25), lineWidth: 0.8)
            )

        case .table(let headers, let alignments, let rows):
            VibeXMarkdownTableView(headers: headers, alignments: alignments, rows: rows)

        case .image(let alt, let src):
            MarkdownImageFrameView(src: src, alt: alt)

        case .mathBlock(let tex):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(tex)
                    .font(.system(size: 13.5, design: .serif).italic())
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.6)
            )

        case .divider:
            Divider()
                .padding(.top, 8)
                .padding(.bottom, 12)
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return 17
        case 2: return 16
        case 3: return 15
        default: return 14.5
        }
    }

    /// Parses inline Markdown (`**bold**`, `*italic*`, `` `code` ``, `[label](url)`, `$math$`)
    /// and styles inline code & file references to match `AstryxMarkdown.tsx` + `conv-markdown.css`.
    static func inlineAttributed(_ raw: String) -> AttributedString {
        let normalized = raw.replacingOccurrences(of: #"\$([^$\n]+)\$"#, with: "`$1`", options: .regularExpression)
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        guard var attributed = try? AttributedString(markdown: normalized, options: options) else {
            return AttributedString(raw)
        }
        for run in attributed.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                let textSlice = String(attributed[run.range].characters)
                attributed[run.range].font = .system(size: 13, weight: .medium, design: .monospaced)
                if looksLikeWorkspaceResource(textSlice) {
                    attributed[run.range].foregroundColor = .accentColor
                    attributed[run.range].backgroundColor = Color.accentColor.opacity(0.10)
                } else {
                    attributed[run.range].backgroundColor = Color.primary.opacity(0.07)
                }
            } else if run.link != nil {
                attributed[run.range].foregroundColor = .accentColor
                attributed[run.range].underlineStyle = .single
            }
        }
        return attributed
    }

    private static func looksLikeWorkspaceResource(_ candidate: String) -> Bool {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains(" ") else { return false }
        if trimmed.hasPrefix("/") || trimmed.hasPrefix("./") || trimmed.contains("/") {
            return trimmed.contains(".")
        }
        let exts = [".swift", ".ts", ".tsx", ".rs", ".js", ".jsx", ".json", ".md", ".css", ".py", ".go", ".toml", ".yaml", ".yml", ".html"]
        return exts.contains { trimmed.lowercased().hasSuffix($0) }
    }
}

// MARK: - GFM Table View (`.conv-markdown table`)

private struct VibeXMarkdownTableView: View {
    let headers: [String]
    let alignments: [MarkdownTableAlignment]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                // Header row (`thead tr th`)
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { colIdx, header in
                        tableCell(
                            text: header,
                            isHeader: true,
                            alignment: alignment(for: colIdx),
                            isLastCol: colIdx == headers.count - 1,
                            isLastRow: rows.isEmpty
                        )
                    }
                }
                .background(Color(.tertiarySystemGroupedBackground))

                // Body rows (`tbody tr td`)
                ForEach(Array(rows.enumerated()), id: \.offset) { rowIdx, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { colIdx, cell in
                            tableCell(
                                text: cell,
                                isHeader: false,
                                alignment: alignment(for: colIdx),
                                isLastCol: colIdx == row.count - 1,
                                isLastRow: rowIdx == rows.count - 1
                            )
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.75)
            )
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
        }
        .padding(.vertical, 2)
    }

    private func alignment(for colIdx: Int) -> Alignment {
        guard alignments.indices.contains(colIdx) else { return .leading }
        switch alignments[colIdx] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func tableCell(
        text: String,
        isHeader: Bool,
        alignment: Alignment,
        isLastCol: Bool,
        isLastRow: Bool
    ) -> some View {
        Text(MarkdownBlockView.inlineAttributed(text))
            .font(.system(size: 13, weight: isHeader ? .semibold : .regular))
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minWidth: 68, maxWidth: 260, alignment: alignment)
            .overlay(alignment: .bottom) {
                if !isLastRow {
                    Rectangle()
                        .fill(Color.primary.opacity(0.08))
                        .frame(height: 0.6)
                }
            }
            .overlay(alignment: .trailing) {
                if !isLastCol {
                    Rectangle()
                        .fill(Color.primary.opacity(0.08))
                        .frame(width: 0.6)
                }
            }
    }
}

// MARK: - Code Switch (`MarkdownCodeSwitch` + `CodeBlock.tsx` + `conv-markdown.css`)

private struct VibeXMarkdownCodeSwitch: View {
    let language: String
    let code: String
    @State private var copied = false

    private var detectedLanguage: CodeLanguage {
        CodeLanguage.detectFromFence(language)
    }

    private var isSingleLine: Bool {
        !code.contains("\n")
    }

    private var isMermaid: Bool {
        language.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "mermaid"
    }

    var body: some View {
        if isMermaid {
            mermaidBlock
        } else if isSingleLine {
            compactSingleLineBlock
        } else {
            fencedCodeBlock
        }
    }

    // Matches `CompactCodeBlock` (`.conv-md-codeblock-single`) in `CodeBlock.tsx`
    private var compactSingleLineBlock: some View {
        let highlighted = CodeHighlighter.highlight(code, language: detectedLanguage)
        return HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                if let first = highlighted.first {
                    Text(first)
                        .font(.system(size: 13, design: .monospaced))
                } else {
                    Text(code)
                        .font(.system(size: 13, design: .monospaced))
                }
            }
            Spacer(minLength: 4)
            copyButton
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
        )
        .padding(.vertical, 2)
    }

    // Matches `CodeBlock` (`.conv-md-codeblock`) in `CodeBlock.tsx` + `conv-markdown.css`
    private var fencedCodeBlock: some View {
        let highlighted = CodeHighlighter.highlight(code, language: detectedLanguage)
        let label = language.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "TEXT"
            : language.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()

        return VStack(alignment: .leading, spacing: 0) {
            // `.conv-md-codeblock-header`
            HStack(spacing: 8) {
                Text(label)
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.45)
                    .foregroundStyle(.secondary)
                Spacer()
                copyButton
            }
            .padding(.leading, 10)
            .padding(.trailing, 6)
            .padding(.vertical, 3)
            .frame(minHeight: 28)
            .background(Color(.tertiarySystemGroupedBackground))

            Divider().opacity(0.5)

            // `.conv-md-codeblock pre`
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(highlighted.enumerated()), id: \.offset) { _, line in
                        Text(line.characters.isEmpty ? AttributedString(" ") : line)
                            .font(.system(size: 13, design: .monospaced))
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
        )
        .padding(.vertical, 3)
    }

    // Matches `.conv-md-mermaid`
    private var mermaidBlock: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                Text("MERMAID 流程图")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(0.4)
                    .foregroundStyle(.secondary)
                Spacer()
                copyButton
            }
            .padding(.leading, 10)
            .padding(.trailing, 6)
            .padding(.vertical, 4)
            .frame(minHeight: 28)
            .background(Color(.tertiarySystemGroupedBackground))

            Divider().opacity(0.5)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 12.5, design: .monospaced))
                    .foregroundStyle(.primary)
                    .padding(12)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
        )
        .padding(.vertical, 3)
    }

    // Matches `.conv-md-codeblock-copy` & `.is-copied`
    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = code
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            withAnimation(.easeInOut(duration: 0.15)) { copied = true }
            Task {
                try? await Task.sleep(for: .milliseconds(1200))
                withAnimation(.easeInOut(duration: 0.15)) { copied = false }
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(copied ? .green : .secondary)
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(copied ? Color.green.opacity(0.10) : Color.clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(copied ? Color.green.opacity(0.45) : Color.clear, lineWidth: 0.75)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "已复制" : "复制代码")
    }
}
