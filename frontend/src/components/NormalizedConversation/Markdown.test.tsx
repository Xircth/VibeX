import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Markdown } from './Markdown';

const panelActionsMock = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
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
  });

  it('renders remote markdown images inline', () => {
    renderMarkdown('![Generated image](https://example.com/image.png)');

    const image = screen.getByRole('img', { name: 'Generated image' });
    expect(image).toHaveAttribute('src', 'https://example.com/image.png');
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
