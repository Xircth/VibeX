import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Scope } from '@/keyboard';
import { useSessionComposerHotkeys } from './useSessionComposerHotkeys';

describe('useSessionComposerHotkeys', () => {
  it('enables both composer scopes while editable and focused', () => {
    const enableScope = vi.fn();
    const disableScope = vi.fn();

    renderHook(() =>
      useSessionComposerHotkeys({
        isEditable: true,
        isTextareaFocused: true,
        enableScope,
        disableScope,
      })
    );

    expect(enableScope).toHaveBeenCalledWith(Scope.FOLLOW_UP);
    expect(enableScope).toHaveBeenCalledWith(Scope.FOLLOW_UP_READY);
    expect(disableScope).not.toHaveBeenCalled();
  });

  it('disables both composer scopes while inactive', () => {
    const enableScope = vi.fn();
    const disableScope = vi.fn();

    renderHook(() =>
      useSessionComposerHotkeys({
        isEditable: false,
        isTextareaFocused: true,
        enableScope,
        disableScope,
      })
    );

    expect(enableScope).not.toHaveBeenCalled();
    expect(disableScope).toHaveBeenCalledWith(Scope.FOLLOW_UP);
    expect(disableScope).toHaveBeenCalledWith(Scope.FOLLOW_UP_READY);
  });

  it('disables both composer scopes on cleanup', () => {
    const enableScope = vi.fn();
    const disableScope = vi.fn();

    const { unmount } = renderHook(() =>
      useSessionComposerHotkeys({
        isEditable: true,
        isTextareaFocused: true,
        enableScope,
        disableScope,
      })
    );

    disableScope.mockClear();
    unmount();

    expect(disableScope).toHaveBeenCalledWith(Scope.FOLLOW_UP);
    expect(disableScope).toHaveBeenCalledWith(Scope.FOLLOW_UP_READY);
  });

  it('disables previously active scopes when the composer becomes inactive', () => {
    const enableScope = vi.fn();
    const disableScope = vi.fn();

    const { rerender } = renderHook(
      ({
        isEditable,
        isTextareaFocused,
      }: {
        isEditable: boolean;
        isTextareaFocused: boolean;
      }) =>
        useSessionComposerHotkeys({
          isEditable,
          isTextareaFocused,
          enableScope,
          disableScope,
        }),
      {
        initialProps: {
          isEditable: true,
          isTextareaFocused: true,
        },
      }
    );

    disableScope.mockClear();

    rerender({
      isEditable: true,
      isTextareaFocused: false,
    });

    expect(disableScope).toHaveBeenCalledWith(Scope.FOLLOW_UP);
    expect(disableScope).toHaveBeenCalledWith(Scope.FOLLOW_UP_READY);
  });
});
