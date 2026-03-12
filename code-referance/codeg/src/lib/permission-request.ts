import { normalizeToolName } from "@/lib/tool-call-normalization"
import {
  countUnifiedDiffLineChanges,
  estimateChangedLineStats,
  splitNormalizedLines,
} from "@/lib/line-change-stats"

type ObjectLike = Record<string, unknown>

export interface PermissionFileChange {
  path: string
  oldText: string
  newText: string
  unifiedDiff?: string
}

export interface PermissionPlanEntry {
  text: string
  status: string | null
}

export interface PermissionAllowedPrompt {
  prompt: string
  tool: string
}

export interface ParsedPermissionToolCall {
  title: string
  normalizedKind: string
  command: string | null
  cwd: string | null
  fileChanges: PermissionFileChange[]
  additions: number
  deletions: number
  diffPreview: string | null
  planEntries: PermissionPlanEntry[]
  planExplanation: string | null
  planMarkdown: string | null
  allowedPrompts: PermissionAllowedPrompt[]
  modeTarget: string | null
  jsonPreview: string
}

function asObject(value: unknown): ObjectLike | null {
  if (!value) return null
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as ObjectLike
  }
  if (typeof value !== "string") return null
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ObjectLike)
      : null
  } catch {
    return null
  }
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function pickValue(record: ObjectLike | null, keys: string[]): unknown {
  if (!record) return null
  for (const key of keys) {
    if (!(key in record)) continue
    const value = record[key]
    if (value !== undefined && value !== null) return value
  }
  return null
}

function pickString(record: ObjectLike | null, keys: string[]): string | null {
  const value = pickValue(record, keys)
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function joinStringArray(values: unknown): string | null {
  if (!Array.isArray(values)) return null
  const parts = values.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0
  )
  return parts.length > 0 ? parts.join(" ") : null
}

function unescapeInlineEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
}

function looksLikeDiffPayload(input: string): boolean {
  const normalized = unescapeInlineEscapes(input)
  return (
    normalized.includes("*** Begin Patch") ||
    normalized.includes("*** Update File:") ||
    /^diff --git /m.test(normalized) ||
    (/^--- .+/m.test(normalized) && /^\+\+\+ .+/m.test(normalized)) ||
    /^@@ /m.test(normalized)
  )
}

function buildCompactDiffFromTexts(
  path: string,
  oldText: string,
  newText: string,
  contextLines: number = 2
): string | null {
  const oldLines = splitNormalizedLines(oldText)
  const newLines = splitNormalizedLines(newText)

  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  if (removed.length === 0 && added.length === 0) return null

  const before = oldLines.slice(Math.max(0, prefix - contextLines), prefix)
  const after = oldLines.slice(
    oldLines.length - suffix,
    Math.min(oldLines.length, oldLines.length - suffix + contextLines)
  )

  const parts: string[] = [`--- ${path}`, `+++ ${path}`]
  for (const line of before) parts.push(` ${line}`)
  for (const line of removed) parts.push(`-${line}`)
  for (const line of added) parts.push(`+${line}`)
  for (const line of after) parts.push(` ${line}`)

  return parts.join("\n")
}

function buildDiffPreviewFromChanges(
  changes: PermissionFileChange[],
  maxFiles: number = 8,
  maxLines: number = 1200
): string | null {
  const meaningful = changes.filter((change) => {
    if (
      typeof change.unifiedDiff === "string" &&
      change.unifiedDiff.trim().length > 0
    ) {
      return true
    }
    return change.oldText.length > 0 || change.newText.length > 0
  })
  if (meaningful.length === 0) return null

  const limited = meaningful.slice(0, maxFiles)
  const lines: string[] = []
  let lineCount = 0
  let truncated = false

  const pushLine = (line: string) => {
    if (lineCount >= maxLines) {
      truncated = true
      return
    }
    lines.push(line)
    lineCount += 1
  }

  for (const change of limited) {
    const block =
      typeof change.unifiedDiff === "string" &&
      change.unifiedDiff.trim().length > 0
        ? change.unifiedDiff.trim()
        : buildCompactDiffFromTexts(change.path, change.oldText, change.newText)
    if (!block) continue

    for (const line of block.split("\n")) {
      pushLine(line)
      if (truncated) break
    }
    if (truncated) break
    pushLine("")
  }

  if (meaningful.length > limited.length) {
    lines.push(`# ... ${meaningful.length - limited.length} more files omitted`)
  }
  if (truncated) {
    lines.push("# ... diff preview truncated")
  }

  const preview = lines.join("\n").trim()
  return preview.length > 0 ? preview : null
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value ?? "")
  }
}

