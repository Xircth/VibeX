import { describe, expect, it, beforeEach } from 'vitest';
import {
  promptEnhancementOwnerKey,
  resetPromptEnhancementStoreForTests,
  usePromptEnhancementStore,
} from './usePromptEnhancementStore';

describe('usePromptEnhancementStore', () => {
  beforeEach(() => {
    resetPromptEnhancementStoreForTests();
  });

  it('scopes a run to the originating session', () => {
    expect(promptEnhancementOwnerKey('session-1', 'workspace-1')).toBe(
      'session:session-1'
    );
    expect(promptEnhancementOwnerKey(null, 'workspace-1')).toBe(
      'workspace:workspace-1'
    );
  });

  it('keeps an in-flight run after the composer unmounts', () => {
    const generation = usePromptEnhancementStore
      .getState()
      .begin('session:session-1');

    expect(
      usePromptEnhancementStore.getState().runs['session:session-1']?.status
    ).toBe('running');

    usePromptEnhancementStore
      .getState()
      .succeed('session:session-1', generation, 'enhanced text');

    expect(
      usePromptEnhancementStore.getState().runs['session:session-1']
    ).toEqual({
      ownerKey: 'session:session-1',
      generation,
      status: 'success',
      enhancedPrompt: 'enhanced text',
    });
  });

  it('does not let a stale generation overwrite a newer run', () => {
    const first = usePromptEnhancementStore.getState().begin('session:a');
    const second = usePromptEnhancementStore.getState().begin('session:a');

    usePromptEnhancementStore
      .getState()
      .succeed('session:a', first, 'stale prompt');

    expect(usePromptEnhancementStore.getState().runs['session:a']?.status).toBe(
      'running'
    );
    expect(
      usePromptEnhancementStore.getState().runs['session:a']?.generation
    ).toBe(second);
  });
});
