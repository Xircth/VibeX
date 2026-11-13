import { describe, expect, it, vi } from 'vitest';
import type { LocalHistoryScanPage } from 'shared/types';
import { prepareOnboardingHistoryImport } from './onboardingHistory';

const api = vi.hoisted(() => ({
  getAll: vi.fn(),
  create: vi.fn(),
  scanLocalHistory: vi.fn(),
}));
vi.mock('@/lib/api/projects', () => ({ projectsApi: api }));
vi.mock('@/features/agents/api', () => ({ agentsApi: api }));

describe('onboarding project and history import', () => {
  it('creates a shared project once and keeps sessions from different Agents distinct', async () => {
    api.getAll.mockResolvedValue([]);
    api.create.mockResolvedValue({
      id: 'project-a',
      root_path: 'C:/Work/App',
      name: 'App',
    });
    const folder = (agent: string, path: string) => ({
      path,
      name: 'App',
      project_id: null,
      project_name: null,
      workspace_id: null,
      sessions: [
        {
          agent_id: agent,
          external_session_id: 'same-id',
          title: null,
          workspace_path: path,
          message_count: 2,
          updated_at: null,
          status: 'new' as const,
        },
      ],
    });
    const scans: LocalHistoryScanPage[] = ['codex', 'claude_code'].map(
      (id, i) => ({
        folders: [folder(id, i ? 'c:\\work\\app' : 'C:/Work/App')],
        destinations: [],
        total_sessions: 1,
        importable_count: 1,
      })
    );
    api.scanLocalHistory.mockImplementation(async (id: string) => ({
      ...scans[0],
      folders: [
        {
          ...folder(id, 'C:/Work/App'),
          project_id: 'project-a',
          workspace_id: 'workspace-a',
        },
      ],
    }));
    const result = await prepareOnboardingHistoryImport(
      scans.flatMap((page) => page.folders),
      new Set(['codex:same-id', 'claude_code:same-id']),
      {}
    );
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(result.projectIds).toEqual(['project-a']);
    expect(result.selections).toEqual([
      {
        agent_id: 'codex',
        external_session_id: 'same-id',
        workspace_id: 'workspace-a',
      },
      {
        agent_id: 'claude_code',
        external_session_id: 'same-id',
        workspace_id: 'workspace-a',
      },
    ]);
    api.create.mockClear();
    api.getAll.mockResolvedValue([
      { id: 'project-a', root_path: 'C:/Work/App', hidden: false },
    ]);
    const existing = await prepareOnboardingHistoryImport(
      scans[0].folders,
      new Set(['codex:same-id']),
      { 'c:/work/app': '' }
    );
    expect(api.create).not.toHaveBeenCalled();
    expect(existing.projectIds).toEqual(['project-a']);
  });
});
