import { useSyncExternalStore } from 'react';
import type { DockviewApi } from 'dockview-react';
import {
  sessionSlotClasses,
  sessionSlotHue,
  type SessionMarker,
} from '@/components/kanban/session-hub/utils';
import { SESSION_PANEL_PREFIX } from '@/utils/dockviewGroupPolicy';

const listeners = new Set<() => void>();
let openSessionIdsSnapshot: string[] = [];

export function extractSessionIdFromPanelId(panelId: string): string | null {
  if (!panelId.startsWith(SESSION_PANEL_PREFIX)) {
    return null;
  }
  const sessionId = panelId.slice(SESSION_PANEL_PREFIX.length).trim();
  return sessionId.length > 0 ? sessionId : null;
}

export function collectOpenSessionIdsFromDockview(
  api: Pick<DockviewApi, 'panels'> | null | undefined
): string[] {
  if (!api) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const panel of api.panels) {
    const sessionId = extractSessionIdFromPanelId(panel.id);
    if (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId);
      ids.push(sessionId);
    }
  }
  return ids;
}

export function setWorkspaceOpenSessionIds(nextIds: readonly string[]): void {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const raw of nextIds) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      deduped.push(id);
    }
  }

  if (
    deduped.length === openSessionIdsSnapshot.length &&
    deduped.every((id, index) => id === openSessionIdsSnapshot[index])
  ) {
    return;
  }

  openSessionIdsSnapshot = deduped;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function syncWorkspaceOpenSessionIdsFromDockview(
  api: Pick<DockviewApi, 'panels'> | null | undefined
): void {
  setWorkspaceOpenSessionIds(collectOpenSessionIdsFromDockview(api));
}

export function getWorkspaceOpenSessionIds(): string[] {
  return openSessionIdsSnapshot;
}

export function subscribeWorkspaceOpenSessionIds(
  listener: () => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWorkspaceOpenSessionIds(): string[] {
  return useSyncExternalStore(
    subscribeWorkspaceOpenSessionIds,
    getWorkspaceOpenSessionIds,
    () => []
  );
}

export function resolveSessionTabMarker(
  sessionId: string | null | undefined,
  openSessionIds: readonly string[] = openSessionIdsSnapshot
): SessionMarker | null {
  if (!sessionId) return null;
  const existingIndex = openSessionIds.indexOf(sessionId);
  const slotIndex = existingIndex >= 0 ? existingIndex : 0;
  return {
    bar: sessionSlotClasses(slotIndex).bar,
    hue: sessionSlotHue(slotIndex),
  };
}
