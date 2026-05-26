import { act, renderHook } from '@testing-library/react';
import type { FocusEvent } from 'react';
import { describe, expect, it } from 'vitest';
import { useSessionComposerFocus } from './useSessionComposerFocus';

function focusEvent(
  currentTarget: HTMLElement,
  relatedTarget: EventTarget | null
): FocusEvent<HTMLElement> {
  return {
    currentTarget,
    relatedTarget,
  } as FocusEvent<HTMLElement>;
}

describe('useSessionComposerFocus', () => {
  it('tracks composer focus and ignores blur into the same surface', () => {
    const container = document.createElement('div');
    const child = document.createElement('button');
    container.appendChild(child);

    const { result } = renderHook(() => useSessionComposerFocus());

    expect(result.current.isTextareaFocused).toBe(false);

    act(() => {
      result.current.handleComposerFocus();
    });

    expect(result.current.isTextareaFocused).toBe(true);

    act(() => {
      result.current.handleComposerBlur(focusEvent(container, child));
    });

    expect(result.current.isTextareaFocused).toBe(true);

    act(() => {
      result.current.handleComposerBlur(focusEvent(container, null));
    });

    expect(result.current.isTextareaFocused).toBe(false);
  });
});
