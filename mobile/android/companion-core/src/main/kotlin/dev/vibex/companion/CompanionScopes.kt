package dev.vibex.companion

/**
 * Companion Device scopes from ADR-0054. Authorization still checks each
 * scope; this set is only the pairing allowlist the phone will accept.
 */
object CompanionScopes {
    val allowed: Set<String> = setOf(
        "conversation.read",
        "conversation.write",
        "conversation.attach",
        "conversation.permission",
        "conversation.question",
        "conversation.cancel",
        "conversation.steer",
        "artifact.read",
        "workflow.read",
        "automation.read",
        "delegation.read",
        "notification.summary",
        "offline.read",
    )

    fun extras(scopes: Collection<String>): Set<String> =
        scopes.filterNot { it in allowed }.toSet()
}
