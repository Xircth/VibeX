"use client"

import { useRef, useState } from "react"
import { Minus, Plus, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useIsMac } from "@/hooks/use-is-mac"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

export function TerminalTabBar() {
  const t = useTranslations("Folder.terminal")
  const { shortcuts } = useShortcutSettings()
  const isMac = useIsMac()
  const {
    tabs,
    activeTabId,
    switchTerminal,
    closeTerminal,
    closeOtherTerminals,
    closeAllTerminals,
    renameTerminal,
    createTerminal,
    toggle,
  } = useTerminalContext()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const startRename = (id: string, title: string) => {
    setEditingId(id)
    setEditValue(title)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      renameTerminal(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="flex items-center h-8 bg-muted/50 border-b gap-0.5 px-1 shrink-0">
      {tabs.map((tab) => (
        <ContextMenu key={tab.id}>
          <ContextMenuTrigger asChild>
            <div
              className={`flex items-center gap-1 h-6 px-2 rounded-sm text-xs cursor-pointer select-none ${
                tab.id === activeTabId
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
              onClick={() => switchTerminal(tab.id)}
            >
              {editingId === tab.id ? (
                <input
                  ref={inputRef}
                  className="bg-transparent outline-none border border-primary/50 rounded px-0.5 w-20 text-xs"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename()
                    if (e.key === "Escape") setEditingId(null)
                  }}
                />
              ) : (
                <span className="truncate max-w-[120px]">{tab.title}</span>
              )}
              <button
                className="ml-1 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(tab.id)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => startRename(tab.id, tab.title)}>
              {t("rename")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => closeTerminal(tab.id)}>
              {t("close")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => closeOtherTerminals(tab.id)}
              disabled={tabs.length <= 1}
            >
              {t("closeOthers")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => closeAllTerminals()}>
              {t("closeAll")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        onClick={() => createTerminal()}
      >
        <Plus className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 ml-auto"
        onClick={toggle}
        title={t("hideTerminal", {
          shortcut: formatShortcutLabel(shortcuts.toggle_terminal, isMac),
        })}
      >
        <Minus className="h-3 w-3" />
      </Button>
    </div>
  )
}
