import type { ContentBlock } from 'shared/types';
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
