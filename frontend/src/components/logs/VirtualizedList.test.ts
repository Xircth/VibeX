import { describe, expect, it } from 'vitest';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory/types';
import {
  buildProcessChangeItems,
  collapsedAssistantMessagesLabel,
  findPreviousUserMessageVirtualIndex,
  findViewportAnchorVirtualIndex,
  getDistanceFromConversationBottom,
  getUserMessageDisplayIndexes,
  getVirtualRowTranslateY,
  isConversationNearBottom,
  pendingAgentPermissionsFromEvents,
} from './VirtualizedList';
import { buildProcessChangeFileGroups } from '@/components/NormalizedConversation/ProcessChangeSummaryCard';
import { buildDisplayEntries } from '@/components/NormalizedConversation/conversation-entry-utils';
import { createLongConversationFixture } from '@/components/NormalizedConversation/__fixtures__/longConversation';

describe('virtualized user-message navigation', () => {
  it('finds the visible virtual item nearest the viewport anchor', () => {
    expect(
      findViewportAnchorVirtualIndex(
        [
          { index: 4, start: 480 },
          { index: 5, start: 600 },
          { index: 6, start: 780 },
        ],
        500,
        600
      )
    ).toBe(5);
  });

  it('jumps to the latest user turn above the current virtual anchor', () => {
    expect(findPreviousUserMessageVirtualIndex([0, 4, 9], 6)).toBe(4);
  });

  it('falls back to the earliest user turn when already near the top', () => {
    expect(findPreviousUserMessageVirtualIndex([2, 8], 0)).toBe(2);
  });

  it('keeps a 1,000-message fixture indexable for virtual navigation', () => {
    const displayEntries = buildDisplayEntries(
      createLongConversationFixture(1000)
    );

    expect(displayEntries).toHaveLength(1000);
    expect(getUserMessageDisplayIndexes(displayEntries)).toHaveLength(500);
    expect(findPreviousUserMessageVirtualIndex([0, 2, 4, 6], 5)).toBe(4);
  });
});

