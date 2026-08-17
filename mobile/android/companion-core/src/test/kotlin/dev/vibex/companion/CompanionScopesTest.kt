package dev.vibex.companion

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CompanionScopesTest {
    @Test
    fun companionAllowlistMatchesHostPreset() {
        assertTrue(CompanionScopes.allowed.contains("conversation.read"))
        assertTrue(CompanionScopes.allowed.contains("offline.read"))
        assertTrue(CompanionScopes.allowed.contains("notification.summary"))
        assertEquals(emptySet(), CompanionScopes.extras(CompanionScopes.allowed))
        assertEquals(setOf("plugin.write", "workflow.write"), CompanionScopes.extras(
            listOf("conversation.read", "plugin.write", "workflow.write"),
        ))
    }
}
