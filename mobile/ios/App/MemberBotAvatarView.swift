import CompanionCore
import SwiftUI

extension Color {
    init?(collabHex raw: String?) {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        let normalized = CollabBotAvatarConfig.normalizeHexColor(raw, fallback: "")
        guard normalized.count == 7, normalized.hasPrefix("#"),
              let val = Int(normalized.dropFirst(), radix: 16)
        else {
            return nil
        }
        self.init(
            red: Double((val >> 16) & 0xFF) / 255.0,
            green: Double((val >> 8) & 0xFF) / 255.0,
            blue: Double(val & 0xFF) / 255.0
        )
    }
}

// MARK: - Bot Session Emotes (Desktop 12-Emote Sequence)

enum BotSessionEmote: String, CaseIterable, Sendable {
    case idle
    case happy
    case curious
    case excited
    case thinking
    case nodding
    case surprised
    case laughing
    case focused
    case wink
    case confused
    case sleepy
    case proud

    var expression: BotAvatarExpression {
        switch self {
        case .idle: return .neutral
        case .happy: return .happy
        case .curious: return .curious
        case .excited: return .excited
        case .thinking: return .attentive
        case .nodding: return .proud
        case .surprised: return .surprised
        case .laughing: return .laughing
        case .focused: return .suspicious
        case .wink: return .shy
        case .confused: return .confused
        case .sleepy: return .sleepy
        case .proud: return .proud
        }
    }

    static let sequence: [BotSessionEmote] = [
        .happy, .curious, .excited, .thinking, .nodding, .surprised,
        .laughing, .focused, .wink, .confused, .sleepy, .proud,
    ]
}

// MARK: - Bot Avatar Shape Path (64x64 Coordinate Space, Desktop Parity)

