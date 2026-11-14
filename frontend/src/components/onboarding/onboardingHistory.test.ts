import { describe, expect, it, vi } from 'vitest';
import type { LocalHistoryScanPage } from 'shared/types';
import {
  prepareOnboardingHistoryImport,
  groupOnboardingHistory,
  filterOnboardingHistory,
} from './onboardingHistory';

const api = vi.hoisted(() => ({
  getAll: vi.fn(),
  create: vi.fn(),
  scanLocalHistory: vi.fn(),
}));
vi.mock('@/lib/api/projects', () => ({ projectsApi: api }));
vi.mock('@/features/agents/api', () => ({ agentsApi: api }));

describe('onboarding project and history import', () => {
  it('aggregates a project when only one Agent resolves its registered identity', () => {
    const folder = {
      name: 'App',
      path: 'C:/Work/App',
      project_id: null,
      project_name: null,
      workspace_id: null,
      sessions: [],
    };
    const result = groupOnboardingHistory([
      folder,
      {
        ...folder,
        path: 'c:\\work\\app\\',
        project_id: 'project-a',
        project_name: 'Registered App',
        workspace_id: 'workspace-a',
      },
      { ...folder, path: 'C:/Work/App/branch', project_id: 'project-a' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      project_id: 'project-a',
      project_name: 'Registered App',
      workspace_id: 'workspace-a',
    });
  });
  it('merges Windows directory aliases across Agents and filters whole sessions by last activity', () => {
    const session = (agent: string, date: string | null) => ({
      agent_id: agent,
      external_session_id: 'same-id',
      title: agent,
      workspace_path: 'C:/Work/App',
      message_count: 2,
      updated_at: date,
      status: 'new' as const,
    });
    const folder = {
      name: 'App',
      path: 'C:/Work/App',
      project_id: null,
      project_name: null,
      workspace_id: null,
      sessions: [session('codex', '2026-11-12T00:00:00Z')],
    };
    const result = groupOnboardingHistory([
      folder,
      {
        ...folder,
        path: 'c:\\work\\app\\',
        sessions: [
          session('claude_code', '2026-10-01T00:00:00Z'),
          session('pi', null),
        ],
      },
      folder,
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].sessions).toHaveLength(3);
    const recent = filterOnboardingHistory(
      result,
      7,
      new Date('2026-11-13T00:00:00Z')
    );
    expect(recent[0].sessions.map((item) => item.agent_id)).toEqual(['codex']);
    expect(filterOnboardingHistory(result, null)[0].sessions).toHaveLength(3);
  });
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
