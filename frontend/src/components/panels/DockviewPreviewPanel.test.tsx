import { fireEvent, render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { describe, expect, it, vi } from 'vitest';

import DockviewPreviewPanel from './DockviewPreviewPanel';

vi.mock('@monaco-editor/react', () => ({
  default: () => (
    <div
      data-testid="monaco-editor"
      onMouseDown={(event) => event.stopPropagation()}
    >
      Markdown source
    </div>
  ),
}));

vi.mock('@/hooks/useFileContent', () => ({
  useFileContent: () => ({
    data: '# Preview title',
    isLoading: false,
    error: null,
  }),
  useFileAtHead: () => ({
    data: null,
    isLoading: false,
    error: null,
  }),
  useDocumentPreview: () => ({
    data: null,
    isLoading: false,
    error: null,
  }),
  useBinaryAssetPreview: () => ({
    assetUrl: null,
    isLoading: false,
    error: null,
  }),
  useSaveFile: () => ({
    mutate: vi.fn(),
  }),
}));

vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('@/stores/useFileTreeStore', () => ({
  useFileTreeStore: (
    selector: (state: { rootPath: string }) => unknown
  ): unknown => selector({ rootPath: '/workspace' }),
}));

function panelProps(): IDockviewPanelProps {
  return {
    params: {
      filePath: 'README.md',
      displayPath: 'README.md',
      mode: 'editor',
    },
  } as unknown as IDockviewPanelProps;
}

describe('DockviewPreviewPanel', () => {
  it('switches Markdown source to preview on a middle click inside Monaco', () => {
    render(<DockviewPreviewPanel {...panelProps()} />);

    expect(screen.getByRole('button', { name: 'Source' })).toBeVisible();

    fireEvent.mouseDown(screen.getByTestId('monaco-editor'), { button: 1 });

    expect(screen.getByRole('button', { name: 'Preview' })).toBeVisible();
  });
});
