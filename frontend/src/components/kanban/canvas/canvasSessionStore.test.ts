import { describe, expect, it, vi } from 'vitest';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { createCanvasSessionStore } from './canvasSessionStore';

function record(
  id: string,
  overrides: Partial<KanbanProjectSessionRecord> = {}
): KanbanProjectSessionRecord {
  return {
    id,
    name: id,
    status: 'todo',
    branch: 'main',
    workspaceName: 'ws',
    workspaceDisplayLabel: 'ws',
    executor: null,
    agentId: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    firstPrompt: null,
    fullName: id,
    shortName: id,
    taskTitle: null,
    isCompleted: false,
    isRunning: false,
    isErrored: false,
    pinnedAt: null,
    ...overrides,
  } as KanbanProjectSessionRecord;
}

describe('createCanvasSessionStore', () => {
  it('notifies only the session whose visible fields changed', () => {
    const store = createCanvasSessionStore();
    const first = record('a', { fullName: 'A' });
    const other = record('b', { fullName: 'B' });
    store.replace(
      new Map([
        ['a', first],
        ['b', other],
      ]),
      true
    );

    const onA = vi.fn();
    const onB = vi.fn();
    store.subscribe('a', onA);
    store.subscribe('b', onB);

    store.replace(
      new Map([
        ['a', { ...first, fullName: 'A2' }],
        ['b', { ...other }],
      ]),
      true
    );

    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
    expect(store.get('a')?.fullName).toBe('A2');
  });

  it('keeps the previous object when a poll repeats the same fields', () => {
    const store = createCanvasSessionStore();
    const first = record('a');
    store.replace(new Map([['a', first]]), true);
    store.replace(new Map([['a', { ...first }]]), true);
    expect(store.get('a')).toBe(first);
  });
});
