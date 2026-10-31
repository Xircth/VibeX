import { resolveMarkdownWorkspacePathTarget } from '@/components/NormalizedConversation/MarkdownResourceLink';
import {
  deriveRelativeFilePath,
  normalizeFilePath,
} from '@/utils/filePaths';

export type MessageHtmlPreviewSegment = {
  kind: 'html';
  code?: string;
  filePath: string;
  displayPath: string;
  title: string;
  isStreaming?: boolean;
};

export type MessageMarkdownSegment = {
  kind: 'markdown';
  text: string;
};

export type MessageContentSegment =
  | MessageMarkdownSegment
  | MessageHtmlPreviewSegment;

const MAX_LINKED_HTML_PREVIEWS_PER_MESSAGE = 4;

function isHtmlLanguage(lang: string): boolean {
  const normalized = lang.trim().toLowerCase();
  return normalized === 'html' || normalized === 'htm';
}

function isLocalHtmlFilePath(filePath: string): boolean {
  return /\.(?:html|htm)$/i.test(filePath.trim());
}

function shortContentHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 8).padStart(6, '0');
}

function extractHtmlTitle(code: string): string | null {
  const titleMatch = code.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const cleaned = titleMatch[1].replace(/\s+/g, ' ').trim();
    if (cleaned) return cleaned;
  }
  const h1Match = code.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match?.[1]) {
    const cleaned = h1Match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned;
  }
  return null;
}

function sanitizeFileSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return slug || 'html-preview';
}

export function buildGeneratedHtmlPreviewPath(
  code: string,
  workspacePath?: string | null,
  explicitHint?: string | null
): { filePath: string; displayPath: string; title: string } {
  const trimmedHint = explicitHint?.trim() ?? '';
  if (trimmedHint && isLocalHtmlFilePath(trimmedHint)) {
    const resolved = resolveMarkdownWorkspacePathTarget(
      trimmedHint,
      trimmedHint,
      workspacePath
    );
    if (resolved && resolved.nodeType === 'file') {
      const fileName =
        resolved.displayPath.split(/[\\/]/).pop() ?? resolved.displayPath;
      return {
        filePath: resolved.path,
        displayPath: resolved.displayPath,
        title: fileName,
      };
    }
  }

  const extractedTitle = extractHtmlTitle(code);
  const slug = sanitizeFileSlug(extractedTitle ?? 'preview');
  const hash = shortContentHash(code);
  const fileName = `${slug}-${hash}.html`;
  const relativePath = `.vibe-images/html-previews/${fileName}`;
  const baseRoot = workspacePath ? normalizeFilePath(workspacePath) : '';
  const filePath = baseRoot
    ? `${baseRoot.replace(/\/+$/, '')}/${relativePath}`
    : relativePath;

  return {
    filePath,
    displayPath: relativePath,
    title: extractedTitle ? `${extractedTitle} (${fileName})` : fileName,
  };
}

type RawFenceSplitItem =
  | { kind: 'text'; text: string }
  | {
      kind: 'html-fence';
      code: string;
      meta: string;
      unclosed: boolean;
    };

function splitFencedHtmlFromText(value: string): RawFenceSplitItem[] {
  const lines = value.match(/[^\n]*(?:\n|$)/g) ?? [];
  const items: RawFenceSplitItem[] = [];
  let textBuffer = '';
  let inFence = false;
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;
  let fenceIsHtml = false;
  let fenceMeta = '';
  let fenceBuffer = '';

  const flushText = () => {
    if (!textBuffer) return;
    items.push({ kind: 'text', text: textBuffer });
    textBuffer = '';
  };

  for (const line of lines) {
    if (!line) continue;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})([^\n\r]*)/);

    if (!inFence && fenceMatch) {
      const rawInfo = (fenceMatch[2] ?? '').trim();
      const [langToken = '', ...restTokens] = rawInfo.split(/\s+/);
      if (isHtmlLanguage(langToken)) {
        flushText();
        inFence = true;
        fenceChar = fenceMatch[1][0] as '`' | '~';
        fenceLength = fenceMatch[1].length;
        fenceIsHtml = true;
        fenceMeta = restTokens.join(' ').trim();
        fenceBuffer = '';
        continue;
      }

      inFence = true;
      fenceChar = fenceMatch[1][0] as '`' | '~';
      fenceLength = fenceMatch[1].length;
      fenceIsHtml = false;
      textBuffer += line;
      continue;
    }

    if (inFence) {
      const closeMatch = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (
        closeMatch &&
        fenceChar &&
        closeMatch[1][0] === fenceChar &&
        closeMatch[1].length >= fenceLength
      ) {
        if (fenceIsHtml) {
          items.push({
            kind: 'html-fence',
            code: fenceBuffer.replace(/\n$/, ''),
            meta: fenceMeta,
            unclosed: false,
          });
          fenceBuffer = '';
          fenceMeta = '';
        } else {
          textBuffer += line;
        }
        inFence = false;
        fenceChar = null;
        fenceLength = 0;
        fenceIsHtml = false;
        continue;
      }

      if (fenceIsHtml) {
        fenceBuffer += line;
      } else {
        textBuffer += line;
      }
      continue;
    }

    textBuffer += line;
  }

  if (inFence && fenceIsHtml) {
    items.push({
      kind: 'html-fence',
      code: fenceBuffer.replace(/\n$/, ''),
      meta: fenceMeta,
      unclosed: true,
    });
  } else {
    flushText();
  }

  return items;
}