function extractCommandFromUnknownValue(
  value: unknown,
  depth: number = 0
): string | null {
  if (depth > 4 || value === null || value === undefined) return null
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed || looksLikeDiffPayload(trimmed)) return null
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      return trimmed
    }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return extractCommandFromUnknownValue(parsed, depth + 1)
    } catch {
      return null
    }
  }

  if (Array.isArray(value)) {
    const joined = joinStringArray(value)
    return joined && joined.trim().length > 0 ? joined.trim() : null
  }

  if (typeof value !== "object") return null
  const obj = value as ObjectLike

  const directKeys = [
    "command",
    "cmd",
    "script",
    "args",
    "argv",
    "command_args",
  ]
  for (const key of directKeys) {
    const direct = extractCommandFromUnknownValue(obj[key], depth + 1)
    if (direct) return direct
  }

  const nestedKeys = [
    "rawInput",
    "raw_input",
    "input",
    "arguments",
    "params",
    "payload",
  ]
  for (const key of nestedKeys) {
    const nested = extractCommandFromUnknownValue(obj[key], depth + 1)
    if (nested) return nested
  }

  return null
}

function extractDiffPreview(
  rawInput: unknown,
  rawInputObj: ObjectLike | null
): string | null {
  const candidates: unknown[] = [rawInput]
  if (rawInputObj) {
    candidates.push(
      rawInputObj.patch,
      rawInputObj.diff,
      rawInputObj.unified_diff,
      rawInputObj.unifiedDiff
    )
  }

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const normalized = unescapeInlineEscapes(candidate).trim()
    if (!normalized) continue
    if (looksLikeDiffPayload(normalized)) return normalized
  }

  return null
}

function parseChangeRecord(
  path: string,
  value: unknown
): PermissionFileChange | null {
  const normalizedPath = path.trim()
  if (!normalizedPath) return null

  if (typeof value === "string") {
    return {
      path: normalizedPath,
      oldText: "",
      newText: value,
      unifiedDiff: undefined,
    }
  }

  const record = asObject(value)
  if (!record) {
    return {
      path: normalizedPath,
      oldText: "",
      newText: "",
    }
  }

  const oldText =
    pickString(record, [
      "old_string",
      "oldString",
      "old_text",
      "oldText",
      "old",
      "before",
    ]) ?? ""
  const newText =
    pickString(record, [
      "new_string",
      "newString",
      "new_text",
      "newText",
      "new",
      "after",
      "content",
      "text",
      "new_source",
      "newSource",
    ]) ?? ""
  const unifiedDiff =
    pickString(record, ["unifiedDiff", "unified_diff", "diff", "patch"]) ??
    undefined

  return {
    path: normalizedPath,
    oldText,
    newText,
    unifiedDiff,
  }
}

function extractRawInputFileChanges(
  rawInputObj: ObjectLike | null
): PermissionFileChange[] {
  if (!rawInputObj) return []

  const changes: PermissionFileChange[] = []
  const byChangesObject = asObject(rawInputObj.changes)
  if (byChangesObject) {
    for (const [path, value] of Object.entries(byChangesObject)) {
      const parsed = parseChangeRecord(path, value)
      if (parsed) changes.push(parsed)
    }
  }

  const directPath =
    pickString(rawInputObj, [
      "file_path",
      "filePath",
      "path",
      "notebook_path",
      "target_file",
      "targetFile",
    ]) ?? null

  if (directPath) {
    const oldText =
      pickString(rawInputObj, [
        "old_string",
        "oldString",
        "old_text",
        "oldText",
      ]) ?? ""
    const newText =
      pickString(rawInputObj, [
        "new_string",
        "newString",
        "new_text",
        "newText",
        "content",
        "text",
        "new_source",
      ]) ?? ""

    if (oldText || newText || changes.length === 0) {
      changes.push({
        path: directPath,
        oldText,
        newText,
        unifiedDiff: undefined,
      })
    }
  }

  return changes
}

