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
    expect(
      store.switchThread('s1', { text: '', images: [] })
    ).toEqual({ text: 'caption', images: [shot] });
    expect(store.allImages()).toEqual([shot]);
  });
});
