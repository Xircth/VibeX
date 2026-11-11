import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppContextMenuHost } from '@/components/context-menu';
import { registerCanvasWorkspaceController } from '@/components/kanban/canvas/canvasWorkspaceBridge';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import { fileTreeApi } from '../../lib/api';
import { FileTreePanel } from './FileTreePanel';

vi.mock('../../lib/api', () => ({
  desktopApi: {
    openPath: vi.fn(),
    revealInFileManager: vi.fn(),
  },
  fileTreeApi: {
    copyItem: vi.fn(),
    createDirectory: vi.fn(),
    getTree: vi.fn(),
    listDirectoryChildren: vi.fn(),
    moveItem: vi.fn(),
    saveFile: vi.fn(),
    searchText: vi.fn(),
    trashItem: vi.fn(),
  },
}));

function renderTree(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AppContextMenuHost>{element}</AppContextMenuHost>
    </QueryClientProvider>
  );
}

describe('FileTreePanel drag-to-canvas', () => {
  const dropPanelAt = vi.fn();
  let unregisterController: (() => void) | null = null;
  let canvasSurface: HTMLDivElement | null = null;
  const originalElementFromPoint = document.elementFromPoint;

  beforeEach(() => {
    dropPanelAt.mockReset();
    vi.mocked(fileTreeApi.getTree).mockReset();
    vi.mocked(fileTreeApi.getTree).mockResolvedValue([
      {
        name: 'readme.md',
        path: 'readme.md',
        is_dir: false,
        children: null,
        git_status: null,
      },
    ]);
    unregisterController = registerCanvasWorkspaceController({
      openOrFocusSession: vi.fn(),
      dropSessionAt: vi.fn(),
      openOrFocusPanel: vi.fn(),
      dropPanelAt,
      closeNode: vi.fn(),
      closeOtherNodes: vi.fn(),
      closeAllNodes: vi.fn(),
      duplicateNode: vi.fn(),
    });
    canvasSurface = document.createElement('div');
    canvasSurface.className = 'canvas-surface';
    document.body.appendChild(canvasSurface);
    document.elementFromPoint = vi.fn(() => canvasSurface);
  });

  afterEach(() => {
    unregisterController?.();
    unregisterController = null;
    canvasSurface?.remove();
    canvasSurface = null;
    document.elementFromPoint = originalElementFromPoint;
  });

  it('drops a file preview panel node when a file row is dragged onto the Infinite Canvas', async () => {
    renderTree(
      <FileTreePanel
        workspacePath="/repo"
        files={['readme.md']}
        directories={[]}
        isLoading={false}
      />
    );

    const fileRow = await screen.findByRole('button', { name: 'readme.md' });

    fireEvent.pointerDown(fileRow, {
      button: 0,
      clientX: 40,
      clientY: 60,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, {
      clientX: 380,
      clientY: 260,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, {
      clientX: 380,
      clientY: 260,
      pointerId: 1,
    });

    await waitFor(() => {
      expect(dropPanelAt).toHaveBeenCalledWith(
        {
          id: 'file:/repo/readme.md',
          component: PANEL_IDS.PREVIEW,
          title: 'readme.md',
          params: { filePath: '/repo/readme.md' },
          expanded: true,
        },
        { x: 380, y: 260 }
      );
    });
  });
});
