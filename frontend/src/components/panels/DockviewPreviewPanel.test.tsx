import { fireEvent, render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  registerImagePreviewSource,
  releaseImagePreviewSource,
} from '@/lib/imagePreviewRegistry';

import DockviewPreviewPanel from './DockviewPreviewPanel';

vi.mock('@monaco-editor/react', () => ({
  default: ({ loading = 'Loading...' }: { loading?: ReactNode }) => (
    <div
      data-testid="monaco-editor"
      onMouseDown={(event) => event.stopPropagation()}
    >
      {loading}
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
  it('resolves transient conversation images without serializing their data', () => {
    const previewId = 'image:test-preview';
    registerImagePreviewSource(previewId, 'data:image/png;base64,AAAA');

    render(
      <DockviewPreviewPanel
        {...({
          params: {
            filePath: '',
            displayPath: 'generated.png',
            imagePreviewId: previewId,
          },
        } as unknown as IDockviewPanelProps)}
      />
    );

    expect(screen.getByRole('img', { name: 'generated.png' })).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAA'
    );
    releaseImagePreviewSource(previewId);
  });

  it('uses a file-specific loading state while Monaco initializes', () => {
    render(<DockviewPreviewPanel {...panelProps()} />);

    expect(
      screen.getByRole('status', { name: 'Opening README.md' })
    ).toBeVisible();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('switches Markdown source to preview on a middle click inside Monaco', () => {
    render(<DockviewPreviewPanel {...panelProps()} />);

    expect(screen.getByRole('button', { name: 'Source' })).toBeVisible();

    fireEvent.mouseDown(screen.getByTestId('monaco-editor'), { button: 1 });

    expect(screen.getByRole('button', { name: 'Preview' })).toBeVisible();
  });
});
