import CompanionCore
import Foundation
import Observation

/// Reader-facing text for a failed Host call: unreachable and revoked need different actions.
func describeHostFailure(_ error: Error) -> String {
    if error is URLError {
        return "无法连接电脑。请确认电脑上的 VibeX 正在运行并已开启远程访问，恢复后会自动重试"
    }
    if case HostError.server(let status, _) = error, status == 401 {
        return "配对已失效，请在设置里重新配对"
    }
    return error.localizedDescription
}

@MainActor
@Observable
final class RemoteList<Item> {
    private(set) var items: [Item]?
    private(set) var errorMessage: String?

    func load(_ fetch: () async throws -> [Item]) async {
        do {
            items = try await fetch()
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            errorMessage = describeHostFailure(error)
        }
    }
}
