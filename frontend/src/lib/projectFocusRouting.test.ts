import { describe, expect, it } from 'vitest';
import {
  isIdeRouteForProjectPathname,
  resolveFocusDispatch,
} from '@/lib/projectFocusRouting';

const PROJECT_ID = 'project-1';

describe('isIdeRouteForProjectPathname', () => {
  it('accepts the sessions IDE route', () => {
    expect(
      isIdeRouteForProjectPathname(`/local-projects/${PROJECT_ID}/sessions`, PROJECT_ID)
    ).toBe(true);
  });

  it('tolerates a trailing slash', () => {
    expect(
      isIdeRouteForProjectPathname(
        `/local-projects/${PROJECT_ID}/sessions/`,
        PROJECT_ID
      )
    ).toBe(true);
  });

  it('accepts the workspace and deep-session IDE routes', () => {
    expect(
      isIdeRouteForProjectPathname(
        `/local-projects/${PROJECT_ID}/workspaces/workspace-1`,
        PROJECT_ID
      )
    ).toBe(true);
    expect(
      isIdeRouteForProjectPathname(
        `/local-projects/${PROJECT_ID}/workspaces/workspace-1/sessions/session-1`,
        PROJECT_ID
      )
    ).toBe(true);
  });

  it('rejects the bare project home route', () => {
    expect(
      isIdeRouteForProjectPathname(`/local-projects/${PROJECT_ID}`, PROJECT_ID)
    ).toBe(false);
  });

  it('rejects the full-attempt-logs route (no focus bridge mounted)', () => {
    expect(
      isIdeRouteForProjectPathname(
        `/local-projects/${PROJECT_ID}/workspaces/workspace-1/full`,
        PROJECT_ID
      )
    ).toBe(false);
  });

  it('rejects routes belonging to another project', () => {
    expect(
      isIdeRouteForProjectPathname(
        `/local-projects/other-project/sessions`,
        PROJECT_ID
      )
    ).toBe(false);
  });

  it('rejects non-project routes', () => {
    expect(isIdeRouteForProjectPathname('/settings', PROJECT_ID)).toBe(false);
  });
});

describe('resolveFocusDispatch', () => {
  const focus = {
    projectId: PROJECT_ID,
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
  };

  it('no-ops when the workspace route already targets the exact session', () => {
    expect(
      resolveFocusDispatch(
        {
          surface: 'workspace',
          isCanvasHub: false,
          routeWorkspaceId: 'workspace-1',
          routeSessionId: 'session-1',
        },
        focus
      )
    ).toEqual({ kind: 'noop' });
  });

  it('navigates to the deep session when the workspace shows a different session', () => {
    expect(
      resolveFocusDispatch(
        {
          surface: 'workspace',
          isCanvasHub: false,
          routeWorkspaceId: 'workspace-1',
          routeSessionId: 'session-0',
        },
        focus
      )
    ).toEqual({
      kind: 'open-in-workspace',
      navigateTo: `/local-projects/${PROJECT_ID}/workspaces/workspace-1/sessions/session-1`,
    });
  });

  it('navigates to the deep session when no workspace is routed yet', () => {
    expect(
      resolveFocusDispatch(
        { surface: 'workspace', isCanvasHub: false },
        focus
      )
    ).toEqual({
      kind: 'open-in-workspace',
      navigateTo: `/local-projects/${PROJECT_ID}/workspaces/workspace-1/sessions/session-1`,
    });
  });

  it('hands off to the canvas channel when the infinite canvas is the visible hub', () => {
    expect(
      resolveFocusDispatch(
        { surface: 'kanban', isCanvasHub: true },
        focus
      )
    ).toEqual({
      kind: 'reveal-on-canvas',
      projectId: PROJECT_ID,
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    });
  });

  it('opens the kanban execution slot otherwise', () => {
    expect(
      resolveFocusDispatch(
        { surface: 'kanban', isCanvasHub: false },
        focus
      )
    ).toEqual({
      kind: 'open-in-kanban-slot',
      placement: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    });
  });
});
