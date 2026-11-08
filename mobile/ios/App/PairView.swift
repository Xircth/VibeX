import CompanionCore
import SwiftUI
import UIKit

struct PairView: View {
    @Environment(ServerStore.self) private var servers
    @Environment(\.dismiss) private var dismiss

    var startWithScanner: Bool = false
    var initialOrigin: String? = nil

    @State private var code = ""
    @State private var origin = ""
    @State private var deviceName = UIDevice.current.name
    @State private var busy = false
    @State private var scanning = false
    @State private var didApplyInitialState = false
    @State private var errorMessage: String?

    private var trimmedCode: String {
        code.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isInvitation: Bool {
        PairingInvitation.looksLikeInvitation(trimmedCode)
    }

    private var parsedInvitationHost: String? {
        guard isInvitation,
              let invitation = try? PairingInvitation.parse(trimmedCode),
              let firstOrigin = invitation.candidateOrigins.first?.value
        else { return nil }
        return firstOrigin
    }

    private var canSubmit: Bool {
        guard !busy, !trimmedCode.isEmpty else { return false }
        return isInvitation || !origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var recentOrigins: [String] {
        var seen = Set<String>()
        var result: [String] = []
        for profile in servers.profiles.reversed() {
            if seen.insert(profile.origin).inserted {
                result.append(profile.origin)
            }
        }
        return result
    }

    var body: some View {
        NavigationStack {
            Form {
                // 1. Primary QR Scan Action
                Section {
                    Button {
                        errorMessage = nil
                        scanning = true
                    } label: {
                        HStack(spacing: 12) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(Color.accentColor.opacity(0.15))
                                    .frame(width: 40, height: 40)
                                Image(systemName: "qrcode.viewfinder")
                                    .font(.system(size: 19, weight: .semibold))
                                    .foregroundStyle(Color.accentColor)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text("扫码配对")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text("对准桌面端二维码即可自动识别连接")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 2)
                    }
                }

                // 2. Connection Code Input
                Section("连接码") {
                    HStack(spacing: 8) {
                        TextField("输入 8 位连接码或粘贴完整邀请码", text: $code)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .font(.subheadline.monospaced())

                        if !code.isEmpty {
                            Button {
                                code = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.tertiary)
                            }
                            .buttonStyle(.borderless)
                        }

                        Button {
                            pasteFromClipboard()
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "doc.on.clipboard")
                                Text("粘贴")
                            }
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Capsule().fill(Color.accentColor.opacity(0.14)))
                            .foregroundStyle(Color.accentColor)
                        }
                        .buttonStyle(.borderless)
                    }

                    if let host = parsedInvitationHost {
                        LabeledContent("识别到的电脑地址") {
                            Text(host)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // 3. Host Address (Only needed when using a short code instead of a full invitation)
                if !isInvitation {
                    Section("电脑地址") {
                        TextField("例如 192.168.1.2 或 http://192.168.1.2:17891", text: $origin)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.subheadline.monospaced())

                        if !recentOrigins.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(recentOrigins, id: \.self) { savedOrigin in
                                        let isSelected = ServerStore.normalizeOrigin(origin) == savedOrigin
                                        Button {
                                            origin = savedOrigin
                                        } label: {
                                            HStack(spacing: 4) {
                                                Image(systemName: isSelected ? "checkmark.circle.fill" : "clock.arrow.circlepath")
                                                    .font(.system(size: 11, weight: .semibold))
                                                Text(savedOrigin)
                                                    .font(.caption2.monospaced())
                                            }
                                            .padding(.horizontal, 10)
                                            .padding(.vertical, 5)
                                            .background(
                                                Capsule()
                                                    .fill(
                                                        isSelected
                                                            ? Color.accentColor.opacity(0.16)
                                                            : Color.secondary.opacity(0.12)
                                                    )
                                            )
                                            .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }

                // 4. Device Name
                Section("本机名称") {
                    TextField("设备名称", text: $deviceName)
                        .font(.subheadline)
                }

                if let errorMessage {
                    Section {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                            Text(errorMessage)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
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
                        Button("配对", action: submit)
                            .fontWeight(.semibold)
                            .disabled(!canSubmit)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
            .fullScreenCover(isPresented: $scanning) { scanner }
            .onAppear {
                guard !didApplyInitialState else { return }
                didApplyInitialState = true
                if let initialOrigin, !initialOrigin.isEmpty {
                    origin = initialOrigin
                } else if origin.isEmpty, let lastOrigin = servers.activeProfile?.origin {
                    origin = lastOrigin
                }
                if startWithScanner {
                    scanning = true
                }
            }
        }
    }

    private var scanner: some View {
        NavigationStack {
            QRScannerView(
                onCode: { text in
                    let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    code = cleaned
                    scanning = false
                    if PairingInvitation.looksLikeInvitation(cleaned) || !origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        submit()
                    }
                },
                onFailure: { message in
                    errorMessage = message
                    scanning = false
                },
                onManualInputTap: {
                    scanning = false
                }
            )
            .ignoresSafeArea()
            .navigationTitle("扫码配对")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") {
                        scanning = false
                    }
                    .foregroundStyle(.white)
                }
            }
        }
    }

    private func pasteFromClipboard() {
        guard let pasted = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines),
              !pasted.isEmpty
        else { return }
        code = pasted
        errorMessage = nil
        if PairingInvitation.looksLikeInvitation(pasted) {
            submit()
        }
    }

    private func submit() {
        guard canSubmit else { return }
        busy = true
        errorMessage = nil
        let input = trimmedCode
        Task {
            do {
                try await servers.pair(input: input, manualOrigin: origin, deviceName: deviceName)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                errorMessage = error.localizedDescription
                busy = false
            }
        }
    }
}

#Preview {
    PairView().environment(ServerStore(defaults: UserDefaults(suiteName: "preview")!))
}
