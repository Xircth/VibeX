import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_IMAGE_INSERT_EVENT,
  COMPOSER_INSERT_EVENT,
  requestComposerImageInsert,
  requestComposerInsert,
  requestComposerTokenInsert,
  shouldAcceptComposerInsert,
} from './composerInsert';

describe('composerInsert', () => {
  it('dispatches trimmed plain text inserts', () => {
    const listener = vi.fn();
    window.addEventListener(COMPOSER_INSERT_EVENT, listener);
    expect(requestComposerInsert('  hello  ')).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail).toEqual({
      text: 'hello',
      mode: 'text',
    });
    window.removeEventListener(COMPOSER_INSERT_EVENT, listener);
  });

  it('dispatches token inserts with a chip label', () => {
    const listener = vi.fn();
    window.addEventListener(COMPOSER_INSERT_EVENT, listener);
    expect(
      requestComposerTokenInsert({
        value: '[:quote](请你帮我完成这次修改)',
        label: '@请你帮我...',
      })
    ).toBe(true);
    expect(listener.mock.calls[0][0].detail).toEqual({
      text: '[:quote](请你帮我完成这次修改)',
      mode: 'token',
      label: '@请你帮我...',
    });
    window.removeEventListener(COMPOSER_INSERT_EVENT, listener);
  });

  it('dispatches a conversation-targeted quote insert', () => {
    const listener = vi.fn();
    window.addEventListener(COMPOSER_INSERT_EVENT, listener);
    expect(
      requestComposerTokenInsert({
        value: '[:quote](请你帮我完成这次修改)',
        label: '@请你帮我...',
        conversationId: 'conv-a',
      })
    ).toBe(true);
    expect(listener.mock.calls[0][0].detail).toEqual({
      text: '[:quote](请你帮我完成这次修改)',
      mode: 'token',
      label: '@请你帮我...',
      conversationId: 'conv-a',
    });
    window.removeEventListener(COMPOSER_INSERT_EVENT, listener);
  });

  it('accepts an untargeted insert on any listening composer', () => {
    expect(
      shouldAcceptComposerInsert(
        { text: 'hello', mode: 'text' },
        { conversationId: 'conv-a' }
      )
    ).toBe(true);
  });

  it('accepts a targeted insert only on the matching conversation composer', () => {
    const detail = {
      text: '[:quote](hello)',
      mode: 'token' as const,
      conversationId: 'conv-a',
    };
    expect(
      shouldAcceptComposerInsert(detail, { conversationId: 'conv-a' })
    ).toBe(true);
    expect(
      shouldAcceptComposerInsert(detail, { conversationId: 'conv-b' })
    ).toBe(false);
    expect(shouldAcceptComposerInsert(detail, {})).toBe(false);
  });

  it('dispatches a picked-element image to the composer', () => {
    const listener = vi.fn();
    window.addEventListener(COMPOSER_IMAGE_INSERT_EVENT, listener);
    const file = new File([new Uint8Array([1, 2, 3])], 'button.png', {
      type: 'image/png',
    });
    expect(requestComposerImageInsert(file)).toBe(true);
    expect(listener.mock.calls[0][0].detail.file).toBe(file);
    window.removeEventListener(COMPOSER_IMAGE_INSERT_EVENT, listener);
  });

  it('rejects external inserts on composers that do not accept them', () => {
    expect(
      shouldAcceptComposerInsert(
        { text: 'hello', mode: 'token', conversationId: 'conv-a' },
        { conversationId: 'conv-a', acceptExternalInserts: false }
      )
    ).toBe(false);
  });
});
