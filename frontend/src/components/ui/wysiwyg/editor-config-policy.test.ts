import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { describe, expect, it } from 'vitest';

import { CODE_HIGHLIGHT_CLASSES } from './lib/code-highlight-theme';
import { ClickedElementNode } from './nodes/clicked-element-node';
import { DollarCommandNode } from './nodes/dollar-command-node';
import { FileReferenceNode } from './nodes/file-reference-node';
import { ImageNode } from './nodes/image-node';
import { PrCommentNode } from './nodes/pr-comment-node';
import { SlashCommandNode } from './nodes/slash-command-node';
import { TagReferenceNode } from './nodes/tag-reference-node';
import { getWysiwygInitialConfig } from './editor-config-policy';

describe('WYSIWYG editor config policy', () => {
  it('keeps the default editor identity, error handler, theme, and node order', () => {
    const config = getWysiwygInitialConfig('default');

    expect(config.namespace).toBe('md-wysiwyg');
    expect(config.onError).toBe(console.error);
    expect(config.theme.paragraph).toBe('mb-2 last:mb-0');
    expect(config.theme.text).toMatchObject({
      bold: 'font-semibold',
      italic: 'italic',
      underline: 'underline underline-offset-2',
      strikethrough: 'line-through',
      code: 'font-mono bg-muted bg-panel px-1 py-0.5 rounded',
    });
    expect(config.theme.list).toMatchObject({
      ul: 'my-1 list-disc list-inside',
      ol: 'my-1 list-decimal list-inside',
      listitem: '',
      nested: {
        listitem: 'list-none pl-4',
      },
    });
    expect(config.theme.codeHighlight).toBe(CODE_HIGHLIGHT_CLASSES);
    expect(config.nodes).toEqual([
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      CodeNode,
      CodeHighlightNode,
      LinkNode,
      ImageNode,
      PrCommentNode,
      TagReferenceNode,
      SlashCommandNode,
      DollarCommandNode,
      FileReferenceNode,
      ClickedElementNode,
      TableNode,
      TableRowNode,
      TableCellNode,
    ]);
  });

  it('keeps the session input minimal theme compact and low-formatting', () => {
    const config = getWysiwygInitialConfig('session-input-minimal');

    expect(config.theme.paragraph).toBe(
      'mb-1 last:mb-0 text-[13px] font-normal leading-5 tracking-[0.005em] text-foreground'
    );
    expect(config.theme.heading).toMatchObject({
      h1: 'mt-2 mb-1.5 text-[1.05rem] font-semibold leading-7 tracking-[0.01em] text-foreground',
      h4: 'mt-1.5 mb-1 text-sm font-semibold leading-6 tracking-[0.03em] text-muted-foreground uppercase',
      h6: 'mt-1.5 mb-1 text-[11px] font-semibold leading-5 tracking-[0.08em] text-muted-foreground uppercase',
    });
    expect(config.theme.list).toMatchObject({
      ul: 'my-1 list-disc pl-5 text-[13px] leading-5 tracking-[0.005em]',
      ol: 'my-1 list-decimal pl-5 text-[13px] leading-5 tracking-[0.005em]',
      nested: {
        listitem: 'list-none pl-3',
      },
    });
    expect(config.theme.text).toMatchObject({
      bold: '',
      italic: '',
      underline: '',
      strikethrough: '',
      code: '',
    });
  });
});
