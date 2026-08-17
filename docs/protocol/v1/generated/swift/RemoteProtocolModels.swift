// Generated from docs/protocol/v1/schema.json. Do not edit.

import Foundation

public enum JSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(Double.self) { self = .number(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode([JSONValue].self) { self = .array(item) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .string(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .object(let item): try value.encode(item)
        }
    }
}

public struct ServerCapabilities: Codable {
    public let server_version: String
    public let protocol_version: String
    public let minimum_client_version: String
    public let capabilities: [CapabilityId]
}

public typealias CapabilityId = String

public struct CommandRequest: Codable {
    public let operation_id: String
    public let args: JSONValue
}

public struct CommandResponse: Codable {
    public let operation_id: String
    public let data: JSONValue
}

public struct ErrorEnvelope: Codable {
    public let code: ErrorCode
    public let message: String
    public let retryable: Bool
    public let operation_id: String
    public let details: JSONValue?
}

public enum ErrorCode: String, Codable {
    case bad_request
    case unauthorized
    case forbidden
    case not_found
    case conflict
    case capability_unavailable
    case `internal`
}

public typealias SubscriptionClientMessage = JSONValue

public typealias SubscriptionRequest = JSONValue

public typealias SubscriptionServerMessage = JSONValue

public struct SubscriptionSnapshot: Codable {
    public let through_sequence: Int64
    public let payload: JSONValue
}

public struct RemoteEvent: Codable {
    public let sequence: Int64
    public let kind: String
    public let payload: JSONValue
}

public enum DevicePermissionPreset: String, Codable {
    case workstation
    case companion
}

public struct CreatePairingRequest: Codable {
    public let preset: DevicePermissionPreset?
    public let requested_scopes: [String]
}

public struct PairingChallenge: Codable {
    public let pairing_id: String
    public let pairing_token: String
    public let expires_at: String
    public let requested_scopes: [String]
}

public struct RedeemPairingRequest: Codable {
    public let pairing_token: String
    public let device_name: String
}

public struct DeviceCredential: Codable {
    public let device_id: String
    public let access_token: String
    public let scopes: [String]
}

public struct RevokeDeviceResponse: Codable {
    public let device_id: String
    public let revoked: Bool
}

public struct TerminalNotificationSummary: Codable {
    public let source: JSONValue
    public let outcome: NotificationOutcome
    public let occurred_at: String
    public let operation_id: String
}

public typealias NotificationSource = JSONValue

public enum NotificationOutcome: String, Codable {
    case completed
    case failed
    case cancelled
    case interrupted
}

public struct OfflineConversationCache: Codable {
    public let conversation_id: String
    public let confirmed_through: Int64
    public let read_only: Bool?
    public let events: [RemoteEvent]?
}