struct BotAvatarShapePath: Shape {
    let shape: BotAvatarShape

    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 64.0
        let sy = rect.height / 64.0
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
        }

        var p = Path()
        switch shape {
        case .circle:
            p.addEllipse(in: CGRect(x: rect.minX + 8 * sx, y: rect.minY + 8 * sy, width: 48 * sx, height: 48 * sy))

        case .cloud:
            p.move(to: pt(20.5, 48.5))
            p.addCurve(to: pt(6.8, 36.2), control1: pt(12, 48.5), control2: pt(6.8, 43.2))
            p.addCurve(to: pt(15.6, 24.8), control1: pt(6.8, 30.8), control2: pt(10.4, 26.2))
            p.addCurve(to: pt(32.8, 10.5), control1: pt(17.1, 16), control2: pt(24.2, 10.5))
            p.addCurve(to: pt(50.8, 25), control1: pt(41.8, 10.5), control2: pt(49.2, 16.5))
            p.addCurve(to: pt(57.2, 35.5), control1: pt(55, 26.8), control2: pt(57.2, 30.8))
            p.addCurve(to: pt(43, 48.5), control1: pt(57.2, 43.2), control2: pt(51, 48.5))
            p.closeSubpath()

        case .squircle:
            p.addRoundedRect(
                in: CGRect(x: rect.minX + 10.5 * sx, y: rect.minY + 10.5 * sy, width: 43 * sx, height: 43 * sy),
                cornerSize: CGSize(width: 10.5 * sx, height: 10.5 * sy),
                style: .continuous
            )

        case .sparkle:
            p.move(to: pt(32, 6))
            p.addCurve(to: pt(46.2, 21.5), control1: pt(37.5, 6), control2: pt(41.2, 17.5))
            p.addCurve(to: pt(58, 32), control1: pt(51.2, 25.5), control2: pt(58, 27))
            p.addCurve(to: pt(46.2, 42.5), control1: pt(58, 37), control2: pt(51.2, 38.5))
            p.addCurve(to: pt(32, 58), control1: pt(41.2, 46.5), control2: pt(37.5, 58))
            p.addCurve(to: pt(17.8, 42.5), control1: pt(26.5, 58), control2: pt(22.8, 46.5))
            p.addCurve(to: pt(6, 32), control1: pt(12.8, 38.5), control2: pt(6, 37))
            p.addCurve(to: pt(17.8, 21.5), control1: pt(6, 27), control2: pt(12.8, 25.5))
            p.addCurve(to: pt(32, 6), control1: pt(22.8, 17.5), control2: pt(26.5, 6))
            p.closeSubpath()

        case .clover:
            p.move(to: pt(32, 13.5))
            p.addCurve(to: pt(13.8, 21.8), control1: pt(24, 5.5), control2: pt(11.2, 10.8))
            p.addCurve(to: pt(13.8, 42.2), control1: pt(6.5, 25.2), control2: pt(6.5, 38.8))
            p.addCurve(to: pt(32, 50.5), control1: pt(11.2, 53.2), control2: pt(24, 58.5))
            p.addCurve(to: pt(50.2, 42.2), control1: pt(40, 58.5), control2: pt(52.8, 53.2))
            p.addCurve(to: pt(50.2, 21.8), control1: pt(57.5, 38.8), control2: pt(57.5, 25.2))
            p.addCurve(to: pt(32, 13.5), control1: pt(52.8, 10.8), control2: pt(40, 5.5))
            p.closeSubpath()

        case .heart:
            p.move(to: pt(32, 53.5))
            p.addCurve(to: pt(8.5, 23.2), control1: pt(27.8, 50.6), control2: pt(8.5, 37.8))
            p.addCurve(to: pt(23.8, 8.5), control1: pt(8.5, 13.8), control2: pt(15.8, 8.5))
            p.addCurve(to: pt(32, 13), control1: pt(27.8, 8.5), control2: pt(30.5, 10.5))
            p.addCurve(to: pt(40.2, 8.5), control1: pt(33.5, 10.5), control2: pt(36.2, 8.5))
            p.addCurve(to: pt(55.5, 23.2), control1: pt(48.2, 8.5), control2: pt(55.5, 13.8))
            p.addCurve(to: pt(32, 53.5), control1: pt(55.5, 37.8), control2: pt(36.2, 50.6))
            p.closeSubpath()

        case .pebble:
            p.move(to: pt(32, 9))
            p.addCurve(to: pt(42.5, 14), control1: pt(36, 6), control2: pt(42, 8.5))
            p.addCurve(to: pt(50.5, 23.5), control1: pt(48, 13.5), control2: pt(52.5, 18))
            p.addCurve(to: pt(52, 36.5), control1: pt(55.5, 26), control2: pt(56.5, 32.5))
            p.addCurve(to: pt(46, 47.5), control1: pt(55, 41.5), control2: pt(51.5, 47.5))
            p.addCurve(to: pt(34, 52.5), control1: pt(45, 53), control2: pt(39, 56))
            p.addCurve(to: pt(21.5, 49.5), control1: pt(30, 56.5), control2: pt(23.5, 55))
            p.addCurve(to: pt(13.5, 40), control1: pt(16, 50.5), control2: pt(11.5, 45.5))
            p.addCurve(to: pt(12, 27), control1: pt(8.5, 37.5), control2: pt(7.5, 31))
            p.addCurve(to: pt(18, 16), control1: pt(9, 22), control2: pt(12.5, 16))
            p.addCurve(to: pt(30, 11), control1: pt(19, 10.5), control2: pt(25, 7.5))
            p.closeSubpath()

        case .droplet:
            p.move(to: pt(32, 7.5))
            p.addCurve(to: pt(53.5, 38.5), control1: pt(36.5, 7.5), control2: pt(53.5, 25.5))
            p.addCurve(to: pt(32, 55.8), control1: pt(53.5, 49.8), control2: pt(44.2, 55.8))
            p.addCurve(to: pt(10.5, 38.5), control1: pt(19.8, 55.8), control2: pt(10.5, 49.8))
            p.addCurve(to: pt(32, 7.5), control1: pt(10.5, 25.5), control2: pt(27.5, 7.5))
            p.closeSubpath()

        case .capsule:
            p.addRoundedRect(
                in: CGRect(x: rect.minX + 7.5 * sx, y: rect.minY + 15 * sy, width: 49 * sx, height: 34 * sy),
                cornerSize: CGSize(width: 17 * sx, height: 17 * sy),
                style: .continuous
            )

        case .triangle:
            p.move(to: pt(26, 9.5))
            p.addQuadCurve(to: pt(38, 9.5), control: pt(32, 2.5))
            p.addLine(to: pt(55.5, 40))
            p.addQuadCurve(to: pt(50.5, 51.5), control: pt(60.5, 48.5))
            p.addQuadCurve(to: pt(13.5, 51.5), control: pt(32, 55.5))
            p.addQuadCurve(to: pt(8.5, 40), control: pt(3.5, 48.5))
            p.closeSubpath()

        case .pentagon:
            p.move(to: pt(27.5, 9.2))
            p.addQuadCurve(to: pt(36.5, 9.2), control: pt(32, 6))
            p.addLine(to: pt(52.5, 20.8))
            p.addQuadCurve(to: pt(54.8, 28.8), control: pt(56.5, 23.8))
            p.addLine(to: pt(48.8, 47.5))
            p.addQuadCurve(to: pt(41.8, 52.5), control: pt(47.2, 52.5))
            p.addLine(to: pt(22.2, 52.5))
            p.addQuadCurve(to: pt(15.2, 47.5), control: pt(16.8, 52.5))
            p.addLine(to: pt(9.2, 28.8))
            p.addQuadCurve(to: pt(11.5, 20.8), control: pt(7.5, 23.8))
            p.closeSubpath()

        case .star:
            p.move(to: pt(29, 7.5))
            p.addCurve(to: pt(36.5, 9.5), control1: pt(31.5, 4.5), control2: pt(35.5, 5.5))
            p.addCurve(to: pt(44, 12.5), control1: pt(37.5, 13.5), control2: pt(40.5, 14.5))
            p.addCurve(to: pt(49, 17.2), control1: pt(47.5, 10.5), control2: pt(51, 13.5))
            p.addCurve(to: pt(52.5, 25), control1: pt(47, 21), control2: pt(48.5, 24))
            p.addCurve(to: pt(53.5, 32.5), control1: pt(56.5, 26), control2: pt(57.2, 30.5))
            p.addCurve(to: pt(52, 41), control1: pt(49.8, 34.5), control2: pt(49.5, 37.8))
            p.addCurve(to: pt(48, 46.8), control1: pt(54.5, 44.2), control2: pt(52, 48.2))
            p.addCurve(to: pt(40.5, 51.2), control1: pt(44, 45.4), control2: pt(41, 47.2))
            p.addCurve(to: pt(33, 53), control1: pt(40, 55.2), control2: pt(35.5, 56.5))
            p.addCurve(to: pt(24.5, 52.5), control1: pt(30.5, 49.5), control2: pt(27.5, 49.5))
            p.addCurve(to: pt(18.2, 49.2), control1: pt(21.5, 55.5), control2: pt(17.2, 53.2))
            p.addCurve(to: pt(13.2, 42), control1: pt(19.2, 45.2), control2: pt(17.2, 42.5))
            p.addCurve(to: pt(11.5, 34.8), control1: pt(9.2, 41.5), control2: pt(8, 37))
            p.addCurve(to: pt(12.2, 26.5), control1: pt(15, 32.6), control2: pt(15.2, 29.5))
            p.addCurve(to: pt(15.5, 20.2), control1: pt(9.2, 23.5), control2: pt(11.5, 19.2))
            p.addCurve(to: pt(23, 15.2), control1: pt(19.5, 21.2), control2: pt(22.5, 19.2))
            p.addCurve(to: pt(29, 7.5), control1: pt(23.5, 11.2), control2: pt(26.5, 10.5))
            p.closeSubpath()

        case .hexagon:
            p.move(to: pt(27.5, 8))
            p.addQuadCurve(to: pt(36.5, 8), control: pt(32, 5.4))
            p.addLine(to: pt(51.5, 16.8))
            p.addQuadCurve(to: pt(55.5, 24.2), control: pt(55.5, 19.4))
            p.addLine(to: pt(55.5, 39.8))
            p.addQuadCurve(to: pt(51.5, 47.2), control: pt(55.5, 44.6))
            p.addLine(to: pt(36.5, 56))
            p.addQuadCurve(to: pt(27.5, 56), control: pt(32, 58.6))
            p.addLine(to: pt(12.5, 47.2))
            p.addQuadCurve(to: pt(8.5, 39.8), control: pt(8.5, 44.6))
            p.addLine(to: pt(8.5, 24.2))
            p.addQuadCurve(to: pt(12.5, 16.8), control: pt(8.5, 19.4))
            p.closeSubpath()
        }
        return p
    }
}

