import type { ContentBlock } from 'shared/types';
import { isBrowserDisplayUrl } from '@/lib/hostAsset';
import { joinLocalPath } from '@/utils/displayPath';
import {
  attachmentPreviewKind,
  type AttachmentPreviewKind,
} from '@/utils/mediaAttachments';

const VIBE_IMAGE_MARKDOWN_PATTERN =
  /!\[([^\]]*)\]\((\.vibe-images\/[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export type UserMessageImage = {
  id: string;
  path: string;
  altText: string;
  sourceUrl?: string | null;
  kind: AttachmentPreviewKind;
};

export function isAbsoluteLocalPath(path: string): boolean {
  const value = path.trim();
  if (!value) return false;
  if (value.startsWith('/') || value.startsWith('\\\\')) return true;
  return /^[a-zA-Z]:[\\/]/.test(value);
}

export function vibeImageFileName(imagePath: string): string | undefined {
  const normalized = imagePath.replaceAll('\\', '/').trim();
  if (!normalized.startsWith('.vibe-images/')) return undefined;
  const fileName = normalized.slice('.vibe-images/'.length);
  return fileName || undefined;
}

export function resolveWorkspaceVibeImagePath(
  workspacePath: string | null | undefined,
  imagePath: string
): string | undefined {
  const fileName = vibeImageFileName(imagePath);
  if (!fileName || !workspacePath?.trim()) return undefined;
  return joinLocalPath(joinLocalPath(workspacePath, '.vibe-images'), fileName);
}

export function resolveUserMessageImageFilesystemPath({
  imagePath,
  metadataPath,
  metadataProxyUrl,
  workspacePath,
}: {
  imagePath: string;
  metadataPath?: string | null;
  metadataProxyUrl?: string | null;
  workspacePath?: string | null;
}): string | undefined {
  // The workspace copy is inside the host file sandbox. The image cache
  // directory is not, so metadata's cache path must not win or thumbnails 404.
  const workspaceCopy = resolveWorkspaceVibeImagePath(workspacePath, imagePath);
  if (workspaceCopy) return workspaceCopy;

  for (const candidate of [metadataPath, metadataProxyUrl, imagePath]) {
    if (!candidate) continue;
    if (candidate.startsWith('data:') || isBrowserDisplayUrl(candidate)) {
      continue;
    }
    if (isAbsoluteLocalPath(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function userMessageImageFilesystemCandidates({
  imagePath,
  metadataPath,
  metadataProxyUrl,
  workspacePath,
}: {
  imagePath: string;
  metadataPath?: string | null;
  metadataProxyUrl?: string | null;
  workspacePath?: string | null;
}): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const push = (value: string | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    paths.push(value);
  };

  push(resolveWorkspaceVibeImagePath(workspacePath, imagePath));
  for (const candidate of [metadataPath, metadataProxyUrl, imagePath]) {
    if (!candidate) continue;
    if (candidate.startsWith('data:') || isBrowserDisplayUrl(candidate)) {
      continue;
    }
    if (isAbsoluteLocalPath(candidate)) {
      push(candidate);
    }
  }
  return paths;
}

export async function loadUserMessageImageSrc(
  paths: string[],
  load: (path: string) => Promise<string>
): Promise<{ path: string; url: string } | null> {
  for (const path of paths) {
    try {
      return { path, url: await load(path) };
    } catch (error) {
      console.warn('Failed to load user message image:', error);
    }
  }
  return null;
}

function fileNameFromPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name || path;
}

function partitionAttachments(attachments: UserMessageImage[]): {
  images: UserMessageImage[];
  files: UserMessageImage[];
} {
  return {
    images: attachments.filter((item) => item.kind !== 'file'),
    files: attachments.filter((item) => item.kind === 'file'),
  };
}

export function splitDisplayContentImages(content: string): {
  text: string;
  images: UserMessageImage[];
  files: UserMessageImage[];
} {
  const attachments: UserMessageImage[] = [];
  const text = content
    .replace(VIBE_IMAGE_MARKDOWN_PATTERN, (_match, altText, imagePath) => {
      const path = String(imagePath ?? '').trim();
      if (!path) return '';

      attachments.push({
        id: `${path}:${attachments.length}`,
        path,
        altText: String(altText ?? '').trim() || 'Image',
        kind: attachmentPreviewKind(path),
      });

      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, ...partitionAttachments(attachments) };
}

export function splitUserTurnContent(blocks: ContentBlock[]): {
  text: string;
  images: UserMessageImage[];
  files: UserMessageImage[];
} {
  const imageBlocks: UserMessageImage[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.trim().length > 0) {
        textParts.push(block.text);
      }
      continue;
    }

    if (block.type !== 'image') continue;

    const path = block.uri?.trim() ?? '';
    const sourceUrl = block.data
      ? `data:${block.mime_type};base64,${block.data}`
      : null;
    if (!path && !sourceUrl) continue;

    imageBlocks.push({
      id: `${path || 'inline'}:${imageBlocks.length}`,
      path,
      altText: path ? fileNameFromPath(path) : 'Image',
      kind: attachmentPreviewKind(
        path || fileNameFromPath(path),
        block.mime_type
      ),
      ...(sourceUrl ? { sourceUrl } : {}),
    });
  }

  const fromMarkdown = splitDisplayContentImages(textParts.join('\n\n'));
  const seenPaths = new Set(
    imageBlocks.map((image) => image.path).filter(Boolean)
  );
  const markdownAttachments = [
    ...fromMarkdown.images,
    ...fromMarkdown.files,
  ].filter((image) => !seenPaths.has(image.path));

  return {
    text: fromMarkdown.text,
    ...partitionAttachments([...imageBlocks, ...markdownAttachments]),
  };
}
