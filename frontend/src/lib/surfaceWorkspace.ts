import type { Workspace } from 'shared/types';

import { resolveDefaultProjectWorkspace } from '@/lib/workspaceDefault';

/**
 * Workspace identity for a surface that stays open after the route leaves
 * `/workspaces/:id`. Plugin tabs do that on purpose: the route tab would
 * otherwise stay "workspace" and cover the surface.
 */
export function resolveSurfaceWorkspaceId(input: {
  routeWorkspaceId?: string | null;
  activeWorkspaceId?: string | null;
  rememberedWorkspaceId?: string | null;
  workspaces?: readonly Workspace[];
  currentBranch?: string | null;
}): string | null {
  const route = input.routeWorkspaceId?.trim() || null;
  if (route) return route;

  const active = input.activeWorkspaceId?.trim() || null;
  if (active) return active;

  const workspaces = input.workspaces ?? [];
  const remembered = input.rememberedWorkspaceId?.trim() || null;
  if (remembered) {
    const known = workspaces.some((workspace) => workspace.id === remembered);
    if (workspaces.length === 0 || known) return remembered;
  }

  return (
    resolveDefaultProjectWorkspace({
      workspaces,
      currentBranch: input.currentBranch,
    })?.id ?? null
  );
}
