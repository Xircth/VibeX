import Foundation

/// An Agent configured in the desktop's settings, as listed by `conversation_catalog`.
public struct CatalogAgent: Equatable, Sendable, Identifiable {
    public let id: String
    public let displayName: String
    public let usable: Bool
    public let currentModeID: String?
    public let modes: [SessionMode]
    public let options: [ConfigOption]

    public var modelOptions: [ConfigOption] { options.filter { $0.category == "model" } }
    public var otherOptions: [ConfigOption] {
        options.filter { $0.category != "model" && $0.category != "mode" }
    }
}

public enum AgentCatalogParser {
    public static func agents(from catalog: JSONValue) -> [CatalogAgent] {
        (catalog["agents"]?.arrayValue ?? []).compactMap { item in
            guard let id = item["id"]?.stringValue else { return nil }
            var usable = false
            if case .bool(let flag)? = item["usable"] { usable = flag }
            return CatalogAgent(
                id: id,
                displayName: item["displayName"]?.stringValue ?? id,
                usable: usable,
                currentModeID: item["currentMode"]?.stringValue,
                modes: (item["sessionModes"]?.arrayValue ?? []).compactMap(SessionStateBuilder.mode),
                options: (item["sessionConfig"]?.arrayValue ?? []).compactMap(SessionStateBuilder.option)
            )
        }
    }
}

extension HostClient {
    public func agentCatalog() async throws -> [CatalogAgent] {
        let catalog: JSONValue = try await call("conversation_catalog", as: JSONValue.self)
        return AgentCatalogParser.agents(from: catalog)
    }
}