describe('conversation bottom distance', () => {
  it('calculates distance from the visible viewport to the scroll bottom', () => {
    expect(
      getDistanceFromConversationBottom({
        scrollHeight: 1200,
        scrollTop: 700,
        clientHeight: 400,
      })
    ).toBe(100);
  });

  it('treats near-bottom scroll positions as pinned', () => {
    expect(
      isConversationNearBottom({
        scrollHeight: 1200,
        scrollTop: 760,
        clientHeight: 400,
      })
    ).toBe(true);
  });

  it('releases stick-to-bottom once the user scrolls away', () => {
    expect(
      isConversationNearBottom({
        scrollHeight: 1200,
        scrollTop: 650,
        clientHeight: 400,
      })
    ).toBe(false);
  });

  it('offsets virtual rows by the measured scroll margin', () => {
    expect(getVirtualRowTranslateY(512, 96)).toBe('translateY(416px)');
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

describe('buildDisplayEntries agent creation groups', () => {
  it('groups consecutive subagent creation entries inside collapsed process messages', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:0',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'spawn_agent',
            action_type: {
              action: 'task_create',
              description: 'Inspect Kanban behavior',
              subagent_type: 'explorer',
              result: null,
            },
            status: { status: 'created' },
          },
          content: 'Inspect Kanban behavior',
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
            tool_name: 'spawn_agent',
            action_type: {
              action: 'task_create',
              description: 'Implement theme behavior',
              subagent_type: 'executor',
              result: null,
            },
            status: { status: 'created' },
          },
          content: 'Implement theme behavior',
          timestamp: null,
        },
      },
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:2',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'assistant_message' },
          content: 'Two subagents are running.',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries, {
      collapseAiMessagesByDefault: true,
    });

    expect(displayEntries).toHaveLength(2);
    expect(displayEntries[0]).toMatchObject({
      type: 'COLLAPSED_ASSISTANT_MESSAGES',
      hiddenCount: 1,
      entries: [
        expect.objectContaining({
          type: 'AGGREGATED_GROUP',
          aggregationType: 'task_create',
          entries: expect.arrayContaining([
            expect.objectContaining({ patchKey: 'proc-1:0' }),
            expect.objectContaining({ patchKey: 'proc-1:1' }),
          ]),
        }),
      ],
    });
    expect(displayEntries[1]).toMatchObject({
      type: 'NORMALIZED_ENTRY',
      content: { entry_type: { type: 'assistant_message' } },
    });
  });

  it('collapses process messages even before final assistant output arrives', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:0',
        executionProcessId: 'proc-1',
        content: {
          entry_type: {
            type: 'tool_use',
            tool_name: 'spawn_agent',
            action_type: {
              action: 'task_create',
              description: 'Implement native bridge behavior',
              subagent_type: 'executor',
              result: null,
            },
            status: { status: 'created' },
          },
          content: 'Implement native bridge behavior',
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
            tool_name: 'wait_agent',
            action_type: {
              action: 'task_create',
              description: 'Poll subagent status',
              subagent_type: 'executor',
              result: null,
            },
            status: { status: 'created' },
          },
          content: 'Poll subagent status',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries, {
      collapseAiMessagesByDefault: true,
    });

    expect(displayEntries).toHaveLength(1);
    expect(displayEntries[0]).toMatchObject({
      type: 'COLLAPSED_ASSISTANT_MESSAGES',
      hiddenCount: 1,
      entries: [
        expect.objectContaining({
          type: 'AGGREGATED_GROUP',
          aggregationType: 'task_create',
        }),
      ],
    });
  });

  it('promotes assistant subagent launch text into a collapsed agent creation group', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        patchKey: 'proc-1:0',
        executionProcessId: 'proc-1',
        content: {
          entry_type: { type: 'assistant_message' },
          content:
            '两个子代理已启动：Peirce 看 agent/contracts，Lovelace 看 frontend/protocol。主线程先补齐 spec 三件套。',
          timestamp: null,
        },
      },
    ];

    const displayEntries = buildDisplayEntries(entries, {
      collapseAiMessagesByDefault: true,
    });

    expect(displayEntries).toHaveLength(2);
    expect(displayEntries[0]).toMatchObject({
      type: 'COLLAPSED_ASSISTANT_MESSAGES',
      hiddenCount: 1,
      entries: [
        expect.objectContaining({
          type: 'AGGREGATED_GROUP',
          aggregationType: 'task_create',
        }),
      ],
    });

    expect(
      (displayEntries[0] as { entries: unknown[] }).entries[0]
    ).toMatchObject({
      entries: [
        expect.objectContaining({
          content: expect.objectContaining({
            entry_type: expect.objectContaining({
              action_type: expect.objectContaining({
                action: 'task_create',
                subagent_type: 'Peirce',
                description: '看 agent/contracts',
              }),
            }),
          }),
        }),
        expect.objectContaining({
          content: expect.objectContaining({
            entry_type: expect.objectContaining({
              action_type: expect.objectContaining({
                action: 'task_create',
                subagent_type: 'Lovelace',
                description: '看 frontend/protocol',
              }),
            }),
          }),
        }),
      ],
    });
    expect(displayEntries[1]).toMatchObject({
      type: 'NORMALIZED_ENTRY',
      content: {
        entry_type: { type: 'assistant_message' },
        content: '主线程先补齐 spec 三件套。',
      },
    });
  });
});

describe('collapsedAssistantMessagesLabel', () => {
  it('shows the hidden process-message count', () => {
    expect(collapsedAssistantMessagesLabel(3)).toBe('已折叠 3 条过程消息');
  });
});

describe('pendingAgentPermissionsFromEvents', () => {
  it('keeps permission requests pending until a response event arrives', () => {
    const requested = {
      sequence: 1,
      workspace_id: 'workspace',
      connection_id: 'connection',
      session_id: 'session',
      created_at: '2026-06-11T00:00:01.000Z',
      event: {
        kind: 'permission_requested' as const,
        request: {
          id: 'permission-1',
          session_id: 'session',
          title: 'Run tests',
          options: [{ id: 'allow', label: 'Allow once' }],
        },
      },
    };

    expect(pendingAgentPermissionsFromEvents([requested])).toEqual([
      {
        connectionId: 'connection',
        request: requested.event.request,
      },
    ]);

    expect(
      pendingAgentPermissionsFromEvents([
        requested,
        {
          sequence: 2,
          workspace_id: 'workspace',
          connection_id: 'connection',
          session_id: 'session',
          created_at: '2026-06-11T00:00:02.000Z',
          event: {
            kind: 'permission_responded',
            permission_id: 'permission-1',
            response: { kind: 'selected', option_id: 'allow' },
          },
        },
      ])
    ).toEqual([]);
  });
});
