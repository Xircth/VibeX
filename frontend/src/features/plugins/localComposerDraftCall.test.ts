import { describe, expect, it } from 'vitest';
import { handleLocalComposerDraftCall } from './PluginRuntimeLoader';

describe('handleLocalComposerDraftCall', () => {
  it('draft.target reports availability under `available`', () => {
    expect(handleLocalComposerDraftCall('conversation', 'draft.target', {})).toEqual({
      conversationId: null,
      available: false,
    });
  });

  it('draft.insert without a target reports inserted=false', () => {
    expect(
      handleLocalComposerDraftCall('conversation', 'draft.insert', {
        token: { label: 'x', markdown: 'y' },
      })
    ).toEqual({ conversationId: null, inserted: false });
  });

  it('defers calls that carry a conversationId to the backend', () => {
    expect(
      handleLocalComposerDraftCall('conversation', 'draft.target', { conversationId: 'c1' })
    ).toBeNull();
  });
});
