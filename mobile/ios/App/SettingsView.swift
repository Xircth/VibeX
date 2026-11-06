import SwiftUI

struct SettingsView: View {
    @Environment(ServerStore.self) private var servers
    @State private var showingPair = false

    var body: some View {
        NavigationStack {
            List {
                Section("电脑") {
                    ForEach(servers.profiles) { profile in
                        NavigationLink(value: profile) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(profile.origin)
                                Text("VibeX \(profile.serverVersion)")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .onDelete { offsets in
                        offsets.map { servers.profiles[$0] }.forEach(servers.forget)
                    }
                    Button("配对电脑", systemImage: "plus") { showingPair = true }
                }
            }
            .navigationTitle("设置")
            .navigationDestination(for: ServerProfile.self) { ServerDetailView(profile: $0) }
            .sheet(isPresented: $showingPair) { PairView() }
        }
    }
}

#Preview {
    SettingsView().environment(ServerStore(defaults: UserDefaults(suiteName: "preview")!))
}
