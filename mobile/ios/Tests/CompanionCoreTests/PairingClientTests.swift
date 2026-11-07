import Foundation
import Testing
@testable import CompanionCore

private final class ScriptedTransport: HttpTransport, @unchecked Sendable {
    struct Recorded {
        let method: String
        let url: String
        let headers: [String: String]
        let body: Data?
    }

    private let lock = NSLock()
    private var responses: [HttpExchange]
    private(set) var requests: [Recorded] = []

    init(_ responses: [String], statuses: [Int]) {
        self.responses = zip(statuses, responses).map {
            HttpExchange(status: $0, body: Data($1.utf8))
        }
    }

    func execute(
        method: String, url: String, headers: [String: String], body: Data?
    ) async throws -> HttpExchange {
        lock.withLock {
            requests.append(Recorded(method: method, url: url, headers: headers, body: body))
            return responses.removeFirst()
        }
    }
}

private let credentialJSON = """
{"device_id":"11111111-1111-1111-1111-111111111111","access_token":"device-token","scopes":["conversation.read","conversation.attach"]}
"""
private let capabilitiesJSON = """
{"server_version":"0.1.3","protocol_version":"1.0","minimum_client_version":"1.0","capabilities":["conversation.attach"]}
"""

@Test func redeemStoresCompanionCredentialAndChecksCapabilities() async throws {
    let transport = ScriptedTransport([credentialJSON, capabilitiesJSON], statuses: [201, 200])
    let session = try await PairingClient(transport: transport).redeem(
        origin: HostOrigin.parse("http://127.0.0.1:17891"),
        pairingToken: "one-time-secret",
        deviceName: "iPhone"
    )
    #expect(session.credential.access_token == "device-token")
    #expect(session.capabilities.protocol_version == "1.0")
    #expect(transport.requests.count == 2)
    #expect(transport.requests[0].method == "POST")
    #expect(transport.requests[0].url.hasSuffix("/api/v1/auth/pairings/redeem"))
    let sent = try #require(transport.requests[0].body.flatMap { String(data: $0, encoding: .utf8) })
    #expect(sent.contains("\"pairing_token\":\"one-time-secret\""))
    #expect(transport.requests[1].headers["authorization"] == "Bearer device-token")
}

@Test func redeemRejectsWorkstationScopes() async throws {
    let granted = """
    {"device_id":"11111111-1111-1111-1111-111111111111","access_token":"t","scopes":["conversation.read","plugin.write"]}
    """
    let transport = ScriptedTransport([granted], statuses: [201])
    await #expect(throws: PairingError.nonCompanionScopes(["plugin.write"])) {
        try await PairingClient(transport: transport).redeem(
            origin: HostOrigin.parse("https://host.example"),
            pairingToken: "token"
        )
    }
}

@Test func redeemRejectsIncompatibleProtocolMajor() async throws {
    let newer = """
    {"server_version":"9","protocol_version":"2.0","minimum_client_version":"2.0","capabilities":[]}
    """
    let transport = ScriptedTransport([credentialJSON, newer], statuses: [201, 200])
    await #expect(throws: PairingError.incompatibleProtocol(host: "2.0", client: "1.0")) {
        try await PairingClient(transport: transport).redeem(
            origin: HostOrigin.parse("https://host.example"),
            pairingToken: "token"
        )
    }
}

@Test func hostOriginRejectsCredentialsInUrl() {
    #expect(throws: PairingError.self) {
        try HostOrigin.parse("http://user:secret@127.0.0.1:17891")
    }
}

@Test func hostOriginNormalizesTrailingSlash() throws {
    let origin = try HostOrigin.parse(" https://host.example:8443/base/ ")
    #expect(origin.value == "https://host.example:8443/base")
    #expect(origin.resolve("api/v1/capabilities") == "https://host.example:8443/base/api/v1/capabilities")
}

