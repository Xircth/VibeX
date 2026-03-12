"use client"

import type { AgentType } from "@/lib/types"

interface PersistedDraftState {
  text: string
}

const STORAGE_PREFIX = "codeg:message-input-draft:v1"
const draftTextCache = new Map<string, string>()
const pendingPersistDrafts = new Map<string, string>()
let idlePersistHandle: number | null = null
let persistenceListenersBound = false

function storageKeyForDraftKey(draftKey: string): string {
  return `${STORAGE_PREFIX}:${draftKey}`
}

function flushPendingDraftPersistence(): void {
  if (typeof window === "undefined") return
  if (pendingPersistDrafts.size === 0) {
    idlePersistHandle = null
    return
  }

  const entries = Array.from(pendingPersistDrafts.entries())
  pendingPersistDrafts.clear()
  idlePersistHandle = null

  for (const [draftKey, text] of entries) {
    try {
      localStorage.setItem(
        storageKeyForDraftKey(draftKey),
        JSON.stringify({ text })
      )
    } catch {
      // Ignore storage quota/permission failures.
    }
  }
}

function cancelScheduledDraftPersistence(): void {
  if (typeof window === "undefined") return
  if (idlePersistHandle == null) return
  if ("cancelIdleCallback" in window) {
    window.cancelIdleCallback(idlePersistHandle)
  }
  idlePersistHandle = null
}

function ensurePersistenceListeners(): void {
  if (typeof window === "undefined") return
  if (persistenceListenersBound) return
  persistenceListenersBound = true

  const flushNow = () => {
    cancelScheduledDraftPersistence()
    flushPendingDraftPersistence()
  }

  window.addEventListener("pagehide", flushNow)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushNow()
    }
  })
}

function scheduleDraftPersistence(): void {
  if (typeof window === "undefined") return
  if (idlePersistHandle != null) return

  ensurePersistenceListeners()
  if ("requestIdleCallback" in window) {
    idlePersistHandle = window.requestIdleCallback(() => {
      flushPendingDraftPersistence()
    })
    return
  }

  // Fallback for runtimes without requestIdleCallback.
  flushPendingDraftPersistence()
}

export function buildConversationDraftStorageKey(
  agentType: AgentType,
  conversationId: number
): string {
  return `conv:${agentType}:${conversationId}`
}

export function buildNewConversationDraftStorageKey(params: {
  folderId: number
}): string {
  return `new:${params.folderId}`
}

export function loadMessageInputDraft(draftKey: string): string | null {
  const cached = draftTextCache.get(draftKey)
  if (typeof cached === "string") return cached
  if (typeof window === "undefined") return null

  try {
    const raw = localStorage.getItem(storageKeyForDraftKey(draftKey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedDraftState>
    if (typeof parsed.text !== "string") return null
    draftTextCache.set(draftKey, parsed.text)
    return parsed.text
  } catch {
    return null
  }
}

export function saveMessageInputDraft(draftKey: string, text: string): void {
  if (text.length === 0) {
    clearMessageInputDraft(draftKey)
    return
  }

  if (draftTextCache.get(draftKey) === text) return
  draftTextCache.set(draftKey, text)
  if (typeof window === "undefined") return

  pendingPersistDrafts.set(draftKey, text)
  scheduleDraftPersistence()
}

export function clearMessageInputDraft(draftKey: string): void {
  draftTextCache.delete(draftKey)
  pendingPersistDrafts.delete(draftKey)
  if (typeof window === "undefined") return

  try {
    localStorage.removeItem(storageKeyForDraftKey(draftKey))
  } catch {
    /* ignore */
  }
}

export function moveMessageInputDraft(
  fromDraftKey: string,
  toDraftKey: string
): void {
  if (fromDraftKey === toDraftKey) return

  const sourceText = loadMessageInputDraft(fromDraftKey)
  const targetText = loadMessageInputDraft(toDraftKey)
  if (sourceText && !targetText) {
    saveMessageInputDraft(toDraftKey, sourceText)
  }
  clearMessageInputDraft(fromDraftKey)
}
