import Foundation

/// Text shown by the Host as QR and copyable connection code: `vibex-pairing:` + JSON.
public struct PairingInvitation: Decodable, Equatable, Sendable {
    public struct Reachability: Decodable, Equatable, Sendable {
        public let origin: String
        public let kind: String
    }

    public static let prefix = "vibex-pairing:"
    public static let companionPreset = "companion"

    public let version: Int
    public let host_id: String
    public let preset: String
    public let expires_at: String
    public let pairing_id: String
    public let pairing_token: String
    public let reachability: [Reachability]

    public static func looksLikeInvitation(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix(prefix)
    }

    public static func parse(_ text: String) throws -> PairingInvitation {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(prefix) else { throw PairingError.invalidInvitation }
        let json = Data(trimmed.dropFirst(prefix.count).utf8)
        guard let invitation = try? JSONDecoder().decode(PairingInvitation.self, from: json),
              !invitation.pairing_token.isEmpty
        else { throw PairingError.invalidInvitation }
        return invitation
    }

    public var expiresAtDate: Date? {
        let plain = ISO8601DateFormatter()
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: expires_at) ?? plain.date(from: expires_at)
    }

    /// Published HTTPS first, then the rest in Host order; loopback never reaches a phone.
    public var candidateOrigins: [HostOrigin] {
        let parsed = reachability.compactMap { item -> (HostOrigin, Bool)? in
            guard let origin = try? HostOrigin.parse(item.origin),
                  !Self.isLoopback(origin.value)
            else { return nil }
            return (origin, origin.value.hasPrefix("https://"))
        }
        return parsed.filter(\.1).map(\.0) + parsed.filter { !$0.1 }.map(\.0)
    }

    private static func isLoopback(_ origin: String) -> Bool {
        guard let host = URLComponents(string: origin)?.host?.lowercased() else { return true }
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }
}