// MARK: - Bot Avatar Eyes & Expressions (64x64 Coordinate Space)

struct BotAvatarFaceView: View {
    let expression: BotAvatarExpression
    let eyeColor: Color
    let size: CGFloat

    var body: some View {
        Canvas { ctx, canvasSize in
            let sx = canvasSize.width / 64.0
            let sy = canvasSize.height / 64.0
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: x * sx, y: y * sy)
            }
            func pill(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, rx: CGFloat) -> Path {
                Path(
                    roundedRect: CGRect(x: x * sx, y: y * sy, width: w * sx, height: h * sy),
                    cornerSize: CGSize(width: rx * sx, height: rx * sy)
                )
            }

            switch expression {
            case .happy, .proud:
                var left = Path()
                left.move(to: pt(21.8, 33.2))
                left.addCurve(to: pt(30.4, 33.2), control1: pt(23.4, 26.8), control2: pt(28.8, 26.8))
                var right = Path()
                right.move(to: pt(33.6, 33.2))
                right.addCurve(to: pt(42.2, 33.2), control1: pt(35.2, 26.8), control2: pt(40.6, 26.8))
                let style = StrokeStyle(lineWidth: 4.6 * sx, lineCap: .round)
                ctx.stroke(left, with: .color(eyeColor), style: style)
                ctx.stroke(right, with: .color(eyeColor), style: style)

            case .laughing:
                var left = Path()
                left.move(to: pt(21.8, 27.6))
                left.addLine(to: pt(28.4, 31.5))
                left.addLine(to: pt(21.8, 35.4))
                var right = Path()
                right.move(to: pt(42.2, 27.6))
                right.addLine(to: pt(35.6, 31.5))
                right.addLine(to: pt(42.2, 35.4))
                let style = StrokeStyle(lineWidth: 4.4 * sx, lineCap: .round, lineJoin: .round)
                ctx.stroke(left, with: .color(eyeColor), style: style)
                ctx.stroke(right, with: .color(eyeColor), style: style)

            case .curious:
                ctx.fill(pill(x: 23.8, y: 27, w: 5.2, h: 9.6, rx: 2.6), with: .color(eyeColor))
                ctx.fill(pill(x: 34.8, y: 23.5, w: 5.6, h: 14.5, rx: 2.8), with: .color(eyeColor))

            case .confused:
                ctx.fill(pill(x: 23.8, y: 25.5, w: 5.2, h: 12.6, rx: 2.6), with: .color(eyeColor))
                ctx.fill(pill(x: 34.8, y: 24.5, w: 5.4, h: 8.4, rx: 2.7), with: .color(eyeColor))

            case .excited:
                ctx.fill(pill(x: 23.4, y: 23.5, w: 5.8, h: 15.5, rx: 2.9), with: .color(eyeColor))
                ctx.fill(pill(x: 34.8, y: 23.5, w: 5.8, h: 15.5, rx: 2.9), with: .color(eyeColor))

            case .surprised:
                ctx.fill(pill(x: 22.8, y: 23.8, w: 6.6, h: 15, rx: 3.3), with: .color(eyeColor))
                ctx.fill(pill(x: 34.6, y: 23.8, w: 6.6, h: 15, rx: 3.3), with: .color(eyeColor))

            case .attentive:
                ctx.fill(pill(x: 24, y: 26, w: 5.2, h: 10.8, rx: 2.6), with: .color(eyeColor))
                ctx.fill(pill(x: 34.8, y: 26, w: 5.2, h: 10.8, rx: 2.6), with: .color(eyeColor))

            case .suspicious:
                ctx.fill(pill(x: 22.8, y: 28.2, w: 7.2, h: 5.8, rx: 2.9), with: .color(eyeColor))
                ctx.fill(pill(x: 34, y: 28.2, w: 7.2, h: 5.8, rx: 2.9), with: .color(eyeColor))

            case .shy:
                var left = Path()
                left.move(to: pt(21.8, 32.5))
                left.addCurve(to: pt(30.2, 32.5), control1: pt(23.4, 27.2), control2: pt(28.6, 27.2))
                ctx.stroke(left, with: .color(eyeColor), style: StrokeStyle(lineWidth: 4.5 * sx, lineCap: .round))
                ctx.fill(pill(x: 34.6, y: 24.8, w: 5.4, h: 13.4, rx: 2.7), with: .color(eyeColor))

            case .sleepy, .unimpressed:
                ctx.fill(pill(x: 22.8, y: 29.6, w: 7.4, h: 4.4, rx: 2.2), with: .color(eyeColor))
                ctx.fill(pill(x: 33.8, y: 29.6, w: 7.4, h: 4.4, rx: 2.2), with: .color(eyeColor))

            default:
                // Default neutral upright pill eyes matching desktop
                ctx.fill(pill(x: 23.8, y: 25, w: 5.4, h: 13, rx: 2.7), with: .color(eyeColor))
                ctx.fill(pill(x: 34.8, y: 25, w: 5.4, h: 13, rx: 2.7), with: .color(eyeColor))
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
    }
}

