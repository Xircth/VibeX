"use client"

export interface PersistedPanelState {
  isOpen: boolean
  width: number
}

export function loadPersistedPanelState(
  storageKey: string
): PersistedPanelState | null {
  if (typeof window === "undefined") return null

  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedPanelState>
    if (typeof parsed.isOpen !== "boolean") return null
    if (typeof parsed.width !== "number" || Number.isNaN(parsed.width)) {
      return null
    }
    return { isOpen: parsed.isOpen, width: parsed.width }
  } catch {
    return null
  }
}

export function savePersistedPanelState(
  storageKey: string,
  state: PersistedPanelState
) {
  if (typeof window === "undefined") return

  try {
    localStorage.setItem(storageKey, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}
