"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useAcpActions } from "@/contexts/acp-connections-context"
import { useTaskContext } from "@/contexts/task-context"
import { useConnection, type UseConnectionReturn } from "@/hooks/use-connection"
import { AGENT_LABELS, type AgentType, type PromptDraft } from "@/lib/types"

interface UseConnectionLifecycleOptions {
  contextKey: string
  agentType: AgentType
  isActive: boolean
  workingDir?: string
  sessionId?: string
}

export interface UseConnectionLifecycleReturn {
  conn: UseConnectionReturn
  modeLoading: boolean
  configOptionsLoading: boolean
  autoConnectError: string | null
  handleFocus: () => void
  handleSend: (draft: PromptDraft, modeId?: string | null) => void
  handleSetConfigOption: (configId: string, valueId: string) => void
  handleCancel: () => void
  handleRespondPermission: (requestId: string, optionId: string) => void
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isExpectedAutoLinkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  return (error as { alerted?: unknown }).alerted === true
}

export function useConnectionLifecycle({
  contextKey,
  agentType,
  isActive,
  workingDir,
  sessionId,
}: UseConnectionLifecycleOptions): UseConnectionLifecycleReturn {
  const t = useTranslations("Folder.chat.connectionLifecycle")
  const { setActiveKey, touchActivity } = useAcpActions()
  const { addTask, updateTask, removeTask } = useTaskContext()
  const conn = useConnection(contextKey)

  // Destructure stable callbacks (depend only on actions + contextKey)
  // vs. volatile derived state (status, liveMessage, etc.)
  const {
    status,
    selectorsReady,
    connect: connConnect,
    sendPrompt,
    setMode: connSetMode,
    setConfigOption: connSetConfigOption,
    cancel: connCancel,
    respondPermission: connRespondPermission,
    modes,
    configOptions,
  } = conn
  const isInteractiveStatus = status === "connected" || status === "prompting"
  const effectiveSelectorsReady =
    selectorsReady || modes !== null || configOptions !== null
  const selectorTaskIdRef = useRef<string | null>(null)
  const selectorTaskTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const selectorTaskSuppressedRef = useRef(false)
  const modeLoading =
    status === "connecting" ||
    status === "downloading" ||
    (isInteractiveStatus && !effectiveSelectorsReady)
  const configOptionsLoading =
    status === "connecting" ||
    status === "downloading" ||
    (isInteractiveStatus && !effectiveSelectorsReady)
  const [lastAutoConnectError, setLastAutoConnectError] = useState<{
    contextKey: string
    agentType: AgentType
    message: string
  } | null>(null)

  // Refs for auto-connect effect, which intentionally avoids volatile
  // dependencies to prevent reconnect loops. Synced via useEffect —
  // effects run in declaration order, so these are current before
  // the auto-connect effect reads them.
  const statusRef = useRef(status)
  useEffect(() => {
    statusRef.current = status
  }, [status])
  const contextKeyRef = useRef(contextKey)
  useEffect(() => {
    contextKeyRef.current = contextKey
  }, [contextKey])
  const connConnectRef = useRef(connConnect)
  useEffect(() => {
    connConnectRef.current = connConnect
  }, [connConnect])
  const agentTypeRef = useRef(agentType)
  useEffect(() => {
    agentTypeRef.current = agentType
  }, [agentType])
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])
  const modeIdRef = useRef<string | null>(modes?.current_mode_id ?? null)
  useEffect(() => {
    modeIdRef.current = modes?.current_mode_id ?? null
  }, [modes?.current_mode_id])
  // Sync activeKey when this view is the active tab
  useEffect(() => {
    if (isActive && contextKey) {
      setActiveKey(contextKey)
      touchActivity(contextKey)
    }
  }, [isActive, contextKey, setActiveKey, touchActivity])

  // Auto-connect when tab becomes active and workingDir is available.
  // Depends on isActive + workingDir so that connections wait for folder
  // info to load (workingDir transitions from undefined → folder.path).
  // Status changes must NOT re-trigger this to avoid infinite reconnect
  // loops on transient errors.
  useEffect(() => {
    if (!isActive) return
    if (!workingDir) return
    let cancelled = false
    const s = statusRef.current
    if (!s || s === "disconnected" || s === "error") {
      connConnectRef
        .current(agentTypeRef.current, workingDir, sessionIdRef.current, {
          source: "auto_link",
        })
        .then(() => {
          if (!cancelled) {
            setLastAutoConnectError(null)
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setLastAutoConnectError({
              contextKey: contextKeyRef.current,
              agentType: agentTypeRef.current,
              message: normalizeErrorMessage(e),
            })
          }
          if (!isExpectedAutoLinkError(e)) {
            console.error("[ConnLifecycle] auto-connect:", e)
          }
        })
    }
    return () => {
      cancelled = true
    }
  }, [isActive, workingDir])

  // Manage task status for connection progress
  const taskIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (status === "connecting" || status === "downloading") {
      if (!taskIdRef.current) {
        const id = `acp-connect-${Date.now()}`
        taskIdRef.current = id
        const agent = AGENT_LABELS[agentType]
        addTask(
          id,
          t("tasks.connectingTitle", { agent }),
          t("tasks.connectingDescription")
        )
      }
      updateTask(taskIdRef.current, { status: "running" })
    } else if (status === "connected" || status === "prompting") {
      if (taskIdRef.current) {
        updateTask(taskIdRef.current, { status: "completed" })
        taskIdRef.current = null
      }
    } else if (status === "error") {
      if (taskIdRef.current) {
        updateTask(taskIdRef.current, {
          status: "failed",
          error: t("errors.connectionFailed"),
        })
        taskIdRef.current = null
      }
    } else if (status === "disconnected" || status === null) {
      if (taskIdRef.current) {
        removeTask(taskIdRef.current)
        taskIdRef.current = null
      }
    }
  }, [status, addTask, updateTask, removeTask, agentType, t])

  const clearSelectorTask = useCallback(() => {
    if (selectorTaskTimeoutRef.current) {
      clearTimeout(selectorTaskTimeoutRef.current)
      selectorTaskTimeoutRef.current = null
    }
    if (selectorTaskIdRef.current) {
      removeTask(selectorTaskIdRef.current)
      selectorTaskIdRef.current = null
    }
  }, [removeTask])

  useEffect(() => {
    const isInteractive = status === "connected" || status === "prompting"
    if (!isInteractive) {
      selectorTaskSuppressedRef.current = false
      clearSelectorTask()
      return
    }

    if (selectorTaskSuppressedRef.current) {
      clearSelectorTask()
      return
    }

    const hasSelectorLoading = !effectiveSelectorsReady
    if (!hasSelectorLoading) {
      clearSelectorTask()
      return
    }

    if (!selectorTaskIdRef.current) {
      const id = `acp-selectors-${Date.now()}`
      selectorTaskIdRef.current = id
      const agent = AGENT_LABELS[agentType]
      addTask(
        id,
        t("tasks.loadingSelectorsTitle", { agent }),
        t("tasks.loadingSelectorsDescription")
      )
      updateTask(id, { status: "running" })
    }

    if (!selectorTaskTimeoutRef.current) {
      selectorTaskTimeoutRef.current = setTimeout(() => {
        selectorTaskTimeoutRef.current = null
        selectorTaskSuppressedRef.current = true
        clearSelectorTask()
      }, 5000)
    }
  }, [
    status,
    effectiveSelectorsReady,
    modes,
    configOptions,
    agentType,
    addTask,
    updateTask,
    clearSelectorTask,
    t,
  ])

  // Clean up lingering task on unmount (e.g. tab closed while connecting)
  useEffect(() => {
    return () => {
      if (taskIdRef.current) {
        removeTask(taskIdRef.current)
      }
      selectorTaskSuppressedRef.current = false
      clearSelectorTask()
    }
  }, [removeTask, clearSelectorTask])

  const handleFocus = useCallback(() => {
    touchActivity(contextKey)
    if (!status || status === "disconnected" || status === "error") {
      setLastAutoConnectError(null)
      connConnect(agentType, workingDir, sessionId, {
        source: "auto_link",
      }).catch((e: unknown) => {
        if (!isExpectedAutoLinkError(e)) {
          console.error("[ConnLifecycle] connect:", e)
        }
      })
    }
  }, [
    agentType,
    workingDir,
    sessionId,
    status,
    connConnect,
    contextKey,
    touchActivity,
  ])

  const autoConnectError =
    status === "connected" || status === "prompting"
      ? null
      : lastAutoConnectError?.contextKey === contextKey &&
          lastAutoConnectError.agentType === agentType
        ? lastAutoConnectError.message
        : null

  // sendPrompt, connCancel, connRespondPermission are stable (depend
  // only on actions + contextKey), so these callbacks are effectively stable.
  const handleSend = useCallback(
    (draft: PromptDraft, modeId?: string | null) => {
      touchActivity(contextKey)
      void (async () => {
        const currentModeId = modeIdRef.current
        if (modeId && modeId !== currentModeId) {
          await connSetMode(modeId)
          // Optimistically track selected mode to avoid duplicate set_mode
          // calls before CurrentModeUpdate arrives from the agent.
          modeIdRef.current = modeId
        }
        await sendPrompt(draft.blocks)
      })().catch((e: unknown) =>
        console.error("[ConnLifecycle] sendPrompt:", e)
      )
    },
    [connSetMode, sendPrompt, contextKey, touchActivity]
  )

  const handleCancel = useCallback(() => {
    connCancel().catch((e: unknown) =>
      console.error("[ConnLifecycle] cancel:", e)
    )
  }, [connCancel])

  const handleSetConfigOption = useCallback(
    (configId: string, valueId: string) => {
      touchActivity(contextKey)
      connSetConfigOption(configId, valueId).catch((e: unknown) =>
        console.error("[ConnLifecycle] setConfigOption:", e)
      )
    },
    [connSetConfigOption, contextKey, touchActivity]
  )

  const handleRespondPermission = useCallback(
    (requestId: string, optionId: string) => {
      touchActivity(contextKey)
      connRespondPermission(requestId, optionId).catch((e: unknown) =>
        console.error("[ConnLifecycle] respondPermission:", e)
      )
    },
    [connRespondPermission, contextKey, touchActivity]
  )

  return {
    conn,
    modeLoading,
    configOptionsLoading,
    autoConnectError,
    handleFocus,
    handleSend,
    handleSetConfigOption,
    handleCancel,
    handleRespondPermission,
  }
}