// MARK: - Single Bot Avatar View (Animated Idle Blink + 12 Session Emotes)

struct MemberBotAvatarView: View {
    let config: CollabBotAvatarConfig
    var size: CGFloat = 38
    var animated: Bool = true
    var sessionActive: Bool = false
    var selectedOutline: Bool = false
    var silhouetteOutlineWidth: CGFloat? = nil
    var gazeUpRight: Bool = false
    var isLead: Bool = false
    var isSupervisor: Bool = false
    var reactionTrigger: Int = 0

    // Animation state (in 64x64 units, scaled by k = size / 64)
    @State private var currentEmote: BotSessionEmote = .idle
    @State private var isBlinking = false
    @State private var headOffset64: CGSize = .zero
    @State private var headRotation: Double = 0
    @State private var headScale: CGSize = CGSize(width: 1, height: 1)
    @State private var headYaw: Double = 0
    @State private var faceOffset64: CGSize = .zero
    @State private var faceRotation: Double = 0
    @State private var faceScale: CGSize = CGSize(width: 1, height: 1)
    @State private var emoteStep: Int = 0

    private var fillColor: Color {
        Color(collabHex: config.color) ?? Color(red: 0.08, green: 0.52, blue: 1.0)
    }

    private var effectiveExpression: BotAvatarExpression {
        currentEmote != .idle ? currentEmote.expression : config.expression
    }

