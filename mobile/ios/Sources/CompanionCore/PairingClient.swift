import Foundation

public struct HttpExchange: Sendable {
    public let status: Int
    public let body: Data

    public init(status: Int, body: Data) {
        self.status = status
        self.body = body
    }
}

public protocol HttpTransport: Sendable {
    func execute(
        method: String,
        url: String,
        headers: [String: String],
        body: Data?
    ) async throws -> HttpExchange
}

public enum PairingError: Error, Equatable, LocalizedError {
    case invalidOrigin(String)
    case missingInput(String)
    case redeemFailed(Int)
    case codeAlreadyUsed
    case codeExpired
    case codeInvalid
    case nonCompanionScopes([String])
    case capabilitiesFailed(Int)
    case incompatibleProtocol(host: String, client: String)
    case invalidInvitation
    case notCompanionInvitation
    case invitationExpired
    case unreachable

    public var errorDescription: String? {
        switch self {
        case .invalidOrigin(let message), .missingInput(let message):
            return message
        case .redeemFailed(let status):
            return "配对失败（\(status)）"
        case .codeAlreadyUsed:
            return "连接码已被使用，请在电脑上重新生成"
        case .codeExpired:
            return "连接码已过期，请在电脑上重新生成"
        case .codeInvalid:
            return "连接码不正确，请检查后重试"
        case .nonCompanionScopes(let scopes):
            return "Host granted non-companion scopes: \(scopes.joined(separator: ", "))"
        case .capabilitiesFailed(let status):
            return "Capabilities check failed (\(status))"
        case .incompatibleProtocol(let host, let client):
            return "Host protocol \(host) is incompatible with client \(client)"
        case .invalidInvitation:
            return "无法识别连接码"
        case .notCompanionInvitation:
            return "此连接码不是手机用的。在电脑上将“连接设备”选为“手机”后重新生成"
        case .invitationExpired:
            return "连接码已过期，请在电脑上重新生成"
        case .unreachable:
            return "无法连接到电脑，请确认手机与电脑在同一网络"
        }
    }
}

public struct CompanionSession {
    public let origin: HostOrigin
    public let credential: DeviceCredential
    public let capabilities: ServerCapabilities
}

public struct PairingClient {
    public static let clientProtocolVersion = "1.0"
    public static let protocolHeader = "x-vibex-protocol-version"

    private let transport: HttpTransport
    private let protocolVersion: String

    public init(
        transport: HttpTransport = URLSessionTransport(),
        protocolVersion: String = PairingClient.clientProtocolVersion
    ) {
        self.transport = transport
        self.protocolVersion = protocolVersion
    }

    public func redeem(
        origin: HostOrigin,
        pairingToken: String,
        deviceName: String = "iOS Companion"
    ) async throws -> CompanionSession {
        let token = pairingToken.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw PairingError.missingInput("Pairing token is required") }
        guard !name.isEmpty else { throw PairingError.missingInput("Device name is required") }

        let body = try JSONSerialization.data(
            withJSONObject: ["pairing_token": token, "device_name": name]
        )
        let redeem = try await transport.execute(
            method: "POST",
            url: origin.resolve("/api/v1/auth/pairings/redeem"),
            headers: [
                "content-type": "application/json",
                Self.protocolHeader: protocolVersion,
            ],
            body: body
        )
        guard (200...299).contains(redeem.status) else {
            throw Self.redeemError(status: redeem.status, body: redeem.body)
        }
        let credential = try JSONDecoder().decode(DeviceCredential.self, from: redeem.body)
        let extras = CompanionScopes.extras(credential.scopes)
        guard extras.isEmpty else {
            throw PairingError.nonCompanionScopes(extras.sorted())
        }

        let response = try await transport.execute(
            method: "GET",
            url: origin.resolve("/api/v1/capabilities"),
            headers: [
                "authorization": "Bearer \(credential.access_token)",
                Self.protocolHeader: protocolVersion,
            ],
            body: nil
        )
        guard (200...299).contains(response.status) else {
            throw PairingError.capabilitiesFailed(response.status)
        }
        let capabilities = try JSONDecoder().decode(ServerCapabilities.self, from: response.body)
        guard Self.major(capabilities.protocol_version) == Self.major(protocolVersion) else {
            throw PairingError.incompatibleProtocol(
                host: capabilities.protocol_version,
                client: protocolVersion
            )
        }
        return CompanionSession(origin: origin, credential: credential, capabilities: capabilities)
    }

    public func redeem(
        invitation: PairingInvitation,
        deviceName: String = "iOS Companion",
        now: Date = Date()
    ) async throws -> CompanionSession {
        guard invitation.preset == PairingInvitation.companionPreset else {
            throw PairingError.notCompanionInvitation
        }
        if let expiry = invitation.expiresAtDate, expiry <= now {
            throw PairingError.invitationExpired
        }
        let origins = invitation.candidateOrigins
        guard !origins.isEmpty else { throw PairingError.unreachable }
        for origin in origins {
            do {
                return try await redeem(
                    origin: origin,
                    pairingToken: invitation.pairing_token,
                    deviceName: deviceName
                )
            } catch let error as PairingError {
                throw error
            } catch {
                continue
            }
        }
        throw PairingError.unreachable
    }

    /// The Host explains a rejected code in `details.reason`; map it to something the user can act on.
    static func redeemError(status: Int, body: Data) -> PairingError {
        struct Failure: Decodable {
            struct Details: Decodable { let reason: String? }
            let details: Details?
        }
        let reason = (try? JSONDecoder().decode(Failure.self, from: body))?.details?.reason
        switch reason {
        case "pairing_redeemed": return .codeAlreadyUsed
        case "pairing_expired": return .codeExpired
        case "invalid_pairing": return .codeInvalid
        default: return status == 401 ? .codeInvalid : .redeemFailed(status)
        }
    }

    static func major(_ version: String) -> Substring {
        version.split(separator: ".", maxSplits: 1).first ?? ""
    }
}

public struct URLSessionTransport: HttpTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func execute(
        method: String,
        url: String,
        headers: [String: String],
        body: Data?
    ) async throws -> HttpExchange {
        guard let target = URL(string: url) else {
            throw PairingError.invalidOrigin("Host origin is not a valid URI")
        }
        var request = URLRequest(url: target, timeoutInterval: 20)
        request.httpMethod = method
        request.httpBody = body
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return HttpExchange(status: status, body: data)
    }
}
