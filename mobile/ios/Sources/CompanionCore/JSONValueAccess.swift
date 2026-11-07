import Foundation

extension JSONValue {
    subscript(key: String) -> JSONValue? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let text) = self { return text }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    /// The Host may nest the event body under `event`; accept both shapes.
    func eventField(_ key: String) -> JSONValue? {
        self[key] ?? self["event"]?[key]
    }

    /// Plain Foundation value for `JSONSerialization`.
    var foundationValue: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return value
        case .number(let value): return value
        case .string(let value): return value
        case .array(let items): return items.map(\.foundationValue)
        case .object(let fields): return fields.mapValues(\.foundationValue)
        }
    }

    /// Short text for showing a config choice's current value.
    var displayText: String? {
        switch self {
        case .string(let value): return value
        case .bool(let value): return value ? "开" : "关"
        case .number(let value): return value == value.rounded() ? String(Int(value)) : String(value)
        default: return nil
        }
    }
}
