"use client"

import { useCallback, useEffect, useMemo, useRef } from "react"
import dynamic from "next/dynamic"
import type { editor as MonacoEditorNs } from "monaco-editor"
import { useTranslations } from "next-intl"
import { useFolderContext } from "@/contexts/folder-context"
import { defineMonacoThemes, useMonacoThemeSync } from "@/lib/monaco-themes"
import { cn } from "@/lib/utils"

type RowMarker = "none" | "added" | "deleted" | "modified"
type DiffFileMode = "modified" | "added" | "deleted" | "renamed"

interface RawDiffRow {
  kind: "context" | "add" | "del"
  text: string
  oldLine: number | null
  newLine: number | null
}

interface ParsedDiffRow {
  type: "context" | "added" | "deleted" | "modified"
  text: string
  sign: " " | "+" | "-"
  oldLine: number | null
  newLine: number | null
}

interface ParsedDiffHunk {
  key: string
  oldStart: number | null
  oldCount: number | null
  newStart: number | null
  newCount: number | null
  rows: ParsedDiffRow[]
}

interface ParsedDiffFile {
  key: string
  path: string
  oldPath: string | null
  newPath: string | null
  mode: DiffFileMode
  additions: number
  deletions: number
  hunks: ParsedDiffHunk[]
}

interface WorkingHunk {
  key: string
  oldStart: number | null
  oldCount: number | null
  newStart: number | null
  newCount: number | null
  rows: RawDiffRow[]
}

interface WorkingFile {
  key: string
  path: string
  oldPath: string | null
  newPath: string | null
  mode: DiffFileMode
  additions: number
  deletions: number
  hunks: WorkingHunk[]
}

interface HunkPreviewLine {
  text: string
  marker: RowMarker
}

const MonacoEditor = dynamic(async () => import("@monaco-editor/react"), {
  ssr: false,
})

function normalizePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^"|"$/g, "")
  if (!trimmed || trimmed === "/dev/null") return null
  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2).replace(/\\/g, "/")
  }
  return trimmed.replace(/\\/g, "/")
}

function parsePathFromDiffGitLine(line: string): string | null {
  const match = line.match(/^diff --git\s+(.+?)\s+(.+)$/)
  if (!match) return null
  return normalizePath(match[2]) ?? normalizePath(match[1])
}

function parseApplyPatchMarker(line: string): {
  path: string | null
  mode: DiffFileMode
} | null {
  if (line.startsWith("*** Update File: ")) {
    return {
      path: normalizePath(line.slice("*** Update File: ".length)),
      mode: "modified",
    }
  }
  if (line.startsWith("*** Add File: ")) {
    return {
      path: normalizePath(line.slice("*** Add File: ".length)),
      mode: "added",
    }
  }
  if (line.startsWith("*** Delete File: ")) {
    return {
      path: normalizePath(line.slice("*** Delete File: ".length)),
      mode: "deleted",
    }
  }
  return null
}

function parseHunkHeader(line: string): {
  oldStart: number | null
  oldCount: number | null
  newStart: number | null
  newCount: number | null
} | null {
  if (!line.startsWith("@@")) return null

  const match = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/)
  if (!match) {
    return {
      oldStart: null,
      oldCount: null,
      newStart: null,
      newCount: null,
    }
  }

  return {
    oldStart: Number(match[1]),
    oldCount: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newCount: match[4] ? Number(match[4]) : 1,
  }
}

