import CompanionCore
import SwiftUI

/// Gate for tabs that read from the paired computer.
struct RequiresServer<Content: View>: View {
    @Environment(ServerStore.self) private var servers
    @Binding var selection: AppTab
    @ViewBuilder let content: (HostClient) -> Content

    var body: some View {
        if let profile = servers.activeProfile {
            if let client = servers.client(for: profile) {
                content(client)
            } else {
                ContentUnavailableView {
                    Label("连接凭据已失效", systemImage: "key.slash")
                } actions: {
                    Button("重新配对") { selection = .settings }
                        .buttonStyle(.borderedProminent)
                }
            }
        } else {
            ContentUnavailableView {
                Label("尚未连接电脑", systemImage: "desktopcomputer")
            } actions: {
                Button("去配对") { selection = .settings }
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}

struct LoadFailureView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("无法读取", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("重试", action: retry)
        }
    }
}
