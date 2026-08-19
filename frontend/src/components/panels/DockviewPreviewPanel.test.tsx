import { fireEvent, render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerImagePreviewSource,
  releaseImagePreviewSource,
} from '@/lib/imagePreviewRegistry';

import DockviewPreviewPanel from './DockviewPreviewPanel';

const api = vi.hoisted(() => ({ resolveFileOpener: vi.fn() }));
const fileContent = vi.hoisted(() => ({
  data: '# Preview title' as string | undefined,
  isLoading: false,
  error: null as Error | null,
}));

vi.mock('@/lib/api/plugins', () => ({
  pluginControlApi: { resolveFileOpener: api.resolveFileOpener },
}));

vi.mock('@/components/previews/PluginArtifactEditor', () => ({
  PluginArtifactEditor: ({ filePath }: { filePath: string }) => (
    <div data-testid="plugin-artifact-editor">{filePath}</div>
  ),
}));

vi.mock('@monaco-editor/react', () => {
  function MockMonacoEditor({
    defaultValue,
    loading = 'Loading...',
  }: {
    defaultValue?: string;
    loading?: ReactNode;
  }) {
    const [modelValue] = useState(defaultValue);
    return (
      <div
        data-testid="monaco-editor"
        data-model-value={modelValue}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {loading}
      </div>
    );
  }

  return { default: MockMonacoEditor };
});

vi.mock('@/hooks/useFileContent', () => ({
  useFileContent: () => fileContent,
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

vi.mock('@/components/NormalizedConversation/FileContentView', () => ({
  default: () => <div data-testid="file-content-view" />,
}));

function panelProps(filePath = 'README.md'): IDockviewPanelProps {
  return {
    params: {
      filePath,
      displayPath: filePath,
      mode: 'editor',
    },
  } as unknown as IDockviewPanelProps;
}

describe('DockviewPreviewPanel', () => {
  beforeEach(() => {
    api.resolveFileOpener.mockReset().mockResolvedValue(null);
    fileContent.data = '# Preview title';
    fileContent.isLoading = false;
    fileContent.error = null;
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

  it('uses a file-specific loading state while Monaco initializes', async () => {
    render(<DockviewPreviewPanel {...panelProps()} />);

    await screen.findByTestId('monaco-editor');
    expect(
      screen.getByRole('status', { name: 'Opening README.md' })
    ).toBeVisible();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('waits for file-handler resolution before creating the Monaco model', async () => {
    let resolveFileOpener: (value: null) => void = () => undefined;
    api.resolveFileOpener.mockReturnValue(
      new Promise<null>((resolve) => {
        resolveFileOpener = resolve;
      })
    );
    fileContent.data = undefined;

    const props = panelProps('src/main.ts');
    const { rerender } = render(<DockviewPreviewPanel {...props} />);

    expect(await screen.findByText('Loading file handler...')).toBeVisible();

    fileContent.data = '# Loaded after handler resolution';
    rerender(<DockviewPreviewPanel {...props} />);
    resolveFileOpener(null);

    expect(await screen.findByTestId('monaco-editor')).toHaveAttribute(
      'data-model-value',
      '# Loaded after handler resolution'
    );
  });

  it('switches Markdown source to preview on a middle click inside Monaco', async () => {
    render(<DockviewPreviewPanel {...panelProps()} />);

    expect(await screen.findByRole('button', { name: 'Source' })).toBeVisible();

    fireEvent.mouseDown(screen.getByTestId('monaco-editor'), { button: 1 });

    expect(screen.getByRole('button', { name: 'Preview' })).toBeVisible();
  });

  it('lets a diff preview switch to the editable file view', async () => {
    render(
      <DockviewPreviewPanel
        {...({
          params: {
            filePath: 'src/App.tsx',
            displayPath: 'src/App.tsx',
            mode: 'diff',
            diffViewMode: 'inline',
          },
        } as unknown as IDockviewPanelProps)}
      />
    );

    fireEvent.click(
      await screen.findByRole('button', { name: '切换文件视图' })
    );
    expect(
      screen.getByRole('button', { name: '切换差异视图' })
    ).toBeInTheDocument();
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