    private var k: CGFloat { size / 64.0 }

    private var seed: UInt32 {
        CollabBotAvatarConfig.hashSeed("\(config.color):\(config.shape.rawValue)")
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ZStack {
                if selectedOutline {
                    BotAvatarShapePath(shape: config.shape)
                        .stroke(
                            Color(red: 0.82, green: 0.84, blue: 0.86),
                            style: StrokeStyle(lineWidth: 8 * k, lineCap: .round, lineJoin: .round)
                        )
                    BotAvatarShapePath(shape: config.shape)
                        .stroke(
                            Color.white,
                            style: StrokeStyle(lineWidth: 4.5 * k, lineCap: .round, lineJoin: .round)
                        )
                }

                if let outlineWidth = silhouetteOutlineWidth {
                    BotAvatarShapePath(shape: config.shape)
                        .stroke(
                            Color(uiColor: .systemBackground),
                            style: StrokeStyle(lineWidth: outlineWidth * k, lineCap: .round, lineJoin: .round)
                        )
                }

                BotAvatarShapePath(shape: config.shape)
                    .fill(fillColor)

                BotAvatarFaceView(
                    expression: effectiveExpression,
                    eyeColor: .white,
                    size: size
                )
                .scaleEffect(
                    x: isBlinking ? 1.03 : faceScale.width,
                    y: isBlinking ? 0.08 : faceScale.height
                )
                .rotationEffect(.degrees(faceRotation))
                .offset(
                    x: ((gazeUpRight ? 3.0 : 0.0) + faceOffset64.width) * k,
                    y: ((gazeUpRight ? -4.0 : 0.0) + faceOffset64.height) * k
                )
            }
            .frame(width: size, height: size)
            .scaleEffect(x: headScale.width, y: headScale.height)
            .rotationEffect(.degrees(headRotation))
            .rotation3DEffect(.degrees(headYaw), axis: (x: 0, y: 1, z: 0))
            .offset(x: headOffset64.width * k, y: headOffset64.height * k)

            if isLead || isSupervisor {
                Image(systemName: isSupervisor ? "crown.fill" : "star.fill")
                    .font(.system(size: max(8, size * 0.24), weight: .bold))
                    .foregroundStyle(.yellow)
                    .padding(max(1.5, size * 0.04))
                    .background(Color(uiColor: .systemBackground), in: Circle())
                    .offset(x: 2, y: 2)
            }
        }
        .frame(width: size, height: size)
        .task(id: "\(animated)-\(sessionActive)-\(config.color)-\(config.shape.rawValue)") {
            guard animated else { return }
            emoteStep = Int(seed % UInt32(BotSessionEmote.sequence.count))

            if sessionActive {
                // Active session loop: cycle through the 12 desktop emotes every ~2.7s
                while !Task.isCancelled {
                    let next = BotSessionEmote.sequence[emoteStep % BotSessionEmote.sequence.count]
                    emoteStep += 1
                    await playEmote(next)
                    let pauseMs = 1350 + Int(seed % 650)
                    try? await Task.sleep(for: .milliseconds(pauseMs))
                }
            } else {
                // Idle life loop: natural blinking + periodic lively micro-emotes
                let initialDelayMs = 600 + Int((seed % 25) * 90)
                try? await Task.sleep(for: .milliseconds(initialDelayMs))
                var cycle = 0
                while !Task.isCancelled {
                    cycle += 1
                    if cycle % 3 == 0 {
                        let next = BotSessionEmote.sequence[emoteStep % BotSessionEmote.sequence.count]
                        emoteStep += 1
                        await playEmote(next)
                    } else {
                        await performBlink()
                        if seed % 2 == 0 {
                            try? await Task.sleep(for: .milliseconds(160))
                            await performBlink()
                        }
                    }
                    let waitMs = 2800 + Int((seed % 20) * 110)
                    try? await Task.sleep(for: .milliseconds(waitMs))
                }
            }
        }
        .onChange(of: reactionTrigger) { _, newValue in
            guard newValue > 0 else { return }
            let next = BotSessionEmote.sequence[(newValue - 1) % BotSessionEmote.sequence.count]
            Task { @MainActor in
                await playEmote(next)
            }
        }
    }

    @MainActor
    private func performBlink() async {
        guard currentEmote == .idle else { return }
        withAnimation(.easeInOut(duration: 0.09)) {
            isBlinking = true
        }
        try? await Task.sleep(for: .milliseconds(100))
        withAnimation(.easeInOut(duration: 0.11)) {
            isBlinking = false
        }
    }

    @MainActor
    private func playEmote(_ emote: BotSessionEmote) async {
        currentEmote = emote
        switch emote {
        case .happy:
            withAnimation(.spring(response: 0.24, dampingFraction: 0.55)) {
                headOffset64 = CGSize(width: -4.5, height: -4.5)
                headRotation = -10
                headScale = CGSize(width: 0.96, height: 1.05)
                faceOffset64 = CGSize(width: -2.5, height: -2.5)
                faceRotation = -4
            }
            try? await Task.sleep(for: .milliseconds(260))
            withAnimation(.spring(response: 0.24, dampingFraction: 0.55)) {
                headOffset64 = CGSize(width: 4.5, height: -4.5)
                headRotation = 10
                headScale = CGSize(width: 0.96, height: 1.05)
                faceOffset64 = CGSize(width: 2.5, height: -2.5)
                faceRotation = 4
            }
            try? await Task.sleep(for: .milliseconds(320))

        case .curious:
            withAnimation(.spring(response: 0.32, dampingFraction: 0.65)) {
                headOffset64 = CGSize(width: 2.2, height: -3.5)
                headRotation = 13
                headScale = CGSize(width: 1.02, height: 0.97)
                faceOffset64 = CGSize(width: 3.5, height: -4.8)
                faceRotation = 5
            }
            try? await Task.sleep(for: .milliseconds(580))

        case .excited:
            withAnimation(.easeInOut(duration: 0.72)) {
                headOffset64 = CGSize(width: 0, height: -4.5)
                headYaw = 360
                headScale = CGSize(width: 1.04, height: 1.06)
            }
            try? await Task.sleep(for: .milliseconds(740))
            headYaw = 0

        case .thinking:
            withAnimation(.easeInOut(duration: 0.28)) {
                headOffset64 = CGSize(width: -2, height: -2.5)
                headRotation = -6
                faceOffset64 = CGSize(width: -5.5, height: -4.2)
            }
            try? await Task.sleep(for: .milliseconds(340))
            withAnimation(.easeInOut(duration: 0.28)) {
                headOffset64 = CGSize(width: 2, height: -2.5)
                headRotation = 6
                faceOffset64 = CGSize(width: 5.5, height: -4.2)
            }
            try? await Task.sleep(for: .milliseconds(340))

        case .nodding:
            for _ in 0..<2 {
                withAnimation(.easeInOut(duration: 0.16)) {
                    headOffset64 = CGSize(width: 0, height: 3)
                    headScale = CGSize(width: 1.04, height: 0.93)
                    faceOffset64 = CGSize(width: 0, height: 5.8)
                }
                try? await Task.sleep(for: .milliseconds(180))
                withAnimation(.easeInOut(duration: 0.16)) {
                    headOffset64 = CGSize(width: 0, height: -2)
                    headScale = CGSize(width: 0.98, height: 1.02)
                    faceOffset64 = CGSize(width: 0, height: -3)
                }
                try? await Task.sleep(for: .milliseconds(180))
            }

        case .surprised:
            withAnimation(.spring(response: 0.24, dampingFraction: 0.52)) {
                headOffset64 = CGSize(width: 0, height: -6)
                headScale = CGSize(width: 0.92, height: 1.09)
                faceOffset64 = CGSize(width: 0, height: -3.8)
                faceScale = CGSize(width: 1.08, height: 1.08)
            }
            try? await Task.sleep(for: .milliseconds(520))

        case .laughing:
            for dir in [-1.0, 1.0, -1.0] {
                withAnimation(.easeInOut(duration: 0.15)) {
                    headOffset64 = CGSize(width: 0, height: -4)
                    headRotation = 4 * dir
                    faceOffset64 = CGSize(width: 0, height: -3)
                }
                try? await Task.sleep(for: .milliseconds(160))
                withAnimation(.easeInOut(duration: 0.15)) {
                    headOffset64 = CGSize(width: 0, height: 1.8)
                    headRotation = -3 * dir
                    faceOffset64 = CGSize(width: 0, height: 2.5)
                }
                try? await Task.sleep(for: .milliseconds(160))
            }

        case .focused:
            withAnimation(.easeInOut(duration: 0.22)) {
                headScale = CGSize(width: 1.06, height: 1.04)
                faceOffset64 = CGSize(width: -5.5, height: 1)
            }
            try? await Task.sleep(for: .milliseconds(300))
            withAnimation(.easeInOut(duration: 0.26)) {
                faceOffset64 = CGSize(width: 5.5, height: 1)
            }
            try? await Task.sleep(for: .milliseconds(320))

        case .wink:
            withAnimation(.spring(response: 0.28, dampingFraction: 0.6)) {
                headOffset64 = CGSize(width: -3, height: -2.5)
                headRotation = -13
                headScale = CGSize(width: 1.03, height: 1.02)
                faceOffset64 = CGSize(width: -3.5, height: -2)
                faceRotation = -4
            }
            try? await Task.sleep(for: .milliseconds(560))

        case .confused:
            withAnimation(.easeInOut(duration: 0.2)) {
                headOffset64 = CGSize(width: -3, height: 0)
                headRotation = -7
                faceOffset64 = CGSize(width: -6.5, height: 0)
            }
            try? await Task.sleep(for: .milliseconds(240))
            withAnimation(.easeInOut(duration: 0.2)) {
                headOffset64 = CGSize(width: 3, height: 0)
                headRotation = 7
                faceOffset64 = CGSize(width: 6.5, height: 0)
            }
            try? await Task.sleep(for: .milliseconds(240))

        case .sleepy:
            withAnimation(.easeInOut(duration: 0.42)) {
                headOffset64 = CGSize(width: 1, height: 4.5)
                headRotation = 6
                headScale = CGSize(width: 1.04, height: 0.94)
                faceOffset64 = CGSize(width: 1.5, height: 6.5)
            }
            try? await Task.sleep(for: .milliseconds(480))
            withAnimation(.spring(response: 0.22, dampingFraction: 0.55)) {
                headOffset64 = CGSize(width: -1.5, height: -3)
                headRotation = -5
                faceOffset64 = CGSize(width: -2, height: -3.5)
            }
            try? await Task.sleep(for: .milliseconds(240))

        case .proud:
            withAnimation(.spring(response: 0.28, dampingFraction: 0.6)) {
                headOffset64 = CGSize(width: -2, height: -4)
                headRotation = -7
                headScale = CGSize(width: 1.06, height: 1.04)
                faceOffset64 = CGSize(width: -2.5, height: -4.5)
            }
            try? await Task.sleep(for: .milliseconds(320))
            withAnimation(.spring(response: 0.28, dampingFraction: 0.6)) {
                headOffset64 = CGSize(width: 2, height: -4)
                headRotation = 7
                faceOffset64 = CGSize(width: 2.5, height: -4.5)
            }
            try? await Task.sleep(for: .milliseconds(320))

        case .idle:
            break
        }

        withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) {
            currentEmote = .idle
            headOffset64 = .zero
            headRotation = 0
            headScale = CGSize(width: 1, height: 1)
            faceOffset64 = .zero
            faceRotation = 0
            faceScale = CGSize(width: 1, height: 1)
        }
    }
}

