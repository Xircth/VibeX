import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { setMergePanelDirty } from './merge/mergePanelDirty';
import {
  confirmCloseWorkspacePanel,
  confirmDiscardPreviewPanel,
  isPreviewPanelDirty,
  resetPreviewPanelDirtyForTests,
  setPreviewPanelDirty,
  useIsPreviewPanelDirty,
} from './previewPanelDirty';

describe('previewPanelDirty', () => {
  const initialLanguage = i18n.language;

  beforeEach(() => {
    resetPreviewPanelDirtyForTests();
    setMergePanelDirty('merge:panel-1', false);
  });

  afterEach(async () => {
    resetPreviewPanelDirtyForTests();
    setMergePanelDirty('merge:panel-1', false);
    if (i18n.language !== initialLanguage) {
      await i18n.changeLanguage(initialLanguage);
    }
    vi.restoreAllMocks();
  });

  it('tracks dirty state per panel and re-renders only the affected subscriber', () => {
    const rendersByPanel = { a: 0, b: 0 };

    function Probe({ id, slot }: { id: string; slot: 'a' | 'b' }) {
      rendersByPanel[slot] += 1;
      const dirty = useIsPreviewPanelDirty(id);
      return React.createElement(
        'span',
        { 'data-testid': `probe-${slot}` },
        dirty ? 'dirty' : 'clean'
      );
    }

    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Probe, { id: 'file:/workspace/a.ts', slot: 'a' }),
        React.createElement(Probe, { id: 'file:/workspace/b.ts', slot: 'b' })
      )
    );

    expect(screen.getByTestId('probe-a')).toHaveTextContent('clean');
    expect(screen.getByTestId('probe-b')).toHaveTextContent('clean');
    expect(rendersByPanel).toEqual({ a: 1, b: 1 });

    act(() => {
      setPreviewPanelDirty('file:/workspace/a.ts', true, 'src/a.ts');
    });

    expect(isPreviewPanelDirty('file:/workspace/a.ts')).toBe(true);
    expect(isPreviewPanelDirty('file:/workspace/b.ts')).toBe(false);
    expect(screen.getByTestId('probe-a')).toHaveTextContent('dirty');
    expect(screen.getByTestId('probe-b')).toHaveTextContent('clean');
    expect(rendersByPanel).toEqual({ a: 2, b: 1 });

    // Updating only the file label while staying dirty does not re-render boolean subscribers
    act(() => {
      setPreviewPanelDirty('file:/workspace/a.ts', true, 'src/a-renamed.ts');
    });
    expect(rendersByPanel).toEqual({ a: 2, b: 1 });

    act(() => {
      setPreviewPanelDirty('file:/workspace/a.ts', false);
    });
    expect(screen.getByTestId('probe-a')).toHaveTextContent('clean');
    expect(rendersByPanel).toEqual({ a: 3, b: 1 });
  });

  it('returns true immediately without prompting when clean, and prompts localized message when dirty', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    expect(confirmDiscardPreviewPanel('file:/workspace/clean.ts')).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();

    await i18n.changeLanguage('zh-CN');
    setPreviewPanelDirty('file:/workspace/dirty.ts', true, 'src/dirty.ts');
    expect(confirmDiscardPreviewPanel('file:/workspace/dirty.ts')).toBe(false);
    expect(confirmSpy).toHaveBeenLastCalledWith(
      '文件 “src/dirty.ts” 有未保存的修改，确定放弃并关闭吗？'
    );

    confirmSpy.mockReturnValue(true);
    await i18n.changeLanguage('en');
    expect(confirmDiscardPreviewPanel('file:/workspace/dirty.ts')).toBe(true);
    expect(confirmSpy).toHaveBeenLastCalledWith(
      'Discard unsaved changes in "src/dirty.ts"?'
    );
  });

  it('guards both merge panels and preview panels in confirmCloseWorkspacePanel', async () => {
    await i18n.changeLanguage('en');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    setMergePanelDirty('merge:panel-1', true);
    expect(confirmCloseWorkspacePanel('merge:panel-1', PANEL_IDS.MERGE)).toBe(
      false
    );
    expect(confirmSpy).toHaveBeenCalledTimes(1);

    setPreviewPanelDirty('file:/workspace/app.tsx', true, 'src/app.tsx');
    expect(
      confirmCloseWorkspacePanel('file:/workspace/app.tsx', PANEL_IDS.PREVIEW)
    ).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(confirmSpy).toHaveBeenLastCalledWith(
      'Discard unsaved changes in "src/app.tsx"?'
    );
  });
});
