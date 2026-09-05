import { paths } from '@/lib/paths';

/**
 * Pure decision helpers for revealing a focused session on whatever surface is
 * currently in view (workspace execution area, kanban execution area, or kanban
 * infinite canvas). Keeping the rules here makes them unit-testable and shared
 * by every session-jump entry point.
 */

export type FocusSurface = 'workspace' | 'kanban';

export interface ProjectSessionFocus {
  projectId: string;
  workspaceId: string;
  sessionId: string;
}

export interface FocusRouteContext {
  /** Effective IDE surface currently in view. */
  surface: FocusSurface;
  /** True when the kanban infinite canvas is the visible session hub. */
  isCanvasHub: boolean;
  /** Route params present while on a workspace / deep-session IDE route. */
  routeWorkspaceId?: string | null;
  routeSessionId?: string | null;
}

export type FocusDispatch =
  | { kind: 'noop' }
  | { kind: 'open-in-workspace'; navigateTo: string }
  | {
      kind: 'open-in-kanban-slot';
      placement: { workspaceId: string; sessionId: string };
    }
  | {
      kind: 'reveal-on-canvas';
      projectId: string;
      workspaceId: string;
      sessionId: string;
    };

/**
 * True when `pathname` is one of the IDE-layout routes for `projectId` — i.e.
 * the route group where `PendingProjectFocusBridge` is mounted:
 * `/local-projects/:projectId/sessions`,
 * `/local-projects/:projectId/workspaces/:workspaceId`, or the deep
 * `/local-projects/:projectId/workspaces/:workspaceId/sessions/:sessionId`.
 * Everything else (project home, `/workspaces/:workspaceId/full`, other
 * projects, settings) returns false: those surfaces mount no bridge, so a jump
 * must first navigate to a route that does.
 */
export function isIdeRouteForProjectPathname(
  pathname: string,
  projectId: string
): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
  const prefix = `/local-projects/${projectId}`;
  if (normalized === prefix) {
    return false;
  }
  if (!normalized.startsWith(`${prefix}/`)) {
    return false;
  }

  const rest = normalized.slice(prefix.length + 1);
  if (rest === 'sessions') {
    return true;
  }
  if (/^workspaces\/[^/]+$/.test(rest)) {
    return true;
  }
  if (/^workspaces\/[^/]+\/sessions\/[^/]+$/.test(rest)) {
    return true;
  }
  return false;
}

/**
 * Decide what revealing `focus` on the current surface means.
 *
 * - Workspace + the deep route already targets the exact session → nothing to
 *   do (`noop`); the window focus alone is the desired behavior.
 * - Workspace otherwise → navigate to the deep session URL, which loads the
 *   session into that page's execution area.
 * - Kanban + infinite canvas visible → hand off to the canvas reveal channel.
 * - Kanban otherwise → open the session in the kanban execution slot
 *   (`activateExecutionSession` is a no-op when it is already the right
 *   session).
 */
export function resolveFocusDispatch(
  input: FocusRouteContext,
  focus: ProjectSessionFocus
): FocusDispatch {
  if (input.surface === 'workspace') {
    const alreadyShown =
      input.routeWorkspaceId === focus.workspaceId &&
      input.routeSessionId === focus.sessionId;
    if (alreadyShown) {
      return { kind: 'noop' };
    }
    return {
      kind: 'open-in-workspace',
      navigateTo: paths.projectSession(
        focus.projectId,
        focus.workspaceId,
        focus.sessionId
      ),
    };
  }

  if (input.isCanvasHub) {
    return {
      kind: 'reveal-on-canvas',
      projectId: focus.projectId,
      workspaceId: focus.workspaceId,
      sessionId: focus.sessionId,
    };
  }

  return {
    kind: 'open-in-kanban-slot',
    placement: {
      workspaceId: focus.workspaceId,
      sessionId: focus.sessionId,
    },
  };
}