// MARK: - Stacked Group Avatar View (Desktop GroupAvatar.tsx Parity)

struct CollabGroupAvatarView: View {
    let avatars: [CollabBotAvatarConfig]
    var tagColorHex: String? = nil
    var size: CGFloat = 40
    var sessionActive: Bool = false

    private struct Slot {
        let x: CGFloat
        let y: CGFloat
        let slotSize: CGFloat
        let z: Double
    }

    private static let layouts: [Int: [Slot]] = [
        1: [Slot(x: 4, y: 4, slotSize: 20, z: 1)],
        2: [
            Slot(x: 0.25, y: 5, slotSize: 18, z: 1),
            Slot(x: 9.75, y: 5, slotSize: 18, z: 2),
        ],
        3: [
            Slot(x: 5.5, y: 0.5, slotSize: 17, z: 1),
            Slot(x: 10.5, y: 10, slotSize: 17, z: 2),
            Slot(x: 0.5, y: 10, slotSize: 17, z: 3),
        ],
        4: [
            Slot(x: 1, y: 1, slotSize: 16, z: 1),
            Slot(x: 11, y: 1, slotSize: 16, z: 2),
            Slot(x: 1, y: 11, slotSize: 16, z: 2),
            Slot(x: 11, y: 11, slotSize: 16, z: 3),
        ],
    ]