const MARKDOWN_LINK_RE = /(?<!!)\[([^\]\n]+)\]\(([^)\n]*)\)/g;

function extractLocalHtmlLinkPreviews(
  markdownChunk: string,
  workspacePath: string | null | undefined,
  seenPaths: Set<string>
): MessageContentSegment[] {
  const paragraphs = markdownChunk.split(/\n{2,}/);
  const result: MessageContentSegment[] = [];
  let textAccumulator: string[] = [];

  const flushTextAccumulator = () => {
    const joined = textAccumulator.join('\n\n').trim();
    if (joined) {
      result.push({ kind: 'markdown', text: joined });
    }
    textAccumulator = [];
  };

  for (const paragraph of paragraphs) {
    const discoveredInParagraph: MessageHtmlPreviewSegment[] = [];
    MARKDOWN_LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = MARKDOWN_LINK_RE.exec(paragraph)) !== null) {
      if (seenPaths.size >= MAX_LINKED_HTML_PREVIEWS_PER_MESSAGE) break;
      const label = match[1]?.trim() ?? '';
      const rawHref = (match[2]?.trim() ?? '').replace(/^<([\s\S]*)>$/, '$1');
      const target = resolveMarkdownWorkspacePathTarget(
        rawHref || undefined,
        label,
        workspacePath
      );
      if (
        !target ||
        target.nodeType !== 'file' ||
        !isLocalHtmlFilePath(target.path)
      ) {
        continue;
      }
      const normalizedKey = normalizeFilePath(target.path).toLowerCase();
      if (seenPaths.has(normalizedKey)) continue;
      seenPaths.add(normalizedKey);

      const displayPath =
        deriveRelativeFilePath(target.path, workspacePath) ??
        target.displayPath;
      const fileName = displayPath.split(/[\\/]/).pop() ?? displayPath;
      discoveredInParagraph.push({
        kind: 'html',
        filePath: target.path,
        displayPath,
        title: fileName,
      });
    }

    if (discoveredInParagraph.length === 0) {
      textAccumulator.push(paragraph);
      continue;
    }

    const standaloneLinkOnly =
      paragraph.trim().replace(MARKDOWN_LINK_RE, '').trim().length === 0;
    if (!standaloneLinkOnly) {
      textAccumulator.push(paragraph);
    }
    flushTextAccumulator();
    result.push(...discoveredInParagraph);
  }

  flushTextAccumulator();
  return result;
}

/**
 * Splits a message's markdown into alternating prose segments and standalone
 * HTML preview blocks so HTML previews render as dedicated full-width message
 * blocks ("first half bubble + HTML preview block + second half bubble")
 * rather than inline inside a prose bubble.
 */
export function splitMessageHtmlSegments(
  value: string,
  options: {
    workspacePath?: string | null;
    isStreaming?: boolean;
  } = {}
): MessageContentSegment[] {
  if (!value.trim()) return [];

  const rawItems = splitFencedHtmlFromText(value);
  const seenLinkedPaths = new Set<string>();
  const segments: MessageContentSegment[] = [];

  for (const item of rawItems) {
    if (item.kind === 'html-fence') {
      const pathInfo = buildGeneratedHtmlPreviewPath(
        item.code,
        options.workspacePath,
        item.meta
      );
      segments.push({
        kind: 'html',
        code: item.code,
        filePath: pathInfo.filePath,
        displayPath: pathInfo.displayPath,
        title: pathInfo.title,
        isStreaming: Boolean(options.isStreaming && item.unclosed),
      });
      continue;
    }

    const extracted = extractLocalHtmlLinkPreviews(
      item.text,
      options.workspacePath,
      seenLinkedPaths
    );
    for (const seg of extracted) {
      const previous = segments.at(-1);
      if (seg.kind === 'markdown' && previous?.kind === 'markdown') {
        previous.text = `${previous.text}\n\n${seg.text}`;
      } else {
        segments.push(seg);
      }
    }
  }

  return segments;
}
