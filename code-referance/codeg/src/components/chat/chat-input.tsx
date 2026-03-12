"use client"

import { useTranslations } from "next-intl"
import type {
  ConnectionStatus,
  PromptCapabilitiesInfo,
  PromptDraft,
  SessionConfigOptionInfo,
  SessionModeInfo,
  AvailableCommandInfo,
} from "@/lib/types"
import type { QueuedMessage } from "@/hooks/use-message-queue"
import { MessageInput } from "@/components/chat/message-input"
import { MessageQueueDisplay } from "@/components/chat/message-queue-display"

interface ChatInputProps {
  status: ConnectionStatus | null
  promptCapabilities: PromptCapabilitiesInfo
  defaultPath?: string
  onFocus?: () => void
  onSend: (draft: PromptDraft, modeId?: string | null) => void
  onCancel: () => void
  modes?: SessionModeInfo[]
  configOptions?: SessionConfigOptionInfo[]
  modeLoading?: boolean
  configOptionsLoading?: boolean
  selectedModeId?: string | null
  onModeChange?: (modeId: string) => void
  onConfigOptionChange?: (configId: string, valueId: string) => void
  availableCommands?: AvailableCommandInfo[] | null
  attachmentTabId?: string | null
  draftStorageKey?: string | null
  isActive?: boolean
  queue?: QueuedMessage[]
  onEnqueue?: (draft: PromptDraft, modeId: string | null) => void
  onQueueReorder?: (items: QueuedMessage[]) => void
  onQueueEdit?: (id: string) => void
  onQueueDelete?: (id: string) => void
  editingItemId?: string | null
  editingDraftText?: string | null
  isEditingQueueItem?: boolean
  onSaveQueueEdit?: (draft: PromptDraft) => void
  onCancelQueueEdit?: () => void
}

export function ChatInput({
  status,
  promptCapabilities,
  defaultPath,
  onFocus,
  onSend,
  onCancel,
  modes,
  configOptions,
  modeLoading = false,
  configOptionsLoading = false,
  selectedModeId,
  onModeChange,
  onConfigOptionChange,
  availableCommands,
  attachmentTabId,
  draftStorageKey,
  isActive,
  queue,
  onEnqueue,
  onQueueReorder,
  onQueueEdit,
  onQueueDelete,
  editingItemId,
  editingDraftText,
  isEditingQueueItem,
  onSaveQueueEdit,
  onCancelQueueEdit,
}: ChatInputProps) {
  const t = useTranslations("Folder.chat.chatInput")
  const isConnected = status === "connected"
  const isPrompting = status === "prompting"
  const isConnecting = status === "connecting" || status === "downloading"

  return (
    <div className="p-4 pt-0">
      {queue &&
        queue.length > 0 &&
        onQueueReorder &&
        onQueueEdit &&
        onQueueDelete && (
          <MessageQueueDisplay
            queue={queue}
            onReorder={onQueueReorder}
            onEdit={onQueueEdit}
            onDelete={onQueueDelete}
            editingItemId={editingItemId ?? null}
          />
        )}
      <MessageInput
        onSend={onSend}
        promptCapabilities={promptCapabilities}
        onFocus={onFocus}
        defaultPath={defaultPath}
        disabled={!isConnected && !isPrompting}
        isPrompting={isPrompting}
        onCancel={onCancel}
        modes={modes}
        configOptions={configOptions}
        modeLoading={modeLoading}
        configOptionsLoading={configOptionsLoading}
        selectedModeId={selectedModeId}
        onModeChange={onModeChange}
        onConfigOptionChange={onConfigOptionChange}
        availableCommands={availableCommands}
        attachmentTabId={attachmentTabId}
        draftStorageKey={draftStorageKey}
        isActive={isActive}
        onEnqueue={onEnqueue}
        editingDraftText={editingDraftText}
        isEditingQueueItem={isEditingQueueItem}
        onSaveQueueEdit={onSaveQueueEdit}
        onCancelQueueEdit={onCancelQueueEdit}
        placeholder={
          isConnecting
            ? t("connecting")
            : isPrompting
              ? t("agentResponding")
              : t("sendMessage")
        }
        className="min-h-28 max-h-60"
      />
    </div>
  )
}