function classifyRows(rows: RawDiffRow[]): ParsedDiffRow[] {
  const parsed: ParsedDiffRow[] = []
  let index = 0

  while (index < rows.length) {
    const current = rows[index]
    if (!current) break

    if (current.kind === "context") {
      parsed.push({
        type: "context",
        text: current.text,
        sign: " ",
        oldLine: current.oldLine,
        newLine: current.newLine,
      })
      index += 1
      continue
    }

    if (current.kind === "add") {
      let addEnd = index
      while (addEnd < rows.length && rows[addEnd]?.kind === "add") {
        const row = rows[addEnd]
        if (!row) break
        parsed.push({
          type: "added",
          text: row.text,
          sign: "+",
          oldLine: row.oldLine,
          newLine: row.newLine,
        })
        addEnd += 1
      }
      index = addEnd
      continue
    }

    let delEnd = index
    while (delEnd < rows.length && rows[delEnd]?.kind === "del") {
      delEnd += 1
    }

    let addEnd = delEnd
    while (addEnd < rows.length && rows[addEnd]?.kind === "add") {
      addEnd += 1
    }

    const delRows = rows.slice(index, delEnd)
    const addRows = rows.slice(delEnd, addEnd)
    const modifiedPairs = Math.min(delRows.length, addRows.length)

    for (const [delta, row] of delRows.entries()) {
      parsed.push({
        type: delta < modifiedPairs ? "modified" : "deleted",
        text: row.text,
        sign: "-",
        oldLine: row.oldLine,
        newLine: row.newLine,
      })
    }

    for (const [delta, row] of addRows.entries()) {
      parsed.push({
        type: delta < modifiedPairs ? "modified" : "added",
        text: row.text,
        sign: "+",
        oldLine: row.oldLine,
        newLine: row.newLine,
      })
    }

    index = addEnd
  }

  return parsed
}

function resolveFileMode(file: WorkingFile): DiffFileMode {
  if (file.mode !== "modified") return file.mode
  if (file.oldPath && !file.newPath) return "deleted"
  if (!file.oldPath && file.newPath) return "added"
  if (file.oldPath && file.newPath && file.oldPath !== file.newPath) {
    return "renamed"
  }
  return "modified"
}

function parseUnifiedDiff(diffText: string): ParsedDiffFile[] {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n")
  const files: WorkingFile[] = []

  let fileIndex = 1
  let hunkIndex = 1
  let currentFile: WorkingFile | null = null
  let currentHunk: WorkingHunk | null = null
  let oldLineCursor: number | null = null
  let newLineCursor: number | null = null
  let inferredOldCursorForNextHunk = 1
  let inferredNewCursorForNextHunk = 1

  const getActiveFile = (): WorkingFile | null =>
    currentFile ?? files[files.length - 1] ?? null
  const getActiveHunk = (): WorkingHunk | null => currentHunk
  const getOldLineCursor = (): number | null => oldLineCursor
  const getNewLineCursor = (): number | null => newLineCursor

  const flushHunk = () => {
    const file = getActiveFile()
    if (!file || !currentHunk) return
    file.hunks.push(currentHunk)
    if (oldLineCursor !== null) {
      inferredOldCursorForNextHunk = Math.max(1, oldLineCursor)
    }
    if (newLineCursor !== null) {
      inferredNewCursorForNextHunk = Math.max(1, newLineCursor)
    }
    currentHunk = null
  }

  const startFile = (
    path: string | null,
    mode: DiffFileMode = "modified"
  ): WorkingFile => {
    flushHunk()
    currentFile = {
      key: `file-${fileIndex}`,
      path: path ?? `Diff #${fileIndex}`,
      oldPath: null,
      newPath: null,
      mode,
      additions: 0,
      deletions: 0,
      hunks: [],
    }
    files.push(currentFile)
    fileIndex += 1
    inferredOldCursorForNextHunk = 1
    inferredNewCursorForNextHunk = 1
    return currentFile
  }

  const ensureFile = () => getActiveFile() ?? startFile(null)

  const startHunk = (line: string) => {
    const file = ensureFile()
    flushHunk()

    const parsed = parseHunkHeader(line)
    const resolvedOldStart = parsed?.oldStart ?? inferredOldCursorForNextHunk
    const resolvedNewStart = parsed?.newStart ?? inferredNewCursorForNextHunk
    oldLineCursor = resolvedOldStart
    newLineCursor = resolvedNewStart

    currentHunk = {
      key: `${file.key}:hunk-${hunkIndex}`,
      oldStart: resolvedOldStart,
      oldCount: parsed?.oldCount ?? null,
      newStart: resolvedNewStart,
      newCount: parsed?.newCount ?? null,
      rows: [],
    }
    hunkIndex += 1
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      startFile(parsePathFromDiffGitLine(line))
      continue
    }

    const applyPatchMarker = parseApplyPatchMarker(line)
    if (applyPatchMarker) {
      startFile(applyPatchMarker.path, applyPatchMarker.mode)
      continue
    }

    if (line.startsWith("*** Move to: ")) {
      const movedPath = normalizePath(line.slice("*** Move to: ".length))
      const file = getActiveFile()
      if (file && movedPath) {
        file.newPath = movedPath
        file.path = movedPath
        file.mode = "renamed"
      }
      continue
    }

    if (line.startsWith("--- ")) {
      const file = ensureFile()
      const oldPath = normalizePath(line.slice(4))
      file.oldPath = oldPath
      if (!file.newPath && oldPath) file.path = oldPath
      continue
    }

    if (line.startsWith("+++ ")) {
      const file = ensureFile()
      const newPath = normalizePath(line.slice(4))
      file.newPath = newPath
      if (newPath) file.path = newPath
      continue
    }

    if (line.startsWith("@@")) {
      startHunk(line)
      continue
    }

    const hunk = getActiveHunk()
    if (!hunk) continue

    if (line.startsWith("+") && !line.startsWith("+++")) {
      hunk.rows.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newLineCursor,
      })
      const cursor = getNewLineCursor()
      if (cursor !== null) newLineCursor = cursor + 1
      const file = getActiveFile()
      if (file) file.additions += 1
      continue
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      hunk.rows.push({
        kind: "del",
        text: line.slice(1),
        oldLine: oldLineCursor,
        newLine: null,
      })
      const cursor = getOldLineCursor()
      if (cursor !== null) oldLineCursor = cursor + 1
      const file = getActiveFile()
      if (file) file.deletions += 1
      continue
    }

    if (line.startsWith(" ")) {
      hunk.rows.push({
        kind: "context",
        text: line.slice(1),
        oldLine: oldLineCursor,
        newLine: newLineCursor,
      })
      const nextOldCursor = getOldLineCursor()
      if (nextOldCursor !== null) oldLineCursor = nextOldCursor + 1
      const nextNewCursor = getNewLineCursor()
      if (nextNewCursor !== null) newLineCursor = nextNewCursor + 1
    }
  }

  flushHunk()

  return files
    .map((file) => ({
      ...file,
      mode: resolveFileMode(file),
      hunks: file.hunks
        .filter((hunk) => hunk.rows.length > 0)
        .map((hunk) => ({
          key: hunk.key,
          oldStart: hunk.oldStart,
          oldCount: hunk.oldCount,
          newStart: hunk.newStart,
          newCount: hunk.newCount,
          rows: classifyRows(hunk.rows),
        })),
    }))
    .filter((file) => file.hunks.length > 0)
}

