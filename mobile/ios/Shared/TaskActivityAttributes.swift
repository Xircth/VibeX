import ActivityKit
import Foundation

/// Live Activity for an Agent run (task list progress, or the current step when there is none): Dynamic Island on supporting iPhones, Lock Screen otherwise.
struct TaskActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var completed: Int
        var total: Int
        var currentTask: String
        var isRunning: Bool
        /// When the current run began; drives the elapsed timer shown while there is no task list.
        var startedAt: Date
    }

    var conversationTitle: String
}
