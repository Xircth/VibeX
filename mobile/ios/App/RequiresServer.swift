import CompanionCore
import SwiftUI

/// Gate for tabs that read from the paired computer.
struct RequiresServer<Content: View>: View {
    @Environment(ServerStore.self) private var servers
    @Binding var selection: AppTab
    @ViewBuilder let content: (HostClient) -> Content

    @State private var showingScannerPair = false
    @State private var showingManualPair = false

    var body: some View {
        Group {
            if let profile = servers.activeProfile {
                if let client = servers.client(for: profile) {
                    content(client)
                } else {
                    ContentUnavailableView {
                        Label("连接凭据已失效", systemImage: "key.slash")
                    } actions: {
                        HStack(spacing: 12) {
                            Button("扫码重新配对", systemImage: "qrcode.viewfinder") {
                                showingScannerPair = true
                            }
                            .buttonStyle(.borderedProminent)

                            Button("连接码配对") {
                                showingManualPair = true
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            } else {
                ContentUnavailableView {
                    Label("尚未连接电脑", systemImage: "desktopcomputer")
                } actions: {
                    HStack(spacing: 12) {
                        Button("扫码配对", systemImage: "qrcode.viewfinder") {
                            showingScannerPair = true
                        }
                        .buttonStyle(.borderedProminent)

                        Button("连接码配对") {
                            showingManualPair = true
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
        .sheet(isPresented: $showingScannerPair) {
            PairView(startWithScanner: true, initialOrigin: servers.activeProfile?.origin)
        }
        .sheet(isPresented: $showingManualPair) {
            PairView(startWithScanner: false, initialOrigin: servers.activeProfile?.origin)
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
