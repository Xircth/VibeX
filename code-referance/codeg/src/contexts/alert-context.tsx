"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react"
import type { FixActionKind } from "@/lib/types"

export type AlertLevel = "error" | "warning"

export interface AlertAction {
  label: string
  kind: FixActionKind
  payload: string
}

export interface Alert {
  id: string
  level: AlertLevel
  message: string
  detail?: string
  actions?: AlertAction[]
  timestamp: number
}

interface AlertContextValue {
  alerts: Alert[]
  hasAlerts: boolean
  pushAlert: (
    level: AlertLevel,
    message: string,
    detail?: string,
    actions?: AlertAction[]
  ) => string
  dismissAlert: (id: string) => void
  clearAll: () => void
}

type Action =
  | { type: "push"; alert: Alert }
  | { type: "dismiss"; id: string }
  | { type: "clear_all" }

let seq = 0
const MAX_ALERTS = 50

function reducer(state: Alert[], action: Action): Alert[] {
  switch (action.type) {
    case "push": {
      const next = [...state, action.alert]
      return next.length > MAX_ALERTS ? next.slice(-MAX_ALERTS) : next
    }
    case "dismiss":
      return state.filter((a) => a.id !== action.id)
    case "clear_all":
      return []
  }
}

const AlertContext = createContext<AlertContextValue | null>(null)

export function useAlertContext() {
  const ctx = useContext(AlertContext)
  if (!ctx) {
    throw new Error("useAlertContext must be used within AlertProvider")
  }
  return ctx
}

export function AlertProvider({ children }: { children: ReactNode }) {
  const [alerts, dispatch] = useReducer(reducer, [])

  const pushAlert = useCallback(
    (
      level: AlertLevel,
      message: string,
      detail?: string,
      actions?: AlertAction[]
    ) => {
      const id = `alert-${++seq}-${Date.now()}`
      dispatch({
        type: "push",
        alert: { id, level, message, detail, actions, timestamp: Date.now() },
      })
      return id
    },
    []
  )

  const dismissAlert = useCallback((id: string) => {
    dispatch({ type: "dismiss", id })
  }, [])

  const clearAll = useCallback(() => {
    dispatch({ type: "clear_all" })
  }, [])

  const hasAlerts = alerts.length > 0

  const value = useMemo(
    () => ({ alerts, hasAlerts, pushAlert, dismissAlert, clearAll }),
    [alerts, hasAlerts, pushAlert, dismissAlert, clearAll]
  )

  return <AlertContext.Provider value={value}>{children}</AlertContext.Provider>
}
