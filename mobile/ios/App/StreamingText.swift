import SwiftUI

/// An assistant answer. As the transcript grows, the new words resolve out of blur one after another;
/// once the turn is done a small action row appears.
struct StreamingMessageText: View {
    let text: String
    let streaming: Bool

    @State private var settled = 0
    @State private var progress = 1.0
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            rendered
                .font(.system(size: 15))
                .lineSpacing(4)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !streaming && !text.isEmpty {
                Button {
                    UIPasteboard.general.string = text
                    withAnimation { copied = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        withAnimation { copied = false }
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 24)
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("复制")
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.3), value: streaming)
        .onAppear { settled = text.count }
        .onChange(of: text) { old, new in
            guard new.hasPrefix(old), new.count > old.count else {
                settled = new.count
                progress = 1
                return
            }
            settled = old.count
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { progress = 0 }
            Task { @MainActor in
                await Task.yield()
                withAnimation(.easeOut(duration: 0.55)) { progress = 1 }
            }
        }
    }

    @ViewBuilder
    private var rendered: some View {
        let display = streaming ? text + "▍" : text
        if #available(iOS 18.0, *) {
            Text(display).textRenderer(RevealRenderer(settled: settled, progress: progress, hasCursor: streaming))
        } else {
            Text(display)
        }
    }
}

@available(iOS 18.0, *)
private struct RevealRenderer: TextRenderer {
    var settled: Int
    var progress: Double
    var hasCursor: Bool

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        let slices = layout.flatMap { $0 }.flatMap { $0 }
        let fresh = max(1, slices.count - settled - (hasCursor ? 1 : 0))
        for (index, slice) in slices.enumerated() {
            if index < settled || (hasCursor && index == slices.count - 1) {
                context.draw(slice)
                continue
            }
            let order = Double(index - settled) / Double(fresh)
            let local = min(1, max(0, progress * 1.6 - 0.6 * order))
            var copy = context
            copy.opacity = local
            copy.addFilter(.blur(radius: (1 - local) * 4))
            copy.draw(slice)
        }
    }
}
