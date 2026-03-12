"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { PromptDraft } from "@/lib/types"

export interface QueuedMessage {
  id: string
  draft: PromptDraft
  modeId: string | null
}

export interface UseMessageQueueReturn {
  queue: QueuedMessage[]
  enqueue: (draft: PromptDraft, modeId: string | null) => void
  dequeue: () => QueuedMessage | undefined
  remove: (id: string) => void
  reorder: (items: QueuedMessage[]) => void
  updateItem: (id: string, draft: PromptDraft) => void
  editingItemId: string | null
  startEditing: (id: string) => void
  cancelEditing: () => void
}

export function useMessageQueue(): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const queueRef = useRef(queue)
  useEffect(() => {
    queueRef.current = queue
  }, [queue])

  const enqueue = useCallback((draft: PromptDraft, modeId: string | null) => {
    const item: QueuedMessage = {
      id: crypto.randomUUID(),
      draft,
      modeId,
    }
    setQueue((prev) => [...prev, item])
  }, [])

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = queueRef.current
    if (current.length === 0) return undefined
    const first = current[0]
    setQueue((prev) => prev.slice(1))
    return first
  }, [])

  const remove = useCallback(
    (id: string) => {
      if (editingItemId === id) {
        setEditingItemId(null)
      }
      setQueue((prev) => prev.filter((item) => item.id !== id))
    },
    [editingItemId]
  )

  const reorder = useCallback((items: QueuedMessage[]) => {
    setQueue(items)
  }, [])

  const updateItem = useCallback((id: string, draft: PromptDraft) => {
    setQueue((prev) =>
      prev.map((item) => (item.id === id ? { ...item, draft } : item))
    )
    setEditingItemId(null)
  }, [])

  const startEditing = useCallback((id: string) => {
    setEditingItemId(id)
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingItemId(null)
  }, [])

  return {
    queue,
    enqueue,
    dequeue,
    remove,
    reorder,
    updateItem,
    editingItemId,
    startEditing,
    cancelEditing,
  }
}