function extractContentDiffChanges(
  toolCallObj: ObjectLike | null
): PermissionFileChange[] {
  if (!toolCallObj) return []
  const content = asArray(toolCallObj.content)
  if (!content) return []

  const changes: PermissionFileChange[] = []
  for (const item of content) {
    const record = asObject(item)
    if (!record) continue
    const type = pickString(record, ["type"])?.toLowerCase()
    if (type !== "diff") continue

    const path = pickString(record, ["path"])
    if (!path) continue
    changes.push({
      path,
      oldText: pickString(record, ["old_text", "oldText"]) ?? "",
      newText: pickString(record, ["new_text", "newText"]) ?? "",
      unifiedDiff: undefined,
    })
  }
  return changes
}

function collectLocationPaths(toolCallObj: ObjectLike | null): string[] {
  if (!toolCallObj) return []
  const locations = asArray(toolCallObj.locations)
  if (!locations) return []

  const paths: string[] = []
  for (const item of locations) {
    const record = asObject(item)
    if (!record) continue
    const path = pickString(record, ["path"])
    if (path) paths.push(path)
  }
  return paths
}

function collectDiffPaths(diffText: string | null): string[] {
  if (!diffText) return []
  const paths = new Set<string>()
  for (const line of diffText.split("\n")) {
    if (line.startsWith("*** Add File: ")) {
      paths.add(line.slice(14).trim())
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      paths.add(line.slice(17).trim())
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      paths.add(line.slice(17).trim())
      continue
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "").trim()
      if (path && path !== "/dev/null") paths.add(path)
    }
  }
  return Array.from(paths)
}

function mergeFileChanges(
  changes: PermissionFileChange[]
): PermissionFileChange[] {
  const merged = new Map<string, PermissionFileChange>()
  for (const change of changes) {
    const path = change.path.trim()
    if (!path) continue
    const prev = merged.get(path)
    if (!prev) {
      merged.set(path, { ...change, path })
      continue
    }

    const oldText = prev.oldText || change.oldText
    const newText = prev.newText || change.newText
    const unifiedDiff = prev.unifiedDiff || change.unifiedDiff
    merged.set(path, { path, oldText, newText, unifiedDiff })
  }
  return Array.from(merged.values())
}

function parsePlanEntries(
  rawInputObj: ObjectLike | null
): PermissionPlanEntry[] {
  if (!rawInputObj) return []

  const candidates = [
    pickValue(rawInputObj, ["plan"]),
    pickValue(rawInputObj, ["entries"]),
    pickValue(rawInputObj, ["steps"]),
    pickValue(rawInputObj, ["todos"]),
  ]

  for (const candidate of candidates) {
    const list = asArray(candidate)
    if (!list || list.length === 0) continue
    const entries: PermissionPlanEntry[] = []
    for (const item of list) {
      const record = asObject(item)
      if (!record) continue
      const text =
        pickString(record, [
          "step",
          "content",
          "title",
          "task",
          "description",
        ]) ?? null
      if (!text) continue
      entries.push({
        text,
        status: pickString(record, ["status", "state"]),
      })
    }
    if (entries.length > 0) return entries
  }

  return []
}

function parseAllowedPrompts(
  rawInputObj: ObjectLike | null
): PermissionAllowedPrompt[] {
  if (!rawInputObj) return []
  const list = asArray(
    pickValue(rawInputObj, ["allowedPrompts", "allowed_prompts"])
  )
  if (!list || list.length === 0) return []

  const prompts: PermissionAllowedPrompt[] = []
  for (const item of list) {
    const record = asObject(item)
    if (!record) continue
    const prompt = pickString(record, ["prompt", "description", "text"])
    const tool = pickString(record, ["tool", "toolName", "tool_name"])
    if (prompt) {
      prompts.push({ prompt, tool: tool ?? "" })
    }
  }
  return prompts
}

