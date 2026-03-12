import type {
  MessageTurn,
  ContentBlock,
  MessageRole,
  TurnUsage,
} from "@/lib/types"

/**
 * Adapted content part types for AI SDK Elements components
 */
export type ToolCallState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"

export type AdaptedContentPart =
  | { type: "text"; text: string }
  | {
      type: "tool-call"
      toolCallId: string
      toolName: string
      displayTitle?: string | null
      input: string | null
      state: ToolCallState
      output?: string | null
      errorText?: string
    }
  | {
      type: "tool-result"
      toolCallId: string
      output: string | null
      errorText?: string
      state: "output-available" | "output-error"
    }
  | { type: "reasoning"; content: string; isStreaming: boolean }

export interface UserResourceDisplay {
  name: string
  uri: string
  mime_type?: string | null
}

export interface UserImageDisplay {
  name: string
  data: string
  mime_type: string
  uri?: string | null
}

const BLOCKED_RESOURCE_MENTION_RE = /@([^\s@]+)\s*\[blocked[^\]]*\]/gi
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g

/**
 * Adapted message format for AI SDK Elements
 */
export interface AdaptedMessage {
  id: string
  role: MessageRole
  content: AdaptedContentPart[]
  userResources?: UserResourceDisplay[]
  userImages?: UserImageDisplay[]
  timestamp: string
  usage?: TurnUsage | null
  duration_ms?: number | null
  model?: string | null
}

export interface AdapterMessageText {
  attachedResources: string
  toolCallFailed: string
}

type InlineToolSegment =
  | { kind: "text"; value: string }
  | { kind: "tool_call" | "tool_result"; value: string }

const INLINE_TOOL_TAG_RE = /<(tool_call|tool_result)>\s*([\s\S]*?)\s*<\/\1>/gi

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function toInlinePayloadString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function splitInlineToolSegments(text: string): InlineToolSegment[] | null {
  INLINE_TOOL_TAG_RE.lastIndex = 0
  const segments: InlineToolSegment[] = []
  let cursor = 0
  let foundTag = false

  for (const match of text.matchAll(INLINE_TOOL_TAG_RE)) {
    const full = match[0]
    const tag = match[1]
    const body = match[2]
    const start = match.index ?? -1
    if (start < 0) continue

    foundTag = true
    if (start > cursor) {
      segments.push({
        kind: "text",
        value: text.slice(cursor, start),
      })
    }

    if (tag === "tool_call" || tag === "tool_result") {
      segments.push({
        kind: tag,
        value: body ?? "",
      })
    }

    cursor = start + full.length
  }

  if (!foundTag) return null

  if (cursor < text.length) {
    segments.push({
      kind: "text",
      value: text.slice(cursor),
    })
  }

  return segments
}

function parseInlineToolCallPayload(payload: string): {
  toolName: string
  toolCallId: string | null
  input: string | null
} {
  const trimmed = payload.trim()
  if (trimmed.length === 0) {
    return { toolName: "tool", toolCallId: null, input: null }
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    const obj = asRecord(parsed)
    if (!obj) {
      return {
        toolName: "tool",
        toolCallId: null,
        input: toInlinePayloadString(parsed),
      }
    }

    const nameCandidates = [
      obj.name,
      obj.tool_name,
      obj.tool,
      obj.kind,
      obj.type,
    ]
    const toolName =
      nameCandidates
        .find((value): value is string => typeof value === "string")
        ?.trim() || "tool"

    const idCandidates = [
      obj.id,
      obj.tool_call_id,
      obj.tool_use_id,
      obj.call_id,
      obj.callId,
    ]
    const toolCallId =
      idCandidates.find(
        (value): value is string => typeof value === "string"
      ) ?? null

    const directInput =
      obj.arguments ?? obj.input ?? obj.params ?? obj.payload ?? null
    if (directInput !== null) {
      return {
        toolName,
        toolCallId,
        input: toInlinePayloadString(directInput),
      }
    }

    const passthroughEntries = Object.entries(obj).filter(
      ([key]) =>
        ![
          "name",
          "tool_name",
          "tool",
          "kind",
          "type",
          "id",
          "tool_call_id",
          "tool_use_id",
          "call_id",
          "callId",
        ].includes(key)
    )
    const fallbackInput =
      passthroughEntries.length > 0
        ? Object.fromEntries(passthroughEntries)
        : null

    return {
      toolName,
      toolCallId,
      input: toInlinePayloadString(fallbackInput),
    }
  } catch {
    return {
      toolName: "tool",
      toolCallId: null,
      input: trimmed,
    }
  }
}

