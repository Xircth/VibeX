package dev.vibex.companion

import dev.vibex.remote.v1.DeviceCredential
import dev.vibex.remote.v1.RedeemPairingRequest
import dev.vibex.remote.v1.ServerCapabilities
import java.net.HttpURLConnection
import java.net.URI

data class HttpExchange(
    val status: Int,
    val body: String,
)

fun interface HttpTransport {
    fun execute(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpExchange
}

class PairingException(message: String) : RuntimeException(message)

data class CompanionSession(
    val origin: HostOrigin,
    val credential: DeviceCredential,
    val capabilities: ServerCapabilities,
)

class PairingClient(
    private val transport: HttpTransport = UrlConnectionTransport(),
    private val protocolVersion: String = CLIENT_PROTOCOL_VERSION,
) {
    fun redeem(
        origin: HostOrigin,
        pairingToken: String,
        deviceName: String = "Android Companion",
    ): CompanionSession {
        require(pairingToken.isNotBlank()) { "Pairing token is required" }
        require(deviceName.isNotBlank()) { "Device name is required" }

        val redeemBody = RedeemPairingRequest(
            pairing_token = pairingToken.trim(),
            device_name = deviceName.trim(),
        ).encodeJson()
        val redeem = transport.execute(
            "POST",
            origin.resolve("/api/v1/auth/pairings/redeem"),
            mapOf(
                "content-type" to "application/json",
                PROTOCOL_HEADER to protocolVersion,
            ),
            redeemBody,
        )
        if (redeem.status !in 200..299) {
            throw PairingException("Pairing redeem failed (${redeem.status})")
        }
        val credential = parseDeviceCredential(redeem.body)
        val extras = CompanionScopes.extras(credential.scopes)
        if (extras.isNotEmpty()) {
            throw PairingException(
                "Host granted non-companion scopes: ${extras.sorted().joinToString(", ")}",
            )
        }

        val capabilitiesResponse = transport.execute(
            "GET",
            origin.resolve("/api/v1/capabilities"),
            mapOf(
                "authorization" to "Bearer ${credential.access_token}",
                PROTOCOL_HEADER to protocolVersion,
            ),
            null,
        )
        if (capabilitiesResponse.status !in 200..299) {
            throw PairingException("Capabilities check failed (${capabilitiesResponse.status})")
        }
        val capabilities = parseServerCapabilities(capabilitiesResponse.body)
        if (protocolMajor(capabilities.protocol_version) != protocolMajor(protocolVersion)) {
            throw PairingException(
                "Protocol ${capabilities.protocol_version} is incompatible with $protocolVersion",
            )
        }
        return CompanionSession(origin, credential, capabilities)
    }

    companion object {
        const val CLIENT_PROTOCOL_VERSION = "1.0"
        const val PROTOCOL_HEADER = "x-vibex-protocol-version"
    }
}

class UrlConnectionTransport : HttpTransport {
    override fun execute(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: String?,
    ): HttpExchange {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        connection.connectTimeout = 10_000
        connection.readTimeout = 20_000
        connection.requestMethod = method
        connection.doInput = true
        headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
        if (body != null) {
            connection.doOutput = true
            connection.outputStream.use { output ->
                output.write(body.toByteArray(Charsets.UTF_8))
            }
        }
        val status = connection.responseCode
        val stream = if (status >= 400) connection.errorStream else connection.inputStream
        val responseBody = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
        return HttpExchange(status, responseBody)
    }
}
