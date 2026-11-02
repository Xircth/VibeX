import { describe, expect, it } from 'vitest';
import {
  SpaceComposerDraftStore,
  spaceComposerDraftKey,
} from './spaceComposerDrafts';

describe('spaceComposerDraftKey', () => {
  it('prefers the direct thread over the selected space id', () => {
    expect(spaceComposerDraftKey('s1', 'direct:m1')).toBe('direct:m1');
    expect(spaceComposerDraftKey('direct:m1', null)).toBe('direct:m1');
    expect(spaceComposerDraftKey('s1')).toBe('s1');
  });
});

describe('SpaceComposerDraftStore', () => {
  it('restores a previous thread draft after switching away and back', () => {
    const store = new SpaceComposerDraftStore();
    expect(store.switchThread('s1', { text: '', images: [] })).toEqual({
      text: '',
      images: [],
    });
    store.remember({ text: 'hello from design', images: [] });
    expect(
      store.switchThread('s2', { text: 'hello from design', images: [] })
    ).toEqual({ text: '', images: [] });
    store.remember({ text: 'hello from ops', images: [] });
    expect(
      store.switchThread('s1', { text: 'hello from ops', images: [] })
    ).toEqual({ text: 'hello from design', images: [] });
    expect(
      store.switchThread('s2', { text: 'hello from design', images: [] })
    ).toEqual({ text: 'hello from ops', images: [] });
  });

  it('keeps the current draft when switching to the same thread key', () => {
    const store = new SpaceComposerDraftStore();
    store.switchThread('s1', { text: '', images: [] });
    store.remember({ text: 'typed', images: [] });
    expect(store.switchThread('s1', { text: 'typed', images: [] })).toEqual({
      text: 'typed',
      images: [],
    });
  });

  it('keeps images with the thread that attached them', () => {
    const store = new SpaceComposerDraftStore();
    const shot = {
      id: 'img-1',
      name: 'shot.png',
      path: '.vibe-images/shot.png',
      previewUrl: 'blob:shot',
    };
    store.switchThread('s1', { text: '', images: [] });
    store.remember({ text: 'caption', images: [shot] });
    expect(
      store.switchThread('s2', { text: 'caption', images: [shot] })
    ).toEqual({ text: '', images: [] });
    expect(store.switchThread('s1', { text: '', images: [] })).toEqual({
      text: 'caption',
      images: [shot],
    });
    expect(store.allImages()).toEqual([shot]);
  });

  it('scopes draft keys by workspace when workspaceId is provided', () => {
    expect(spaceComposerDraftKey('s1', null, 'workspace-1')).toBe(
      'workspace-1::s1'
    );
    expect(spaceComposerDraftKey('s1', 'direct:m1', 'workspace-1')).toBe(
      'workspace-1::direct:m1'
    );
    expect(spaceComposerDraftKey('', null, 'workspace-1')).toBe('');
  });

  it('restores stored draft on remount when previousKey is empty and persists across storage', () => {
    const backing = new Map<string, string>();
    const mockStorage = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (key: string) => backing.get(key) ?? null,
      key: (index: number) => [...backing.keys()][index] ?? null,
      removeItem: (key: string) => {
        backing.delete(key);
      },
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
    } satisfies Storage;

    const firstMountStore = new SpaceComposerDraftStore(mockStorage);
    firstMountStore.switchThread(
      'workspace-1::s1',
      { text: '', images: [] },
      ''
    );
    firstMountStore.remember(
      { text: 'unsent draft before page switch', images: [] },
      'workspace-1::s1'
    );
    firstMountStore.rememberWorkspaceSession('workspace-1', {
      selectedId: 's1',
      selectedMemberKey: '',
      activeDirect: null,
      expanded: { s1: true },
      error: '',
    });

    const remountedStore = new SpaceComposerDraftStore(mockStorage);
    expect(remountedStore.getWorkspaceSession('workspace-1')).toEqual({
      selectedId: 's1',
      selectedMemberKey: '',
      activeDirect: null,
      expanded: { s1: true },
      error: '',
    });
    expect(
      remountedStore.switchThread(
        'workspace-1::s1',
        { text: '', images: [] },
        ''
      )
    ).toEqual({
      text: 'unsent draft before page switch',
      images: [],
    });
  });
});
