"use client"

import { Clock } from "lucide-react"
import { useTranslations } from "next-intl"
import { useTaskContext } from "@/contexts/task-context"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={`animate-spin rounded-full border-[1.5px] border-current border-t-transparent ${className}`}
    />
  )
}

export function StatusBarTasks() {
  const t = useTranslations("Folder.statusBar.tasks")
  const { tasks } = useTaskContext()

  if (tasks.length === 0) return null

  const runningTask = tasks.find(
    (t) => t.status === "running" || t.status === "pending"
  )

  return (
    <div className="flex items-center gap-2">
      {runningTask && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate max-w-40">
            {runningTask.label || runningTask.description}
          </span>
          <Skeleton className="h-1 w-28 rounded bg-primary/80" />
          <Spinner className="h-3 w-3 shrink-0" />
        </div>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <button className="flex items-center gap-1 hover:text-foreground transition-colors">
            {!runningTask && <Clock className="h-3 w-3" />}
            {tasks.length > 1 && <span>{tasks.length}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-72 p-3">
          <div className="text-xs font-medium mb-2">{t("title")}</div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {tasks.map((task) => (
              <div key={task.id} className="space-y-1">
                <div className="flex items-center gap-2 text-xs">
                  {task.status === "running" ? (
                    <Spinner className="h-3 w-3 text-blue-500" />
                  ) : (
                    <Clock className="h-3 w-3 text-muted-foreground" />
                  )}
                  <span className="truncate flex-1">{task.label}</span>
                </div>
                {task.status === "running" && task.progress != null && (
                  <div className="h-1 rounded-full bg-muted ml-5">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{ width: `${task.progress}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
