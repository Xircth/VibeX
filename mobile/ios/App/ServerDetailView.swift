import SwiftUI

struct ServerDetailView: View {
    @Environment(ServerStore.self) private var servers
    @Environment(\.dismiss) private var dismiss
    let profile: ServerProfile
    @State private var confirmingForget = false
    @State private var showingRepairSheet = false

    private var isActive: Bool {
        servers.activeProfile?.id == profile.id
    }

    var body: some View {
        List {
            Section("连接信息") {
                LabeledContent("状态") {
                    HStack(spacing: 5) {
                        Circle()
                            .fill(isActive ? Color.green : Color.secondary.opacity(0.4))
                            .frame(width: 7, height: 7)
                        Text(isActive ? "当前连接" : "已保存")
                            .foregroundStyle(isActive ? .primary : .secondary)
                    }
                }
                LabeledContent("电脑名称", value: profile.serverName)
                LabeledContent("地址") {
                    Text(profile.origin)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                }
                LabeledContent("桌面端版本", value: "v\(profile.serverVersion)")
                LabeledContent("通讯协议", value: "v\(profile.protocolVersion)")
                LabeledContent("本机标识", value: profile.deviceName)
            }

            Section {
                if !isActive {
                    Button {
                        servers.setActive(profile.id)
                        dismiss()
                    } label: {
                        Label("设为当前连接电脑", systemImage: "checkmark.circle")
                    }
                }

                Button {
                    showingRepairSheet = true
                } label: {
                    Label("重新配对更新凭据", systemImage: "qrcode.viewfinder")
                }

                Button(role: .destructive) {
                    confirmingForget = true
                } label: {
                    Label("移除此电脑", systemImage: "trash")
                }
            }
        }
        .navigationTitle(profile.displayHost)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showingRepairSheet) {
            PairView(startWithScanner: false, initialOrigin: profile.origin)
        }
        .confirmationDialog("移除此电脑？", isPresented: $confirmingForget, titleVisibility: .visible) {
            Button("移除", role: .destructive) {
                servers.forget(profile)
                dismiss()
            }
        } message: {
            Text("移除后需重新扫码或输入连接码才能再次连接")
        }
    }
}