private func invitationText(
    preset: String = "companion",
    expiresAt: String = "2999-01-01T00:00:00Z",
    origins: [String]
) -> String {
    let reach = origins.map { "{\"origin\":\"\($0)\",\"kind\":\"lan\"}" }.joined(separator: ",")
    return "vibex-pairing:{\"version\":1,\"host_id\":\"h\",\"preset\":\"\(preset)\",\"expires_at\":\"\(expiresAt)\",\"pairing_id\":\"p\",\"pairing_token\":\"secret\",\"reachability\":[\(reach)]}"
}

private final class FlakyTransport: HttpTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var urls: [String] = []
    func execute(
        method: String, url: String, headers: [String: String], body: Data?
    ) async throws -> HttpExchange {
        let step = lock.withLock { () -> Int in
            urls.append(url)
            return urls.count
        }
        if step == 1 { throw URLError(.cannotConnectToHost) }
        let text = step == 2 ? credentialJSON : capabilitiesJSON
        return HttpExchange(status: 200, body: Data(text.utf8))
    }
}

@Test func invitationRejectsWorkstationPresetBeforeAnyRequest() async throws {
    let transport = ScriptedTransport([], statuses: [])
    let invitation = try PairingInvitation.parse(
        invitationText(preset: "workstation", origins: ["http://192.168.1.2:17891"])
    )
    await #expect(throws: PairingError.notCompanionInvitation) {
        try await PairingClient(transport: transport).redeem(invitation: invitation)
    }
    #expect(transport.requests.isEmpty)
}

@Test func invitationRejectsExpired() async throws {
    let invitation = try PairingInvitation.parse(
        invitationText(expiresAt: "2000-01-01T00:00:00Z", origins: ["http://192.168.1.2:17891"])
    )
    await #expect(throws: PairingError.invitationExpired) {
        try await PairingClient(transport: ScriptedTransport([], statuses: [])).redeem(
            invitation: invitation
        )
    }
}

@Test func invitationFallsBackToNextOriginAndSkipsLoopback() async throws {
    let transport = FlakyTransport()
    let invitation = try PairingInvitation.parse(
        invitationText(origins: [
            "http://127.0.0.1:17891", "http://192.168.1.2:17891", "http://192.168.1.3:17891",
        ])
    )
    let session = try await PairingClient(transport: transport).redeem(invitation: invitation)
    #expect(session.origin.value == "http://192.168.1.3:17891")
    #expect(transport.urls.first?.hasPrefix("http://192.168.1.2") == true)
}

@Test func invitationParseRejectsGarbage() {
    #expect(throws: PairingError.invalidInvitation) { try PairingInvitation.parse("K7M2NPQX") }
    #expect(throws: PairingError.invalidInvitation) { try PairingInvitation.parse("vibex-pairing:{") }
}

@Test func redeemExplainsWhyTheHostRejectedTheCode() async throws {
    func body(_ reason: String) -> String {
        "{\"code\":\"conflict\",\"message\":\"x\",\"retryable\":false,\"operation_id\":\"o\",\"details\":{\"reason\":\"\(reason)\"}}"
    }
    for (reason, status, expected) in [
        ("pairing_redeemed", 409, PairingError.codeAlreadyUsed),
        ("pairing_expired", 409, PairingError.codeExpired),
        ("invalid_pairing", 401, PairingError.codeInvalid),
    ] {
        let transport = ScriptedTransport([body(reason)], statuses: [status])
        await #expect(throws: expected) {
            try await PairingClient(transport: transport).redeem(
                origin: HostOrigin.parse("http://127.0.0.1:17891"),
                pairingToken: "YGFQX9R2"
            )
        }
    }
    let unknown = ScriptedTransport(["oops"], statuses: [500])
    await #expect(throws: PairingError.redeemFailed(500)) {
        try await PairingClient(transport: unknown).redeem(
            origin: HostOrigin.parse("http://127.0.0.1:17891"),
            pairingToken: "x"
        )
    }
}
