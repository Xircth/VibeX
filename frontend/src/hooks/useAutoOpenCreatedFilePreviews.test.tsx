import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileTreeChange } from '@/lib/fileTreeChangeStream';

const stream = vi.hoisted(() => ({ subscribeFileTreeChanges: vi.fn() }));
const panelActions = vi.hoisted(() => ({ openFilePreview: vi.fn() }));
const store = vi.hoisted(() => ({ rootPath: '/workspace' as string | null }));
const toastInfo = vi.hoisted(() => vi.fn());

vi.mock('@/lib/fileTreeChangeStream', () => stream);
vi.mock('@/hooks/usePanelActions', () => ({
  // A fresh function identity every render, as a real hook would produce.
  usePanelActions: () => ({
    openFilePreview: (...args: unknown[]) =>
      panelActions.openFilePreview(...args),
  }),
}));
vi.mock('@/stores/useFileTreeStore', () => ({
  useFileTreeStore: (
    selector: (state: { rootPath: string | null }) => unknown
  ) => selector({ rootPath: store.rootPath }),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { info: toastInfo },
}));

import {
  MAX_AUTO_OPENED_PREVIEWS,
  useAutoOpenCreatedFilePreviews,
} from './useAutoOpenCreatedFilePreviews';

/** The handler the hook handed to the stream, once it has subscribed. */
let emit: ((change: FileTreeChange) => void) | null;

function Harness({ enabled = true }: { enabled?: boolean }) {
  useAutoOpenCreatedFilePreviews({ enabled });
  return null;
}

describe('useAutoOpenCreatedFilePreviews', () => {
  beforeEach(() => {
    emit = null;
    store.rootPath = '/workspace';
    panelActions.openFilePreview.mockReset().mockReturnValue('opened');
    toastInfo.mockReset();
    stream.subscribeFileTreeChanges
      .mockReset()
      .mockImplementation(
        (_rootPath: string, handler: (change: FileTreeChange) => void) => {
          emit = handler;
          return () => undefined;
        }
      );
  });

  it('opens the preview of a created svg or html file', () => {
    render(<Harness />);

    emit?.({
      root_path: '/workspace',
      added_paths: ['docs/page.html', 'icon.svg'],
    });

    expect(panelActions.openFilePreview).toHaveBeenCalledWith(
      '/workspace/docs/page.html',
      { activate: true }
    );
    expect(panelActions.openFilePreview).toHaveBeenCalledWith(
      '/workspace/icon.svg',
      { activate: false }
    );
  });

  it('leaves files that do not render on their own alone', () => {
    render(<Harness />);

    emit?.({
      root_path: '/workspace',
      added_paths: ['shot.png', 'notes.md', 'main.rs', 'page.HTM'],
    });

    expect(panelActions.openFilePreview).toHaveBeenCalledTimes(1);
    expect(panelActions.openFilePreview).toHaveBeenCalledWith(
      '/workspace/page.HTM',
      { activate: true }
    );
  });

  it('does not subscribe while the workspace page is not showing', () => {
    render(<Harness enabled={false} />);

    expect(stream.subscribeFileTreeChanges).not.toHaveBeenCalled();
  });

  it('does not subscribe without a workspace root', () => {
    store.rootPath = null;
    render(<Harness />);

    expect(stream.subscribeFileTreeChanges).not.toHaveBeenCalled();
  });

  it('caps how many previews one batch may open', () => {
    render(<Harness />);

    emit?.({
      root_path: '/workspace',
      added_paths: ['a.html', 'b.html', 'c.html', 'd.html', 'e.html'],
    });

    expect(panelActions.openFilePreview).toHaveBeenCalledTimes(
      MAX_AUTO_OPENED_PREVIEWS
    );
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('says so when the host capped the batch before it was sent', () => {
    render(<Harness />);

    emit?.({
      root_path: '/workspace',
      added_paths: ['a.html'],
      added_paths_truncated: true,
    });

    expect(panelActions.openFilePreview).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('reports nothing skipped when the batch fits', () => {
    render(<Harness />);

    emit?.({ root_path: '/workspace', added_paths: ['a.html', 'b.svg'] });

    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('opens a given file only once, so a closed tab stays closed', () => {
    render(<Harness />);

    emit?.({ root_path: '/workspace', added_paths: ['a.html'] });
    emit?.({ root_path: '/workspace', added_paths: ['a.html'] });

    expect(panelActions.openFilePreview).toHaveBeenCalledTimes(1);
  });

  it('leaves a file unmarked when there was nowhere to show it', () => {
    panelActions.openFilePreview.mockReturnValue('unavailable');
    render(<Harness />);

    emit?.({ root_path: '/workspace', added_paths: ['a.html'] });
    emit?.({ root_path: '/workspace', added_paths: ['a.html'] });

    // The second change is the retry the first one could not perform.
    expect(panelActions.openFilePreview).toHaveBeenCalledTimes(2);
  });

  it('keeps one subscription across re-renders', () => {
    const { rerender } = render(<Harness />);
    rerender(<Harness />);
    rerender(<Harness />);

    expect(stream.subscribeFileTreeChanges).toHaveBeenCalledTimes(1);
  });

  it('tolerates a change with no added paths', () => {
    render(<Harness />);

    emit?.({ root_path: '/workspace' });

    expect(panelActions.openFilePreview).not.toHaveBeenCalled();
  });
});
