import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MARKDOWN_PREVIEW_MODE,
  nextMarkdownPreviewMode,
  parseMarkdownPreviewMode,
} from './markdownPreviewMode';

describe('markdownPreviewMode', () => {
  it('parses known modes and falls back to preview', () => {
    expect(parseMarkdownPreviewMode('source')).toBe('source');
    expect(parseMarkdownPreviewMode('richtext')).toBe('richtext');
    expect(parseMarkdownPreviewMode('preview')).toBe('preview');
    expect(parseMarkdownPreviewMode('nope')).toBe(
      DEFAULT_MARKDOWN_PREVIEW_MODE
    );
    expect(parseMarkdownPreviewMode(undefined)).toBe(
      DEFAULT_MARKDOWN_PREVIEW_MODE
    );
  });

  it('cycles preview, source, then rich text', () => {
    expect(nextMarkdownPreviewMode('preview')).toBe('source');
    expect(nextMarkdownPreviewMode('source')).toBe('richtext');
    expect(nextMarkdownPreviewMode('richtext')).toBe('preview');
  });
});
