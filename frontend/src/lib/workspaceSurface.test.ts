import { describe, expect, it } from 'vitest';

import { isWorkspaceSurfaceActive } from './workspaceSurface';

describe('isWorkspaceSurfaceActive', () => {
  it('treats a workspace or session route as the workspace surface', () => {
    expect(isWorkspaceSurfaceActive('ws-1', undefined, 'kanban')).toBe(true);
    expect(isWorkspaceSurfaceActive(undefined, 'session-1', 'kanban')).toBe(
      true
    );
  });

  it('follows the toolbar tab when the route is not a workspace', () => {
    expect(isWorkspaceSurfaceActive(undefined, undefined, 'workspace')).toBe(
      true
    );
    expect(isWorkspaceSurfaceActive(undefined, undefined, 'kanban')).toBe(
      false
    );
    expect(
      isWorkspaceSurfaceActive(undefined, undefined, 'plugin:acme/tab')
    ).toBe(false);
  });
});
