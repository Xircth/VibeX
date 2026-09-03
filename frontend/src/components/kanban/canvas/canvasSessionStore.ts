import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';

export type CanvasSessionStore = {
  get: (sessionId: string) => KanbanProjectSessionRecord | undefined;
  ready: () => boolean;
  replace: (
    sessions: ReadonlyMap<string, KanbanProjectSessionRecord>,
    sessionsReady: boolean
  ) => void;
  subscribe: (sessionId: string, onChange: () => void) => () => void;
};

function sessionRevision(
  session: KanbanProjectSessionRecord | undefined
): string {
  if (!session) return '';
  return [
    session.id,
    session.fullName,
    session.shortName,
    session.updatedAt,
    session.branch,
    session.workspaceName,
    session.workspaceDisplayLabel,
    session.status,
    session.executor ?? '',
    session.agentId ?? '',
    String(session.isRunning),
    String(session.isCompleted),
    String(session.isErrored),
    session.pinnedAt ?? '',
  ].join('\0');
}

export function createCanvasSessionStore(): CanvasSessionStore {
  let sessions = new Map<string, KanbanProjectRecordSnapshot>();
  let sessionsReady = true;
  const listeners = new Map<string, Set<() => void>>();

  const notify = (sessionId: string) => {
    const subs = listeners.get(sessionId);
    if (!subs) return;
    for (const listener of subs) listener();
  };

  return {
    get(sessionId) {
      return sessions.get(sessionId)?.session;
    },
    ready() {
      return sessionsReady;
    },
    replace(next, nextReady) {
      const prev = sessions;
      const updated = new Map<string, KanbanProjectRecordSnapshot>();
      const seen = new Set<string>();
      for (const [id, session] of next) {
        seen.add(id);
        const revision = sessionRevision(session);
        const previous = prev.get(id);
        if (previous && previous.revision === revision) {
          updated.set(id, previous);
          continue;
        }
        updated.set(id, { session, revision });
        if (!previous || previous.revision !== revision) notify(id);
      }
      for (const id of prev.keys()) {
        if (seen.has(id)) continue;
        notify(id);
      }
      sessions = updated;
      if (sessionsReady !== nextReady) {
        sessionsReady = nextReady;
        for (const id of listeners.keys()) notify(id);
      } else {
        sessionsReady = nextReady;
      }
    },
    subscribe(sessionId, onChange) {
      let subs = listeners.get(sessionId);
      if (!subs) {
        subs = new Set();
        listeners.set(sessionId, subs);
      }
      subs.add(onChange);
      return () => {
        subs.delete(onChange);
        if (subs.size === 0) listeners.delete(sessionId);
      };
    },
  };
}

type KanbanProjectRecordSnapshot = {
  session: KanbanProjectSessionRecord;
  revision: string;
};
