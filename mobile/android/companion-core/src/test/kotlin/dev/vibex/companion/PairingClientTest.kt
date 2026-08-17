package dev.vibex.companion

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class PairingClientTest {
    @Test
    fun redeemStoresCompanionCredentialAndNegotiatesV1() {
        val transport = ScriptedTransport(
            listOf(
                HttpExchange(
                    201,
                    """{"device_id":"11111111-1111-1111-1111-111111111111","access_token":"device-token","scopes":["conversation.read","conversation.write","offline.read"]}""",
                ),
                HttpExchange(
                    200,
                    """{"server_version":"0.1.3","protocol_version":"1.0","minimum_client_version":"1.0","capabilities":["conversation.attach"]}""",
                ),
            ),
        )
        val session = PairingClient(transport).redeem(
            HostOrigin.parse("http://127.0.0.1:3080"),
            "one-time-secret",
            "Pixel",
        )
        assertEquals("device-token", session.credential.access_token)
        assertEquals("1.0", session.capabilities.protocol_version)
        assertEquals(2, transport.requests.size)
        assertEquals("POST", transport.requests[0].method)
        assertTrue(transport.requests[0].url.endsWith("/api/v1/auth/pairings/redeem"))
        assertTrue(transport.requests[0].body!!.contains("\"pairing_token\":\"one-time-secret\""))
        assertEquals("GET", transport.requests[1].method)
        assertEquals("Bearer device-token", transport.requests[1].headers["authorization"])
    }

    @Test
    fun redeemRejectsWorkstationScopes() {
        val transport = ScriptedTransport(
            listOf(
                HttpExchange(
                    201,
                    """{"device_id":"11111111-1111-1111-1111-111111111111","access_token":"device-token","scopes":["conversation.read","plugin.write"]}""",
                ),
            ),
        )
        val error = assertFailsWith<PairingException> {
            PairingClient(transport).redeem(
                HostOrigin.parse("https://host.example"),
                "token",
            )
        }
        assertTrue(error.message!!.contains("plugin.write"))
    }

    @Test
    fun hostOriginRejectsCredentialsInUrl() {
        assertFailsWith<IllegalArgumentException> {
            HostOrigin.parse("http://user:secret@127.0.0.1:3080")
        }
    }
}

private data class RecordedRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    val body: String?,
)

private class ScriptedTransport(
    private val responses: List<HttpExchange>,
) : HttpTransport {
    val requests = mutableListOf<RecordedRequest>()
    private var index = 0

    override fun execute(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpExchange {
        requests += RecordedRequest(method, url, headers, body)
        return responses[index++]
    }
}
