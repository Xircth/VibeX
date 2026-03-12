"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  useAcpActions,
  useConnectionStore,
  type ConnectionState,
  type ConnectOptions,
  type LiveMessage,
  type PendingPermission,
  type PendingQuestion,
} from "@/contexts/acp-connections-context"
import type {
  AgentType,
  AvailableCommandInfo,
  ConnectionStatus,
  PromptCapabilitiesInfo,
  SessionConfigOptionInfo,
  SessionModeStateInfo,
  PromptInputBlock,
} from "@/lib/types"

const DEFAULT_PROMPT_CAPABILITIES: PromptCapabilitiesInfo = {
  image: false,
  audio: false,
  embedded_context: false,
}

export interface UseConnectionReturn {
  connectionId: string | null
  status: ConnectionStatus | null
  promptCapabilities: PromptCapabilitiesInfo
  selectorsReady: boolean
  sessionId: string | null
  modes: SessionModeStateInfo | null
  configOptions: SessionConfigOptionInfo[] | null
  availableCommands: AvailableCommandInfo[] | null
  liveMessage: LiveMessage | null
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  error: string | null
  connect: (
    agentType: AgentType,
    workingDir?: string,
    sessionId?: string,
    options?: ConnectOptions
  ) => Promise<void>
  disconnect: () => Promise<void>
  sendPrompt: (blocks: PromptInputBlock[]) => Promise<void>
  setMode: (modeId: string) => Promise<void>
  setConfigOption: (configId: string, valueId: string) => Promise<void>
  cancel: () => Promise<void>
  respondPermission: (requestId: string, optionId: string) => Promise<void>
}

function derive(conn: ConnectionState | undefined) {
  if (!conn) return null
  return conn
}

export function useConnection(contextKey: string): UseConnectionReturn {
  const store = useConnectionStore()
  const actions = useAcpActions()

  const subscribe = useCallback(
    (cb: () => void) => store.subscribeKey(contextKey, cb),
    [store, contextKey]
  )
  const getSnapshot = useCallback(
    () => derive(store.getConnection(contextKey)),
    [store, contextKey]
  )
  const connection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const connectionId = connection?.connectionId ?? null
  const status = connection?.status ?? null
  const promptCapabilities =
    connection?.promptCapabilities ?? DEFAULT_PROMPT_CAPABILITIES
  const selectorsReady = connection?.selectorsReady ?? false
  const sessionId = connection?.sessionId ?? null
  const modes = connection?.modes ?? null
  const configOptions = connection?.configOptions ?? null
  const availableCommands = connection?.availableCommands ?? null
  const liveMessage = connection?.liveMessage ?? null
  const pendingPermission = connection?.pendingPermission ?? null
  const pendingQuestion = connection?.pendingQuestion ?? null
  const error = connection?.error ?? null

  const connect = useCallback(
    (
      agentType: AgentType,
      workingDir?: string,
      sessionId?: string,
      options?: ConnectOptions
    ) => actions.connect(contextKey, agentType, workingDir, sessionId, options),
    [actions, contextKey]
  )

  const disconnect = useCallback(
    () => actions.disconnect(contextKey),
    [actions, contextKey]
  )

  const sendPrompt = useCallback(
    (blocks: PromptInputBlock[]) => actions.sendPrompt(contextKey, blocks),
    [actions, contextKey]
  )

  const setMode = useCallback(
    (modeId: string) => actions.setMode(contextKey, modeId),
    [actions, contextKey]
  )

  const setConfigOption = useCallback(
    (configId: string, valueId: string) =>
      actions.setConfigOption(contextKey, configId, valueId),
    [actions, contextKey]
  )

  const cancel = useCallback(
    () => actions.cancel(contextKey),
    [actions, contextKey]
  )

  const respondPermission = useCallback(
    (requestId: string, optionId: string) =>
      actions.respondPermission(contextKey, requestId, optionId),
    [actions, contextKey]
  )

  return useMemo(
    () => ({
      connectionId,
      status,
      promptCapabilities,
      selectorsReady,
      sessionId,
      modes,
      configOptions,
      availableCommands,
      liveMessage,
      pendingPermission,
      pendingQuestion,
      error,
      connect,
      disconnect,
      sendPrompt,
      setMode,
      setConfigOption,
      cancel,
      respondPermission,
    }),
    [
      connectionId,
      status,
      promptCapabilities,
      selectorsReady,
      sessionId,
      modes,
      configOptions,
      availableCommands,
      liveMessage,
      pendingPermission,
      pendingQuestion,
      error,
      connect,
      disconnect,
      sendPrompt,
      setMode,
      setConfigOption,
      cancel,
      respondPermission,
    ]
  )
}
