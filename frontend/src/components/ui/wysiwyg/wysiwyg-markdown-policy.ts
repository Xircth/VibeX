import { TRANSFORMERS, CODE, HEADING } from '@lexical/markdown';
import type { Transformer } from '@lexical/markdown';

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
import type { WysiwygMarkdownPreset } from '../wysiwyg';

const FULL_MARKDOWN_TRANSFORMERS: Transformer[] = [
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
  ...TRANSFORMERS,
];

const SESSION_INPUT_MINIMAL_TRANSFORMERS: Transformer[] = [
  IMAGE_TRANSFORMER,
  TAG_REFERENCE_TRANSFORMER,
  SLASH_COMMAND_DISPLAY_TRANSFORMER,
  DOLLAR_COMMAND_TRANSFORMER,
  FILE_REFERENCE_TRANSFORMER,
  CLICKED_ELEMENT_TRANSFORMER,
];

export function getWysiwygMarkdownTransformers(
  preset: WysiwygMarkdownPreset
): Transformer[] {
  return preset === 'session-input-minimal'
    ? SESSION_INPUT_MINIMAL_TRANSFORMERS
    : FULL_MARKDOWN_TRANSFORMERS;
}

export function getWysiwygMarkdownShortcutTransformers(
  preset: WysiwygMarkdownPreset
): Transformer[] {
  if (preset === 'session-input-minimal') return [];

  return getWysiwygMarkdownTransformers(preset).filter(
    (transformer) => transformer !== HEADING
  );
}
