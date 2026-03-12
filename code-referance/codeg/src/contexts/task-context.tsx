"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react"

export type TaskStatus = "pending" | "running" | "completed" | "failed"

export interface Task {
  id: string
  label: string
  description?: string
  status: TaskStatus
  progress?: number
  error?: string
}

interface TaskContextValue {
  tasks: Task[]
  hasRunningTasks: boolean
  addTask: (id: string, label: string, description?: string) => void
  updateTask: (
    id: string,
    update: Partial<Pick<Task, "status" | "progress" | "error">>
  ) => void
  removeTask: (id: string) => void
  clearCompleted: () => void
}

type Action =
  | { type: "add"; id: string; label: string; description?: string }
  | {
      type: "update"
      id: string
      update: Partial<Pick<Task, "status" | "progress" | "error">>
    }
  | { type: "remove"; id: string }
  | { type: "clear_completed" }

function reducer(state: Task[], action: Action): Task[] {
  switch (action.type) {
    case "add":
      return [
        ...state,
        {
          id: action.id,
          label: action.label,
          description: action.description,
          status: "pending",
        },
      ]
    case "update":
      return state.map((t) =>
        t.id === action.id ? { ...t, ...action.update } : t
      )
    case "remove":
      return state.filter((t) => t.id !== action.id)
    case "clear_completed":
      return state.filter(
        (t) => t.status !== "completed" && t.status !== "failed"
      )
  }
}

const TaskContext = createContext<TaskContextValue | null>(null)

export function useTaskContext() {
  const ctx = useContext(TaskContext)
  if (!ctx) {
    throw new Error("useTaskContext must be used within TaskProvider")
  }
  return ctx
}

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, dispatch] = useReducer(reducer, [])

  const addTask = useCallback(
    (id: string, label: string, description?: string) => {
      dispatch({ type: "add", id, label, description })
    },
    []
  )

  const removeTask = useCallback((id: string) => {
    dispatch({ type: "remove", id })
  }, [])

  const updateTask = useCallback(
    (
      id: string,
      update: Partial<Pick<Task, "status" | "progress" | "error">>
    ) => {
      if (update.status === "completed" || update.status === "failed") {
        dispatch({ type: "remove", id })
      } else {
        dispatch({ type: "update", id, update })
      }
    },
    []
  )

  const clearCompleted = useCallback(() => {
    dispatch({ type: "clear_completed" })
  }, [])

  const hasRunningTasks = tasks.some((t) => t.status === "running")

  const value = useMemo(
    () => ({
      tasks,
      hasRunningTasks,
      addTask,
      updateTask,
      removeTask,
      clearCompleted,
    }),
    [tasks, hasRunningTasks, addTask, updateTask, removeTask, clearCompleted]
  )

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>
}