function parseInlineToolResultPayload(payload: string): {
  output: string | null
  isError: boolean
} {
  const trimmed = payload.trim()
  if (trimmed.length === 0) {
    return { output: null, isError: false }
  }

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "string") {
      return { output: parsed, isError: false }
    }

    const obj = asRecord(parsed)
    if (!obj) {
      return { output: toInlinePayloadString(parsed), isError: false }
    }

    const isError =
      obj.is_error === true ||
      obj.error === true ||
      (typeof obj.status === "string" && obj.status.toLowerCase() === "error")

    const outputCandidates = [
      obj.output,
      obj.result,
      obj.text,
      obj.content,
      obj.stdout,
      obj.stderr,
      obj.message,
    ]
    const output = outputCandidates
      .map((value) => toInlinePayloadString(value))
      .find((value): value is string => typeof value === "string")

    return {
      output: output ?? toInlinePayloadString(parsed),
      isError,
    }
  } catch {
    return {
      output: trimmed,
      isError: false,
    }
  }
}

function expandInlineToolText(
  text: string,
  messageId: string,
  blockIndex: number,
  toolCallFailedText: string
): AdaptedContentPart[] | null {
  const segments = splitInlineToolSegments(text)
  if (!segments) return null

  const parts: AdaptedContentPart[] = []
  let inlineCounter = 0

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]

    if (segment.kind === "text") {
      if (segment.value.trim().length > 0) {
        parts.push({
          type: "text",
          text: segment.value,
        })
      }
      continue
    }

    if (segment.kind === "tool_call") {
      const parsedCall = parseInlineToolCallPayload(segment.value)
      const fallbackId = `${messageId}-inline-tool-${blockIndex}-${inlineCounter}`
      const toolCallId = parsedCall.toolCallId ?? fallbackId

      let output: string | null = null
      let errorText: string | undefined
      let state: ToolCallState = "output-available"

      let lookahead = index + 1
      while (
        lookahead < segments.length &&
        segments[lookahead].kind === "text" &&
        segments[lookahead].value.trim().length === 0
      ) {
        lookahead += 1
      }

      if (
        lookahead < segments.length &&
        segments[lookahead].kind === "tool_result"
      ) {
        const parsedResult = parseInlineToolResultPayload(
          segments[lookahead].value
        )
        output = parsedResult.output
        if (parsedResult.isError) {
          state = "output-error"
          errorText = output ?? toolCallFailedText
        }
        index = lookahead
      }

      parts.push({
        type: "tool-call",
        toolCallId,
        toolName: parsedCall.toolName,
        input: parsedCall.input,
        state,
        output,
        errorText,
      })
      inlineCounter += 1
      continue
    }

    const parsedResult = parseInlineToolResultPayload(segment.value)
    const toolCallId = `${messageId}-inline-tool-result-${blockIndex}-${inlineCounter}`
    parts.push({
      type: "tool-result",
      toolCallId,
      output: parsedResult.output,
      errorText: parsedResult.isError
        ? (parsedResult.output ?? toolCallFailedText)
        : undefined,
      state: parsedResult.isError ? "output-error" : "output-available",
    })
    inlineCounter += 1
  }

  return parts
}

function sanitizeMentionName(raw: string): string {
  return raw.replace(/[),.;:!?]+$/g, "")
}

function normalizeResourceText(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim()
}

function fileNameFromUri(uri: string): string {
  try {
    const url = new URL(uri)
    const segment = url.pathname.split("/").pop() || ""
    return decodeURIComponent(segment) || uri
  } catch {
    return uri
  }
}

function addResource(
  resources: UserResourceDisplay[],
  resource: UserResourceDisplay
) {
  if (
    resources.some(
      (item) => item.name === resource.name && item.uri === resource.uri
    )
  ) {
    return
  }
  resources.push(resource)
}

function addImage(images: UserImageDisplay[], image: UserImageDisplay) {
  const key = `${image.mime_type}:${image.data.length}:${image.data.slice(0, 64)}`
  if (
    images.some(
      (item) =>
        `${item.mime_type}:${item.data.length}:${item.data.slice(0, 64)}` ===
        key
    )
  ) {
    return
  }
  images.push(image)
}

