import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ClickedElementsProvider } from '@/contexts/ClickedElementsProvider';
import {
  hasActiveComposerDraftTarget,
  insertIntoActiveComposer,
} from '@/lib/composerDraftTargets';
import { getSessionComposerStructuredTokenSegments } from './sessionComposerStructuredTokens';
import { useSessionComposerPreviewElementInsertion } from './useSessionComposerPreviewElementInsertion';

function wrapper({ children }: { children: ReactNode }) {
  return <ClickedElementsProvider>{children}</ClickedElementsProvider>;
}

const token = { label: '<Button> SendBar.tsx:42', markdown: '[UI 元素] x' };

function renderComposer(enabled = true) {
  const onChange = vi.fn();
  const hook = renderHook(
    ({ on }: { on: boolean }) =>
      useSessionComposerPreviewElementInsertion({
        enabled: on,
        getMessage: () => '',
        onChange,
      }),
    { wrapper, initialProps: { on: enabled } }
  );
  return { onChange, hook };
}

describe('draft.insert composer targeting', () => {
  it('inserts only into the most recently focused composer in split view', () => {
    const left = renderComposer();
    const right = renderComposer();

    act(() => left.hook.result.current.markFocused());
    act(() => right.hook.result.current.markFocused());

    let inserted = false;
    act(() => {
      inserted = insertIntoActiveComposer(token);
    });

    expect(inserted).toBe(true);
    expect(left.onChange).not.toHaveBeenCalled();
    expect(right.onChange).toHaveBeenCalledTimes(1);
    const segments = getSessionComposerStructuredTokenSegments(
      right.onChange.mock.lastCall?.[0] as string
    ).filter((segment) => segment.kind === 'token');
    expect(segments).toHaveLength(1);

    act(() => left.hook.result.current.markFocused());
    act(() => {
      insertIntoActiveComposer(token);
    });
    expect(left.onChange).toHaveBeenCalledTimes(1);
    expect(right.onChange).toHaveBeenCalledTimes(1);

    left.hook.unmount();
    right.hook.unmount();
  });

  it('reports inserted=false when no editable composer exists', () => {
    const readOnly = renderComposer(false);
    expect(hasActiveComposerDraftTarget()).toBe(false);
    expect(insertIntoActiveComposer(token)).toBe(false);
    expect(readOnly.onChange).not.toHaveBeenCalled();

    readOnly.hook.rerender({ on: true });
    expect(hasActiveComposerDraftTarget()).toBe(true);
    readOnly.hook.unmount();
    expect(hasActiveComposerDraftTarget()).toBe(false);
  });

  it('appends plain text transcripts directly when text is provided without a token label', () => {
    const composer = renderComposer(true);
    act(() => composer.hook.result.current.markFocused());

    let inserted = false;
    act(() => {
      inserted = insertIntoActiveComposer({
        label: '',
        markdown: '',
        text: '请帮我运行单元测试',
      });
    });

    expect(inserted).toBe(true);
    expect(composer.onChange).toHaveBeenCalledWith('请帮我运行单元测试');
    composer.hook.unmount();
  });
});
