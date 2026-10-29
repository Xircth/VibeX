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
  directThreadId?: string | null
): string {
  const direct = directThreadId?.trim() ?? '';
  if (direct) return direct;
  return selectedId.trim();
}

const EMPTY_DRAFT: SpaceComposerDraftSnapshot = {
  text: '',
  images: [],
};

function cloneSnapshot(
  snapshot: SpaceComposerDraftSnapshot
): SpaceComposerDraftSnapshot {
  return {
    text: snapshot.text,
    images: snapshot.images.map((image) => ({ ...image })),
  };
}

export class SpaceComposerDraftStore {
  private drafts = new Map<string, SpaceComposerDraftSnapshot>();
  private currentKey = '';

  remember(snapshot: SpaceComposerDraftSnapshot): void {
    if (!this.currentKey) return;
    this.drafts.set(this.currentKey, cloneSnapshot(snapshot));
  }

  switchThread(
    nextKey: string,
    current: SpaceComposerDraftSnapshot
  ): SpaceComposerDraftSnapshot {
    const key = nextKey.trim();
    if (this.currentKey === key) {
      return current;
    }
    if (this.currentKey) {
      this.drafts.set(this.currentKey, cloneSnapshot(current));
    }
    this.currentKey = key;
    if (!key) return cloneSnapshot(EMPTY_DRAFT);
    return cloneSnapshot(this.drafts.get(key) ?? EMPTY_DRAFT);
  }

  allImages(): SpaceComposerImageDraft[] {
    return [...this.drafts.values()].flatMap((snapshot) => snapshot.images);
  }
}
