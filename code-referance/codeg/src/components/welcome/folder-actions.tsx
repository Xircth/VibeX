"use client"

import { useState } from "react"
import { FolderOpen, GitBranch } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { open } from "@tauri-apps/plugin-dialog"
import { openFolderWindow } from "@/lib/tauri"
import { Button } from "@/components/ui/button"
import { CloneDialog } from "./clone-dialog"
import { resolveWelcomeError } from "@/components/welcome/error-utils"

export function FolderActions() {
  const t = useTranslations("WelcomePage")
  const [cloneOpen, setCloneOpen] = useState(false)

  const handleOpen = async () => {
    const selected = await open({ directory: true, multiple: false })
    if (!selected) return

    try {
      await openFolderWindow(selected)
    } catch (err) {
      console.error("[FolderActions] failed to open folder:", err)
      const resolvedError = resolveWelcomeError(err)
      toast.error(t("toasts.openFolderFailed"), {
        description: resolvedError.detail ?? t(resolvedError.key),
      })
    }
  }

  return (
    <div className="w-full flex flex-col gap-1 px-3">
      <Button
        variant="ghost"
        className="justify-start gap-2 h-9"
        onClick={handleOpen}
        type="button"
      >
        <FolderOpen className="h-4 w-4" />
        {t("openFolder")}
      </Button>
      <Button
        variant="ghost"
        className="justify-start gap-2 h-9"
        onClick={() => setCloneOpen(true)}
        type="button"
      >
        <GitBranch className="h-4 w-4" />
        {t("cloneRepository")}
      </Button>

      <CloneDialog open={cloneOpen} onOpenChange={setCloneOpen} />
    </div>
  )
}
