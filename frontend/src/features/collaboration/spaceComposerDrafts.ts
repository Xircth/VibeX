import {
  INITIAL_SPACE_SESSION_STATE,
  type SpaceSessionState,
} from './spaceModel';

export type SpaceComposerImageDraft = {
  id: string;
  name: string;
  path: string;
  previewUrl?: string;
};

export type SpaceComposerDraftSnapshot = {
  text: string;
  images: SpaceComposerImageDraft[];
};

export function spaceComposerDraftKey(
  selectedId: string,
  directThreadId?: string | null,
  workspaceId?: string | null
): string {
  const direct = directThreadId?.trim() ?? '';
  const baseKey = direct || selectedId.trim();
  if (!baseKey) return '';
  const workspace = workspaceId?.trim() ?? '';
  return workspace ? `${workspace}::${baseKey}` : baseKey;
}

const EMPTY_DRAFT: SpaceComposerDraftSnapshot = {
  text: '',
  images: [],
};

const STORAGE_KEY = 'vibex:collaboration-space-composer-drafts:v1';

function isEmptyDraft(snapshot: SpaceComposerDraftSnapshot): boolean {
  return snapshot.text.length === 0 && snapshot.images.length === 0;
}

function cloneSnapshot(
  snapshot: SpaceComposerDraftSnapshot
): SpaceComposerDraftSnapshot {
  return {
    text: snapshot.text,
    images: snapshot.images.map((image) => ({ ...image })),
  };
}

function cloneWorkspaceSession(session: SpaceSessionState): SpaceSessionState {
  return {
    selectedId: session.selectedId,
    selectedMemberKey: session.selectedMemberKey,
    activeDirect: session.activeDirect ? { ...session.activeDirect } : null,
    expanded: { ...session.expanded },
    error: '',
  };
}

function defaultSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

type PersistedComposerDraftState = {
  drafts?: Record<string, SpaceComposerDraftSnapshot>;
  workspaceSessions?: Record<string, SpaceSessionState>;
};

export class SpaceComposerDraftStore {
  private drafts = new Map<string, SpaceComposerDraftSnapshot>();
  private workspaceSessions = new Map<string, SpaceSessionState>();
  private currentKey = '';
  private storage: Storage | null;

  constructor(storage: Storage | null = null) {
    this.storage = storage;
    this.hydrateFromStorage();
  }

  private hydrateFromStorage(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedComposerDraftState;
      if (parsed?.drafts && typeof parsed.drafts === 'object') {
        for (const [key, value] of Object.entries(parsed.drafts)) {
          if (!key || !value || typeof value.text !== 'string') continue;
          const images = Array.isArray(value.images)
            ? value.images.filter((img): img is SpaceComposerImageDraft =>
                Boolean(img && typeof img.id === 'string')
              )
            : [];
          const snapshot = { text: value.text, images };
          if (!isEmptyDraft(snapshot)) {
            this.drafts.set(key, cloneSnapshot(snapshot));
          }
        }
      }
      if (
        parsed?.workspaceSessions &&
        typeof parsed.workspaceSessions === 'object'
      ) {
        for (const [workspaceId, session] of Object.entries(
          parsed.workspaceSessions
        )) {
          if (
            !workspaceId ||
            !session ||
            typeof session.selectedId !== 'string'
          ) {
            continue;
          }
          this.workspaceSessions.set(workspaceId, {
            ...INITIAL_SPACE_SESSION_STATE,
            selectedId: session.selectedId,
            selectedMemberKey:
              typeof session.selectedMemberKey === 'string'
                ? session.selectedMemberKey
                : '',
            activeDirect:
              session.activeDirect &&
              typeof session.activeDirect.threadId === 'string'
                ? { ...session.activeDirect }
                : null,
            expanded:
              session.expanded && typeof session.expanded === 'object'
                ? { ...session.expanded }
                : {},
            error: '',
          });
        }
      }
    } catch {
      // Ignore malformed sessionStorage payloads.
    }
  }

  private persistToStorage(): void {
    if (!this.storage) return;
    try {
      if (this.drafts.size === 0 && this.workspaceSessions.size === 0) {
        this.storage.removeItem(STORAGE_KEY);
        return;
      }
      const payload: PersistedComposerDraftState = {
        drafts: Object.fromEntries(this.drafts.entries()),
        workspaceSessions: Object.fromEntries(this.workspaceSessions.entries()),
      };
      this.storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors.
    }
  }

  private setDraftEntry(
    key: string,
    snapshot: SpaceComposerDraftSnapshot
  ): void {
    if (!key) return;
    if (isEmptyDraft(snapshot)) {
      this.drafts.delete(key);
    } else {
      this.drafts.set(key, cloneSnapshot(snapshot));
    }
  }

  get(key: string): SpaceComposerDraftSnapshot {
    const normalized = key.trim();
    if (!normalized) return cloneSnapshot(EMPTY_DRAFT);
    return cloneSnapshot(this.drafts.get(normalized) ?? EMPTY_DRAFT);
  }

  remember(snapshot: SpaceComposerDraftSnapshot, key?: string): void {
    const targetKey = (key !== undefined ? key : this.currentKey).trim();
    if (!targetKey) return;
    this.currentKey = targetKey;
    this.setDraftEntry(targetKey, snapshot);
    this.persistToStorage();
  }

  switchThread(
    nextKey: string,
    current: SpaceComposerDraftSnapshot,
    previousKey?: string
  ): SpaceComposerDraftSnapshot {
    const key = nextKey.trim();
    const fromKey = (
      previousKey !== undefined ? previousKey : this.currentKey
    ).trim();
    if (fromKey === key) {
      if (previousKey !== undefined) {
        if (!key) return cloneSnapshot(EMPTY_DRAFT);
        if (!isEmptyDraft(current)) {
          this.setDraftEntry(key, current);
          this.persistToStorage();
          return cloneSnapshot(current);
        }
        return cloneSnapshot(this.drafts.get(key) ?? EMPTY_DRAFT);
      }
      return current;
    }
    if (fromKey) {
      this.setDraftEntry(fromKey, current);
    }
    this.currentKey = key;
    this.persistToStorage();
    if (!key) return cloneSnapshot(EMPTY_DRAFT);
    return cloneSnapshot(this.drafts.get(key) ?? EMPTY_DRAFT);
  }

  rememberWorkspaceSession(
    workspaceId: string,
    session: SpaceSessionState
  ): void {
    const key = workspaceId.trim();
    if (!key || !session.selectedId.trim()) return;
    this.workspaceSessions.set(key, cloneWorkspaceSession(session));
    this.persistToStorage();
  }

  getWorkspaceSession(workspaceId: string): SpaceSessionState | null {
    const key = workspaceId.trim();
    if (!key) return null;
    const saved = this.workspaceSessions.get(key);
    return saved ? cloneWorkspaceSession(saved) : null;
  }

  allImages(): SpaceComposerImageDraft[] {
    return [...this.drafts.values()].flatMap((snapshot) => snapshot.images);
  }

  clear(): void {
    this.drafts.clear();
    this.workspaceSessions.clear();
    this.currentKey = '';
    if (this.storage) {
      try {
        this.storage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore storage errors.
      }
    }
  }
}

export const sharedSpaceComposerDraftStore = new SpaceComposerDraftStore(
  defaultSessionStorage()
);

export function resetSharedSpaceComposerDrafts(): void {
  sharedSpaceComposerDraftStore.clear();
}
