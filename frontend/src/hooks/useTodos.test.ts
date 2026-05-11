import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PatchTypeWithKey } from '@/hooks/useConversationHistory';
import { useTodos } from './useTodos';

describe('useTodos', () => {
  it('extracts task list items from ACP plan presentation entries', () => {
    const entries: PatchTypeWithKey[] = [
      {
        type: 'NORMALIZED_ENTRY',
        executionProcessId: 'proc-1',
        patchKey: 'proc-1:1',
        content: {
          timestamp: '2026-05-11T00:00:00.000Z',
          content: 'Plan updated',
          entry_type: {
            type: 'tool_use',
            tool_name: 'plan',
            status: { status: 'success' },
            action_type: {
              action: 'plan_presentation',
              plan: [
                '1. [in_progress | medium] Define task output',
                '2. [pending | high] Inspect frontend rendering',
              ].join('\n'),
            },
          },
        },
      },
    ];

    const { result } = renderHook(() => useTodos(entries));

    expect(result.current.todos).toEqual([
      {
        status: 'in_progress',
        priority: 'medium',
        content: 'Define task output',
      },
      {
        status: 'pending',
        priority: 'high',
        content: 'Inspect frontend rendering',
      },
    ]);
    expect(result.current.inProgressTodo?.content).toBe('Define task output');
  });
});
