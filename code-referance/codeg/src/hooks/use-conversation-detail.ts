"use client"

import { useEffect } from "react"
import { useConversationRuntime } from "@/contexts/conversation-runtime-context"
import type { DbConversationDetail } from "@/lib/types"

function isVirtualConversationId(conversationId: number): boolean {
  return !Number.isFinite(conversationId) || conversationId <= 0
}

export function useConversationDetail(conversationId: number): {
  detail: DbConversationDetail | null
  loading: boolean
  error: string | null
} {
  const { getSession, fetchDetail } = useConversationRuntime()
  const session = getSession(conversationId)
  const isVirtual = isVirtualConversationId(conversationId)

  useEffect(() => {
    if (isVirtual) return
    if (session?.detail || session?.detailLoading) return
    fetchDetail(conversationId)
  }, [
    conversationId,
    isVirtual,
    session?.detail,
    session?.detailLoading,
    fetchDetail,
  ])

  return {
    detail: session?.detail ?? null,
    loading: session ? session.detailLoading : !isVirtual,
    error: session?.detailError ?? null,
  }
}