export function extractUserResourcesFromText(text: string): {
  text: string
  resources: UserResourceDisplay[]
} {
  const resources: UserResourceDisplay[] = []
  const withoutBlocked = text.replace(
    BLOCKED_RESOURCE_MENTION_RE,
    (_match: string, mention: string) => {
      const name = sanitizeMentionName(mention)
      if (name.length > 0) {
        addResource(resources, {
          name,
          uri: name,
          mime_type: null,
        })
      }
      return ""
    }
  )
  const cleaned = withoutBlocked.replace(
    MARKDOWN_LINK_RE,
    (match: string, label: string, uri: string) => {
      const normalizedLabel = label.trim()
      const normalizedUri = uri.trim()
      const hasMentionLabel = normalizedLabel.startsWith("@")
      const isFileUri = normalizedUri.toLowerCase().startsWith("file://")
      if (!hasMentionLabel && !isFileUri) {
        return match
      }

      const candidateName = hasMentionLabel
        ? normalizedLabel.slice(1)
        : normalizedLabel
      const name = sanitizeMentionName(candidateName) || fileNameFromUri(uri)
      addResource(resources, {
        name,
        uri: normalizedUri,
        mime_type: null,
      })
      return ""
    }
  )

  return {
    text: normalizeResourceText(cleaned),
    resources,
  }
}

function splitUserTextAndResources(
  parts: AdaptedContentPart[],
  attachedResourcesText: string
): {
  parts: AdaptedContentPart[]
  resources: UserResourceDisplay[]
} {
  const resources: UserResourceDisplay[] = []
  const nextParts: AdaptedContentPart[] = []

  for (const part of parts) {
    if (part.type !== "text") {
      nextParts.push(part)
      continue
    }
    const extracted = extractUserResourcesFromText(part.text)
    if (extracted.resources.length > 0) {
      resources.push(...extracted.resources)
      if (extracted.text.length > 0) {
        nextParts.push({ type: "text", text: extracted.text })
      }
    } else {
      nextParts.push(part)
    }
  }

  if (nextParts.length === 0 && resources.length > 0) {
    nextParts.push({ type: "text", text: attachedResourcesText })
  }

  return { parts: nextParts, resources }
}

function deriveImageNameFromBlock(
  block: Extract<ContentBlock, { type: "image" }>
): string {
  if (block.uri && block.uri.trim().length > 0) {
    return fileNameFromUri(block.uri)
  }
  const ext = block.mime_type.split("/")[1]?.split("+")[0] ?? "image"
  return `image.${ext}`
}

function extractUserImagesFromBlocks(
  blocks: ContentBlock[]
): UserImageDisplay[] {
  const images: UserImageDisplay[] = []
  for (const block of blocks) {
    if (block.type !== "image") continue
    if (!block.data || !block.mime_type) continue
    addImage(images, {
      name: deriveImageNameFromBlock(block),
      data: block.data,
      mime_type: block.mime_type,
      uri: block.uri ?? null,
    })
  }
  return images
}

/**
 * Generate a stable tool call ID based on message ID and block index
 */
function generateToolCallId(messageId: string, blockIndex: number): string {
  return `${messageId}-tool-${blockIndex}`
}

/**
 * Transform a single ContentBlock to AdaptedContentPart
 */
function adaptContentBlock(
  block: ContentBlock,
  messageId: string,
  blockIndex: number,
  isStreaming: boolean = false
): AdaptedContentPart | null {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: block.text,
      }

    case "tool_use":
      return {
        type: "tool-call",
        toolCallId: generateToolCallId(messageId, blockIndex),
        toolName: block.tool_name,
        input: block.input_preview,
        state: "input-available",
      }

    case "tool_result":
      return {
        type: "tool-result",
        toolCallId: generateToolCallId(messageId, blockIndex),
        output: block.output_preview,
        errorText: block.is_error
          ? block.output_preview || undefined
          : undefined,
        state: block.is_error ? "output-error" : "output-available",
      }

    case "thinking":
      return {
        type: "reasoning",
        content: block.text,
        isStreaming,
      }

    default:
      return null
  }
}

/**
 * Build a map of tool_use_id → tool_result ContentBlock from content blocks.
 * Used to correlate tool calls with their results.
 */
function buildToolResultMap(
  blocks: ContentBlock[]
): Map<string, ContentBlock & { type: "tool_result" }> {
  const map = new Map<string, ContentBlock & { type: "tool_result" }>()
  for (const block of blocks) {
    if (block.type === "tool_result" && block.tool_use_id) {
      map.set(block.tool_use_id, block)
    }
  }
  return map
}