function modeKey(
  mode: DiffFileMode
): "mode.added" | "mode.deleted" | "mode.renamed" | "mode.modified" {
  if (mode === "added") return "mode.added"
  if (mode === "deleted") return "mode.deleted"
  if (mode === "renamed") return "mode.renamed"
  return "mode.modified"
}

function toDisplayPath(filePath: string, folderPath: string | null): string {
  const normalizedPath = filePath.replace(/\\/g, "/")
  if (!folderPath) return normalizedPath

  const normalizedFolder = folderPath.replace(/\\/g, "/").replace(/\/+$/, "")
  if (!normalizedFolder) return normalizedPath

  const prefix = `${normalizedFolder}/`
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length)
  }

  return normalizedPath
}

function countHunkChanges(hunk: ParsedDiffHunk): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0

  for (const row of hunk.rows) {
    if (row.sign === "+") additions += 1
    if (row.sign === "-") deletions += 1
  }

  return { additions, deletions }
}

function buildHunkPreviewLines(rows: ParsedDiffRow[]): {
  lines: HunkPreviewLine[]
} {
  const lines: HunkPreviewLine[] = rows.map((row) => {
    let marker: RowMarker = "none"
    if (row.type === "added") marker = "added"
    else if (row.type === "deleted") marker = "deleted"
    else if (row.type === "modified") marker = "modified"

    return {
      text: `${row.sign}${row.text}`,
      marker,
    }
  })

  return {
    lines,
  }
}

