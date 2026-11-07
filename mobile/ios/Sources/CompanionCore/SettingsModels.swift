import Foundation

private struct DynamicCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init(_ string: String) {
        self.stringValue = string
        self.intValue = nil
    }

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = "\(intValue)"
        self.intValue = intValue
    }
}

private extension KeyedDecodingContainer where Key == DynamicCodingKey {
    func decodeString(forKeys keys: [String]) -> String? {
        for key in keys {
            if let value = try? decodeIfPresent(String.self, forKey: DynamicCodingKey(key)) {
                return value
            }
        }
        return nil
    }

    func decodeBool(forKeys keys: [String]) -> Bool? {
        for key in keys {
            if let value = try? decodeIfPresent(Bool.self, forKey: DynamicCodingKey(key)) {
                return value
            }
        }
        return nil
    }

    func decodeInt(forKeys keys: [String]) -> Int? {
        for key in keys {
            if let value = try? decodeIfPresent(Int.self, forKey: DynamicCodingKey(key)) {
                return value
            }
        }
        return nil
    }
}

// MARK: - Local Skills

public struct LocalSkillItem: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let group: String
    public let global: Bool
    public let apps: [String]
    public let path: String

    public init(
        id: String,
        name: String,
        description: String? = nil,
        group: String = "",
        global: Bool = false,
        apps: [String] = [],
        path: String = ""
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.group = group
        self.global = global
        self.apps = apps
        self.path = path
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.id = c.decodeString(forKeys: ["id"]) ?? UUID().uuidString
        self.name = c.decodeString(forKeys: ["name"]) ?? self.id
        self.description = c.decodeString(forKeys: ["description"])
        self.group = c.decodeString(forKeys: ["group"]) ?? ""
        self.global = c.decodeBool(forKeys: ["global"]) ?? false
        self.apps = (try? c.decode([String].self, forKey: DynamicCodingKey("apps"))) ?? []
        self.path = c.decodeString(forKeys: ["path"]) ?? ""
    }
}

public struct LocalSkillContentItem: Codable, Equatable, Sendable {
    public let id: String
    public let path: String
    public let content: String

    public init(id: String, path: String, content: String) {
        self.id = id
        self.path = path
        self.content = content
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.id = c.decodeString(forKeys: ["id"]) ?? ""
        self.path = c.decodeString(forKeys: ["path"]) ?? ""
        self.content = c.decodeString(forKeys: ["content"]) ?? ""
    }
}

// MARK: - Local MCP Servers

public struct LocalMcpServerItem: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let spec: JSONValue
    public let global: Bool
    public let apps: [String]

    public init(
        id: String,
        spec: JSONValue = .object([:]),
        global: Bool = false,
        apps: [String] = []
    ) {
        self.id = id
        self.spec = spec
        self.global = global
        self.apps = apps
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.id = c.decodeString(forKeys: ["id"]) ?? UUID().uuidString
        self.spec = (try? c.decode(JSONValue.self, forKey: DynamicCodingKey("spec"))) ?? .object([:])
        self.global = c.decodeBool(forKeys: ["global"]) ?? false
        self.apps = (try? c.decode([String].self, forKey: DynamicCodingKey("apps"))) ?? []
    }

    public var transportLabel: String {
        if let type = spec["type"]?.stringValue ?? spec["transport"]?.stringValue, !type.isEmpty {
            return type.uppercased()
        }
        if spec["url"]?.stringValue != nil {
            return "HTTP/SSE"
        }
        return "STDIO"
    }

    public var commandSummary: String {
        if let url = spec["url"]?.stringValue, !url.isEmpty {
            return url
        }
        let cmd = spec["command"]?.stringValue ?? ""
        let args = spec["args"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let joined = ([cmd] + args).filter { !$0.isEmpty }.joined(separator: " ")
        return joined.isEmpty ? "本地 MCP 服务" : joined
    }
}

// MARK: - Installed Plugins

