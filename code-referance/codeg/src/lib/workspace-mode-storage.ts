"use client"

const WORKSPACE_MODES = ["conversation", "fusion", "files"] as const

export type PersistedWorkspaceMode = (typeof WORKSPACE_MODES)[number]

interface PersistedWorkspaceState {
  mode: PersistedWorkspaceMode
}

function isWorkspaceMode(value: unknown): value is PersistedWorkspaceMode {
  return WORKSPACE_MODES.includes(value as PersistedWorkspaceMode)
}

export function loadPersistedWorkspaceMode(
  storageKey: string
): PersistedWorkspaceMode | null {
  if (typeof window === "undefined") return null

  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceState>
    if (!isWorkspaceMode(parsed.mode)) return null
    return parsed.mode
  } catch {
    return null
  }
}

export function savePersistedWorkspaceMode(
  storageKey: string,
  mode: PersistedWorkspaceMode
) {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(storageKey, JSON.stringify({ mode }))
  } catch {
    /* ignore */
  }
}
