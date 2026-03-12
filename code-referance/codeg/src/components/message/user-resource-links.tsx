"use client"

import { FileSearch } from "lucide-react"
import type { UserResourceDisplay } from "@/lib/adapters/ai-elements-adapter"

interface UserResourceLinksProps {
  resources: UserResourceDisplay[]
  className?: string
}

export function UserResourceLinks({
  resources,
  className,
}: UserResourceLinksProps) {
  if (resources.length === 0) return null

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1.5">
        {resources.map((resource, index) => (
          <div
            key={`${resource.uri}-${index}`}
            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
          >
            <FileSearch className="h-3 w-3" />
            <span className="max-w-56 truncate">{resource.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
