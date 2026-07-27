import type { ActionType, NormalizedEntry, ToolStatus } from 'shared/types';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';

const BASE_TIMESTAMP = '2026-06-13T08:00:00.000Z';

function entry(
  key: string,
  processId: string,
  content: NormalizedEntry
): PatchTypeWithKey {
  return {
    type: 'NORMALIZED_ENTRY',
    patchKey: `long-conversation:${key}`,
    executionProcessId: processId,
    content,
  };
}

function normalized(
  entryType: NormalizedEntry['entry_type'],
  content: string,
  timestamp = BASE_TIMESTAMP
): NormalizedEntry {
  return {
    entry_type: entryType,
    content,
    timestamp,
  };
}

function toolEntry({
  key,
  processId,
  toolName,
  actionType,
  status = { status: 'success' },
  content,
}: {
  key: string;
  processId: string;
  toolName: string;
  actionType: ActionType;
  status?: ToolStatus;
  content: string;
}): PatchTypeWithKey {
  return entry(
    key,
    processId,
    normalized(
      {
        type: 'tool_use',
        tool_name: toolName,
        action_type: actionType,
        status,
      },
      content
    )
  );
}

export const mixedRenderingConversationFixture: PatchTypeWithKey[] = [
  entry(
    'user-cjk-image',
    'fixture-turn-1',
    normalized(
      { type: 'user_message' },
      [
        '请审查这个界面截图，并保留中文、日本語、한국어 mixed text 的自然换行。',
        '',
        '![dashboard preview](.vibe-images/t2-dashboard-preview.png)',
        '',
        'Open [@:App.tsx](src/App.tsx) and run [/:test](pnpm test).',
      ].join('\n')
    )
  ),
  entry(
    'assistant-markdown-rich',
    'fixture-turn-1',
    normalized(
      { type: 'assistant_message' },
      [
        '下面是一个覆盖 Markdown、CJK、数学、Mermaid 和代码块的响应。',
        '',
        '软换行应该保留语义，长段中文需要自然换行：这是一个用于验证 CJK 排版的长句，包含 punctuation, inline `code`, 以及全角标点。',
        '',
        'Inline math: $E = mc^2$',
        '',
        '$$',
        '\\int_0^1 x^2 dx = \\frac{1}{3}',
        '$$',
        '',
        '```mermaid',
        'flowchart TD',
        '  A[User prompt] --> B{Tool needed?}',
        '  B -->|yes| C[Tool card]',
        '  B -->|no| D[Markdown answer]',
        '```',
        '',
        '```tsx',
        'export function StatusBadge({ state }: { state: string }) {',
        '  return <span data-state={state}>{state}</span>;',
        '}',
        '```',
      ].join('\n')
    )
  ),
  entry(
    'thinking-stream',
    'fixture-turn-1',
    normalized(
      { type: 'thinking' },
      'I should verify rendering surfaces one by one, then keep the previous successful visual state while streaming continues.'
    )
  ),
  toolEntry({
    key: 'command-running',
    processId: 'fixture-turn-1',
    toolName: 'shell',
    actionType: {
      action: 'command_run',
      category: 'other',
      command: 'pnpm run frontend:check',
      result: null,
    },
    status: { status: 'created' },
    content: 'pnpm run frontend:check',
  }),
  toolEntry({
    key: 'command-success',
    processId: 'fixture-turn-1',
    toolName: 'shell',
    actionType: {
      action: 'command_run',
      category: 'other',
      command: 'pnpm exec vitest run src/components/NormalizedConversation',
      result: {
        exit_status: { type: 'exit_code', code: 0 },
        output: '42 tests passed',
      },
    },
    content: '42 tests passed',
  }),
  toolEntry({
    key: 'file-read',
    processId: 'fixture-turn-1',
    toolName: 'Read',
    actionType: {
      action: 'file_read',
      path: 'src/components/NormalizedConversation/Markdown.tsx',
    },
    content: 'Read Markdown.tsx',
  }),
  toolEntry({
    key: 'search',
    processId: 'fixture-turn-1',
    toolName: 'Search',
    actionType: {
      action: 'search',
      query: 'ToolCallCard',
    },
    content: 'Search results for ToolCallCard',
  }),
  toolEntry({
    key: 'web-fetch',
    processId: 'fixture-turn-1',
    toolName: 'fetch',
    actionType: {
      action: 'web_fetch',
      url: 'https://example.com/docs/rendering',
    },
    content: 'Fetched rendering docs',
  }),
  toolEntry({
    key: 'inline-diff',
    processId: 'fixture-turn-1',
    toolName: 'edit',
    actionType: {
      action: 'file_edit',
      path: 'src/App.tsx',
      changes: [
        {
          action: 'edit',
          unified_diff: [
            'diff --git a/src/App.tsx b/src/App.tsx',
            '--- a/src/App.tsx',
            '+++ b/src/App.tsx',
            '@@ -1,3 +1,4 @@',
            ' import React from "react";',
            '+import { StatusBadge } from "./StatusBadge";',
            ' export function App() {',
            '-  return <main />;',
            '+  return <main><StatusBadge state="ready" /></main>;',
            ' }',
          ].join('\n'),
          has_line_numbers: true,
        },
      ],
    },
    content: 'Updated src/App.tsx',
  }),
  toolEntry({
    key: 'plan-card',
    processId: 'fixture-turn-1',
    toolName: 'plan',
    actionType: {
      action: 'plan_presentation',
      plan: [
        '1. [completed | high] Baseline fixed',
        '2. [in_progress | high] Conversation rendering',
        '3. [pending | medium] Browser smoke',
      ].join('\n'),
    },
    content: 'Plan updated',
  }),
  toolEntry({
    key: 'generic-json',
    processId: 'fixture-turn-1',
    toolName: 'generate_image',
    actionType: {
      action: 'tool',
      tool_name: 'generate_image',
      arguments: {
        prompt: 'compact dashboard preview',
        size: '1024x768',
      },
      result: {
        type: { type: 'json' },
        value: {
          status: 'ready',
          image: '.vibe-images/generated-dashboard.png',
          revised_prompt: 'A compact dashboard preview with readable UI',
        },
      },
    },
    content: 'Generated image metadata',
  }),
  entry(
    'assistant-summary',
    'fixture-turn-1',
    normalized(
      { type: 'assistant_message' },
      '完成混合渲染检查：工具卡、diff、图片、Thinking、数学和 Mermaid 都在同一长会话 fixture 中。'
    )
  ),
];

function createFillerEntry(index: number): PatchTypeWithKey {
  const isUserMessage = index % 2 === 0;
  const turnIndex = Math.floor(index / 2);
  const processId = `long-conversation-turn:${turnIndex}`;

  return entry(
    `filler:${index}`,
    processId,
    normalized(
      { type: isUserMessage ? 'user_message' : 'assistant_message' },
      isUserMessage
        ? `Inspect item ${turnIndex} with CJK marker 中文-${turnIndex}`
        : [
            `Result ${turnIndex}`,
            '',
            `- changed files: ${turnIndex % 7}`,
            `- status: ${turnIndex % 5 === 0 ? 'streaming' : 'ready'}`,
            '- note: filler rows preserve long-list pressure after rich fixtures',
          ].join('\n')
    )
  );
}

export function createLongConversationFixture(
  messageCount = 1000
): PatchTypeWithKey[] {
  if (messageCount <= mixedRenderingConversationFixture.length) {
    return mixedRenderingConversationFixture.slice(0, messageCount);
  }

  const fillerCount = messageCount - mixedRenderingConversationFixture.length;
  const filler = Array.from({ length: fillerCount }, (_, index) =>
    createFillerEntry(index)
  );

  return [...mixedRenderingConversationFixture, ...filler];
}
