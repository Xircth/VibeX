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
const platform = vi.hoisted(() => ({ isTauriDesktopShell: vi.fn(() => true) }));
const fileContent = vi.hoisted(() => ({
  data: '# Preview title' as string | undefined,
  isLoading: false,
  error: null as Error | null,
}));

vi.mock('@/lib/api/plugins', () => ({
  pluginControlApi: { resolveFileOpener: api.resolveFileOpener },
}));

vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform')>()),
  isTauriDesktopShell: platform.isTauriDesktopShell,
}));

vi.mock('@/components/previews/HostHtmlPreview', () => ({
  HostHtmlPreview: ({
    filePath,
    assetRoot,
    displayPath,
  }: {
    filePath: string;
    assetRoot: string;
    displayPath: string;
  }) => (
    <div
      data-testid="host-html-preview"
      data-file-path={filePath}
      data-asset-root={assetRoot}
      data-display-path={displayPath}
    />
  ),
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

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock('@/components/NormalizedConversation/AstryxMarkdown', () => ({
  default: ({
    value,
    workspacePath,
  }: {
    value?: string;
    workspacePath?: string | null;
  }) => (
    <div
      data-testid="astryx-markdown"
      data-value={value}
      data-workspace-path={workspacePath ?? ''}
    />
  ),
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
    platform.isTauriDesktopShell.mockReturnValue(true);
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

  it('renders markdown preview relative to the file directory', async () => {
    render(<DockviewPreviewPanel {...panelProps('docs/guide.md')} />);

    await screen.findByRole('button', { name: 'Source' });
    fireEvent.mouseDown(screen.getByTestId('monaco-editor'), { button: 1 });

    const markdown = await screen.findByTestId('astryx-markdown');
    expect(markdown).toHaveAttribute('data-workspace-path', '/workspace/docs');
    expect(markdown).toHaveAttribute('data-value', '# Preview title');
  });

  it('opens an HTML file in the rendered preview instead of its source', async () => {
    render(<DockviewPreviewPanel {...panelProps('docs/page.html')} />);

    // The whole workspace is granted so `../` references stay reachable.
    expect(await screen.findByTestId('host-html-preview')).toHaveAttribute(
      'data-asset-root',
      '/workspace'
    );
    expect(screen.queryByTestId('monaco-editor')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeVisible();
  });

  it('switches an HTML file back to source and to preview again', async () => {
    render(<DockviewPreviewPanel {...panelProps('docs/page.html')} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));

    const editor = await screen.findByTestId('monaco-editor');
    expect(screen.getByRole('button', { name: 'Source' })).toBeVisible();
    expect(screen.queryByTestId('host-html-preview')).not.toBeInTheDocument();

    fireEvent.mouseDown(editor, { button: 1 });

    expect(await screen.findByTestId('host-html-preview')).toHaveAttribute(
      'data-file-path',
      '/workspace/docs/page.html'
    );
    expect(screen.getByRole('button', { name: 'Preview' })).toBeVisible();
  });

  it('remembers the chosen view per HTML file', async () => {
    const first = panelProps('docs/page.html');
    const { rerender } = render(<DockviewPreviewPanel {...first} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    await screen.findByTestId('monaco-editor');

    rerender(<DockviewPreviewPanel {...panelProps('docs/other.html')} />);

    // A file that was never toggled still opens rendered; the choice above
    // belongs to the first file alone.
    expect(await screen.findByTestId('host-html-preview')).toHaveAttribute(
      'data-file-path',
      '/workspace/docs/other.html'
    );

    rerender(<DockviewPreviewPanel {...first} />);
    expect(await screen.findByTestId('monaco-editor')).toBeInTheDocument();
  });

  it('keeps HTML as source where no local webview can serve it', async () => {
    platform.isTauriDesktopShell.mockReturnValue(false);

    render(<DockviewPreviewPanel {...panelProps('docs/page.html')} />);

    expect(await screen.findByTestId('monaco-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('host-html-preview')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Preview' })
    ).not.toBeInTheDocument();
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