function HunkMonacoPreview({
  hunk,
  modelId,
  theme,
}: {
  hunk: ParsedDiffHunk
  modelId: string
  theme: string
}) {
  const t = useTranslations("Folder.diffPreview")
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<string[]>([])

  const { lines } = useMemo(() => buildHunkPreviewLines(hunk.rows), [hunk.rows])

  const renderedContent = useMemo(
    () => lines.map((line) => line.text).join("\n"),
    [lines]
  )

  const applyDecorations = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return

    const model = editor.getModel()
    if (!model) return

    const maxLine = model.getLineCount()
    const decorations: MonacoEditorNs.IModelDeltaDecoration[] = []

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1
      if (lineNumber > maxLine) continue

      let cls: string | null = null
      if (line.marker === "added") {
        cls = "codeg-session-diff-line-added"
      } else if (line.marker === "modified") {
        cls = "codeg-session-diff-line-modified"
      } else if (line.marker === "deleted") {
        cls = "codeg-session-diff-line-deleted"
      }

      if (!cls) continue

      decorations.push({
        range: {
          startLineNumber: lineNumber,
          startColumn: 1,
          endLineNumber: lineNumber,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: cls,
        },
      })
    }

    decorationsRef.current = editor.deltaDecorations(
      decorationsRef.current,
      decorations
    )
  }, [lines])

  useEffect(() => {
    applyDecorations()
  }, [applyDecorations])

  useEffect(
    () => () => {
      const editor = editorRef.current
      if (!editor) return
      editor.deltaDecorations(decorationsRef.current, [])
      decorationsRef.current = []
    },
    []
  )

  return (
    <MonacoEditor
      beforeMount={defineMonacoThemes}
      onMount={(editor) => {
        editorRef.current = editor
        applyDecorations()
      }}
      path={`inmemory://session-hunk/${encodeURIComponent(modelId)}`}
      value={renderedContent}
      language="plaintext"
      theme={theme}
      loading={
        <div className="h-28 flex items-center justify-center text-xs text-muted-foreground">
          {t("loadingHunk")}
        </div>
      }
      options={{
        readOnly: true,
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 12,
        lineNumbers: "off",
        lineDecorationsWidth: 10,
        glyphMargin: false,
        wordWrap: "off",
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        contextmenu: false,
        folding: false,
        scrollbar: {
          alwaysConsumeMouseWheel: false,
        },
        padding: { top: 6, bottom: 6 },
      }}
    />
  )
}

export function UnifiedDiffPreview({
  diffText,
  modelId,
  className,
}: {
  diffText: string
  modelId?: string
  className?: string
}) {
  const t = useTranslations("Folder.diffPreview")
  const { folder } = useFolderContext()
  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText])
  const theme = useMonacoThemeSync()

  if (!diffText.trim()) {
    return (
      <div
        className={cn(
          "h-full flex items-center justify-center text-xs text-muted-foreground",
          className
        )}
      >
        {t("noDiffData")}
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className={cn("h-full overflow-auto p-3", className)}>
        <pre className="font-mono text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">
          {diffText}
        </pre>
      </div>
    )
  }

  return (
    <div className={cn("h-full overflow-auto p-3", className)}>
      <div className="space-y-3">
        {files.map((file) => (
          <section
            key={file.key}
            className="overflow-hidden rounded-lg border border-border bg-background"
          >
            <header className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-[11px]">
              <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t(modeKey(file.mode))}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-foreground"
                title={file.path}
              >
                {toDisplayPath(file.path, folder?.path ?? null)}
              </span>
              <span className="ml-auto inline-flex shrink-0 items-center gap-2 font-mono">
                <span className="text-green-700 dark:text-green-400">
                  +{file.additions}
                </span>
                <span className="text-red-700 dark:text-red-400">
                  -{file.deletions}
                </span>
              </span>
            </header>

            <div className="space-y-2 p-2">
              {file.hunks.map((hunk, index) => {
                const hunkStats = countHunkChanges(hunk)

                return (
                  <div
                    key={hunk.key}
                    className="rounded-md border border-border"
                  >
                    <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
                      <span>{t("hunkLabel", { index: index + 1 })}</span>
                      <span className="ml-auto inline-flex items-center gap-2">
                        <span className="text-green-700 dark:text-green-400">
                          +{hunkStats.additions}
                        </span>
                        <span className="text-red-700 dark:text-red-400">
                          -{hunkStats.deletions}
                        </span>
                      </span>
                    </div>
                    <div
                      className="min-h-[7rem]"
                      style={{
                        height: `${Math.max(120, hunk.rows.length * 20 + 18)}px`,
                      }}
                    >
                      <HunkMonacoPreview
                        hunk={hunk}
                        modelId={`${modelId ?? "session"}:${file.key}:${hunk.key}`}
                        theme={theme}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
