import ActivityKit
import Foundation

/// High-level human-readable phase of a VibeX Agent session (never raw code).
enum VibeXActivityPhase: String, Codable, Hashable, Sendable {
    case thinking      // 思考规划中
    case exploring     // 查阅项目中
    case developing    // 代码开发中
    case verifying     // 调试验证中
    case summarizing   // 整理回复中
    case waitingInput  // 等待你确认（权限/提问）
    case completed     // 任务已完成
    case failed        // 任务执行异常
}

/// Live Activity for an Agent run: Dynamic Island on supporting iPhones, Lock Screen everywhere else.
struct TaskActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var phase: VibeXActivityPhase
        /// Short 4-5 char badge title (e.g. "代码开发中", "等待你确认", "思考规划中")
        var stageTitle: String
        /// Clean, code-free explanation of what VibeX is doing (e.g. "正在编写与更新项目模块")
        var stageSubtitle: String
        /// Smooth 0.0 ... 1.0 progress for the circular progress ring
        var progress: Double
        var completed: Int
        var total: Int
        var stepCount: Int
        var isRunning: Bool
        /// When the current run began; drives the elapsed timer.
        var startedAt: Date
    }

    var projectName: String
    var conversationTitle: String
}