    private var shown: [CollabBotAvatarConfig] {
        let slice = Array(avatars.prefix(4))
        return slice.isEmpty ? [CollabBotAvatarConfig.derive(seed: "group")] : slice
    }

    var body: some View {
        let count = min(max(shown.count, 1), 4)
        let slots = Self.layouts[count] ?? Self.layouts[1]!
        let k = size / 28.0

        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(Color(uiColor: .secondarySystemFill).opacity(0.65))

            ForEach(Array(shown.enumerated()), id: \.offset) { index, avatar in
                let slot = slots[index]
                let px = slot.slotSize * k
                let outlinePx = 0.75 * (size / 24.0)
                let strokeWidth64 = ((outlinePx * 2.0) / max(px, 1.0)) * 64.0

                MemberBotAvatarView(
                    config: avatar,
                    size: px,
                    animated: true,
                    sessionActive: sessionActive,
                    silhouetteOutlineWidth: strokeWidth64,
                    gazeUpRight: true
                )
                .rotationEffect(.degrees(-12))
                .offset(x: slot.x * k, y: slot.y * k)
                .zIndex(slot.z)
            }
        }
        .frame(width: size, height: size)
        .overlay {
            if let hex = tagColorHex, let ringColor = Color(collabHex: hex) {
                RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                    .stroke(ringColor, lineWidth: max(1.5, (1.5 * size) / 24.0))
            }
        }
    }
}

