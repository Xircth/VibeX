import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { LinkNode } from '@lexical/link';
import { ListItemNode, ListNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';

import { CODE_HIGHLIGHT_CLASSES } from './lib/code-highlight-theme';
import { ClickedElementNode } from './nodes/clicked-element-node';
import { DollarCommandNode } from './nodes/dollar-command-node';
import { FileReferenceNode } from './nodes/file-reference-node';
import { ImageNode } from './nodes/image-node';
import { PrCommentNode } from './nodes/pr-comment-node';
import { SlashCommandNode } from './nodes/slash-command-node';
import { TagReferenceNode } from './nodes/tag-reference-node';
import type { WysiwygMarkdownPreset } from '../wysiwyg';

export function getWysiwygInitialConfig(markdownPreset: WysiwygMarkdownPreset) {
  const isSessionInputMinimalPreset =
    markdownPreset === 'session-input-minimal';

  return {
    namespace: 'md-wysiwyg',
    onError: console.error,
    theme: {
      paragraph: isSessionInputMinimalPreset
        ? 'mb-1 last:mb-0 text-[13px] font-normal leading-5 tracking-[0.005em] text-foreground'
        : 'mb-2 last:mb-0',
      heading: {
        h1: isSessionInputMinimalPreset
          ? 'mt-2 mb-1.5 text-[1.05rem] font-semibold leading-7 tracking-[0.01em] text-foreground'
          : 'mt-4 mb-2 text-2xl font-semibold',
        h2: isSessionInputMinimalPreset
          ? 'mt-2 mb-1.5 text-[1rem] font-semibold leading-7 tracking-[0.01em] text-foreground'
          : 'mt-3 mb-2 text-xl font-semibold',
        h3: isSessionInputMinimalPreset
          ? 'mt-2 mb-1 text-[0.95rem] font-semibold leading-7 tracking-[0.01em] text-foreground'
          : 'mt-3 mb-2 text-lg font-semibold',
        h4: isSessionInputMinimalPreset
          ? 'mt-1.5 mb-1 text-sm font-semibold leading-6 tracking-[0.03em] text-muted-foreground uppercase'
          : 'mt-2 mb-1 text-base font-medium',
        h5: isSessionInputMinimalPreset
          ? 'mt-1.5 mb-1 text-xs font-semibold leading-6 tracking-[0.05em] text-muted-foreground uppercase'
          : 'mt-2 mb-1 text-sm font-medium',
        h6: isSessionInputMinimalPreset
          ? 'mt-1.5 mb-1 text-[11px] font-semibold leading-5 tracking-[0.08em] text-muted-foreground uppercase'
          : 'mt-2 mb-1 text-xs font-medium uppercase tracking-wide',
      },
      quote:
        'my-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-muted-foreground',
      list: {
        ul: isSessionInputMinimalPreset
          ? 'my-1 list-disc pl-5 text-[13px] leading-5 tracking-[0.005em]'
          : 'my-1 list-disc list-inside',
        ol: isSessionInputMinimalPreset
          ? 'my-1 list-decimal pl-5 text-[13px] leading-5 tracking-[0.005em]'
          : 'my-1 list-decimal list-inside',
        listitem: '',
        nested: {
          // Hide the structural wrapper marker Lexical adds for nested items.
          listitem: isSessionInputMinimalPreset
            ? 'list-none pl-3'
            : 'list-none pl-4',
        },
      },
      link: 'cursor-pointer text-primary underline underline-offset-2 hover:text-primary/80',
      text: {
        bold: isSessionInputMinimalPreset ? '' : 'font-semibold',
        italic: isSessionInputMinimalPreset ? '' : 'italic',
        underline: isSessionInputMinimalPreset
          ? ''
          : 'underline underline-offset-2',
        strikethrough: isSessionInputMinimalPreset ? '' : 'line-through',
        code: isSessionInputMinimalPreset
          ? ''
          : 'font-mono bg-muted bg-panel px-1 py-0.5 rounded',
      },
      code: 'block font-mono bg-secondary rounded-md px-3 py-2 my-2 whitespace-pre overflow-x-auto',
      codeHighlight: CODE_HIGHLIGHT_CLASSES,
      table: 'border-collapse my-2 w-full text-sm',
      tableRow: '',
      tableCell: 'border border-border px-3 py-2 text-left align-top',
      tableCellHeader:
        'bg-muted font-semibold border border-border px-3 py-2 text-left align-top',
    },
    nodes: [
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
    ],
  };
}
