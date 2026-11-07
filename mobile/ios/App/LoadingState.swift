import SwiftUI

/// 3×3 pixel grid with a chevron wavefront driving right; two fronts are always in flight.
struct PixelLoader: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let cycle = 650.0
    private let delays: [Double] = (0..<9).map { index in
        let row = index / 3, column = index % 3
        return Double((column + abs(row - 1)) * 90)
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let now = context.date.timeIntervalSinceReferenceDate * 1000
            Grid(horizontalSpacing: 1.5, verticalSpacing: 1.5) {
                ForEach(0..<3, id: \.self) { row in
                    GridRow {
                        ForEach(0..<3, id: \.self) { column in
                            RoundedRectangle(cornerRadius: 1)
                                .fill(Color.primary)
                                .frame(width: 4, height: 4)
                                .opacity(opacity(now: now, index: row * 3 + column))
                        }
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }

    private func opacity(now: Double, index: Int) -> Double {
        guard !reduceMotion else { return 0.15 }
        let local = (now - delays[index]).truncatingRemainder(dividingBy: cycle)
        let phase = (local < 0 ? local + cycle : local) / cycle
        return 0.15 + 0.85 * pow(sin(.pi * phase), 2)
    }
}

/// Label whose highlight sweeps across it while work is in progress.
struct ShimmerText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let phase = (context.date.timeIntervalSinceReferenceDate / 1.4).truncatingRemainder(dividingBy: 1)
            Text(text)
                .foregroundStyle(.secondary)
                .overlay {
                    if !reduceMotion {
                        Text(text)
                            .foregroundStyle(.primary)
                            .mask {
                                GeometryReader { proxy in
                                    LinearGradient(
                                        colors: [.clear, .black, .clear],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                    .frame(width: proxy.size.width * 0.6)
                                    .offset(x: (phase * 1.6 - 0.3) * proxy.size.width)
                                }
                            }
                    }
                }
        }
    }
}

/// Long-running work indicator: pixel grid, shimmering label and a live elapsed timer.
struct LoadingState: View {
    let label: String
    @State private var started = Date()

    var body: some View {
        HStack(spacing: 10) {
            PixelLoader()
            ShimmerText(text: label).font(.system(size: 13, weight: .medium))
            TimelineView(.periodic(from: started, by: 0.1)) { context in
                Text(elapsed(context.date.timeIntervalSince(started)))
                    .font(.system(size: 12, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }

    private func elapsed(_ seconds: TimeInterval) -> String {
        seconds < 60
            ? String(format: "%.1fs", seconds)
            : String(format: "%dm %.1fs", Int(seconds) / 60, seconds.truncatingRemainder(dividingBy: 60))
    }
}
