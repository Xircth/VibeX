import { describe, expect, it } from 'vitest';

import { getAppRouteMode } from './appRouteMode';

describe('getAppRouteMode', () => {
  it('selects the desktop toast shell for the exact desktop toast route', () => {
    expect(getAppRouteMode('/desktop-toast')).toBe('desktop-toast');
  });

  it('keeps prefixed but non-exact routes in the main app shell', () => {
    expect(getAppRouteMode('/desktop-toast/settings')).toBe('main');
    expect(getAppRouteMode('/project-rail')).toBe('main');
    expect(getAppRouteMode('/project-rail/local-projects')).toBe('main');
  });

  it('defaults ordinary routes to the main app shell', () => {
    expect(getAppRouteMode('/')).toBe('main');
    expect(getAppRouteMode('/settings/agents')).toBe('main');
    expect(
      getAppRouteMode('/local-projects/project-1/workspaces/worktree-1')
    ).toBe('main');
  });
});
