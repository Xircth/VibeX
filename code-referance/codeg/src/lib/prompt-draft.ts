import type {
  AdaptedContentPart,
  UserImageDisplay,
  UserResourceDisplay,
} from "@/lib/adapters/ai-elements-adapter"
import type { PromptDraft, PromptInputBlock } from "@/lib/types"

function isResourceLinkBlock(
  block: PromptInputBlock
): block is Extract<PromptInputBlock, { type: "resource_link" }> {
  return block.type === "resource_link"
}

function isEmbeddedResourceBlock(
  block: PromptInputBlock
): block is Extract<PromptInputBlock, { type: "resource" }> {
  return block.type === "resource"
}

function isImageBlock(
  block: PromptInputBlock
): block is Extract<PromptInputBlock, { type: "image" }> {
  return block.type === "image"
}

function deriveResourceNameFromUri(uri: string): string {
  const fallback = "resource"
  const normalized = uri.trim()
  if (!normalized) return fallback
  const withoutQuery = normalized.split(/[?#]/, 1)[0]
  const candidate = withoutQuery.split(/[\\/]/).pop() ?? ""
  let decoded = ""
  if (candidate) {
    try {
      decoded = decodeURIComponent(candidate)
    } catch {
      decoded = candidate
    }
  }
  return decoded || fallback
}

export function getPromptDraftDisplayText(
  draft: PromptDraft,
  attachedResourcesFallback: string
): string {
  const trimmed = draft.displayText.trim()
  return trimmed || attachedResourcesFallback
}

export function buildUserMessageTextPartsFromDraft(
  draft: PromptDraft,
  attachedResourcesFallback: string
): AdaptedContentPart[] {
  return [
    {
      type: "text",
      text: getPromptDraftDisplayText(draft, attachedResourcesFallback),
    },
  ]
}

export function extractUserResourcesFromDraft(
  draft: PromptDraft
): UserResourceDisplay[] {
  const linked = draft.blocks.filter(isResourceLinkBlock).map((resource) => ({
    name: resource.name,
    uri: resource.uri,
    mime_type: resource.mime_type ?? null,
  }))
  const embedded = draft.blocks
    .filter(isEmbeddedResourceBlock)
    .map((resource) => ({
      name: deriveResourceNameFromUri(resource.uri),
      uri: resource.uri,
      mime_type: resource.mime_type ?? null,
    }))
  return [...linked, ...embedded]
}

function deriveImageName(
  uri: string | null | undefined,
  mimeType: string
): string {
  if (uri && uri.trim().length > 0) {
    const name = deriveResourceNameFromUri(uri)
    if (name !== "resource") return name
  }
  const ext = mimeType.split("/")[1]?.split("+")[0] ?? "image"
  return `image.${ext}`
}

export function extractUserImagesFromDraft(
  draft: PromptDraft
): UserImageDisplay[] {
  return draft.blocks.filter(isImageBlock).map((image) => ({
    name: deriveImageName(image.uri, image.mime_type),
    data: image.data,
    mime_type: image.mime_type,
    uri: image.uri ?? null,
  }))
}
