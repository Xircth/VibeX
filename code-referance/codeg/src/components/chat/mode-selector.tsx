"use client"

import { ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DropdownRadioItemContent } from "@/components/chat/dropdown-radio-item-content"
import type { SessionModeInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

interface ModeSelectorProps {
  modes: SessionModeInfo[]
  selectedModeId: string | null
  onSelect: (modeId: string) => void
}

export function ModeSelector({
  modes,
  selectedModeId,
  onSelect,
}: ModeSelectorProps) {
  const selectedMode = modes.find((m) => m.id === selectedModeId)
  const label = selectedMode?.name ?? "Mode"
  const isActive = Boolean(selectedMode)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={cn("gap-1 min-w-0", isActive && "text-primary")}
          title={selectedMode?.description ?? selectedMode?.name}
        >
          <span className="truncate">{label}</span>
          <ChevronUp className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-72">
        <DropdownMenuRadioGroup
          value={selectedModeId ?? ""}
          onValueChange={onSelect}
        >
          {modes.map((mode) => (
            <DropdownMenuRadioItem key={mode.id} value={mode.id}>
              <DropdownRadioItemContent
                label={mode.name}
                description={mode.description}
              />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
