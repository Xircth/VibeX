import Foundation

/// Rows of one Conversation's transcript, merged across polls.
public struct TranscriptState: Sendable {
    public let conversationID: String
    public private(set) var items: [TimelineItem] = []
    var nextIndex = 0
    private var order: [String] = []
    private var rows: [String: (revision: Double, row: JSONValue)] = [:]

    public init(conversationID: String) {
        self.conversationID = conversationID
    }

    mutating func merge(_ incoming: [JSONValue]) {
        for row in incoming {
            guard let id = row["row_id"]?.stringValue else { continue }
            var revision = 0.0
            if case .number(let value)? = row["revision"] { revision = value }
            if let known = rows[id], known.revision > revision { continue }
            if rows[id] == nil { order.append(id) }
            rows[id] = (revision, row)
        }
        items = TimelineBuilder.build(fromRows: order.compactMap { rows[$0]?.row })
    }
}
