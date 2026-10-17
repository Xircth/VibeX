import { describe, expect, it } from 'vitest';
import {
  editorStateJSONToMarkdown,
  markdownToEditorStateJSON,
} from '@astryxdesign/richtext';

describe('Astryx richtext markdown roundtrip', () => {
  it('converts a heading back to markdown', () => {
    const json = markdownToEditorStateJSON('# Title\n\nHello');
    const markdown = editorStateJSONToMarkdown(json);
    expect(markdown).toContain('Title');
    expect(markdown).toContain('Hello');
  });
});
