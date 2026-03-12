"use client"

import { createContext, useContext, useState, useCallback } from "react"
import type { SessionStats } from "@/lib/types"

interface SessionStatsContextValue {
  sessionStats: SessionStats | null
  setSessionStats: (stats: SessionStats | null) => void
}

const SessionStatsContext = createContext<SessionStatsContextValue>({
  sessionStats: null,
  setSessionStats: () => {},
})

export function SessionStatsProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [sessionStats, setSessionStatsRaw] = useState<SessionStats | null>(null)
  const setSessionStats = useCallback(
    (stats: SessionStats | null) => setSessionStatsRaw(stats),
    []
  )
  return (
    <SessionStatsContext.Provider value={{ sessionStats, setSessionStats }}>
      {children}
    </SessionStatsContext.Provider>
  )
}

export function useSessionStats() {
  return useContext(SessionStatsContext)
}
