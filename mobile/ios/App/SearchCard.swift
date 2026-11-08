import SwiftUI

struct SearchResultItem: Identifiable, Equatable {
    let id: String
    let title: String
    let subtitle: String?
    let icon: String
    let action: () -> Void

    static func == (lhs: SearchResultItem, rhs: SearchResultItem) -> Bool {
        lhs.id == rhs.id && lhs.title == rhs.title && lhs.subtitle == rhs.subtitle && lhs.icon == rhs.icon
    }
}

/// Top status pill showing the paired computer and live connection health:
/// green dot when connected, yellow dot when disconnected or failing.
struct ConnectedDeviceBar: View {
    @Environment(ServerStore.self) private var servers
    let isConnected: Bool

    private var deviceTitle: String {
        guard let profile = servers.activeProfile else { return "未配对电脑" }
        if let host = URL(string: profile.origin)?.host, !host.isEmpty {
            return "VibeX · \(host)"
        }
        return profile.origin
    }

    private var statusText: String {
        isConnected ? "已连接" : "连接异常"
    }

    private var dotColor: Color {
        isConnected ? Color.green : Color.yellow
    }

    var body: some View {
        HStack(spacing: 7) {
            ZStack {
                Circle()
                    .fill(dotColor.opacity(0.24))
                    .frame(width: 14, height: 14)
                Circle()
                    .fill(dotColor)
                    .frame(width: 7.5, height: 7.5)
            }
            Text(deviceTitle)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Text("·")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.tertiary)
            Text(statusText)
                .font(.system(size: 12))
                .foregroundStyle(isConnected ? Color.secondary : Color.orange)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            Capsule(style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
                .shadow(color: .black.opacity(0.05), radius: 6, y: 2)
        )
        .overlay(
            Capsule(style: .continuous)
                .strokeBorder(Color.primary.opacity(0.07), lineWidth: 0.5)
        )
    }
}

/// SwiftUI port of the SearchList + GlideMenu card:
/// a 40pt input row with clear button, live-filtered GlideMenu results, and a centered empty state.
struct SearchListCard: View {
    @Binding var query: String
    let placeholder: String
    let results: [SearchResultItem]
    var emptyTitle: String = "未找到匹配结果"
    var emptyHint: String = "换个关键词试试"

    @FocusState private var isFocused: Bool
    @State private var isSearchActive = false
    @State private var selectedID: String?
    @State private var cardGlobalFrame: CGRect = .zero
    @Namespace private var glideNamespace

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var showDropdown: Bool {
        isSearchActive && !trimmedQuery.isEmpty
    }

    private var isEmptyResult: Bool {
        !trimmedQuery.isEmpty && results.isEmpty
    }

    private var showCancelButton: Bool {
        isFocused || isSearchActive || !query.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            // Input row (h-10 / 40pt)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(isFocused ? Color.accentColor : Color.secondary)
                    .frame(width: 16, height: 16)

                TextField(placeholder, text: $query)
                    .font(.system(size: 13))
                    .foregroundStyle(.primary)
                    .focused($isFocused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .onSubmit {
                        if let first = results.first {
                            selectResult(first)
                        } else {
                            isFocused = false
                        }
                    }

                if !query.isEmpty {
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) {
                            query = ""
                            selectedID = nil
                        }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 24, height: 24)
                            .background(
                                Circle()
                                    .fill(Color.primary.opacity(0.06))
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("清除搜索")
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }

                if showCancelButton {
                    Button {
                        cancelSearch()
                    } label: {
                        Text("取消")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(Color.accentColor)
                            .padding(.leading, 2)
                    }
                    .buttonStyle(.plain)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .contentShape(Rectangle())
            .onTapGesture {
                if !isFocused {
                    isFocused = true
                    isSearchActive = true
                }
            }

            if showDropdown {
                Divider()
                    .overlay(Color.primary.opacity(0.08))

                if isEmptyResult {
                    VStack(spacing: 4) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.primary.opacity(0.05))
                                .frame(width: 32, height: 32)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .strokeBorder(Color.primary.opacity(0.08), lineWidth: 0.5)
                                )
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                        .padding(.bottom, 4)

                        Text(emptyTitle)
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.primary)
                        Text(emptyHint)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 28)
                    .transition(.opacity)
                } else {
                    VStack(spacing: 1) {
                        ForEach(results.prefix(6)) { item in
                            let isActive = selectedID == item.id
                            Button {
                                selectResult(item)
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: item.icon)
                                        .font(.system(size: 12))
                                        .foregroundStyle(.secondary)
                                        .frame(width: 16)
                                    Text(item.title)
                                        .font(.system(size: 13))
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Spacer(minLength: 6)
                                    if let subtitle = item.subtitle, !subtitle.isEmpty {
                                        Text(subtitle)
                                            .font(.system(size: 11, design: .monospaced))
                                            .foregroundStyle(.tertiary)
                                            .lineLimit(1)
                                            .truncationMode(.head)
                                    }
                                }
                                .padding(.horizontal, 8)
                                .frame(height: 32)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background {
                                    if isActive {
                                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                                            .fill(Color.primary.opacity(0.07))
                                            .matchedGeometryEffect(id: "glide-highlight", in: glideNamespace)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(4)
                    .transition(.opacity)
                }
            }
        }
        .background(
            GeometryReader { geo in
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
                    .shadow(color: .black.opacity(0.06), radius: 10, y: 3)
                    .onAppear {
                        cardGlobalFrame = geo.frame(in: .global)
                    }
                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                        cardGlobalFrame = newFrame
                    }
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(
                    isFocused ? Color.accentColor.opacity(0.45) : Color.primary.opacity(0.08),
                    lineWidth: isFocused ? 1.0 : 0.5
                )
        )
        .animation(.easeOut(duration: 0.18), value: showDropdown)
        .animation(.easeOut(duration: 0.18), value: isEmptyResult)
        .animation(.easeOut(duration: 0.18), value: showCancelButton)
        .onChange(of: isFocused) { _, focused in
            if focused {
                isSearchActive = true
            }
        }
        .onChange(of: query) { _, newValue in
            if !newValue.isEmpty {
                isSearchActive = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .vibexTapOutsideInput)) { note in
            guard showCancelButton else { return }
            if let locationValue = note.userInfo?["location"] as? NSValue {
                let point = locationValue.cgPointValue
                if !cardGlobalFrame.insetBy(dx: -8, dy: -8).contains(point) {
                    cancelSearch()
                }
            }
        }
    }

    private func selectResult(_ item: SearchResultItem) {
        withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.2)) {
            selectedID = item.id
            isFocused = false
            isSearchActive = false
            query = ""
        }
        dismissKeyboard()
        item.action()
    }

    private func cancelSearch() {
        withAnimation(.easeOut(duration: 0.18)) {
            isFocused = false
            isSearchActive = false
            query = ""
            selectedID = nil
        }
        dismissKeyboard()
    }
}
