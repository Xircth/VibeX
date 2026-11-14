import {
  MarkdownBlockCache,
  MAX_CACHED_CHARS,
} from './markdownBlockCache';
import {
  splitFencedCodeSegments,
  stabilizeUnclosedFencedCode,
  type FenceSegment,
} from './markdownFences';
import {
  preprocessForBlockSplit,
  splitIntoBlocks,
  type MarkdownBlockKind,
} from './markdownPreprocess';
import { normalizeLooseTableRowsInText } from './markdownTables';

export type ConversationMarkdownOptions = {
  softBreaks?: boolean;
};

export type PreparedMarkdownBlockPart = {
  hash: string;
  source: string;
  kind: MarkdownBlockKind;
  prepared: string;
};

export type ConversationMarkdownPrepareCache = {
  softBreaks: boolean;
  lru: MarkdownBlockCache<PreparedMarkdownBlockPart>;
  parts: PreparedMarkdownBlockPart[];
};

function trimFilePathCandidate(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+/, '')
    .replace(/['"`.,;]+$/, '')
    .replace(/[)\]}]+$/, '')
    .replace(/:(\d+)(?::\d+)?$/, '');
}

function isMarkdownImagePath(value: string): boolean {
  const candidate = trimFilePathCandidate(value);
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)(?:[?#].*)?$/i.test(candidate);
}

const IMAGE_EXTENSION_HINT_REGEX =
  /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)/i;

function normalizeBareImageReferences(value: string): string {
  if (!IMAGE_EXTENSION_HINT_REGEX.test(value)) {
    return value;
  }

  return value
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (
        !trimmed ||
        trimmed.startsWith('![') ||
        trimmed.startsWith('[') ||
        /\s/.test(trimmed) ||
        !isMarkdownImagePath(trimmed)
      ) {
        return line;
      }

      const label = trimmed.split(/[\\/]/).pop() ?? 'Image';
      return `${line.slice(0, line.indexOf(trimmed))}![${label}](${trimmed})`;
    })
    .join('\n');
}

function isSoftBreakBlockBoundary(line: string): boolean {
  const trimmed = line.trim();
  return (
    !trimmed ||
    /^#{1,6}\s/.test(trimmed) ||
    /^([-*+]|\d+[.)])\s+/.test(trimmed) ||
    /^>/.test(trimmed) ||
    /^[-*_]{3,}$/.test(trimmed) ||
    /^\|.*\|$/.test(trimmed)
  );
}

function applySoftBreaksToText(value: string): string {
  const lines = value.split('\n');
  return lines
    .map((line, index) => {
      if (index === lines.length - 1) return line;

      const nextLine = lines[index + 1] ?? '';
      if (
        isSoftBreakBlockBoundary(line) ||
        isSoftBreakBlockBoundary(nextLine) ||
        /\s{2}$/.test(line) ||
        /\\$/.test(line)
      ) {
        return line;
      }

      return `${line}  `;
    })
    .join('\n');
}

export function applySoftBreaks(value: string): string {
  return splitFencedCodeSegments(value)
    .map((segment) =>
      segment.kind === 'text'
        ? applySoftBreaksToText(segment.text)
        : segment.text
    )
    .join('');
}

function transformTextSegment(
  text: string,
  options: ConversationMarkdownOptions
): string {
  const withImages = normalizeBareImageReferences(text);
  const withTables = normalizeLooseTableRowsInText(withImages);
  return options.softBreaks ? applySoftBreaksToText(withTables) : withTables;
}

function transformSegment(
  segment: FenceSegment,
  options: ConversationMarkdownOptions
): string {
  return segment.kind === 'text'
    ? transformTextSegment(segment.text, options)
    : segment.text;
}

/**
 * Prepare a single already-preprocessed markdown block (fence-safe image
 * normalization, loose-table compaction, optional soft breaks, and open-fence
 * stabilization).
 */
export function prepareSingleMarkdownBlock(
  value: string,
  options: ConversationMarkdownOptions = {}
): string {
  if (!value) return '';
  const segments = splitFencedCodeSegments(value);
  const transformed = segments
    .map((segment) => transformSegment(segment, options))
    .join('');
  return stabilizeUnclosedFencedCode(transformed);
}

export function prepareConversationMarkdownCached(
  value: string,
  options: ConversationMarkdownOptions = {},
  cache: ConversationMarkdownPrepareCache | null = null
): { text: string; cache: ConversationMarkdownPrepareCache } {
  const softBreaks = Boolean(options.softBreaks);
  const lru =
    cache?.softBreaks === softBreaks
      ? cache.lru
      : new MarkdownBlockCache<PreparedMarkdownBlockPart>(MAX_CACHED_CHARS);

  const { body, tagAppendix, mathSpans } = preprocessForBlockSplit(value);
  const blocks = splitIntoBlocks(body, mathSpans, true);

  const parts: PreparedMarkdownBlockPart[] = blocks.map((block) => {
    if (block.closed) {
      const cached = lru.hit(block.hash, block.text);
      if (cached) {
        return cached;
      }
      const created: PreparedMarkdownBlockPart = {
        hash: block.hash,
        source: block.text,
        kind: block.kind,
        prepared: prepareSingleMarkdownBlock(block.text, options),
      };
      lru.set(block.hash, block.text, created);
      return created;
    }

    return {
      hash: block.hash,
      source: block.text,
      kind: block.kind,
      prepared: prepareSingleMarkdownBlock(block.text, options),
    };
  });

  const preparedSections = parts.map((part) => part.prepared);
  if (tagAppendix) {
    preparedSections.push(prepareSingleMarkdownBlock(tagAppendix, options));
  }

  return {
    text: preparedSections.join('\n\n'),
    cache: { softBreaks, lru, parts },
  };
}

export function prepareConversationMarkdown(
  value: string,
  options: ConversationMarkdownOptions = {}
): string {
  return prepareConversationMarkdownCached(value, options).text;
}
