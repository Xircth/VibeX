import { describe, expect, it } from 'vitest';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';
import {
  buildProcessChangeItems,
  findPreviousUserMessageKey,
} from './VirtualizedList';
import { buildProcessChangeFileGroups } from '@/components/NormalizedConversation/ProcessChangeSummaryCard';

describe('findPreviousUserMessageKey', () => {
  it('jumps to the latest user turn above the current viewport anchor', () => {
    expect(
      findPreviousUserMessageKey(
        [
          { patchKey: 'user-1', top: 120 },
          { patchKey: 'user-2', top: 520 },
        ],
        420,
        600
      )
    ).toBe('user-2');
  });

  it('keeps walking back through older user turns after the first jump', () => {
    expect(
      findPreviousUserMessageKey(
        [
          { patchKey: 'user-1', top: 120 },
          { patchKey: 'user-2', top: 520 },
        ],
        280,
        400
      )
    ).toBe('user-1');
  });

  it('falls back to the earliest user turn when already near the top', () => {
    expect(
      findPreviousUserMessageKey([{ patchKey: 'user-1', top: 80 }], 0, 500)
    ).toBe('user-1');
  });
});

describe('buildProcessChangeItems', () => {
  it('keeps file edit changes displayable in the process summary card', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:0',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'Edit',
            action_type: {
              action: 'file_edit',
              path: 'src/App.tsx',
              changes: [
                {
                  action: 'edit',
                  unified_diff: '@@\n-a\n+b',
                  has_line_numbers: true,
                },
                {
                  action: 'write',
                  content: 'export const ok = true;\n',
                },
              ],
            },
            status: { status: 'success' },
          },
          content: '',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:1',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'Read',
            action_type: {
              action: 'file_read',
              path: 'src/App.tsx',
            },
            status: { status: 'success' },
          },
          content: '',
          timestamp: null,
        },
      },
    ];

    expect(buildProcessChangeItems(entries)).toEqual([
      {
        key: 'proc-1:0:0',
        path: 'src/App.tsx',
        change: {
          action: 'edit',
          unified_diff: '@@\n-a\n+b',
          has_line_numbers: true,
        },
      },
      {
        key: 'proc-1:0:1',
        path: 'src/App.tsx',
        change: {
          action: 'write',
          content: 'export const ok = true;\n',
        },
      },
    ]);
  });

  it('groups repeated changes by file for the process summary count', () => {
    expect(
      buildProcessChangeFileGroups([
        {
          key: 'change-1',
          path: 'src/App.tsx',
          change: {
            action: 'edit',
            unified_diff: '@@\n-a\n+b',
            has_line_numbers: true,
          },
        },
        {
          key: 'change-2',
          path: 'src/main.tsx',
          change: {
            action: 'write',
            content: 'console.log(1);\n',
          },
        },
        {
          key: 'change-3',
          path: 'src/App.tsx',
          change: {
            action: 'edit',
            unified_diff: '@@\n-b\n+c',
            has_line_numbers: true,
          },
        },
      ]).map((group) => ({
        path: group.path,
        count: group.items.length,
      }))
    ).toEqual([
      { path: 'src/App.tsx', count: 2 },
      { path: 'src/main.tsx', count: 1 },
    ]);
  });
});
