"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { terminalSpawn, terminalKill } from "@/lib/tauri"
import { useFolderContext } from "@/contexts/folder-context"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"

export interface TerminalTab {
  id: string
  title: string
}

const DEFAULT_HEIGHT = 300
const MIN_HEIGHT = 150
const MAX_HEIGHT = 600

interface TerminalContextValue {
  isOpen: boolean
  height: number
  minHeight: number
  maxHeight: number
  toggle: () => void
  setHeight: (h: number) => void
  tabs: TerminalTab[]
  activeTabId: string | null
  createTerminal: () => Promise<void>
  createTerminalInDirectory: (
    workingDir: string,
    title?: string
  ) => Promise<string | null>
  createTerminalWithCommand: (
    title: string,
    command: string
  ) => Promise<string | null>
  closeTerminal: (id: string) => void
  closeOtherTerminals: (id: string) => void
  closeAllTerminals: () => void
  renameTerminal: (id: string, title: string) => void
  switchTerminal: (id: string) => void
}

const TerminalContext = createContext<TerminalContextValue | null>(null)

export function useTerminalContext() {
  const ctx = useContext(TerminalContext)
  if (!ctx) {
    throw new Error("useTerminalContext must be used within TerminalProvider")
  }
  return ctx
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const { folder } = useFolderContext()
  const { shortcuts } = useShortcutSettings()
  const [isOpen, setIsOpen] = useState(false)
  const [height, setHeightState] = useState(DEFAULT_HEIGHT)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const tabCounterRef = useRef(0)
  const spawningRef = useRef(false)
  const suppressAutoCreateRef = useRef(false)
  const lastMouseActivityInTerminalRef = useRef(false)
  // Keep a ref of tabs for cleanup on unmount (effect [] captures stale state)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs

  const folderPath = folder?.path ?? ""

  const killTerminalTabs = useCallback((targetTabs: TerminalTab[]) => {
    targetTabs.forEach((tab) => {
      terminalKill(tab.id).catch(() => {})
    })
  }, [])

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev)
  }, [])

  const createTerminalWithCommand = useCallback(
    async (title: string, command: string) => {
      if (!folderPath) return null

      suppressAutoCreateRef.current = true
      setIsOpen(true)

      try {
        const id = await terminalSpawn(folderPath, command)
        tabCounterRef.current += 1
        setTabs((prev) => [...prev, { id, title }])
        setActiveTabId(id)
        return id
      } catch (err) {
        console.error("Failed to spawn terminal for command:", err)
        return null
      } finally {
        suppressAutoCreateRef.current = false
      }
    },
    [folderPath]
  )

  const createTerminalInDirectory = useCallback(
    async (workingDir: string, title?: string) => {
      if (!workingDir || spawningRef.current) return null

      suppressAutoCreateRef.current = true
      setIsOpen(true)
      spawningRef.current = true

      try {
        const id = await terminalSpawn(workingDir)
        tabCounterRef.current += 1
        const defaultTitle = `Terminal ${tabCounterRef.current}`
        setTabs((prev) => [...prev, { id, title: title ?? defaultTitle }])
        setActiveTabId(id)
        return id
      } catch (err) {
        console.error("Failed to spawn terminal in directory:", err)
        return null
      } finally {
        spawningRef.current = false
        suppressAutoCreateRef.current = false
      }
    },
    []
  )

  const createTerminal = useCallback(async () => {
    if (!folderPath) return
    await createTerminalInDirectory(folderPath)
  }, [folderPath, createTerminalInDirectory])

  // Auto-create first terminal when panel opens with no tabs
  useEffect(() => {
    if (isOpen && tabs.length === 0 && !suppressAutoCreateRef.current) {
      createTerminal()
    }
  }, [isOpen, tabs.length, createTerminal])

  const setHeight = useCallback((h: number) => {
    setHeightState(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h)))
  }, [])

  // No stale closure — reads current activeTabId via updater
  const closeTerminal = useCallback((id: string) => {
    terminalKill(id).catch(() => {})
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (next.length === 0) {
        tabCounterRef.current = 0
        setIsOpen(false)
        setActiveTabId(null)
      }
      return next
    })
    setActiveTabId((prev) => (prev === id ? null : prev))
  }, [])

  // Auto-select last tab when active tab is removed
  useEffect(() => {
    if (activeTabId === null && tabs.length > 0) {
      setActiveTabId(tabs[tabs.length - 1].id)
    }
  }, [activeTabId, tabs])

  const closeOtherTerminals = useCallback(
    (id: string) => {
      setTabs((prev) => {
        killTerminalTabs(prev.filter((t) => t.id !== id))
        return prev.filter((t) => t.id === id)
      })
      setActiveTabId(id)
    },
    [killTerminalTabs]
  )

  const closeAllTerminals = useCallback(() => {
    setTabs((prev) => {
      killTerminalTabs(prev)
      return []
    })
    tabCounterRef.current = 0
    setActiveTabId(null)
    setIsOpen(false)
  }, [killTerminalTabs])

  const renameTerminal = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)))
  }, [])

  const switchTerminal = useCallback((id: string) => {
    setActiveTabId(id)
  }, [])

  const isInTerminalRegion = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false
    return Boolean(target.closest('[data-terminal-panel-region="true"]'))
  }, [])

  const updateLastMouseActivity = useCallback(
    (target: EventTarget | null) => {
      const next = isInTerminalRegion(target)
      if (lastMouseActivityInTerminalRef.current === next) return
      lastMouseActivityInTerminalRef.current = next
    },
    [isInTerminalRegion]
  )

  useEffect(() => {
    const handlePointerActivity = (event: PointerEvent) => {
      updateLastMouseActivity(event.target)
    }
    const handleFocusActivity = (event: FocusEvent) => {
      updateLastMouseActivity(event.target)
    }

    window.addEventListener("pointerover", handlePointerActivity, true)
    window.addEventListener("pointerdown", handlePointerActivity, true)
    window.addEventListener("focusin", handleFocusActivity, true)
    return () => {
      window.removeEventListener("pointerover", handlePointerActivity, true)
      window.removeEventListener("pointerdown", handlePointerActivity, true)
      window.removeEventListener("focusin", handleFocusActivity, true)
    }
  }, [updateLastMouseActivity])

  useEffect(() => {
    if (!isOpen) {
      lastMouseActivityInTerminalRef.current = false
    }
  }, [isOpen])

  useEffect(() => {
    const handleTerminalHotkeys = (event: KeyboardEvent) => {
      if (!isOpen) return

      const targetInTerminal = isInTerminalRegion(event.target)
      const activeElementInTerminal = isInTerminalRegion(document.activeElement)
      const shouldHandle =
        lastMouseActivityInTerminalRef.current ||
        targetInTerminal ||
        activeElementInTerminal
      if (!shouldHandle) return

      if (matchShortcutEvent(event, shortcuts.new_terminal_tab)) {
        event.preventDefault()
        event.stopPropagation()
        void createTerminal()
        return
      }

      if (
        activeTabId &&
        matchShortcutEvent(event, shortcuts.close_current_terminal_tab)
      ) {
        event.preventDefault()
        event.stopPropagation()
        closeTerminal(activeTabId)
      }
    }

    window.addEventListener("keydown", handleTerminalHotkeys, true)
    return () => {
      window.removeEventListener("keydown", handleTerminalHotkeys, true)
    }
  }, [
    activeTabId,
    closeTerminal,
    createTerminal,
    isInTerminalRegion,
    isOpen,
    shortcuts.close_current_terminal_tab,
    shortcuts.new_terminal_tab,
  ])

  // Cleanup all terminals on unmount — uses ref to get current tabs
  useEffect(() => {
    return () => {
      tabsRef.current.forEach((t) => {
        terminalKill(t.id).catch(() => {})
      })
    }
  }, [])

  const value = useMemo(
    () => ({
      isOpen,
      height,
      minHeight: MIN_HEIGHT,
      maxHeight: MAX_HEIGHT,
      toggle,
      setHeight,
      tabs,
      activeTabId,
      createTerminal,
      createTerminalInDirectory,
      createTerminalWithCommand,
      closeTerminal,
      closeOtherTerminals,
      closeAllTerminals,
      renameTerminal,
      switchTerminal,
    }),
    [
      isOpen,
      height,
      toggle,
      setHeight,
      tabs,
      activeTabId,
      createTerminal,
      createTerminalInDirectory,
      createTerminalWithCommand,
      closeTerminal,
      closeOtherTerminals,
      closeAllTerminals,
      renameTerminal,
      switchTerminal,
    ]
  )

  return (
    <TerminalContext.Provider value={value}>
      {children}
    </TerminalContext.Provider>
  )
}
