"use client"

import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { ChevronDown, Play, Plus, Square } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useFolderContext } from "@/contexts/folder-context"
import { useTerminalContext } from "@/contexts/terminal-context"
import {
  bootstrapFolderCommandsFromPackageJson,
  listFolderCommands,
  terminalKill,
  terminalList,
} from "@/lib/tauri"
import { disposeTauriListener } from "@/lib/tauri-listener"
import type { FolderCommand, TerminalEvent } from "@/lib/types"
import { CommandManageDialog } from "./command-manage-dialog"

function getSelectedCommandId(folderId: number): number | null {
  try {
    const v = localStorage.getItem(`lastCmd:${folderId}`)
    return v ? Number(v) : null
  } catch {
    return null
  }
}

function setSelectedCommandId(folderId: number, cmdId: number) {
  try {
    localStorage.setItem(`lastCmd:${folderId}`, String(cmdId))
  } catch {
    /* ignore */
  }
}

export function CommandDropdown() {
  const t = useTranslations("Folder.commandDropdown")
  const { folder } = useFolderContext()
  const { createTerminalWithCommand } = useTerminalContext()
  const [commands, setCommands] = useState<FolderCommand[]>([])
  const [manageOpen, setManageOpen] = useState(false)
  const [bootstrapping, setBootstrapping] = useState(false)
  const [selectedCommandId, setSelectedCommandIdState] = useState<
    number | null
  >(null)
  const [runningCommandTerminals, setRunningCommandTerminals] = useState<
    Record<number, string>
  >({})
  const exitUnlistenersRef = useRef<Map<string, UnlistenFn>>(new Map())
  const runningCommandTerminalsRef = useRef<Record<number, string>>({})

  const folderId = folder?.id ?? 0
  const folderPath = folder?.path ?? ""

  useEffect(() => {
    runningCommandTerminalsRef.current = runningCommandTerminals
  }, [runningCommandTerminals])

  const clearRunningByTerminalId = useCallback((terminalId: string) => {
    const unlisten = exitUnlistenersRef.current.get(terminalId)
    if (unlisten) {
      disposeTauriListener(unlisten, "CommandDropdown.terminalExit")
      exitUnlistenersRef.current.delete(terminalId)
    }

    setRunningCommandTerminals((prev) => {
      let changed = false
      const next = { ...prev }
      for (const [commandId, mappedTerminalId] of Object.entries(prev)) {
        if (mappedTerminalId === terminalId) {
          delete next[Number(commandId)]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const clearAllRunningStates = useCallback(() => {
    for (const unlisten of exitUnlistenersRef.current.values()) {
      disposeTauriListener(unlisten, "CommandDropdown.terminalExit")
    }
    exitUnlistenersRef.current.clear()
    setRunningCommandTerminals({})
  }, [])

  const selectCommand = useCallback(
    (commandId: number) => {
      if (!folderId) return
      setSelectedCommandId(folderId, commandId)
      setSelectedCommandIdState(commandId)
    },
    [folderId]
  )

  useEffect(() => {
    if (!folderId) {
      setSelectedCommandIdState(null)
      clearAllRunningStates()
      return
    }
    setSelectedCommandIdState(getSelectedCommandId(folderId))
    clearAllRunningStates()
  }, [clearAllRunningStates, folderId])

  useEffect(
    () => () => {
      clearAllRunningStates()
    },
    [clearAllRunningStates]
  )

  const refreshCommands = useCallback(async () => {
    if (!folderId) return
    try {
      setCommands(await listFolderCommands(folderId))
    } catch (err) {
      console.error("Failed to load commands:", err)
    }
  }, [folderId])

  useEffect(() => {
    if (!folderId) return
    let ignore = false
    const loadCommands = async () => {
      try {
        setBootstrapping(false)
        const data = await listFolderCommands(folderId)
        if (ignore) return

        if (data.length > 0 || !folderPath) {
          setCommands(data)
          return
        }

        setBootstrapping(true)
        const bootstrapped = await bootstrapFolderCommandsFromPackageJson(
          folderId,
          folderPath
        )
        if (!ignore) setCommands(bootstrapped)
      } catch (err) {
        console.error("Failed to load commands:", err)
      } finally {
        if (!ignore) setBootstrapping(false)
      }
    }

    loadCommands()

    return () => {
      ignore = true
    }
  }, [folderId, folderPath])

  const registerExitListener = useCallback(
    async (terminalId: string) => {
      if (exitUnlistenersRef.current.has(terminalId)) return
      try {
        const unlisten = await listen<TerminalEvent>(
          `terminal://exit/${terminalId}`,
          () => {
            clearRunningByTerminalId(terminalId)
          }
        )
        exitUnlistenersRef.current.set(terminalId, unlisten)
      } catch (err) {
        console.error("Failed to subscribe terminal exit event:", err)
      }
    },
    [clearRunningByTerminalId]
  )

  const runCommand = useCallback(
    async (cmd: FolderCommand) => {
      if (!folderPath) return
      if (runningCommandTerminalsRef.current[cmd.id]) return

      selectCommand(cmd.id)
      const terminalId = await createTerminalWithCommand(cmd.name, cmd.command)
      if (!terminalId) return

      setRunningCommandTerminals((prev) => ({ ...prev, [cmd.id]: terminalId }))
      await registerExitListener(terminalId)
    },
    [createTerminalWithCommand, folderPath, registerExitListener, selectCommand]
  )

  const stopCommand = useCallback(
    async (cmd: FolderCommand) => {
      const terminalId = runningCommandTerminalsRef.current[cmd.id]
      if (!terminalId) return

      clearRunningByTerminalId(terminalId)
      try {
        await terminalKill(terminalId)
      } catch (err) {
        console.error("Failed to stop command terminal:", err)
      }
    },
    [clearRunningByTerminalId]
  )

  useEffect(() => {
    if (Object.keys(runningCommandTerminals).length === 0) return
    let cancelled = false

    const syncRunningCommandState = async () => {
      try {
        const terminals = await terminalList()
        if (cancelled) return

        const aliveTerminalIds = new Set(terminals.map((item) => item.id))
        for (const terminalId of Object.values(
          runningCommandTerminalsRef.current
        )) {
          if (!aliveTerminalIds.has(terminalId)) {
            clearRunningByTerminalId(terminalId)
          }
        }
      } catch (err) {
        console.error("Failed to sync command terminal state:", err)
      }
    }

    syncRunningCommandState()
    const timer = setInterval(syncRunningCommandState, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [clearRunningByTerminalId, runningCommandTerminals])

  const activeCmd = useMemo(
    () =>
      commands.find((c) => c.id === selectedCommandId) ?? commands[0] ?? null,
    [commands, selectedCommandId]
  )
  const activeTerminalId = activeCmd
    ? runningCommandTerminals[activeCmd.id]
    : undefined
  const isActiveCommandRunning = Boolean(activeTerminalId)

  useEffect(() => {
    if (!activeCmd && selectedCommandId !== null) {
      setSelectedCommandIdState(null)
      return
    }
    if (!activeCmd || selectedCommandId === activeCmd.id) return
    selectCommand(activeCmd.id)
  }, [activeCmd, selectedCommandId, selectCommand])

  const handleRunOrStop = useCallback(() => {
    if (!activeCmd) return
    if (isActiveCommandRunning) {
      void stopCommand(activeCmd)
      return
    }
    void runCommand(activeCmd)
  }, [activeCmd, isActiveCommandRunning, runCommand, stopCommand])

  const handleSelectCommand = useCallback(
    (cmd: FolderCommand) => {
      selectCommand(cmd.id)
    },
    [selectCommand]
  )

  if (!folder) return null

  // No commands → show add command button
  if (commands.length === 0) {
    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs gap-1 hover:text-foreground/80"
          onClick={() => setManageOpen(true)}
          disabled={bootstrapping}
        >
          <Plus className="h-3 w-3" />
          {bootstrapping ? t("loading") : t("addCommand")}
        </Button>
        <CommandManageDialog
          open={manageOpen}
          onOpenChange={setManageOpen}
          folderId={folderId}
          commands={commands}
          onSaved={refreshCommands}
        />
      </>
    )
  }

  // Has commands → split button: [name ▼] [run/stop]
  return (
    <>
      <div className="flex items-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-6 hover:text-foreground/80">
              <span className="max-w-24 truncate">{activeCmd?.name}</span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            {commands.map((cmd) => (
              <DropdownMenuItem
                key={cmd.id}
                onClick={() => handleSelectCommand(cmd)}
                className={`flex items-center justify-between gap-4 ${
                  cmd.id === activeCmd?.id ? "bg-accent/60" : ""
                }`}
              >
                <span className="truncate">{cmd.name}</span>
                <span className="text-xs text-muted-foreground font-mono truncate max-w-32">
                  {cmd.command}
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setManageOpen(true)}>
              {t("manageCommands")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="sm"
          className={`h-6 px-2 text-xs gap-1 ${
            isActiveCommandRunning
              ? "text-destructive hover:text-destructive"
              : "hover:text-foreground/80"
          }`}
          onClick={handleRunOrStop}
          title={
            isActiveCommandRunning
              ? t("stopCommandTitle", { command: activeCmd?.command ?? "" })
              : t("runCommandTitle", { command: activeCmd?.command ?? "" })
          }
        >
          {isActiveCommandRunning ? (
            <Square className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" />
          )}
        </Button>
      </div>

      <CommandManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        folderId={folderId}
        commands={commands}
        onSaved={refreshCommands}
      />
    </>
  )
}
