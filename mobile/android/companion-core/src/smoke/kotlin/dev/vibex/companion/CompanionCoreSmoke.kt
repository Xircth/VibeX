package dev.vibex.companion

fun main() {
    check(CompanionScopes.allowed.contains("conversation.read"))
    check(CompanionScopes.allowed.contains("offline.read"))
    check(!CompanionScopes.allowed.contains("plugin.write"))
    check(
        CompanionScopes.extras(listOf("conversation.read", "plugin.write")) ==
            setOf("plugin.write"),
    )

    val origin = HostOrigin.parse("http://127.0.0.1:17891/")
    check(origin.value == "http://127.0.0.1:17891")
    check(origin.resolve("/api/v1/capabilities") == "http://127.0.0.1:17891/api/v1/capabilities")

    var threw = false
    try {
        HostOrigin.parse("http://user:secret@127.0.0.1:17891")
    } catch (_: IllegalArgumentException) {
        threw = true
    }
    check(threw)

    val transport = object : HttpTransport {
        override fun execute(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: String?,
        ): HttpExchange {
            return if (method == "POST") {
                check(url.endsWith("/api/v1/auth/pairings/redeem"))
                check(body!!.contains("\"pairing_token\":\"one-time-secret\""))
                HttpExchange(
                    201,
                    """{"device_id":"11111111-1111-1111-1111-111111111111","access_token":"device-token","scopes":["conversation.read","offline.read"]}""",
                )
            } else {
                check(headers["authorization"] == "Bearer device-token")
                HttpExchange(
                    200,
                    """{"server_version":"0.1.3","protocol_version":"1.0","minimum_client_version":"1.0","capabilities":["conversation.attach"]}""",
                )
            }
        }
    }
    val session = PairingClient(transport).redeem(origin, "one-time-secret", "Pixel")
    check(session.credential.access_token == "device-token")
    check(session.capabilities.protocol_version == "1.0")

    val rejected = object : HttpTransport {
        override fun execute(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: String?,
        ): HttpExchange =
            HttpExchange(
                201,
                """{"device_id":"11111111-1111-1111-1111-111111111111","access_token":"device-token","scopes":["plugin.write"]}""",
            )
    }
    var rejectedPairing = false
    try {
        PairingClient(rejected).redeem(origin, "token")
    } catch (error: PairingException) {
        rejectedPairing = error.message!!.contains("plugin.write")
    }
    check(rejectedPairing)
}
