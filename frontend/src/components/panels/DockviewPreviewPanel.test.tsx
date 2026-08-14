import { fireEvent, render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerImagePreviewSource,
  releaseImagePreviewSource,
} from '@/lib/imagePreviewRegistry';

import DockviewPreviewPanel from './DockviewPreviewPanel';

const api = vi.hoisted(() => ({ resolveFileOpener: vi.fn() }));

vi.mock('@/lib/api/plugins', () => ({
  pluginControlApi: { resolveFileOpener: api.resolveFileOpener },
}));

vi.mock('@/components/previews/PluginArtifactEditor', () => ({
  PluginArtifactEditor: ({ filePath }: { filePath: string }) => (
    <div data-testid="plugin-artifact-editor">{filePath}</div>
  ),
}));

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
  beforeEach(() => {
    api.resolveFileOpener.mockReset().mockResolvedValue(null);
  });

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

  it('switches Markdown source to preview on a middle click inside Monaco', async () => {
    render(<DockviewPreviewPanel {...panelProps()} />);

    expect(await screen.findByRole('button', { name: 'Source' })).toBeVisible();

    fireEvent.mouseDown(screen.getByTestId('monaco-editor'), { button: 1 });

    expect(screen.getByRole('button', { name: 'Preview' })).toBeVisible();
  });

  it('mounts an App-backed file opener as the editable file tab', async () => {
    api.resolveFileOpener.mockResolvedValue({
      pluginId: 'vibex.drawio',
      contributionId: 'drawio-files',
      label: 'Drawio editor',
      handler: 'drawio-editor',
      target: 'app_surface',
      priority: 100,
      generation: 7,
    });

    render(
      <DockviewPreviewPanel
        {...({
          params: {
            filePath: 'architecture.drawio',
            displayPath: 'architecture.drawio',
            mode: 'editor',
          },
        } as unknown as IDockviewPanelProps)}
      />
    );

    expect(
      await screen.findByTestId('plugin-artifact-editor')
    ).toHaveTextContent('/workspace/architecture.drawio');
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument();
  });
});
