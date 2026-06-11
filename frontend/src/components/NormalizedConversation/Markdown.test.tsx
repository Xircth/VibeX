import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Markdown } from './Markdown';

const panelActionsMock = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
  revealInFileTree: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => panelActionsMock,
}));

vi.mock('@/components/dialogs/wysiwyg/ImagePreviewDialog', () => ({
  ImagePreviewDialog: {
    show: vi.fn(),
  },
}));

function renderMarkdown(value: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <Markdown
        value={value}
        taskAttemptId="workspace-1"
        workspacePath="C:/workspace/project"
      />
    </QueryClientProvider>
  );
}

describe('Markdown', () => {
  beforeEach(() => {
    panelActionsMock.openFilePreview.mockClear();
    panelActionsMock.revealInFileTree.mockClear();
  });

  it('renders remote markdown images inline', () => {
    renderMarkdown('![Generated image](https://example.com/image.png)');

    const image = screen.getByRole('img', { name: 'Generated image' });
    expect(image).toHaveAttribute('src', 'https://example.com/image.png');
  });

  it('renders data-uri markdown images inline', () => {
    renderMarkdown('![Generated image](<data:image/png;base64,abc123>)');

    const image = screen.getByRole('img', { name: 'Generated image' });
    expect(image).toHaveAttribute('src', 'data:image/png;base64,abc123');
  });

  it('renders relative workspace images through the Tauri file asset URL', () => {
    renderMarkdown('![Mockup](outputs/mockup.png)');

    const image = screen.getByRole('img', { name: 'Mockup' });
    expect(image).toHaveAttribute(
      'src',
      'asset://C:/workspace/project/outputs/mockup.png'
    );
  });

  it('renders bare image paths inline', () => {
    renderMarkdown('outputs/mockup.png');

    const image = screen.getByRole('img', { name: 'mockup.png' });
    expect(image).toHaveAttribute(
      'src',
      'asset://C:/workspace/project/outputs/mockup.png'
    );
  });

  it('opens file-looking links in the workspace editor instead of navigating project routes', () => {
    renderMarkdown(
      '[frontend/src/App.tsx](http://127.0.0.1:3002/local-projects/project-1/sessions)'
    );

    fireEvent.click(screen.getByRole('link', { name: 'frontend/src/App.tsx' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/App.tsx',
      {
        displayPath: 'frontend/src/App.tsx',
        title: 'frontend/src/App.tsx',
      }
    );
  });

  it('opens relative file hrefs in the workspace editor instead of navigating the page', () => {
    renderMarkdown('[manager.rs](crates/agents/src/manager.rs)');

    fireEvent.click(screen.getByRole('link', { name: 'manager.rs' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/crates/agents/src/manager.rs',
      {
        displayPath: 'crates/agents/src/manager.rs',
        title: 'crates/agents/src/manager.rs',
      }
    );
  });

  it('opens same-origin URL paths as workspace files instead of browser URLs', () => {
    renderMarkdown(
      '[manager.rs](http://127.0.0.1:3002/crates/agents/src/manager.rs)'
    );

    fireEvent.click(screen.getByRole('link', { name: 'manager.rs' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/crates/agents/src/manager.rs',
      {
        displayPath: 'crates/agents/src/manager.rs',
        title: 'crates/agents/src/manager.rs',
      }
    );
  });

  it('opens web-root file paths as workspace-relative files on Windows', () => {
    renderMarkdown('[manager.rs](/crates/agents/src/manager.rs)');

    fireEvent.click(screen.getByRole('link', { name: 'manager.rs' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/crates/agents/src/manager.rs',
      {
        displayPath: 'crates/agents/src/manager.rs',
        title: 'crates/agents/src/manager.rs',
      }
    );
  });

  it('opens file-looking links with empty hrefs in the workspace editor', () => {
    renderMarkdown('[PRD/english-video-review-extension-prd.md]()');

    fireEvent.click(
      screen.getByRole('link', {
        name: 'PRD/english-video-review-extension-prd.md',
      })
    );

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/PRD/english-video-review-extension-prd.md',
      {
        displayPath: 'PRD/english-video-review-extension-prd.md',
        title: 'PRD/english-video-review-extension-prd.md',
      }
    );
  });

  it('reveals directory-looking links with empty hrefs in the file tree', () => {
    renderMarkdown('[frontend/src/components]()');

    fireEvent.click(
      screen.getByRole('link', { name: 'frontend/src/components' })
    );

    expect(panelActionsMock.revealInFileTree).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/components',
      {
        displayPath: 'frontend/src/components',
        nodeType: 'folder',
      }
    );
  });

  it('reveals absolute directory links in the file tree instead of opening them as files', () => {
    renderMarkdown('[C:/workspace/project/frontend/src/components]()');

    fireEvent.click(
      screen.getByRole('link', {
        name: 'C:/workspace/project/frontend/src/components',
      })
    );

    expect(panelActionsMock.revealInFileTree).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/components',
      {
        displayPath: 'frontend/src/components',
        nodeType: 'folder',
      }
    );
    expect(panelActionsMock.openFilePreview).not.toHaveBeenCalled();
  });

  it('renders placeholder document hrefs without browser navigation targets', () => {
    renderMarkdown('[文件名称](path_to_document)');

    const link = screen.getByRole('link', { name: '文件名称' });

    expect(link).not.toHaveAttribute('href');
    fireEvent.click(link);
    expect(panelActionsMock.openFilePreview).not.toHaveBeenCalled();
  });

  it('opens inline code file paths in the workspace editor', () => {
    renderMarkdown('Open `frontend/src/App.tsx`');

    fireEvent.click(screen.getByRole('button', { name: 'frontend/src/App.tsx' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/App.tsx',
      {
        displayPath: 'frontend/src/App.tsx',
        title: 'frontend/src/App.tsx',
      }
    );
  });
});
