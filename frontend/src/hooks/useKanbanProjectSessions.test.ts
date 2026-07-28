import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { SessionSummary } from '@/lib/api';
import { buildDefaultSessionName } from './useKanbanProjectSessions';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    workspace_id: 'workspace-1',
    task_id: null,
    name: null,
    display_name: '修复会话标题功能',
    status: 'todo',
    executor: 'codex',
    workspace_name: 'Workspace',
    workspace_branch: 'main',
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
    first_prompt: '修复会话标题功能并保持手动标题',
    is_running: false,
    continuity_mode: 'new_session',
    ...overrides,
  };
}

describe('buildDefaultSessionName', () => {
  it('uses the first eight characters of the first prompt', () => {
    const t = vi.fn(() => '新会话') as unknown as TFunction<['app', 'common']>;

    expect(buildDefaultSessionName(summary(), t)).toEqual({
      name: '修复会话标题功能',
      source: 'prompt',
      prompt: '修复会话标题功能并保持手动标题',
    });
  });

  it('keeps the backend placeholder in the fallback naming path', () => {
    const t = vi.fn(() => '新会话') as unknown as TFunction<['app', 'common']>;

    expect(
      buildDefaultSessionName(
        summary({
          display_name: '新会话',
          first_prompt: null,
        }),
        t
      )
    ).toEqual({
      name: '新会话1',
      source: 'fallback',
      prompt: null,
    });
  });
});
