"use client"

import { useState, useEffect } from "react"
import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Plus, Trash2 } from "lucide-react"
import type { FolderCommand } from "@/lib/types"
import {
  createFolderCommand,
  updateFolderCommand,
  deleteFolderCommand,
} from "@/lib/tauri"

interface CommandDraft {
  id: number | null
  name: string
  command: string
  deleted: boolean
}

interface CommandManageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folderId: number
  commands: FolderCommand[]
  onSaved: () => void
}

export function CommandManageDialog({
  open,
  onOpenChange,
  folderId,
  commands,
  onSaved,
}: CommandManageDialogProps) {
  const t = useTranslations("Folder.commandDropdown.manageDialog")
  const tCommon = useTranslations("Folder.common")
  const [drafts, setDrafts] = useState<CommandDraft[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setDrafts(
        commands.map((c) => ({
          id: c.id,
          name: c.name,
          command: c.command,
          deleted: false,
        }))
      )
    }
  }, [open, commands])

  const addDraft = () => {
    setDrafts((prev) => [
      ...prev,
      { id: null, name: "", command: "", deleted: false },
    ])
  }

  const updateDraft = (
    index: number,
    field: "name" | "command",
    value: string
  ) => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === index ? { ...d, [field]: value } : d))
    )
  }

  const removeDraft = (index: number) => {
    setDrafts((prev) =>
      prev.map((d, i) => (i === index ? { ...d, deleted: true } : d))
    )
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      for (const draft of drafts) {
        if (draft.deleted && draft.id != null) {
          await deleteFolderCommand(draft.id)
        } else if (draft.deleted) {
          continue
        } else if (draft.id == null && draft.name && draft.command) {
          await createFolderCommand(folderId, draft.name, draft.command)
        } else if (draft.id != null) {
          const orig = commands.find((c) => c.id === draft.id)
          if (
            orig &&
            (orig.name !== draft.name || orig.command !== draft.command)
          ) {
            await updateFolderCommand(draft.id, draft.name, draft.command)
          }
        }
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      console.error("Failed to save commands:", err)
    } finally {
      setSaving(false)
    }
  }

  const visibleDrafts = drafts.filter((d) => !d.deleted)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-72">
          <div className="space-y-2 pr-2">
            {visibleDrafts.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                {t("empty")}
              </p>
            )}
            {drafts.map(
              (draft, index) =>
                !draft.deleted && (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      placeholder={t("namePlaceholder")}
                      value={draft.name}
                      onChange={(e) =>
                        updateDraft(index, "name", e.target.value)
                      }
                      className="h-8 text-sm flex-1"
                    />
                    <Input
                      placeholder={t("commandPlaceholder")}
                      value={draft.command}
                      onChange={(e) =>
                        updateDraft(index, "command", e.target.value)
                      }
                      className="h-8 text-sm font-mono flex-[2]"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => removeDraft(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                )
            )}
          </div>
        </ScrollArea>
        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button variant="outline" size="sm" onClick={addDraft}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t("add")}
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? t("saving") : tCommon("save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
