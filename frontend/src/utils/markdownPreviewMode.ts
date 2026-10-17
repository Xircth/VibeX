export const MARKDOWN_PREVIEW_MODES = [
  'preview',
  'source',
  'richtext',
] as const;

export type MarkdownPreviewMode = (typeof MARKDOWN_PREVIEW_MODES)[number];

export const DEFAULT_MARKDOWN_PREVIEW_MODE: MarkdownPreviewMode = 'richtext';

export function parseMarkdownPreviewMode(value: unknown): MarkdownPreviewMode {
  return MARKDOWN_PREVIEW_MODES.includes(value as MarkdownPreviewMode)
    ? (value as MarkdownPreviewMode)
    : DEFAULT_MARKDOWN_PREVIEW_MODE;
}

export function nextMarkdownPreviewMode(
  current: MarkdownPreviewMode
): MarkdownPreviewMode {
  const index = MARKDOWN_PREVIEW_MODES.indexOf(current);
  return MARKDOWN_PREVIEW_MODES[(index + 1) % MARKDOWN_PREVIEW_MODES.length];
}
