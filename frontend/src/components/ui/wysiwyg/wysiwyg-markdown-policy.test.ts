import { TRANSFORMERS, CODE, HEADING } from '@lexical/markdown';
import { describe, expect, it } from 'vitest';

import { IMAGE_TRANSFORMER } from './nodes/image-node';
import {
  PR_COMMENT_EXPORT_TRANSFORMER,
  PR_COMMENT_TRANSFORMER,
} from './nodes/pr-comment-node';
import { TABLE_TRANSFORMER } from './transformers/table-transformer';
import { TAG_REFERENCE_TRANSFORMER } from './nodes/tag-reference-node';
import { SLASH_COMMAND_DISPLAY_TRANSFORMER } from './nodes/slash-command-node';
import { DOLLAR_COMMAND_TRANSFORMER } from './nodes/dollar-command-node';
import { FILE_REFERENCE_TRANSFORMER } from './nodes/file-reference-node';
import { CLICKED_ELEMENT_TRANSFORMER } from './nodes/clicked-element-node';
import {
  getWysiwygMarkdownShortcutTransformers,
  getWysiwygMarkdownTransformers,
} from './wysiwyg-markdown-policy';

describe('WYSIWYG markdown policy', () => {
  it('keeps the default transformer order including rich markdown support', () => {
    const transformers = getWysiwygMarkdownTransformers('default');

    expect(transformers.slice(0, 10)).toEqual([
      TABLE_TRANSFORMER,
      IMAGE_TRANSFORMER,
      PR_COMMENT_EXPORT_TRANSFORMER,
      PR_COMMENT_TRANSFORMER,
      TAG_REFERENCE_TRANSFORMER,
      SLASH_COMMAND_DISPLAY_TRANSFORMER,
      DOLLAR_COMMAND_TRANSFORMER,
      FILE_REFERENCE_TRANSFORMER,
      CLICKED_ELEMENT_TRANSFORMER,
      CODE,
    ]);
    expect(transformers.slice(10)).toEqual(TRANSFORMERS);
  });

  it('keeps default markdown shortcuts except heading shortcuts', () => {
    const activeTransformers = getWysiwygMarkdownTransformers('default');
    const shortcutTransformers =
      getWysiwygMarkdownShortcutTransformers('default');

    expect(shortcutTransformers).toEqual(
      activeTransformers.filter((transformer) => transformer !== HEADING)
    );
    expect(shortcutTransformers).not.toContain(HEADING);
  });

  it('limits session input transformers to structured chips and images', () => {
    expect(getWysiwygMarkdownTransformers('session-input-minimal')).toEqual([
      IMAGE_TRANSFORMER,
      TAG_REFERENCE_TRANSFORMER,
      SLASH_COMMAND_DISPLAY_TRANSFORMER,
      DOLLAR_COMMAND_TRANSFORMER,
      FILE_REFERENCE_TRANSFORMER,
      CLICKED_ELEMENT_TRANSFORMER,
    ]);
  });

  it('disables markdown shortcuts for session input minimal preset', () => {
    expect(
      getWysiwygMarkdownShortcutTransformers('session-input-minimal')
    ).toEqual([]);
  });
});