/**
 * Transform a MessageTurn (from backend) to AdaptedMessage format.
 * Same correlation logic as adaptUnifiedMessage but operates on turn.blocks.
 */
export function adaptMessageTurn(
  turn: MessageTurn,
  text: AdapterMessageText,
  isStreaming: boolean = false
): AdaptedMessage {
  const adaptedContent: AdaptedContentPart[] = []
  const resultMap = buildToolResultMap(turn.blocks)
  const matchedResultIds = new Set<string>()

  // Track indices of tool_result blocks consumed by position-based matching
  const positionMatchedIndices = new Set<number>()

  for (let index = 0; index < turn.blocks.length; index++) {
    const block = turn.blocks[index]

    if (turn.role === "assistant" && block.type === "text") {
      const expandedParts = expandInlineToolText(
        block.text,
        turn.id,
        index,
        text.toolCallFailed
      )
      if (expandedParts) {
        adaptedContent.push(...expandedParts)
        continue
      }
    }

    if (block.type === "tool_use") {
      const toolCallId = block.tool_use_id || generateToolCallId(turn.id, index)
      const matchedResult = block.tool_use_id
        ? resultMap.get(block.tool_use_id)
        : undefined

      if (matchedResult) {
        matchedResultIds.add(block.tool_use_id!)
        adaptedContent.push({
          type: "tool-call",
          toolCallId,
          toolName: block.tool_name,
          input: block.input_preview,
          state: matchedResult.is_error ? "output-error" : "output-available",
          output: matchedResult.output_preview,
          errorText: matchedResult.is_error
            ? matchedResult.output_preview || undefined
            : undefined,
        })
      } else {
        // Position-based matching: if this tool_use has no ID, check next block
        const nextBlock = turn.blocks[index + 1]
        const positionalResult =
          !block.tool_use_id &&
          nextBlock?.type === "tool_result" &&
          !nextBlock.tool_use_id
            ? nextBlock
            : undefined

        if (positionalResult) {
          positionMatchedIndices.add(index + 1)
          adaptedContent.push({
            type: "tool-call",
            toolCallId,
            toolName: block.tool_name,
            input: block.input_preview,
            state: positionalResult.is_error
              ? "output-error"
              : "output-available",
            output: positionalResult.output_preview,
            errorText: positionalResult.is_error
              ? positionalResult.output_preview || undefined
              : undefined,
          })
        } else {
          // For live streaming, unmatched tools are still running.
          // For DB historical data, default to "completed" since the
          // conversation has already ended.
          adaptedContent.push({
            type: "tool-call",
            toolCallId,
            toolName: block.tool_name,
            input: block.input_preview,
            state: isStreaming ? "input-available" : "output-available",
          })
        }
      }
      continue
    }

    // Skip tool_result blocks already matched by ID or position
    if (
      block.type === "tool_result" &&
      ((block.tool_use_id && matchedResultIds.has(block.tool_use_id)) ||
        positionMatchedIndices.has(index))
    ) {
      continue
    }

    const adapted = adaptContentBlock(block, turn.id, index, false)
    if (adapted) {
      adaptedContent.push(adapted)
    }
  }

  // Mark the last reasoning block as streaming if the turn is actively streaming
  if (isStreaming) {
    const last = adaptedContent[adaptedContent.length - 1]
    if (last?.type === "reasoning") {
      last.isStreaming = true
    }
  }

  const userSplit =
    turn.role === "user"
      ? splitUserTextAndResources(adaptedContent, text.attachedResources)
      : { parts: adaptedContent, resources: [] as UserResourceDisplay[] }
  const userImages =
    turn.role === "user" ? extractUserImagesFromBlocks(turn.blocks) : []

  return {
    id: turn.id,
    role: turn.role,
    content: userSplit.parts,
    userResources:
      userSplit.resources.length > 0 ? userSplit.resources : undefined,
    userImages: userImages.length > 0 ? userImages : undefined,
    timestamp: turn.timestamp,
    usage: turn.usage,
    duration_ms: turn.duration_ms,
    model: turn.model,
  }
}

/**
 * Transform all turns in a conversation to AdaptedMessage[].
 * Internally computes completedToolIds so callers don't need to.
 */
export function adaptMessageTurns(
  turns: MessageTurn[],
  text: AdapterMessageText,
  streamingIndices?: Set<number>
): AdaptedMessage[] {
  return turns.map((turn, i) =>
    adaptMessageTurn(turn, text, streamingIndices?.has(i) ?? false)
  )
}
