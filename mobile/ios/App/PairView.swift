import CompanionCore
import SwiftUI
import UIKit

struct PairView: View {
    @Environment(ServerStore.self) private var servers
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var origin = ""
    @State private var deviceName = UIDevice.current.name
    @State private var busy = false
    @State private var scanning = false
    @State private var errorMessage: String?

    private var isInvitation: Bool { PairingInvitation.looksLikeInvitation(code) }

    private var canSubmit: Bool {
        guard !busy, !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        return isInvitation || !origin.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("连接码") {
                    TextField("粘贴连接码", text: $code)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    HStack {
                        Button("粘贴", systemImage: "doc.on.clipboard") {
                            if let text = UIPasteboard.general.string { code = text }
                        }
                        Spacer()
                        Button("扫码", systemImage: "qrcode.viewfinder") { scanning = true }
                    }
                    .buttonStyle(.borderless)
                }
                Section("电脑地址") {
                    if isInvitation {
                        Text("已包含在连接码中").foregroundStyle(.secondary)
                    } else {
                        TextField("http://192.168.1.2:17891", text: $origin)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }
                Section("设备名称") {
                    TextField("设备名称", text: $deviceName)
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("配对电脑")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("配对", action: submit).disabled(!canSubmit)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
            .fullScreenCover(isPresented: $scanning) { scanner }
        }
    }

    private var scanner: some View {
        NavigationStack {
            QRScannerView(
                onCode: { text in
                    code = text
                    scanning = false
                    if PairingInvitation.looksLikeInvitation(text) { submit() }
                },
                onFailure: { message in
                    errorMessage = message
                    scanning = false
                }
            )
            .ignoresSafeArea()
            .navigationTitle("扫描二维码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { scanning = false }
                }
            }
        }
    }

    private func submit() {
        busy = true
        errorMessage = nil
        let input = code.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                try await servers.pair(input: input, manualOrigin: origin, deviceName: deviceName)
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                busy = false
            }
        }
    }
}

#Preview {
    PairView().environment(ServerStore(defaults: UserDefaults(suiteName: "preview")!))
}
