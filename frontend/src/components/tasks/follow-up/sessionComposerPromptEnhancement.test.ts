import { describe, expect, it } from 'vitest';
import {
  buildPromptEnhancementRequest,
  canEnhancePrompt,
  getPromptEnhancementClickAction,
  getPromptEnhancementErrorMessage,
  isPromptEnhancementCancelledError,
  normalizeEnhancedPrompt,
} from './sessionComposerPromptEnhancement';

const contextMessages = [
  {
    role: 'user' as const,
    content: 'previous request',
    timestamp: '2026-05-25T00:00:00.000Z',
  },
];

describe('session composer prompt enhancement helpers', () => {
  it('enables prompt enhancement only when typing is available and the draft has content', () => {
    expect(
      canEnhancePrompt({
        canTypeFollowUp: true,
        draftPrompt: ' improve this ',
      })
    ).toBe(true);

    expect(
      canEnhancePrompt({
        canTypeFollowUp: false,
        draftPrompt: 'improve this',
      })
    ).toBe(false);

    expect(
      canEnhancePrompt({
        canTypeFollowUp: true,
        draftPrompt: '   ',
      })
    ).toBe(false);
  });

  it('starts prompt enhancement only for non-empty drafts while idle', () => {
    expect(
      getPromptEnhancementClickAction({
        isEnhancingPrompt: false,
        draftPrompt: ' improve this ',
      })
    ).toBe('start');

    expect(
      getPromptEnhancementClickAction({
        isEnhancingPrompt: false,
        draftPrompt: '   ',
      })
    ).toBe('ignore');
  });

  it('cancels the in-flight enhancement when the loading control is clicked', () => {
    expect(
      getPromptEnhancementClickAction({
        isEnhancingPrompt: true,
        draftPrompt: 'improve this',
      })
    ).toBe('cancel');

    expect(
      getPromptEnhancementClickAction({
        isEnhancingPrompt: true,
        draftPrompt: '   ',
      })
    ).toBe('cancel');
  });

  it('builds prompt enhancement requests with null session and workspace fallbacks', () => {
    expect(
      buildPromptEnhancementRequest({
        draftPrompt: ' improve this ',
        sessionId: undefined,
        workspaceId: undefined,
        contextMessages,
      })
    ).toEqual({
      draftPrompt: ' improve this ',
      sessionId: null,
      workspaceId: null,
      contextMessages,
    });

    expect(
      buildPromptEnhancementRequest({
        draftPrompt: 'improve this',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        contextMessages,
      })
    ).toEqual({
      draftPrompt: 'improve this',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      contextMessages,
    });
  });

  it('trims enhanced prompt responses before applying them', () => {
    expect(
      normalizeEnhancedPrompt({ enhancedPrompt: '  better prompt  ' })
    ).toBe('better prompt');
  });

  it('rejects empty enhanced prompt responses with the backend-compatible error', () => {
    expect(() =>
      normalizeEnhancedPrompt({ enhancedPrompt: '   ' })
    ).toThrowError('Prompt enhancement returned empty content');
  });

  it('strips backend error prefixes while keeping unknown details', () => {
    expect(
      getPromptEnhancementErrorMessage('Bad request: custom detail')
    ).toMatch(/custom detail$/);
    expect(
      getPromptEnhancementErrorMessage({
        message: 'Internal error: nested failure',
      })
    ).toMatch(/nested failure$/);
  });

  it('maps known prompt enhancement failures to user-facing messages', () => {
    const disabled = getPromptEnhancementErrorMessage(
      'Bad request: Prompt enhancement is disabled in system settings'
    );
    const empty = getPromptEnhancementErrorMessage(
      new Error('Prompt enhancement returned empty content')
    );
    const missingAgent = getPromptEnhancementErrorMessage(
      'No enabled Agent currently advertises the configured model'
    );

    expect(disabled).not.toContain('Prompt enhancement is disabled');
    expect(empty).not.toContain('Prompt enhancement returned empty content');
    expect(missingAgent).not.toContain('No enabled Agent');
  });

  it('treats user cancellation as a silent non-error', () => {
    expect(
      isPromptEnhancementCancelledError('Prompt enhancement cancelled')
    ).toBe(true);
    expect(
      isPromptEnhancementCancelledError(
        new Error('Prompt enhancement cancelled')
      )
    ).toBe(true);
    expect(
      isPromptEnhancementCancelledError('Prompt enhancement failed: timeout')
    ).toBe(false);
  });
});