function formatFallbackTitle(kind: string): string {
  const normalized = kind.replace(/_/g, " ").trim()
  if (!normalized) return "Permission Request"
  return normalized
    .split(/\s+/)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ")
}

export function parsePermissionToolCall(
  toolCall: unknown
): ParsedPermissionToolCall {
  const toolCallObj = asObject(toolCall)
  const rawKind =
    pickString(toolCallObj, [
      "kind",
      "tool_name",
      "toolName",
      "name",
      "type",
    ]) ?? "tool"
  const normalizedKind = normalizeToolName(rawKind)

  const rawInputValue =
    pickValue(toolCallObj, [
      "rawInput",
      "raw_input",
      "input",
      "arguments",
      "params",
      "payload",
    ]) ?? null
  const rawInputObj = asObject(rawInputValue)

  const command =
    extractCommandFromUnknownValue(rawInputValue) ??
    extractCommandFromUnknownValue(toolCallObj)

  const cwd =
    pickString(rawInputObj, [
      "cwd",
      "workdir",
      "working_directory",
      "workingDirectory",
    ]) ??
    pickString(toolCallObj, [
      "cwd",
      "workdir",
      "working_directory",
      "workingDirectory",
    ])

  const explicitDiffPreview = extractDiffPreview(rawInputValue, rawInputObj)
  const rawInputFileChanges = extractRawInputFileChanges(rawInputObj)
  const contentDiffChanges = extractContentDiffChanges(toolCallObj)
  const locationPaths = collectLocationPaths(toolCallObj)
  const diffPaths = collectDiffPaths(explicitDiffPreview)

  const combinedChanges = mergeFileChanges([
    ...rawInputFileChanges,
    ...contentDiffChanges,
    ...locationPaths.map((path) => ({
      path,
      oldText: "",
      newText: "",
      unifiedDiff: undefined,
    })),
    ...diffPaths.map((path) => ({
      path,
      oldText: "",
      newText: "",
      unifiedDiff: undefined,
    })),
  ])
  const diffPreview =
    explicitDiffPreview ?? buildDiffPreviewFromChanges(combinedChanges)

  let additions = 0
  let deletions = 0
  if (diffPreview) {
    const stats = countUnifiedDiffLineChanges(diffPreview)
    additions = stats.additions
    deletions = stats.deletions
  } else {
    for (const change of combinedChanges) {
      if (
        typeof change.unifiedDiff === "string" &&
        change.unifiedDiff.trim().length > 0
      ) {
        const stats = countUnifiedDiffLineChanges(change.unifiedDiff)
        additions += stats.additions
        deletions += stats.deletions
        continue
      }
      const stats = estimateChangedLineStats(change.oldText, change.newText)
      additions += stats.additions
      deletions += stats.deletions
    }
  }

  const planEntries = parsePlanEntries(rawInputObj)
  const planExplanation = pickString(rawInputObj, ["explanation"])

  const rawPlan = rawInputObj ? pickValue(rawInputObj, ["plan"]) : null
  const planMarkdown =
    typeof rawPlan === "string" && rawPlan.trim().length > 0 ? rawPlan : null

  const allowedPrompts = parseAllowedPrompts(rawInputObj)

  const modeTarget =
    pickString(rawInputObj, [
      "mode_id",
      "modeId",
      "target_mode",
      "targetMode",
    ]) ?? null

  const title =
    pickString(toolCallObj, ["title", "tool_name", "toolName", "name"]) ??
    formatFallbackTitle(normalizedKind)

  return {
    title,
    normalizedKind,
    command,
    cwd,
    fileChanges: combinedChanges,
    additions,
    deletions,
    diffPreview,
    planEntries,
    planExplanation,
    planMarkdown,
    allowedPrompts,
    modeTarget,
    jsonPreview: stringifyJson(toolCallObj ?? toolCall),
  }
}
