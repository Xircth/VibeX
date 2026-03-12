"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { useFolderContext } from "@/contexts/folder-context"
import {
  gitDiff,
  gitDiffWithBranch,
  gitIsTracked,
  gitShowDiff,
  gitShowFile,
  readFileForEdit,
  readFilePreview,
  saveFileContent,
} from "@/lib/tauri"
import { languageFromPath } from "@/lib/language-detect"
import {
  loadPersistedWorkspaceMode,
  savePersistedWorkspaceMode,
} from "@/lib/workspace-mode-storage"

export type WorkspaceMode = "conversation" | "fusion" | "files"
export type WorkspacePane = "conversation" | "files"

const DEFAULT_WORKSPACE_MODE: WorkspaceMode = "conversation"

type FileWorkspaceTabKind = "file" | "diff" | "rich-diff"
type FileSaveState = "idle" | "saving" | "error"
type LineEnding = "lf" | "crlf" | "mixed" | "none"

export interface FileWorkspaceTab {
  id: string
  kind: FileWorkspaceTabKind
  title: string
  description: string | null
  path: string | null
  language: string
  content: string
  loading: boolean
  originalContent?: string
  modifiedContent?: string
  gitBaseContent?: string
  savedContent?: string
  isDirty?: boolean
  etag?: string | null
  mtimeMs?: number | null
  readonly?: boolean
  truncated?: boolean
  lineEnding?: LineEnding
  saveState?: FileSaveState
  saveError?: string | null
}

interface WorkspaceContextValue {
  mode: WorkspaceMode
  activePane: WorkspacePane
  setMode: (mode: WorkspaceMode) => void
  setActivePane: (pane: WorkspacePane) => void
  activateConversationPane: () => void
  activateFilePane: () => void
  fileTabs: FileWorkspaceTab[]
  activeFileTabId: string | null
  activeFileTab: FileWorkspaceTab | null
  activeFilePath: string | null
  switchFileTab: (tabId: string) => void
  closeFileTab: (tabId: string) => void
  closeOtherFileTabs: (tabId: string) => void
  closeAllFileTabs: () => void
  reorderFileTabs: (tabs: FileWorkspaceTab[]) => void
  openFilePreview: (path: string, options?: { line?: number }) => Promise<void>
  pendingFileReveal: {
    requestId: number
    path: string
    line: number
  } | null
  consumePendingFileReveal: (requestId: number) => void
  openWorkingTreeDiff: (
    path?: string,
    options?: { mode?: "auto" | "unified" | "overview" }
  ) => Promise<void>
  openBranchDiff: (
    branch: string,
    path?: string,
    options?: { mode?: "default" | "overview" }
  ) => Promise<void>
  openCommitDiff: (
    commit: string,
    path?: string,
    message?: string
  ) => Promise<void>
  openSessionFileDiff: (
    filePath: string,
    diffContent: string,
    groupLabel: string
  ) => void
  openExternalConflictDiff: (
    filePath: string,
    diskContent: string,
    unsavedContent: string
  ) => void
  updateActiveFileContent: (content: string) => void
  saveActiveFile: (options?: { force?: boolean }) => Promise<boolean>
  reloadActiveFile: () => Promise<void>
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
}

function fileName(path: string): string {
  return path.split("/").pop() || path
}

function isDirtyFileTab(tab: FileWorkspaceTab): boolean {
  return tab.kind === "file" && Boolean(tab.isDirty)
}

