"use client"

import { Fragment } from "react"
import { ChevronUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DropdownRadioItemContent } from "@/components/chat/dropdown-radio-item-content"
import type { SessionConfigOptionInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

interface SessionConfigSelectorProps {
  option: SessionConfigOptionInfo
  onSelect: (configId: string, valueId: string) => void
}

export function SessionConfigSelector({
  option,
  onSelect,
}: SessionConfigSelectorProps) {
  if (option.kind.type !== "select") return null

  const selected = option.kind.options.find(
    (item) => item.value === option.kind.current_value
  )
  const label = selected?.name ?? option.kind.current_value
  const isActive = Boolean(selected)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={cn("gap-1 min-w-0", isActive && "text-primary")}
          title={option.description ?? option.name}
        >
          <span className="truncate">{label}</span>
          <ChevronUp className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-72">
        <DropdownMenuRadioGroup
          value={option.kind.current_value}
          onValueChange={(value) => onSelect(option.id, value)}
        >
          {option.kind.groups.length > 0
            ? option.kind.groups.map((group, index) => (
                <Fragment key={group.group}>
                  {index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel>{group.name}</DropdownMenuLabel>
                  {group.options.map((item) => (
                    <DropdownMenuRadioItem
                      key={`${group.group}-${item.value}`}
                      value={item.value}
                    >
                      <DropdownRadioItemContent
                        label={item.name}
                        description={item.description}
                      />
                    </DropdownMenuRadioItem>
                  ))}
                </Fragment>
              ))
            : option.kind.options.map((item) => (
                <DropdownMenuRadioItem key={item.value} value={item.value}>
                  <DropdownRadioItemContent
                    label={item.name}
                    description={item.description}
                  />
                </DropdownMenuRadioItem>
              ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
