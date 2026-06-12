import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Markdown } from './Markdown';

const panelActionsMock = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
  revealInFileTree: vi.fn(),
}));

const clipboardMock = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

const shikiMock = vi.hoisted(() => {
  const loadLanguage = vi.fn(async () => undefined);
  const codeToTokensWithThemes = vi.fn((code: string) =>
    code.split('\n').map((line) =>
      line
        ? [
            {
              content: line,
              offset: 0,
              variants: {
                light: { color: '#111111' },
                dark: { color: '#eeeeee' },
              },
            },
          ]
        : []
    )
  );
  const createHighlighter = vi.fn(async () => ({
    loadLanguage,
    codeToTokensWithThemes,
  }));

  return {
    codeToTokensWithThemes,
    createHighlighter,
    loadLanguage,
  };
});

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Mock diagram</text></svg>',
  })),
}));

vi.mock('shiki', () => ({
  bundledLanguages: {
    bash: {},
    css: {},
    diff: {},
    html: {},
    javascript: {},
    json: {},
    markdown: {},
    python: {},
    rust: {},
    tsx: {},
    typescript: {},
    yaml: {},
  },
  createHighlighter: shikiMock.createHighlighter,
}));

vi.mock('mermaid', () => ({
  default: mermaidMock,
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

function renderMarkdown(
  value: string,
  props: Partial<ComponentProps<typeof Markdown>> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Markdown
        value={value}
        taskAttemptId="workspace-1"
        workspacePath="C:/workspace/project"
        {...props}
      />
    </QueryClientProvider>
  );
}

describe('Markdown', () => {
  beforeEach(() => {
    panelActionsMock.openFilePreview.mockClear();
    panelActionsMock.revealInFileTree.mockClear();
    shikiMock.createHighlighter.mockClear();
    shikiMock.codeToTokensWithThemes.mockClear();
    shikiMock.loadLanguage.mockClear();
    mermaidMock.initialize.mockClear();
    mermaidMock.render.mockClear();
    mermaidMock.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Mock diagram</text></svg>',
    });
    clipboardMock.writeText.mockReset();
    clipboardMock.writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: clipboardMock,
    });
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

    fireEvent.click(
      screen.getByRole('button', { name: 'frontend/src/App.tsx' })
    );

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/App.tsx',
      {
        displayPath: 'frontend/src/App.tsx',
        title: 'frontend/src/App.tsx',
      }
    );
  });

  it('renders fenced code through Shiki token spans instead of injected html', async () => {
    renderMarkdown('```ts\nconst answer = 42;\nconsole.log(answer);\n```');

    expect(screen.getByText('ts')).toBeInTheDocument();
    await waitFor(() =>
      expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
        'const answer = 42;\nconsole.log(answer);',
        expect.objectContaining({
          lang: 'typescript',
          themes: {
            light: 'github-light',
            dark: 'github-dark-default',
          },
        })
      )
    );

    const token = screen.getByText('const answer = 42;');
    expect(token).toHaveClass('conv-md-token');
    expect(token.getAttribute('style')).toContain(
      '--shiki-token-light: #111111'
    );
    expect(token.getAttribute('style')).toContain(
      '--shiki-token-dark: #eeeeee'
    );
  });

  it('keeps unknown fenced languages readable as plain text', async () => {
    renderMarkdown('```madeup\nplain output\nnext line\n```');

    expect(screen.getByText('madeup')).toBeInTheDocument();
    await waitFor(() =>
      expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
        'plain output\nnext line',
        expect.objectContaining({
          lang: 'text',
        })
      )
    );
    expect(screen.getByText('plain output')).toBeInTheDocument();
  });

  it('renders inline and display math through KaTeX', () => {
    const { container } = renderMarkdown(String.raw`Euler $e^{i\pi}+1=0$

$$
\int_0^1 x^2 dx
$$`);

    expect(container.querySelector('.katex')).toBeInTheDocument();
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
  });

  it('normalizes TeX math delimiters without changing fenced code', async () => {
    const { container } = renderMarkdown(
      'Inline \\(a+b\\)\n\n\\[\nc=d\n\\]\n\n```ts\nconst raw = "\\\\(not math\\\\)";\n```'
    );

    expect(container.querySelector('.katex')).toBeInTheDocument();
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
    await waitFor(() =>
      expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
        'const raw = "\\\\(not math\\\\)";',
        expect.objectContaining({ lang: 'typescript' })
      )
    );
  });

  it('renders user soft breaks without changing paragraph spacing globally', () => {
    const { container } = renderMarkdown('first line\nsecond line', {
      softBreaks: true,
    });

    expect(container.querySelector('br')).toBeInTheDocument();
  });

  it('keeps incomplete Mermaid fences as readable code while streaming', async () => {
    renderMarkdown('```mermaid\ngraph TD\nA-->B');

    await waitFor(() =>
      expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
        'graph TD\nA-->B',
        expect.objectContaining({ lang: 'text' })
      )
    );
    expect(mermaidMock.render).not.toHaveBeenCalled();
  });

  it('renders Mermaid fenced blocks as diagrams instead of code blocks', async () => {
    renderMarkdown('```mermaid\ngraph TD\nA-->B\n```');

    await waitFor(() =>
      expect(mermaidMock.render).toHaveBeenCalledWith(
        expect.stringMatching(/^mermaid-/),
        'graph TD\nA-->B'
      )
    );

    const image = await screen.findByRole('img', { name: /Mermaid/ });
    expect(image).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/svg+xml;charset=utf-8,')
    );
    expect(screen.queryByText('mermaid')).not.toBeInTheDocument();
  });

  it('keeps Mermaid source inspectable when rendering fails', async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error('bad diagram'));

    renderMarkdown('```mermaid\ngraph TD\nA-->B\n```');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('\u56fe\u8868\u6e32\u67d3\u5931\u8d25');
    expect(alert).toHaveTextContent('graph TD');
    expect(alert).toHaveTextContent('A-->B');
  });

  it('copies the original fenced code text', async () => {
    renderMarkdown('```ts\nconst answer = 42;\nconsole.log(answer);\n```');

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));

    await waitFor(() =>
      expect(clipboardMock.writeText).toHaveBeenCalledWith(
        'const answer = 42;\nconsole.log(answer);'
      )
    );
  });
});