// MARK: - MemberBotAvatarPicker (Exact Desktop UI: 颜色 / 形状 + Preview + Swatches)

struct MemberBotAvatarPicker: View {
    @Binding var value: CollabBotAvatarConfig
    var label: String = "头像"

    enum SectionTab: String, CaseIterable, Identifiable {
        case color
        case shape
        var id: String { rawValue }
    }

    @State private var activeSection: SectionTab = .color
    @State private var reactionKey: Int = 0

    private let firstRowColors = Array(CollabBotAvatarConfig.colorPresets.prefix(6))
    private let secondRowColors = Array(CollabBotAvatarConfig.colorPresets.dropFirst(6))

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Top bar: "头像" label + "颜色 | 形状" segmented pill control
            HStack {
                Text(label)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.primary)

                Spacer()

                HStack(spacing: 2) {
                    segmentButton(
                        tab: .color,
                        title: "颜色",
                        systemImage: "paintpalette"
                    )
                    segmentButton(
                        tab: .shape,
                        title: "形状",
                        systemImage: "square.on.circle"
                    )
                }
                .padding(3)
                .background(
                    Capsule(style: .continuous)
                        .fill(Color(uiColor: .secondarySystemFill))
                )
            }

            // Main layout: Left interactive character preview + Right rounded card
            HStack(alignment: .center, spacing: 14) {
                Button {
                    reactionKey += 1
                } label: {
                    MemberBotAvatarView(
                        config: value,
                        size: 68,
                        animated: true,
                        sessionActive: true,
                        reactionTrigger: reactionKey
                    )
                    .frame(width: 74, height: 74)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("点击预览头像表情")

                ZStack {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color(uiColor: .systemBackground))
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(Color.primary.opacity(0.09), lineWidth: 1)

                    if activeSection == .color {
                        VStack(spacing: 10) {
                            HStack(spacing: 10) {
                                ForEach(firstRowColors) { preset in
                                    colorSwatch(preset)
                                }
                            }
                            HStack(spacing: 10) {
                                ForEach(secondRowColors) { preset in
                                    colorSwatch(preset)
                                }
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 14)
                        .transition(.opacity)
                    } else {
                        LazyVGrid(
                            columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 5),
                            spacing: 8
                        ) {
                            ForEach(BotAvatarShape.allCases) { shape in
                                shapeButton(shape)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 12)
                        .transition(.opacity)
                    }
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func segmentButton(tab: SectionTab, title: String, systemImage: String) -> some View {
        let isSelected = activeSection == tab
        return Button {
            withAnimation(.easeInOut(duration: 0.16)) {
                activeSection = tab
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 12, weight: .semibold))
                Text(title)
                    .font(.system(size: 13, weight: .medium))
            }
            .foregroundStyle(isSelected ? Color.primary : Color.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background {
                if isSelected {
                    Capsule(style: .continuous)
                        .fill(Color(uiColor: .systemBackground))
                        .shadow(color: .black.opacity(0.08), radius: 2, y: 1)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func colorSwatch(_ preset: BotAvatarColorPreset) -> some View {
        let selected = CollabBotAvatarConfig.normalizeHexColor(value.color)
            == CollabBotAvatarConfig.normalizeHexColor(preset.hex)
        let swatchColor = Color(collabHex: preset.hex) ?? .blue

        return Button {
            value.color = CollabBotAvatarConfig.normalizeHexColor(preset.hex, fallback: value.color)
            value.expression = .neutral
            reactionKey += 1
        } label: {
            ZStack {
                if selected {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.primary.opacity(0.22), lineWidth: 2)
                        .frame(width: 34, height: 34)
                }
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(swatchColor)
                    .frame(width: 26, height: 26)
            }
            .frame(width: 34, height: 34)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(preset.label)
    }

    private func shapeButton(_ shape: BotAvatarShape) -> some View {
        let selected = value.shape == shape
        let previewConfig = CollabBotAvatarConfig(
            color: value.color,
            shape: shape,
            expression: .neutral
        )

        return Button {
            value.shape = shape
            value.expression = .neutral
            reactionKey += 1
        } label: {
            MemberBotAvatarView(
                config: previewConfig,
                size: 32,
                animated: false,
                selectedOutline: selected
            )
            .frame(width: 36, height: 36)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(selected ? Color.primary.opacity(0.06) : Color.clear)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(shape.label)
    }
}
