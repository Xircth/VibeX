"use client"

import { useCallback, useMemo, useState } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import type { LinkSafetyConfig, LinkSafetyModalProps } from "streamdown"
import { toast } from "sonner"
import { useFolderContext } from "@/contexts/folder-context"
import { useWorkspaceContext } from "@/contexts/workspace-context"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface LocalFileTarget {
  path: string
  line: number | null
}

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/
const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/

function normalizeSlashPath(path: string): string {
  return path.replace(/\\/g, "/")
}

function decodeUriSafely(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseLineValue(raw: string | undefined): number | null {
  if (!raw) return null
  const line = Number.parseInt(raw, 10)
  if (!Number.isFinite(line) || line <= 0) return null
  return line
}

function parseHashLine(hash: string): number | null {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash
  if (!normalized) return null
  return (
    parseLineValue(normalized.match(/^L(\d+)$/i)?.[1]) ??
    parseLineValue(normalized.match(/^line=(\d+)$/i)?.[1]) ??
    parseLineValue(normalized.match(/^(\d+)$/)?.[1])
  )
}

function splitPathAndLine(rawPath: string): LocalFileTarget {
  const trimmed = rawPath.trim()
  const match = trimmed.match(/^(.*):(\d+)(?::\d+)?$/)
  if (!match) {
    return { path: trimmed, line: null }
  }

  const maybePath = match[1]
  if (!maybePath || maybePath.endsWith("://")) {
    return { path: trimmed, line: null }
  }

  const line = parseLineValue(match[2])
  if (!line) {
    return { path: trimmed, line: null }
  }

  return { path: maybePath, line }
}

function isLocalPathLike(path: string): boolean {
  return (
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith("~/") ||
    WINDOWS_ABSOLUTE_PATH.test(path)
  )
}

function parseLocalFileTarget(rawUrl: string): LocalFileTarget | null {
  const raw = decodeUriSafely(rawUrl.trim())
  if (!raw) return null

  if (raw.toLowerCase().startsWith("file://")) {
    try {
      const parsed = new URL(raw)
      const rawPathname = decodeUriSafely(parsed.pathname)
      const normalizedPathname =
        rawPathname.startsWith("/") && WINDOWS_ABSOLUTE_PATH.test(rawPathname)
          ? rawPathname.slice(1)
          : rawPathname
      const pathAndLine = splitPathAndLine(normalizedPathname)
      if (!pathAndLine.path) return null
      return {
        path: normalizeSlashPath(pathAndLine.path),
        line: parseHashLine(parsed.hash) ?? pathAndLine.line,
      }
    } catch {
      return null
    }
  }

  if (URL_SCHEME.test(raw) && !WINDOWS_ABSOLUTE_PATH.test(raw)) {
    return null
  }

  const hashIndex = raw.indexOf("#")
  const hash = hashIndex >= 0 ? raw.slice(hashIndex) : ""
  const withoutHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw
  const queryIndex = withoutHash.indexOf("?")
  const withoutQuery =
    queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash
  const pathAndLine = splitPathAndLine(withoutQuery)
  if (!isLocalPathLike(pathAndLine.path)) return null

  return {
    path: normalizeSlashPath(pathAndLine.path),
    line: parseHashLine(hash) ?? pathAndLine.line,
  }
}

function toWorkspaceRelativePath(
  path: string,
  workspacePath: string
): string | null {
  const normalizedPath = normalizeSlashPath(path)
  const normalizedWorkspace = normalizeSlashPath(workspacePath).replace(
    /\/+$/,
    ""
  )
  if (!normalizedPath || !normalizedWorkspace) return null

  if (!normalizedPath.startsWith("/") && !WINDOWS_ABSOLUTE_PATH.test(path)) {
    return normalizedPath.replace(/^\.\/+/, "")
  }

  const isWindows = WINDOWS_ABSOLUTE_PATH.test(normalizedWorkspace)
  const pathForCompare = isWindows
    ? normalizedPath.toLowerCase()
    : normalizedPath
  const workspaceForCompare = isWindows
    ? normalizedWorkspace.toLowerCase()
    : normalizedWorkspace

  if (pathForCompare === workspaceForCompare) return null
  if (!pathForCompare.startsWith(`${workspaceForCompare}/`)) return null

  return normalizedPath.slice(normalizedWorkspace.length + 1)
}

function LinkSafetyModal({
  url,
  isOpen,
  onClose,
  onAction,
}: LinkSafetyModalProps & {
  onAction: (url: string) => Promise<void>
}) {
  const [opening, setOpening] = useState(false)
  const localTarget = useMemo(() => parseLocalFileTarget(url), [url])
  const isLocalFile = Boolean(localTarget)

  const handleAction = useCallback(() => {
    if (opening) return
    setOpening(true)
    void onAction(url).finally(() => {
      setOpening(false)
    })
  }, [onAction, opening, url])

  return (
    <AlertDialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isLocalFile ? "Open local file?" : "Open external link?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isLocalFile
              ? "You're about to open a local file in the Files panel."
              : "You're about to visit an external website."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-28 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs break-all">
          {url}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={opening}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={opening} onClick={handleAction}>
            {opening ? "Opening..." : isLocalFile ? "Open file" : "Open link"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function useStreamdownLinkSafety(): LinkSafetyConfig {
  const { folder } = useFolderContext()
  const folderPath = folder?.path
  const { openFilePreview } = useWorkspaceContext()

  const handleOpenTarget = useCallback(
    async (url: string) => {
      const localTarget = parseLocalFileTarget(url)
      if (localTarget) {
        if (!folderPath) {
          toast.error("Cannot open local file", {
            description: "No workspace folder is currently active.",
          })
          return
        }

        const relativePath = toWorkspaceRelativePath(
          localTarget.path,
          folderPath
        )
        if (!relativePath) {
          toast.error("Cannot open local file", {
            description: "The file is outside the current workspace folder.",
          })
          return
        }

        try {
          await openFilePreview(relativePath, {
            line: localTarget.line ?? undefined,
          })
        } catch (error) {
          toast.error("Failed to open local file", {
            description: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      try {
        await openUrl(url)
      } catch (error) {
        toast.error("Failed to open link", {
          description: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [folderPath, openFilePreview]
  )

  const renderModal = useCallback(
    (props: LinkSafetyModalProps) => (
      <LinkSafetyModal {...props} onAction={handleOpenTarget} />
    ),
    [handleOpenTarget]
  )

  return useMemo(
    () => ({
      enabled: true,
      renderModal,
    }),
    [renderModal]
  )
}
