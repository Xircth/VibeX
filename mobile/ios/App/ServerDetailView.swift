import SwiftUI

struct ServerDetailView: View {
    @Environment(ServerStore.self) private var servers
    @Environment(\.dismiss) private var dismiss
    let profile: ServerProfile
    @State private var confirmingForget = false

    var body: some View {
        List {
            Section("电脑") {
                LabeledContent("地址", value: profile.origin)
                LabeledContent("VibeX 版本", value: profile.serverVersion)
                LabeledContent("协议版本", value: profile.protocolVersion)
                LabeledContent("设备名称", value: profile.deviceName)
            }
            Section("权限") {
                ForEach(profile.scopes, id: \.self) { Text($0).font(.footnote.monospaced()) }
            }
            Section {
                Button("忘记此电脑", role: .destructive) { confirmingForget = true }
            }
        }
        .navigationTitle("电脑详情")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("忘记此电脑？", isPresented: $confirmingForget, titleVisibility: .visible) {
            Button("忘记", role: .destructive) {
                servers.forget(profile)
                dismiss()
            }
        } message: {
            Text("需要重新配对才能再次连接")
        }
    }
}