public struct PluginCatalogItem: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let publisher: String?
    public let name: String
    public let version: String
    public let description: String?
    public let enabled: Bool
    public let builtin: Bool
    public let sourceKind: String
    public let formats: [String]
    public let skills: [String]
    public let mcpCount: Int
    public let mcpServers: [String]

    public init(
        id: String,
        publisher: String? = nil,
        name: String,
        version: String = "1.0.0",
        description: String? = nil,
        enabled: Bool = true,
        builtin: Bool = false,
        sourceKind: String = "builtin",
        formats: [String] = [],
        skills: [String] = [],
        mcpCount: Int = 0,
        mcpServers: [String] = []
    ) {
        self.id = id
        self.publisher = publisher
        self.name = name
        self.version = version
        self.description = description
        self.enabled = enabled
        self.builtin = builtin
        self.sourceKind = sourceKind
        self.formats = formats
        self.skills = skills
        self.mcpCount = mcpCount
        self.mcpServers = mcpServers
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.id = c.decodeString(forKeys: ["id"]) ?? UUID().uuidString
        self.publisher = c.decodeString(forKeys: ["publisher"])
        self.name = c.decodeString(forKeys: ["name"]) ?? self.id
        self.version = c.decodeString(forKeys: ["version"]) ?? "1.0.0"
        self.description = c.decodeString(forKeys: ["description"])
        self.enabled = c.decodeBool(forKeys: ["enabled"]) ?? true
        self.builtin = c.decodeBool(forKeys: ["builtin"]) ?? false
        self.sourceKind = c.decodeString(forKeys: ["sourceKind", "source_kind"]) ?? "builtin"
        self.formats = (try? c.decode([String].self, forKey: DynamicCodingKey("formats"))) ?? []
        self.skills = (try? c.decode([String].self, forKey: DynamicCodingKey("skills"))) ?? []
        self.mcpCount = c.decodeInt(forKeys: ["mcpCount", "mcp_count"]) ?? 0
        self.mcpServers =
            (try? c.decode([String].self, forKey: DynamicCodingKey("mcpServers")))
            ?? (try? c.decode([String].self, forKey: DynamicCodingKey("mcp_servers")))
            ?? []
    }
}

public struct PluginControlCatalogResponse: Codable, Equatable, Sendable {
    public let plugins: [PluginCatalogItem]

    public init(plugins: [PluginCatalogItem] = []) {
        self.plugins = plugins
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.plugins = (try? c.decode([PluginCatalogItem].self, forKey: DynamicCodingKey("plugins"))) ?? []
    }
}

// MARK: - Host Environment & User System Info

public struct HostSystemEnvironmentInfo: Codable, Equatable, Sendable {
    public let osType: String
    public let osVersion: String
    public let osArchitecture: String
    public let bitness: String

    public init(
        osType: String = "macOS",
        osVersion: String = "macOS",
        osArchitecture: String = "aarch64",
        bitness: String = "64-bit"
    ) {
        self.osType = osType
        self.osVersion = osVersion
        self.osArchitecture = osArchitecture
        self.bitness = bitness
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.osType = c.decodeString(forKeys: ["os_type", "osType"]) ?? "macOS"
        self.osVersion = c.decodeString(forKeys: ["os_version", "osVersion"]) ?? "macOS"
        self.osArchitecture = c.decodeString(forKeys: ["os_architecture", "osArchitecture"]) ?? "aarch64"
        self.bitness = c.decodeString(forKeys: ["bitness"]) ?? "64-bit"
    }
}

public struct HostUserSystemInfo: Codable, Equatable, Sendable {
    public let environment: HostSystemEnvironmentInfo
    public let plugins: [PluginCatalogItem]

    public init(
        environment: HostSystemEnvironmentInfo = HostSystemEnvironmentInfo(),
        plugins: [PluginCatalogItem] = []
    ) {
        self.environment = environment
        self.plugins = plugins
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.environment =
            (try? c.decode(HostSystemEnvironmentInfo.self, forKey: DynamicCodingKey("environment")))
            ?? HostSystemEnvironmentInfo()
        self.plugins =
            (try? c.decode([PluginCatalogItem].self, forKey: DynamicCodingKey("plugins")))
            ?? []
    }
}
