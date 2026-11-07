import SwiftUI
import UIKit

/// Mirrors `frontend/src/components/agents/AgentIcon.tsx`: built-in brand
/// artwork lives in `AgentIcons.xcassets` (light/dark variants), unknown
/// agents fall back to a generic glyph.
enum AgentBrand {
    static func normalizedKey(_ agent: String?) -> String? {
        guard let raw = agent?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        let key = raw.lowercased().replacingOccurrences(of: "-", with: "_")
        switch key {
        case "gemini": return "antigravity"
        case "claude": return "claude_code"
        case "kimi": return "kimi_code"
        case "deepseek", "dsh": return "deepseek_harness"
        case "qodercli": return "qoder"
        case "kirocli", "kiro_cli": return "kiro"
        case "traex", "traecli", "trae_cli": return "trae"
        case "commandcode", "cmdc": return "command_code"
        case "oh_my_pi", "ohmypi": return "omp"
        case "mimo", "mimocode": return "mimo_code"
        default: return key
        }
    }

    private static let displayNames: [String: String] = [
        "claude_code": "Claude Code",
        "codex": "Codex",
        "antigravity": "Google Antigravity",
        "openclaw": "OpenClaw",
        "opencode": "OpenCode",
        "cline": "Cline",
        "hermes": "Hermes Agent",
        "codebuddy": "CodeBuddy",
        "kimi_code": "Kimi Code",
        "pi": "Pi",
        "grok": "Grok",
        "cursor": "Cursor",
        "deepseek_harness": "DeepSeek Harness",
        "qoder": "Qoder",
        "kiro": "Kiro CLI",
        "auggie": "Auggie",
        "trae": "TRAE CLI",
        "command_code": "Command Code",
        "zcode": "ZCode",
        "omp": "OMP",
        "mimo_code": "MiMo Code",
    ]

    /// Human name for an agent id; prefers the host-provided name when it is
    /// more than the raw id.
    static func displayName(_ agent: String?, hostName: String? = nil) -> String {
        if let hostName, !hostName.isEmpty, hostName != agent { return hostName }
        guard let key = normalizedKey(agent) else { return agent ?? "Agent" }
        return displayNames[key] ?? agent ?? "Agent"
    }

    static func image(_ agent: String?) -> UIImage? {
        guard let key = normalizedKey(agent) else { return nil }
        return UIImage(named: "agent_\(key)")
    }

    /// Best-effort agent for aggregate rows that only carry a model id
    /// (usage by model). Returns nil when the vendor is ambiguous.
    static func inferAgent(fromModel model: String?) -> String? {
        guard let m = model?.lowercased(), !m.isEmpty else { return nil }
        if m.contains("claude") || m.contains("opus") || m.contains("sonnet") || m.contains("haiku") {
            return "claude_code"
        }
        if m.hasPrefix("gpt") || m.contains("codex") || m.hasPrefix("o3") || m.hasPrefix("o4") {
            return "codex"
        }
        if m.contains("gemini") { return "antigravity" }
        if m.contains("grok") { return "grok" }
        if m.contains("deepseek") { return "deepseek_harness" }
        if m.contains("kimi") { return "kimi_code" }
        if m.contains("mimo") { return "mimo_code" }
        return nil
    }
}

extension UIImage {
    /// System menus draw `UIImage`s at their intrinsic size, so brand marks are
    /// redrawn at menu-icon size with their original colors preserved.
    func resizedForMenu(_ side: CGFloat = 20) -> UIImage {
        let scale = min(side / max(size.width, 1), side / max(size.height, 1))
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        let light = imageAsset?.image(with: UITraitCollection(userInterfaceStyle: .light)) ?? self
        let dark = imageAsset?.image(with: UITraitCollection(userInterfaceStyle: .dark)) ?? self
        func draw(_ img: UIImage) -> UIImage {
            renderer.image { _ in
                img.draw(in: CGRect(
                    x: (side - target.width) / 2, y: (side - target.height) / 2,
                    width: target.width, height: target.height
                ))
            }.withRenderingMode(.alwaysOriginal)
        }
        let asset = UIImageAsset()
        asset.register(draw(light), with: UITraitCollection(userInterfaceStyle: .light))
        asset.register(draw(dark), with: UITraitCollection(userInterfaceStyle: .dark))
        return asset.image(with: UITraitCollection.current)
    }
}

/// Label for agent rows inside `Menu` / `Picker`, where only `UIImage`-backed
/// icons render reliably.
struct AgentMenuLabel: View {
    let agentID: String?
    var hostName: String?

    var body: some View {
        Label {
            Text(AgentBrand.displayName(agentID, hostName: hostName))
        } icon: {
            if let image = AgentBrand.image(agentID) {
                Image(uiImage: image.resizedForMenu())
            } else {
                Image(systemName: "cpu")
            }
        }
    }
}

struct AgentIconView: View {
    let agent: String?
    var size: CGFloat = 16

    var body: some View {
        Group {
            if let image = AgentBrand.image(agent) {
                Image(uiImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Image(systemName: "cpu")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.secondary)
                    .padding(size * 0.08)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(AgentBrand.displayName(agent))
    }
}

/// Model label prefixed with the agent that runs it. Use wherever a model
/// name is shown so the agent is always visible alongside it.
struct AgentModelLabel: View {
    let agent: String?
    let model: String?
    var iconSize: CGFloat = 14
    var spacing: CGFloat = 4

    var body: some View {
        HStack(spacing: spacing) {
            if agent != nil { AgentIconView(agent: agent, size: iconSize) }
            if let model, !model.isEmpty {
                Text(model).lineLimit(1)
            } else if agent != nil {
                Text(AgentBrand.displayName(agent)).lineLimit(1)
            }
        }
    }
}
