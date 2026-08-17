// Generated from docs/protocol/v1/schema.json. Do not edit.

package dev.vibex.remote.v1

sealed interface JsonValue {
    data object Null : JsonValue
    data class Bool(val value: Boolean) : JsonValue
    data class Number(val value: Double) : JsonValue
    data class Text(val value: String) : JsonValue
    data class Array(val value: List<JsonValue>) : JsonValue
    data class Object(val value: Map<String, JsonValue>) : JsonValue

    fun encode(): String = when (this) {
        Null -> "null"
        is Bool -> value.toString()
        is Number -> if (value % 1.0 == 0.0) value.toLong().toString() else value.toString()
        is Text -> "\"${escape(value)}\""
        is Array -> value.joinToString(prefix = "[", postfix = "]") { it.encode() }
        is Object -> value.entries.joinToString(prefix = "{", postfix = "}") {
            "\"${escape(it.key)}\":${it.value.encode()}"
        }
    }

    companion object {
        fun parse(input: String): JsonValue = Parser(input).parse()

        private fun escape(value: String): String = buildString {
            value.forEach { character ->
                append(
                    when (character) {
                        '\\' -> "\\\\"
                        '"' -> "\\\""
                        '\n' -> "\\n"
                        '\r' -> "\\r"
                        '\t' -> "\\t"
                        else -> character
                    },
                )
            }
        }
    }
}

private class Parser(private val input: String) {
    private var index = 0

    fun parse(): JsonValue {
        val value = value()
        whitespace()
        require(index == input.length) { "trailing JSON" }
        return value
    }

    private fun value(): JsonValue {
        whitespace()
        return when (input.getOrNull(index)) {
            '{' -> objectValue()
            '[' -> arrayValue()
            '"' -> JsonValue.Text(stringValue())
            't' -> literal("true", JsonValue.Bool(true))
            'f' -> literal("false", JsonValue.Bool(false))
            'n' -> literal("null", JsonValue.Null)
            else -> numberValue()
        }
    }

    private fun objectValue(): JsonValue {
        index++
        val values = linkedMapOf<String, JsonValue>()
        whitespace()
        if (input.getOrNull(index) == '}') {
            index++
            return JsonValue.Object(values)
        }
        while (true) {
            whitespace()
            val key = stringValue()
            whitespace()
            require(input.getOrNull(index++) == ':') { "expected colon" }
            values[key] = value()
            whitespace()
            when (input.getOrNull(index++)) {
                '}' -> return JsonValue.Object(values)
                ',' -> Unit
                else -> error("expected comma or object end")
            }
        }
    }

    private fun arrayValue(): JsonValue {
        index++
        val values = mutableListOf<JsonValue>()
        whitespace()
        if (input.getOrNull(index) == ']') {
            index++
            return JsonValue.Array(values)
        }
        while (true) {
            values += value()
            whitespace()
            when (input.getOrNull(index++)) {
                ']' -> return JsonValue.Array(values)
                ',' -> Unit
                else -> error("expected comma or array end")
            }
        }
    }

    private fun stringValue(): String {
        require(input.getOrNull(index++) == '"') { "expected string" }
        return buildString {
            while (true) {
                val character = input.getOrNull(index++) ?: error("unterminated string")
                when (character) {
                    '"' -> return@buildString
                    '\\' -> append(
                        when (val escaped = input.getOrNull(index++)) {
                            '"', '\\', '/' -> escaped
                            'b' -> '\b'
                            'f' -> '\u000C'
                            'n' -> '\n'
                            'r' -> '\r'
                            't' -> '\t'
                            else -> error("unsupported escape")
                        },
                    )
                    else -> append(character)
                }
            }
        }
    }

    private fun numberValue(): JsonValue {
        val start = index
        while (input.getOrNull(index)?.let { it.isDigit() || it in ".-+eE" } == true) index++
        return JsonValue.Number(input.substring(start, index).toDouble())
    }

    private fun literal(text: String, value: JsonValue): JsonValue {
        require(input.startsWith(text, index)) { "invalid literal" }
        index += text.length
        return value
    }

    private fun whitespace() {
        while (input.getOrNull(index)?.isWhitespace() == true) index++
    }
}

data class ServerCapabilities(
    val server_version: String,
    val protocol_version: String,
    val minimum_client_version: String,
    val capabilities: List<CapabilityId>,
)

typealias CapabilityId = String

data class CommandRequest(
    val operation_id: String,
    val args: JsonValue,
)

data class CommandResponse(
    val operation_id: String,
    val data: JsonValue,
)

data class ErrorEnvelope(
    val code: ErrorCode,
    val message: String,
    val retryable: Boolean,
    val operation_id: String,
    val details: JsonValue? = null,
)

enum class ErrorCode { BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, CAPABILITY_UNAVAILABLE, INTERNAL }

typealias SubscriptionClientMessage = JsonValue

typealias SubscriptionRequest = JsonValue

typealias SubscriptionServerMessage = JsonValue

data class SubscriptionSnapshot(
    val through_sequence: Long,
    val payload: JsonValue,
)

data class RemoteEvent(
    val sequence: Long,
    val kind: String,
    val payload: JsonValue,
) {
    companion object {
        fun decodeJson(input: String): RemoteEvent {
            val root = JsonValue.parse(input) as JsonValue.Object
            return RemoteEvent(
                sequence = (root.value["sequence"] as JsonValue.Number).value.toLong(),
                kind = (root.value["kind"] as JsonValue.Text).value,
                payload = root.value.getValue("payload"),
            )
        }
    }

    fun encodeJson(): String = JsonValue.Object(
        mapOf(
            "sequence" to JsonValue.Number(sequence.toDouble()),
            "kind" to JsonValue.Text(kind),
            "payload" to payload,
        ),
    ).encode()
}

enum class DevicePermissionPreset { WORKSTATION, COMPANION }

data class CreatePairingRequest(
    val preset: DevicePermissionPreset?,
    val requested_scopes: List<String>,
)

data class PairingChallenge(
    val pairing_id: String,
    val pairing_token: String,
    val expires_at: String,
    val requested_scopes: List<String>,
)

data class RedeemPairingRequest(
    val pairing_token: String,
    val device_name: String,
)

data class DeviceCredential(
    val device_id: String,
    val access_token: String,
    val scopes: List<String>,
)

data class RevokeDeviceResponse(
    val device_id: String,
    val revoked: Boolean,
)

data class TerminalNotificationSummary(
    val source: JsonValue,
    val outcome: NotificationOutcome,
    val occurred_at: String,
    val operation_id: String,
)

typealias NotificationSource = JsonValue

enum class NotificationOutcome { COMPLETED, FAILED, CANCELLED, INTERRUPTED }

data class OfflineConversationCache(
    val conversation_id: String,
    val confirmed_through: Long,
    val read_only: Boolean = true,
    val events: List<RemoteEvent> = emptyList(),
)
