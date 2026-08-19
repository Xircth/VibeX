import { describe, expect, it } from 'vitest';
import { resolveCreateSessionHref } from './createSessionHref';

describe('resolveCreateSessionHref', () => {
  it('opens the execution-area overlay on the Kanban page', () => {
    expect(
      resolveCreateSessionHref({
        projectId: 'project-1',
        isWorkspaceTab: false,
      })
    ).toBe('/local-projects/project-1/sessions?newSession=1');
  });

  it('opens the execution-area overlay on the Workspace page', () => {
    expect(
      resolveCreateSessionHref({
        projectId: 'project-1',
        isWorkspaceTab: true,
        workspaceId: 'workspace-1',
      })
    ).toBe('/local-projects/project-1/workspaces/workspace-1?newSession=1');
  });
});
