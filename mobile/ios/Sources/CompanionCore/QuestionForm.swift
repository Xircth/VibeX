import Foundation

public struct QuestionChoice: Equatable, Sendable, Identifiable {
    public let value: JSONValue
    public let label: String
    public let description: String?
    public var id: String { label }
}

/// One step of a question card.
public struct FormQuestion: Equatable, Sendable, Identifiable {
    public enum ValueType: Sendable { case string, number, integer, boolean }

    public let id: String
    /// Schema property the answer is stored under; nil for `x-vibex-questions`, which answer by id.
    public let fieldName: String?
    public let customFieldName: String?
    public let header: String
    public let text: String
    public let multiSelect: Bool
    public let valueType: ValueType
    public let choices: [QuestionChoice]
}

public struct QuestionAnswer: Equatable, Sendable {
    public var selected: [JSONValue] = []
    public var customText = ""

    public init(selected: [JSONValue] = [], customText: String = "") {
        self.selected = selected
        self.customText = customText
    }

    public var trimmedCustom: String { customText.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var isEmpty: Bool { selected.isEmpty && trimmedCustom.isEmpty }
}

/// Turns a question request into card steps and the answer back into the `content` the Agent expects.
/// The shapes mirror the desktop's question card so both clients answer identically.
public enum QuestionForm {
    public static func questions(for request: PendingQuestion) -> [FormQuestion] {
        let root = request.schema
        if let list = root?["x-vibex-questions"]?.arrayValue {
            let parsed = list.enumerated().compactMap { index, item -> FormQuestion? in
                guard item["question"]?.stringValue != nil || item["header"]?.stringValue != nil else { return nil }
                let text = item["question"]?.stringValue ?? "问题 \(index + 1)"
                return FormQuestion(
                    id: item["id"]?.stringValue ?? "question-\(index + 1)",
                    fieldName: nil,
                    customFieldName: nil,
                    header: item["header"]?.stringValue ?? text,
                    text: text,
                    multiSelect: flag(item["multiSelect"]) || flag(item["multi_select"]) || flag(item["is_multi_select"]),
                    valueType: .string,
                    choices: choices(from: item["options"]?.arrayValue ?? [])
                )
            }
            if !parsed.isEmpty { return parsed }
        }
        if case .object(let properties)? = root?["properties"], !properties.isEmpty {
            let names = properties.keys.sorted()
            let companions = Set(names.filter { name in
                name.hasSuffix("_custom") && properties[String(name.dropLast("_custom".count))] != nil
            })
            return names.filter { !companions.contains($0) }.enumerated().map { index, name in
                let property = properties[name] ?? .null
                let isArray = property["type"]?.stringValue == "array"
                let source = isArray ? (property["items"] ?? .null) : property
                var type = FormQuestion.ValueType.string
                switch source["type"]?.stringValue {
                case "number": type = .number
                case "integer": type = .integer
                case "boolean": type = .boolean
                default: break
                }
                var options = schemaChoices(source)
                if type == .boolean && options.isEmpty {
                    options = [
                        QuestionChoice(value: .bool(true), label: "是", description: nil),
                        QuestionChoice(value: .bool(false), label: "否", description: nil),
                    ]
                }
                let text = property["description"]?.stringValue ?? property["title"]?.stringValue ?? name
                return FormQuestion(
                    id: name,
                    fieldName: name,
                    customFieldName: companions.contains(name + "_custom") ? name + "_custom" : nil,
                    header: property["title"]?.stringValue ?? "问题 \(index + 1)",
                    text: text,
                    multiSelect: isArray,
                    valueType: type,
                    choices: options
                )
            }
        }
        return [FormQuestion(
            id: "answer",
            fieldName: "answer",
            customFieldName: nil,
            header: request.prompt,
            text: request.prompt,
            multiSelect: false,
            valueType: .string,
            choices: request.options.map { QuestionChoice(value: .string($0), label: $0, description: nil) }
        )]
    }

    /// `nil` when nothing was answered, which the card sends as a decline.
    public static func content(
        for request: PendingQuestion,
        questions: [FormQuestion],
        answers: [String: QuestionAnswer]
    ) -> JSONValue? {
        guard answers.values.contains(where: { !$0.isEmpty }) else { return nil }
        if request.schema?["x-vibex-questions"]?.arrayValue != nil {
            let items = questions.map { question -> JSONValue in
                let answer = answers[question.id] ?? QuestionAnswer()
                var labels = answer.selected.compactMap { value in
                    question.choices.first { $0.value == value }?.label ?? value.displayText
                }
                if !answer.trimmedCustom.isEmpty { labels.append(answer.trimmedCustom) }
                return .object([
                    "questionId": .string(question.id),
                    "labels": .array(labels.map(JSONValue.string)),
                ])
            }
            return .object(["answers": .array(items)])
        }
        var content: [String: JSONValue] = [:]
        for question in questions {
            let answer = answers[question.id] ?? QuestionAnswer()
            let field = question.fieldName ?? question.id
            let custom = answer.trimmedCustom
            if !custom.isEmpty, let companion = question.customFieldName {
                if question.multiSelect {
                    content[field] = .array(answer.selected)
                } else if let first = answer.selected.first {
                    content[field] = first
                }
                content[companion] = .string(custom)
            } else if !custom.isEmpty {
                let value = parsed(custom, as: question.valueType)
                content[field] = question.multiSelect ? .array(answer.selected + [value]) : value
            } else {
                content[field] = question.multiSelect ? .array(answer.selected) : (answer.selected.first ?? .string(""))
            }
        }
        return .object(content)
    }

    // MARK: Parsing helpers

    private static func flag(_ value: JSONValue?) -> Bool {
        if case .bool(true)? = value { return true }
        return false
    }

    private static func choices(from list: [JSONValue]) -> [QuestionChoice] {
        list.compactMap { item in
            if let label = item.stringValue { return QuestionChoice(value: .string(label), label: label, description: nil) }
            guard let label = item["label"]?.stringValue ?? item["value"]?.stringValue else { return nil }
            return QuestionChoice(
                value: item["value"] ?? .string(label),
                label: label,
                description: item["description"]?.stringValue
            )
        }
    }

    private static func schemaChoices(_ property: JSONValue) -> [QuestionChoice] {
        if let values = property["enum"]?.arrayValue {
            let names = property["enumNames"]?.arrayValue ?? []
            return values.enumerated().compactMap { index, value in
                let label = (index < names.count ? names[index].stringValue : nil) ?? value.displayText
                return label.map { QuestionChoice(value: value, label: $0, description: nil) }
            }
        }
        for key in ["oneOf", "anyOf"] {
            if let variants = property[key]?.arrayValue {
                return variants.compactMap { variant in
                    guard let value = variant["const"] else { return nil }
                    let label = variant["title"]?.stringValue ?? value.displayText
                    return label.map { QuestionChoice(value: value, label: $0, description: variant["description"]?.stringValue) }
                }
            }
        }
        return []
    }

    private static func parsed(_ text: String, as type: FormQuestion.ValueType) -> JSONValue {
        switch type {
        case .number, .integer:
            if let number = Double(text) { return .number(number) }
        case .boolean:
            if text.lowercased() == "true" { return .bool(true) }
            if text.lowercased() == "false" { return .bool(false) }
        case .string:
            break
        }
        return .string(text)
    }
}
