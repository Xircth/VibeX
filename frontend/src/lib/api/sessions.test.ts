import { beforeEach, describe, expect, it, vi } from 'vitest';

const backendCall = vi.hoisted(() => vi.fn());

vi.mock('./base', () => ({
  backendCall,
}));

import { sessionsApi } from './sessions';

describe('sessionsApi.createProject', () => {
  beforeEach(() => {
    backendCall.mockReset();
    backendCall.mockResolvedValue({ id: 'session-1' });
  });

  it('sends the Host camelCase create-session payload', async () => {
    await sessionsApi.createProject({
      project_id: '11111111-1111-1111-1111-111111111111',
      workspace_id: null,
      branch: 'main',
      executor: 'grok',
      name: 'Plan review',
      create_workspace: true,
      repos: [
        {
          repo_id: '22222222-2222-2222-2222-222222222222',
          target_branch: 'main',
        },
      ],
    });

    expect(backendCall).toHaveBeenCalledWith('create_project_session', {
      payload: {
        sessionId: null,
        projectId: '11111111-1111-1111-1111-111111111111',
        workspaceId: null,
        branch: 'main',
        executor: 'grok',
        name: 'Plan review',
        initialPrompt: null,
        createWorkspace: true,
        repos: [
          {
            repoId: '22222222-2222-2222-2222-222222222222',
            targetBranch: 'main',
          },
        ],
      },
    });
  });
});
