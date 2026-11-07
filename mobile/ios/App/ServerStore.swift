import CompanionCore
import Foundation
import Observation

struct ServerProfile: Codable, Identifiable, Hashable {
    let id: String
    var origin: String
    var deviceName: String
    var serverVersion: String
    var protocolVersion: String
    var scopes: [String]

    var displayHost: String {
        URL(string: origin)?.host ?? origin
    }

    var serverName: String {
        "VibeX (\(displayHost))"
    }
}

@Observable
final class ServerStore {
    private(set) var profiles: [ServerProfile]
    private let defaults: UserDefaults
    private static let key = "server-profiles"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.profiles = (defaults.data(forKey: Self.key))
            .flatMap { try? JSONDecoder().decode([ServerProfile].self, from: $0) } ?? []
    }

    /// `input` is a pasted or scanned invitation, or a bare connection code with a manual origin.
    func pair(input: String, manualOrigin: String, deviceName: String) async throws {
        let client = PairingClient()
        let session: CompanionSession
        if PairingInvitation.looksLikeInvitation(input) {
            let invitation = try PairingInvitation.parse(input)
            session = try await client.redeem(invitation: invitation, deviceName: deviceName)
        } else {
            session = try await client.redeem(
                origin: try HostOrigin.parse(manualOrigin),
                pairingToken: input,
                deviceName: deviceName
            )
        }
        let id = session.credential.device_id
        try KeychainStore.save(session.credential.access_token, account: id)
        let profile = ServerProfile(
            id: id,
            origin: session.origin.value,
            deviceName: deviceName,
            serverVersion: session.capabilities.server_version,
            protocolVersion: session.capabilities.protocol_version,
            scopes: session.credential.scopes
        )
        profiles.removeAll { $0.origin == profile.origin }
        profiles.append(profile)
        persist()
    }

    /// The most recently paired computer is the one the tabs read from.
    var activeProfile: ServerProfile? { profiles.last }

    func activeClient() -> HostClient? {
        activeProfile.flatMap { client(for: $0) }
    }

    func setActive(_ profileID: String) {
        guard let idx = profiles.firstIndex(where: { $0.id == profileID }) else { return }
        let chosen = profiles.remove(at: idx)
        profiles.append(chosen)
        persist()
    }

    func remove(_ profileID: String) {
        guard let profile = profiles.first(where: { $0.id == profileID }) else { return }
        forget(profile)
    }

    func client(for profile: ServerProfile) -> HostClient? {
        guard let origin = try? HostOrigin.parse(profile.origin),
              let token = KeychainStore.read(account: profile.id)
        else { return nil }
        return HostClient(origin: origin, accessToken: token)
    }

    func forget(_ profile: ServerProfile) {
        KeychainStore.delete(account: profile.id)
        profiles.removeAll { $0.id == profile.id }
        persist()
    }

    private func persist() {
        defaults.set(try? JSONEncoder().encode(profiles), forKey: Self.key)
    }
}
