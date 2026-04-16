import { describe, expect, it } from 'vitest';
import {
  buildDisplayEntries,
  getCompactMetaNoticeText,
  normalizeMetaNoticeText,
  shouldHideInitializationNotice,
} from './conversation-entry-utils';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';

describe('conversation meta notices', () => {
  it('hides hook initialization config entries', () => {
    const shouldHide = shouldHideInitializationNotice(
      { type: 'system_message' } as never,
      'model: gpt-5.2\nreasoning effort: high'
    );

    expect(shouldHide).toBe(true);
  });

  it('does not hide normal assistant replies', () => {
    const shouldHide = shouldHideInitializationNotice(
      { type: 'assistant_message' } as never,
      'I updated the component and added tests.'
    );

    expect(shouldHide).toBe(false);
  });

  it('compacts model resume notices into one line', () => {
    const compactText = getCompactMetaNoticeText(
      { type: 'assistant_message' } as never,
      'This session was recorded with model `gpt-5.4` but is resuming with `gpt-5.2`.\nConsider switching back to `gpt-5.4` as it may affect Codex performance.'
    );

    expect(compactText).toBe(
      'This session was recorded with model gpt-5.4 but is resuming with gpt-5.2. Consider switching back to gpt-5.4 as it may affect Codex performance.'
    );
  });

  it('keeps rich formatted system content out of compact mode', () => {
    const compactText = getCompactMetaNoticeText(
      { type: 'system_message' } as never,
      '## Setup required\n- Install dependencies\n- Retry the task'
    );

    expect(compactText).toBeNull();
  });

  it('normalizes inline markdown markers in notices', () => {
    expect(
      normalizeMetaNoticeText('Recorded with `gpt-5.4` and **high** effort')
    ).toBe('Recorded with gpt-5.4 and high effort');
  });

  it('aggregates consecutive command tool calls from the same tool', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'bash',
            action_type: {
              action: 'command_run',
              command: 'pwd',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'pwd',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'bash',
            action_type: {
              action: 'command_run',
              command: 'ls',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'ls',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]).toMatchObject({
      type: 'AGGREGATED_GROUP',
      aggregationType: 'command_run',
    });
  });

  it('keeps command tool calls separate when tool names differ', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'bash',
            action_type: {
              action: 'command_run',
              command: 'pwd',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'pwd',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'Setup Script',
            action_type: {
              action: 'command_run',
              command: 'pnpm install',
              result: null,
            },
            status: { status: 'success' },
          },
          content: 'pnpm install',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(2);
    expect(displayEntries[0]?.type).toBe('NORMALIZED_ENTRY');
    expect(displayEntries[1]?.type).toBe('NORMALIZED_ENTRY');
  });

  it('aggregates completed file edits into a process change summary group', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'edit',
            action_type: {
              action: 'file_edit',
              path: 'src/App.tsx',
              changes: [
                {
                  action: 'edit',
                  unified_diff: '@@\\n-a\\n+b',
                  has_line_numbers: true,
                },
              ],
            },
            status: { status: 'success' },
          },
          content: 'src/App.tsx',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'edit',
            action_type: {
              action: 'file_edit',
              path: 'src/main.tsx',
              changes: [{ action: 'write', content: 'console.log(1);' }],
            },
            status: { status: 'success' },
          },
          content: 'src/main.tsx',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries);

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]).toMatchObject({
      type: 'AGGREGATED_DIFF_GROUP',
      executionProcessId: 'proc-1',
    });
  });

  it('aggregates consecutive thinking entries when thinking grouping is enabled', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'thinking' },
          content: 'first thought',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'thinking' },
          content: 'second thought',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries, {
      aggregateThinking: true,
    });

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]).toMatchObject({
      type: 'AGGREGATED_THINKING_GROUP',
      executionProcessId: 'proc-1',
    });
  });
});
