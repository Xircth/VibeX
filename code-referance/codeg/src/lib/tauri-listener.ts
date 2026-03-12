type TauriUnlisten = () => void | Promise<void>

const disposedListeners = new WeakSet<TauriUnlisten>()

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isKnownDisposeRaceError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("listeners[eventid].handlerid") ||
    normalized.includes("cannot read properties of undefined") ||
    normalized.includes("undefined is not an object")
  )
}

function handleDisposeError(error: unknown, scope?: string): void {
  const message = getErrorMessage(error)
  if (isKnownDisposeRaceError(message)) return
  if (scope) {
    console.warn(`[${scope}] failed to dispose listener:`, error)
  } else {
    console.warn("[tauri-listener] failed to dispose listener:", error)
  }
}

/**
 * Dispose Tauri listener functions defensively.
 *
 * React StrictMode, rapid tab/window switches, and async listener setup can
 * trigger duplicate dispose paths. Tauri can throw when the internal listener
 * is already gone; this helper makes cleanup idempotent.
 */
export function disposeTauriListener(
  unlisten: TauriUnlisten | null | undefined,
  scope?: string
): void {
  if (!unlisten) return
  if (disposedListeners.has(unlisten)) return

  disposedListeners.add(unlisten)

  try {
    const disposeResult = unlisten()
    void Promise.resolve(disposeResult).catch((error) => {
      handleDisposeError(error, scope)
    })
  } catch (error) {
    handleDisposeError(error, scope)
  }
}
