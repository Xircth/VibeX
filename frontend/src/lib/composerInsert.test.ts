import { describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_INSERT_EVENT,
  requestComposerInsert,
  requestComposerTokenInsert,
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
});