function loadingTab(
  id: string,
  kind: FileWorkspaceTabKind,
  title: string,
  description: string | null,
  path: string | null,
  language: string
): FileWorkspaceTab {
  return {
    id,
    kind,
    title,
    description,
    path,
    language,
    content: "",
    loading: true,
    savedContent: "",
    isDirty: false,
    etag: null,
    mtimeMs: null,
    readonly: kind !== "file",
    truncated: false,
    lineEnding: "none",
    saveState: "idle",
    saveError: null,
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface WorkspaceProviderProps {
  children: ReactNode
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const t = useTranslations("Folder.workspaceContext")
  const { folder, folderId } = useFolderContext()
  const folderPath = folder?.path
  const storageKey = useMemo(
    () => `folder:${folderId}:workspace-mode`,
    [folderId]
  )
  const [mode, setModeState] = useState<WorkspaceMode>(DEFAULT_WORKSPACE_MODE)
  const [activePane, setActivePaneState] =
    useState<WorkspacePane>("conversation")
  const [restored, setRestored] = useState(false)
  const [fileTabs, setFileTabs] = useState<FileWorkspaceTab[]>([])
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null)
  const [pendingFileReveal, setPendingFileReveal] = useState<{
    requestId: number
    path: string
    line: number
  } | null>(null)
  const fileTabsRef = useRef<FileWorkspaceTab[]>([])
  const fileRevealRequestIdRef = useRef(0)

  useEffect(() => {
    fileTabsRef.current = fileTabs
  }, [fileTabs])

  useEffect(() => {
    const storedMode = loadPersistedWorkspaceMode(storageKey)
    const nextMode = (storedMode ?? DEFAULT_WORKSPACE_MODE) as WorkspaceMode
    // Hydrate from localStorage after mount to keep SSR/CSR markup consistent.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModeState(nextMode)
    if (nextMode === "conversation" || nextMode === "files") {
      setActivePaneState(nextMode)
    }
    setRestored(true)
  }, [storageKey])

  useEffect(() => {
    if (!restored) return
    savePersistedWorkspaceMode(storageKey, mode)
  }, [mode, restored, storageKey])

  const setModeSafe = useCallback((nextMode: WorkspaceMode) => {
    setModeState(nextMode)
    if (nextMode === "conversation" || nextMode === "files") {
      setActivePaneState(nextMode)
    }
  }, [])

  const setActivePane = useCallback((nextPane: WorkspacePane) => {
    setActivePaneState((prev) => (prev === nextPane ? prev : nextPane))
  }, [])

  const activateConversationPane = useCallback(() => {
    setActivePaneState((prev) =>
      prev === "conversation" ? prev : "conversation"
    )
    setModeState((prev) => (prev === "fusion" ? prev : "conversation"))
  }, [])

  const activateFilePane = useCallback(() => {
    setActivePaneState((prev) => (prev === "files" ? prev : "files"))
    setModeState((prev) => (prev === "fusion" ? prev : "files"))
  }, [])

  const upsertLoadingTab = useCallback(
    (nextTab: FileWorkspaceTab) => {
      setFileTabs((prev) => {
        const idx = prev.findIndex((tab) => tab.id === nextTab.id)
        if (idx < 0) {
          return [...prev, nextTab]
        }

        const updated = [...prev]
        updated[idx] = {
          ...updated[idx],
          ...nextTab,
        }
        return updated
      })
      setActiveFileTabId(nextTab.id)
      activateFilePane()
    },
    [activateFilePane]
  )

  const resolveTab = useCallback(
    (tabId: string, content: string, loading = false) => {
      setFileTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                content,
                loading,
              }
            : tab
        )
      )
    },
    []
  )

  const rejectTab = useCallback(
    (tabId: string, errorMessage: string) => {
      resolveTab(
        tabId,
        t("unableLoadContent", { message: errorMessage }),
        false
      )
      setFileTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                saveState: "error",
                saveError: errorMessage,
              }
            : tab
        )
      )
    },
    [resolveTab, t]
  )

  const resolveRichDiffTab = useCallback(
    (
      tabId: string,
      originalContent: string,
      modifiedContent: string,
      loading = false
    ) => {
      setFileTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, originalContent, modifiedContent, content: "", loading }
            : tab
        )
      )
    },
    []
  )

  const consumePendingFileReveal = useCallback((requestId: number) => {
    setPendingFileReveal((prev) =>
      prev && prev.requestId === requestId ? null : prev
    )
  }, [])

  const openFilePreview = useCallback(
    async (rawPath: string, options?: { line?: number }) => {
      if (!folderPath) return
      const path = normalizePath(rawPath)
      const requestedLine =
        typeof options?.line === "number" && Number.isFinite(options.line)
          ? Math.max(1, Math.floor(options.line))
          : null
      if (requestedLine) {
        fileRevealRequestIdRef.current += 1
        setPendingFileReveal({
          requestId: fileRevealRequestIdRef.current,
          path,
          line: requestedLine,
        })
      } else {
        setPendingFileReveal(null)
      }
      const tabId = `file:${path}`
      upsertLoadingTab(
        loadingTab(
          tabId,
          "file",
          fileName(path),
          path,
          path,
          languageFromPath(path)
        )
      )

      try {
        const [result, gitBaseContent] = await withTimeout(
          Promise.all([
            readFileForEdit(folderPath, path),
            (async () => {
              const tracked = await gitIsTracked(folderPath, path).catch(
                () => false
              )
              if (!tracked) return undefined
              return gitShowFile(folderPath, path).catch(() => "")
            })(),
          ]),
          15_000,
          t("previewRequestTimedOut")
        )
        setFileTabs((prev) =>
          prev.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  content: result.content,
                  gitBaseContent,
                  savedContent: result.content,
                  isDirty: false,
                  etag: result.etag,
                  mtimeMs: result.mtime_ms,
                  readonly: result.readonly,
                  truncated: result.truncated,
                  lineEnding: result.line_ending,
                  saveState: "idle",
                  saveError: null,
                  loading: false,
                }
              : tab
          )
        )
      } catch (error) {
        if (requestedLine) {
          setPendingFileReveal((prev) =>
            prev && prev.path === path ? null : prev
          )
        }
        rejectTab(tabId, error instanceof Error ? error.message : String(error))
      }
    },
    [folderPath, rejectTab, t, upsertLoadingTab]
  )

  const openWorkingTreeDiff = useCallback(
    async (
      rawPath?: string,
      options?: { mode?: "auto" | "unified" | "overview" }
    ) => {
      if (!folderPath) return

      if (!rawPath) {
        const tabId = "diff:working:all"
        const title = t("diffTitleWorkspace")
        const description = t("diffDescriptionWorkingTree")
        upsertLoadingTab(
          loadingTab(tabId, "diff", title, description, null, "diff")
        )
        try {
          const result = await withTimeout(
            gitDiff(folderPath),
            20_000,
            t("diffRequestTimedOut")
          )
          resolveTab(tabId, result || t("noChanges"), false)
        } catch (error) {
          rejectTab(
            tabId,
            error instanceof Error ? error.message : String(error)
          )
        }
        return
      }

      const path = normalizePath(rawPath)
      const mode = options?.mode ?? "auto"

      if (mode === "overview") {
        const encodedPath = encodeURIComponent(path)
        const tabId = `diff:working-overview:${encodedPath}`
        const title = t("diffTitleFile", { name: fileName(path) })
        const description = path
        upsertLoadingTab(
          loadingTab(tabId, "diff", title, description, path, "diff")
        )

        try {
          const result = await withTimeout(
            gitDiff(folderPath, path),
            20_000,
            t("diffRequestTimedOut")
          )
          resolveTab(tabId, result || t("noChanges"), false)
        } catch (error) {
          rejectTab(
            tabId,
            error instanceof Error ? error.message : String(error)
          )
        }
        return
      }

      if (mode === "unified") {
        const tabId = `diff:working:${path}:unified`
        const title = t("diffTitleFile", { name: fileName(path) })
        const description = path
        upsertLoadingTab(
          loadingTab(tabId, "diff", title, description, path, "diff")
        )

        try {
          const result = await withTimeout(
            gitDiff(folderPath, path),
            20_000,
            t("diffRequestTimedOut")
          )
          resolveTab(tabId, result || t("noChanges"), false)
        } catch (error) {
          rejectTab(
            tabId,
            error instanceof Error ? error.message : String(error)
          )
        }
        return
      }

      const tabId = `diff:working:${path}`
      const title = t("diffTitleFile", { name: fileName(path) })
      const description = path
      const lang = languageFromPath(path)

      upsertLoadingTab(
        loadingTab(tabId, "rich-diff", title, description, path, lang)
      )

      try {
        const [originalContent, modifiedResult] = await withTimeout(
          Promise.all([
            gitShowFile(folderPath, path).catch(() => ""),
            readFilePreview(folderPath, path).catch(() => ({
              content: "",
              truncated: false,
              path: "",
            })),
          ]),
          20_000,
          t("diffRequestTimedOut")
        )
        resolveRichDiffTab(tabId, originalContent, modifiedResult.content)
      } catch (error) {
        rejectTab(tabId, error instanceof Error ? error.message : String(error))
      }
    },
    [folderPath, rejectTab, resolveTab, resolveRichDiffTab, t, upsertLoadingTab]
  )

  const openBranchDiff = useCallback(
    async (
      branch: string,
      rawPath?: string,
      options?: { mode?: "default" | "overview" }
    ) => {
      if (!folderPath) return
      const targetBranch = branch.trim()
      if (!targetBranch) return

      const path = rawPath ? normalizePath(rawPath) : null
      const mode = options?.mode ?? "default"
      const encodedBranch = encodeURIComponent(targetBranch)
      const encodedPath = encodeURIComponent(path ?? "all")
      const tabId =
        mode === "overview"
          ? `diff:branch-overview:${encodedBranch}:${encodedPath}`
          : `diff:branch:${targetBranch}:${path ?? "all"}`
      const title = path
        ? t("compareTitleFile", { name: fileName(path) })
        : t("compareTitleBranch", { branch: targetBranch })
      const description = path
        ? t("compareDescriptionPath", { path, branch: targetBranch })
        : t("compareDescriptionBranch", { branch: targetBranch })

      if (mode !== "overview" && path) {
        const lang = languageFromPath(path)
        upsertLoadingTab(
          loadingTab(tabId, "rich-diff", title, description, path, lang)
        )

        try {
          const [originalContent, modifiedResult] = await withTimeout(
            Promise.all([
              gitShowFile(folderPath, path, targetBranch).catch(() => ""),
              readFilePreview(folderPath, path).catch(() => ({
                content: "",
                truncated: false,
                path: "",
              })),
            ]),
            20_000,
            t("branchCompareRequestTimedOut")
          )
          resolveRichDiffTab(tabId, originalContent, modifiedResult.content)
        } catch (error) {
          rejectTab(
            tabId,
            error instanceof Error ? error.message : String(error)
          )
        }
        return
      }

      upsertLoadingTab(
        loadingTab(tabId, "diff", title, description, path, "diff")
      )

      try {
        const result = await withTimeout(
          gitDiffWithBranch(folderPath, targetBranch, path ?? undefined),
          20_000,
          t("branchCompareRequestTimedOut")
        )
        resolveTab(tabId, result || t("noChanges"), false)
      } catch (error) {
        rejectTab(tabId, error instanceof Error ? error.message : String(error))
      }
    },
    [folderPath, rejectTab, resolveRichDiffTab, resolveTab, t, upsertLoadingTab]
  )

  const openCommitDiff = useCallback(
    async (commit: string, rawPath?: string, message?: string) => {
      if (!folderPath) return
      const path = rawPath ? normalizePath(rawPath) : null
      const tabId = `diff:commit:${commit}:${path ?? "all"}`
      const title = path
        ? t("diffTitleCommitFile", {
            name: fileName(path),
            hash: commit.slice(0, 7),
          })
        : t("diffTitleCommit", { hash: commit.slice(0, 7) })
      const description = path
        ? t("diffDescriptionCommitPath", { path, commit })
        : message || t("diffDescriptionCommit", { commit })

      if (path) {
        const lang = languageFromPath(path)
        upsertLoadingTab(
          loadingTab(tabId, "rich-diff", title, description, path, lang)
        )

        try {
          const [originalContent, modifiedContent] = await withTimeout(
            Promise.all([
              gitShowFile(folderPath, path, `${commit}~1`).catch(() => ""),
              gitShowFile(folderPath, path, commit).catch(() => ""),
            ]),
            20_000,
            t("commitDiffRequestTimedOut")
          )
          resolveRichDiffTab(tabId, originalContent, modifiedContent)
        } catch (error) {
          rejectTab(
            tabId,
            error instanceof Error ? error.message : String(error)
          )
        }
      } else {
        upsertLoadingTab(
          loadingTab(tabId, "diff", title, description, path, "diff")
        )

        try {
          const result = await withTimeout(
            gitShowDiff(folderPath, commit, undefined),
            20_000,
            t("commitDiffRequestTimedOut")
          )
          resolveTab(tabId, result || t("noDiffOutput"), false)
        } catch (error) {
          rejectTab(
            tabId,
            error instanceof Error ? error.message : String(error)
          )
        }
      }
    },
    [folderPath, rejectTab, resolveTab, resolveRichDiffTab, t, upsertLoadingTab]
  )

  const openSessionFileDiff = useCallback(
    (filePath: string, diffContent: string, groupLabel: string) => {
      const path = normalizePath(filePath)
      const tabId = `diff:session:${groupLabel}:${path}`
      const title = t("diffTitleFile", { name: fileName(path) })
      const description = `${path} · ${groupLabel}`

      const tab: FileWorkspaceTab = {
        id: tabId,
        kind: "diff",
        title,
        description,
        path: null,
        language: "diff",
        content: diffContent,
        loading: false,
      }

      upsertLoadingTab(tab)
    },
    [t, upsertLoadingTab]
  )

  const openExternalConflictDiff = useCallback(
    (filePath: string, diskContent: string, unsavedContent: string) => {
      const path = normalizePath(filePath)
      const tabId = `diff:external-conflict:${path}`
      const title = t("diffTitleConflictFile", { name: fileName(path) })
      const description = t("diffDescriptionConflict", { path })
      const language = languageFromPath(path)

      const tab: FileWorkspaceTab = {
        id: tabId,
        kind: "rich-diff",
        title,
        description,
        path,
        language,
        content: "",
        loading: false,
        originalContent: diskContent,
        modifiedContent: unsavedContent,
      }

      upsertLoadingTab(tab)
    },
    [t, upsertLoadingTab]
  )

  const updateActiveFileContent = useCallback(
    (content: string) => {
      if (!activeFileTabId) return

      setFileTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== activeFileTabId || tab.kind !== "file") return tab
          if (tab.loading || tab.readonly || tab.truncated) return tab
          if (tab.content === content) return tab

          const savedContent = tab.savedContent ?? ""
          return {
            ...tab,
            content,
            isDirty: content !== savedContent,
            saveState: tab.saveState === "saving" ? "saving" : "idle",
            saveError: null,
          }
        })
      )
    },
    [activeFileTabId]
  )

  const saveFileTab = useCallback(
    async (tabId: string, options?: { force?: boolean }): Promise<boolean> => {
      if (!folderPath) return false
      const tab = fileTabsRef.current.find(
        (candidate) => candidate.id === tabId
      )
      if (!tab || tab.kind !== "file") return false
      if (tab.loading || tab.readonly || tab.truncated) return false
      if (!tab.path) return false
      if (!tab.isDirty) return true

      const contentAtSaveStart = tab.content
      const expectedEtag = options?.force ? null : (tab.etag ?? null)

      setFileTabs((prev) =>
        prev.map((candidate) =>
          candidate.id === tabId
            ? {
                ...candidate,
                saveState: "saving",
                saveError: null,
              }
            : candidate
        )
      )

      try {
        const result = await withTimeout(
          saveFileContent(
            folderPath,
            tab.path,
            contentAtSaveStart,
            expectedEtag
          ),
          20_000,
          t("saveRequestTimedOut")
        )

        setFileTabs((prev) =>
          prev.map((candidate) => {
            if (candidate.id !== tabId || candidate.kind !== "file") {
              return candidate
            }

            const savedContent = contentAtSaveStart
            return {
              ...candidate,
              etag: result.etag,
              mtimeMs: result.mtime_ms,
              readonly: result.readonly,
              lineEnding: result.line_ending,
              savedContent,
              isDirty: candidate.content !== savedContent,
              saveState: "idle",
              saveError: null,
            }
          })
        )

        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setFileTabs((prev) =>
          prev.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  saveState: "error",
                  saveError: message,
                }
              : candidate
          )
        )
        return false
      }
    },
    [folderPath, t]
  )

  const saveActiveFile = useCallback(
    async (options?: { force?: boolean }) => {
      if (!activeFileTabId) return false
      return saveFileTab(activeFileTabId, options)
    },
    [activeFileTabId, saveFileTab]
  )

  const reloadFileTab = useCallback(
    async (tabId: string) => {
      if (!folderPath) return
      const tab = fileTabsRef.current.find(
        (candidate) => candidate.id === tabId
      )
      if (!tab || tab.kind !== "file" || !tab.path) return
      const tabPath = tab.path

      setFileTabs((prev) =>
        prev.map((candidate) =>
          candidate.id === tabId
            ? {
                ...candidate,
                loading: true,
                saveError: null,
                saveState: "idle",
              }
            : candidate
        )
      )

      try {
        const [result, gitBaseContent] = await withTimeout(
          Promise.all([
            readFileForEdit(folderPath, tabPath),
            (async () => {
              const tracked = await gitIsTracked(folderPath, tabPath).catch(
                () => false
              )
              if (!tracked) return undefined
              return gitShowFile(folderPath, tabPath).catch(() => "")
            })(),
          ]),
          15_000,
          t("reloadRequestTimedOut")
        )
        setFileTabs((prev) =>
          prev.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  content: result.content,
                  gitBaseContent,
                  savedContent: result.content,
                  isDirty: false,
                  etag: result.etag,
                  mtimeMs: result.mtime_ms,
                  readonly: result.readonly,
                  truncated: result.truncated,
                  lineEnding: result.line_ending,
                  saveState: "idle",
                  saveError: null,
                  loading: false,
                }
              : candidate
          )
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setFileTabs((prev) =>
          prev.map((candidate) =>
            candidate.id === tabId
              ? {
                  ...candidate,
                  loading: false,
                  saveState: "error",
                  saveError: message,
                }
              : candidate
          )
        )
      }
    },
    [folderPath, t]
  )

  const reloadActiveFile = useCallback(async () => {
    if (!activeFileTabId) return
    await reloadFileTab(activeFileTabId)
  }, [activeFileTabId, reloadFileTab])

  const switchFileTab = useCallback(
    (tabId: string) => {
      if (activeFileTabId && activeFileTabId !== tabId) {
        void saveFileTab(activeFileTabId)
      }
      setActiveFileTabId(tabId)
      activateFilePane()
    },
    [activeFileTabId, activateFilePane, saveFileTab]
  )

  const closeFileTab = useCallback(
    (tabId: string) => {
      setFileTabs((prev) => {
        const idx = prev.findIndex((tab) => tab.id === tabId)
        if (idx < 0) return prev

        const tab = prev[idx]
        if (isDirtyFileTab(tab)) {
          const confirmed = window.confirm(
            t("confirmCloseDirtyTab", { title: tab.title })
          )
          if (!confirmed) return prev
        }

        const next = prev.filter((candidate) => candidate.id !== tabId)

        setActiveFileTabId((current) => {
          if (current !== tabId) return current
          if (next.length === 0) {
            activateConversationPane()
            return null
          }
          const nextIdx = Math.min(idx, next.length - 1)
          return next[nextIdx].id
        })

        return next
      })
    },
    [activateConversationPane, t]
  )

  const closeOtherFileTabs = useCallback(
    (tabId: string) => {
      setFileTabs((prev) => {
        const remaining = prev.filter((tab) => tab.id === tabId)
        if (remaining.length === 0) return prev

        const closingTabs = prev.filter((tab) => tab.id !== tabId)
        if (closingTabs.some(isDirtyFileTab)) {
          const confirmed = window.confirm(t("confirmCloseOtherDirtyTabs"))
          if (!confirmed) return prev
        }

        setActiveFileTabId(tabId)
        activateFilePane()
        return remaining
      })
    },
    [activateFilePane, t]
  )

  const closeAllFileTabs = useCallback(() => {
    setFileTabs((prev) => {
      if (prev.some(isDirtyFileTab)) {
        const confirmed = window.confirm(t("confirmCloseAllDirtyTabs"))
        if (!confirmed) return prev
      }

      setActiveFileTabId(null)
      activateConversationPane()
      return []
    })
  }, [activateConversationPane, t])

  const reorderFileTabs = useCallback((tabs: FileWorkspaceTab[]) => {
    setFileTabs(tabs)
  }, [])

  const activeFileTab = useMemo(
    () => fileTabs.find((tab) => tab.id === activeFileTabId) ?? null,
    [fileTabs, activeFileTabId]
  )

  const activeFilePath = activeFileTab?.path ?? null

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      mode,
      activePane,
      setMode: setModeSafe,
      setActivePane,
      activateConversationPane,
      activateFilePane,
      fileTabs,
      activeFileTabId,
      activeFileTab,
      activeFilePath,
      switchFileTab,
      closeFileTab,
      closeOtherFileTabs,
      closeAllFileTabs,
      reorderFileTabs,
      openFilePreview,
      pendingFileReveal,
      consumePendingFileReveal,
      openWorkingTreeDiff,
      openBranchDiff,
      openCommitDiff,
      openSessionFileDiff,
      openExternalConflictDiff,
      updateActiveFileContent,
      saveActiveFile,
      reloadActiveFile,
    }),
    [
      mode,
      activePane,
      setModeSafe,
      setActivePane,
      activateConversationPane,
      activateFilePane,
      fileTabs,
      activeFileTabId,
      activeFileTab,
      activeFilePath,
      switchFileTab,
      closeFileTab,
      closeOtherFileTabs,
      closeAllFileTabs,
      reorderFileTabs,
      openFilePreview,
      pendingFileReveal,
      consumePendingFileReveal,
      openWorkingTreeDiff,
      openBranchDiff,
      openCommitDiff,
      openSessionFileDiff,
      openExternalConflictDiff,
      updateActiveFileContent,
      saveActiveFile,
      reloadActiveFile,
    ]
  )

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspaceContext() {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) {
    throw new Error("useWorkspaceContext must be used within WorkspaceProvider")
  }
  return ctx
}
