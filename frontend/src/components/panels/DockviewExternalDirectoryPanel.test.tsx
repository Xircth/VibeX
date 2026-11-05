import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalDirectoryPanelParams } from '@/types/panels';
import DockviewExternalDirectoryPanel from './DockviewExternalDirectoryPanel';

const mocks = vi.hoisted(() => ({
  listDir: vi.fn(),
  revealInFileManager: vi.fn(),
  resolveFileOpener: vi.fn(),
  openFilePreview: vi.fn(),
}));

vi.mock('@/lib/api/misc', () => ({
  fileSystemApi: {
    list: mocks.listDir,
  },
  desktopApi: {
    revealInFileManager: mocks.revealInFileManager,
  },
}));

vi.mock('@/lib/api/plugins', () => ({
  pluginControlApi: {
    resolveFileOpener: mocks.resolveFileOpener,
  },
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => ({
    openFilePreview: mocks.openFilePreview,
  }),
}));

function buildPanelProps(
  params: ExternalDirectoryPanelParams
): IDockviewPanelProps<ExternalDirectoryPanelParams> {
  return {
    params,
    api: {} as IDockviewPanelProps<ExternalDirectoryPanelParams>['api'],
    containerApi:
      {} as IDockviewPanelProps<ExternalDirectoryPanelParams>['containerApi'],
  };
}

describe('DockviewExternalDirectoryPanel', () => {
  beforeEach(() => {
    mocks.listDir.mockReset();
    mocks.revealInFileManager.mockReset();
    mocks.resolveFileOpener.mockReset();
    mocks.openFilePreview.mockReset();
    mocks.revealInFileManager.mockResolvedValue(undefined);
    mocks.resolveFileOpener.mockResolvedValue(null);
    mocks.listDir.mockImplementation(async (dirPath: string) => {
      if (dirPath === '/Users/alex/Downloads/spec-assets') {
        return {
          current_path: '/Users/alex/Downloads/spec-assets',
          entries: [
            {
              name: 'wireframes',
              path: '/Users/alex/Downloads/spec-assets/wireframes',
              is_directory: true,
              is_git_repo: false,
              last_modified: 1711879200,
              size_bytes: null,
              created_at_ms: 1711879200000,
              modified_at_ms: 1711879200000,
            },
            {
              name: 'architecture-overview.md',
              path: '/Users/alex/Downloads/spec-assets/architecture-overview.md',
              is_directory: false,
              is_git_repo: false,
              last_modified: 1711879200,
              size_bytes: 18432,
              created_at_ms: 1711584000000,
              modified_at_ms: 1711879200000,
            },
            {
              name: 'release-bundle.zip',
              path: '/Users/alex/Downloads/spec-assets/release-bundle.zip',
              is_directory: false,
              is_git_repo: false,
              last_modified: 1711879200,
              size_bytes: 1048576,
              created_at_ms: 1711584000000,
              modified_at_ms: 1711879200000,
            },
          ],
        };
      }
      if (dirPath === '/Users/alex/Downloads/spec-assets/wireframes') {
        return {
          current_path: '/Users/alex/Downloads/spec-assets/wireframes',
          entries: [
            {
              name: 'flow-diagram.png',
              path: '/Users/alex/Downloads/spec-assets/wireframes/flow-diagram.png',
              is_directory: false,
              is_git_repo: false,
              last_modified: 1711879200,
              size_bytes: 4096,
              created_at_ms: 1711584000000,
              modified_at_ms: 1711879200000,
            },
          ],
        };
      }
      return { current_path: dirPath, entries: [] };
    });
  });

  it('loads the root directory in the first column and opens the current folder in file manager from toolbar', async () => {
    render(
      <DockviewExternalDirectoryPanel
        {...buildPanelProps({
          rootPath: '/Users/alex/Downloads/spec-assets',
        })}
      />
    );

    expect(await screen.findByText('wireframes')).toBeInTheDocument();
    expect(screen.getByText('architecture-overview.md')).toBeInTheDocument();
    expect(mocks.listDir).toHaveBeenCalledWith(
      '/Users/alex/Downloads/spec-assets'
    );

    const openFolderBtn = screen.getByRole('button', {
      name: /在文件夹中打开|Open in Folder/i,
    });
    fireEvent.click(openFolderBtn);
    expect(mocks.revealInFileManager).toHaveBeenCalledWith(
      '/Users/alex/Downloads/spec-assets'
    );
  });

  it('expands a second column when clicking a subfolder and shows file Information + Open in Tab for previewable files', async () => {
    render(
      <DockviewExternalDirectoryPanel
        {...buildPanelProps({
          rootPath: '/Users/alex/Downloads/spec-assets',
        })}
      />
    );

    const subfolderItem = await screen.findByText('wireframes');
    fireEvent.click(subfolderItem);

    expect(await screen.findByText('flow-diagram.png')).toBeInTheDocument();
    expect(mocks.listDir).toHaveBeenCalledWith(
      '/Users/alex/Downloads/spec-assets/wireframes'
    );

    // Clicking a previewable markdown file shows Information metadata and "Open in Tab" button
    fireEvent.click(screen.getByText('architecture-overview.md'));

    await waitFor(() => {
      expect(screen.getByText('18 KB')).toBeInTheDocument();
    });
    expect(screen.getAllByText('MD Document').length).toBeGreaterThanOrEqual(1);

    const openInTabBtn = screen.getByRole('button', {
      name: /在标签页打开|Open in Tab/i,
    });
    fireEvent.click(openInTabBtn);
    expect(mocks.openFilePreview).toHaveBeenCalledWith(
      '/Users/alex/Downloads/spec-assets/architecture-overview.md',
      {
        title: 'architecture-overview.md',
        displayPath:
          '/Users/alex/Downloads/spec-assets/architecture-overview.md',
      }
    );

    // Clicking a binary zip file shows Information metadata without "Open in Tab"
    fireEvent.click(screen.getByText('release-bundle.zip'));
    await waitFor(() => {
      expect(screen.getByText('1.0 MB')).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: /在标签页打开|Open in Tab/i })
    ).not.toBeInTheDocument();
  });
});
