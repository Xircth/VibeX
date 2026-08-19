import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AstryxMarkdown as Markdown } from './AstryxMarkdown';

const markdownStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/conversation/conv-markdown.css'),
  'utf8'
);

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
                light: { color: 'rgb(17 17 17)' },
                dark: { color: 'rgb(238 238 238)' },
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
    <div className="legacy-design">
      <style>{markdownStyles}</style>
      <QueryClientProvider client={queryClient}>
        <Markdown
          value={value}
          taskAttemptId="workspace-1"
          workspacePath="C:/workspace/project"
          {...props}
        />
      </QueryClientProvider>
    </div>
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

  it('renders bare GFM URLs as links', () => {
    renderMarkdown('See https://example.com/docs for details.');

    const link = screen.getByRole('link', {
      name: 'https://example.com/docs',
    });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveClass('conv-resource-link');
    expect(link).toHaveAttribute('data-resource-kind', 'web');
    expect(link.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/favicon.ico'
    );
  });

  it('uses the link label as the inline baseline while centering its icon', () => {
    renderMarkdown('Plain text and [linked text](https://example.com/docs).');

    const link = screen.getByRole('link', { name: 'linked text' });
    const icon = link.querySelector('.conv-resource-link-icon');

    expect(getComputedStyle(link).alignItems).toBe('baseline');
    expect(getComputedStyle(icon as Element).alignSelf).toBe('center');
  });

  it('keeps ordered-list numbers and periods on one line', () => {
    renderMarkdown('1. first\n2. second\n10. tenth');

    const ordered = screen
      .getAllByRole('list')
      .find((list) => list.tagName === 'OL');
    const markers = ordered?.querySelectorAll(':scope > li > span:first-child');

    expect(ordered).toBeTruthy();
    expect(markers?.length).toBeGreaterThanOrEqual(2);
    for (const marker of markers ?? []) {
      const style = getComputedStyle(marker);
      expect(style.whiteSpace).toBe('nowrap');
      expect(style.width).not.toBe('12px');
      expect(style.minWidth).toBe('1.5em');
    }
    expect(getComputedStyle(ordered as Element).paddingLeft).toBe('8px');
  });

  it('keeps unordered list markers compact', () => {
    renderMarkdown('- item');

    const unordered = screen.getByRole('list');
    const marker = unordered.querySelector(':scope > li > span:first-child');

    expect(getComputedStyle(unordered).paddingLeft).toBe('2.2px');
    expect(getComputedStyle(marker as Element).width).toBe('8px');
  });

  it('leaves extra space below a horizontal rule', () => {
    const { container } = renderMarkdown('Above\n\n---\n\nBelow');
    const rule = container.querySelector('hr');

    expect(rule).not.toBeNull();
    expect(getComputedStyle(rule as Element).marginBottom).toBe('20px');
  });

  it('uses a looser line-height so adjacent inline code stays separated', () => {
    const { container } = renderMarkdown(
      'line with `one` token\n\nline with `two` token'
    );
    const root = container.querySelector('.conv-markdown');

    const lineHeight = getComputedStyle(root as Element).lineHeight;
    expect(['1.7', '22.1px']).toContain(lineHeight);
  });

  it('renders a GFM table when projected message rows contain blank gaps', () => {
    renderMarkdown(
      [
        '| Layer | Extension |',
        '',
        '| --- | --- |',
        '',
        '| Server | Services and RPC |',
        '',
        '| App | [React view](frontend/src/App.tsx) |',
      ].join('\n')
    );

    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(getComputedStyle(table).display).toBe('table');
    expect(table.closest('[role="group"][tabindex="0"]')).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Layer' })
    ).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Server' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'React view' })).toHaveAttribute(
      'data-resource-kind',
      'file'
    );
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

  it('keeps GitHub repository markdown links as web links even when the label looks like a folder', () => {
    renderMarkdown(
      '[firecrawl/open-agent-builder](https://github.com/firecrawl/open-agent-builder)'
    );

    const link = screen.getByRole('link', {
      name: 'firecrawl/open-agent-builder',
    });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/firecrawl/open-agent-builder'
    );
    expect(link).toHaveAttribute('data-resource-kind', 'web');
    fireEvent.click(link);
    expect(panelActionsMock.revealInFileTree).not.toHaveBeenCalled();
    expect(panelActionsMock.openFilePreview).not.toHaveBeenCalled();
  });

  it('turns GitHub owner/repo inline code into a repository link', () => {
    renderMarkdown('See `escapeboy/agent-fleet-o`');

    const link = screen.getByRole('link', { name: 'escapeboy/agent-fleet-o' });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/escapeboy/agent-fleet-o'
    );
    expect(link).toHaveAttribute('data-resource-kind', 'web');
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

    const link = screen.getByRole('link', { name: 'manager.rs' });
    expect(link).toHaveClass('conv-resource-link');
    expect(link).toHaveAttribute('data-resource-kind', 'file');
    const fileIcon = link.querySelector('[data-resource-icon="file"] svg');
    expect(fileIcon).toBeInTheDocument();
    const paintedIconPart = fileIcon?.querySelector(
      '[fill]:not([fill="none"])'
    );
    expect(getComputedStyle(paintedIconPart as Element).fill).toBe(
      'currentcolor'
    );
    fireEvent.click(link);

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/crates/agents/src/manager.rs',
      {
        displayPath: 'crates/agents/src/manager.rs',
        title: 'crates/agents/src/manager.rs',
      }
    );
  });

  it('opens workspace links with the keyboard', () => {
    renderMarkdown('[manager.rs](crates/agents/src/manager.rs)');

    fireEvent.keyDown(screen.getByRole('link', { name: 'manager.rs' }), {
      key: 'Enter',
    });

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

  it('preserves POSIX absolute file hrefs without joining the workspace twice', () => {
    renderMarkdown(
      '[events.rs](/Users/mac/Projects/VibeX/src-tauri/src/events.rs)',
      { workspacePath: '/Users/mac/Projects/VibeX' }
    );

    fireEvent.click(screen.getByRole('link', { name: 'events.rs' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      '/Users/mac/Projects/VibeX/src-tauri/src/events.rs',
      {
        displayPath: 'src-tauri/src/events.rs',
        title: 'src-tauri/src/events.rs',
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

    fireEvent.click(screen.getByRole('link', { name: 'frontend/src/App.tsx' }));

    expect(panelActionsMock.openFilePreview).toHaveBeenCalledWith(
      'C:/workspace/project/frontend/src/App.tsx',
      {
        displayPath: 'frontend/src/App.tsx',
        title: 'frontend/src/App.tsx',
      }
    );
  });

  it('opens inline code file paths with the keyboard', () => {
    renderMarkdown('Open `frontend/src/App.tsx`');

    const code = screen.getByRole('link', {
      name: 'frontend/src/App.tsx',
    });
    fireEvent.keyDown(code, { key: 'Enter' });

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
      '--shiki-token-light: rgb(17 17 17)'
    );
    expect(token.getAttribute('style')).toContain(
      '--shiki-token-dark: rgb(238 238 238)'
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

  it('renders inline and display math through KaTeX', async () => {
    const { container } = renderMarkdown(String.raw`Euler $e^{i\pi}+1=0$

$$
\int_0^1 x^2 dx
$$`);

    await waitFor(() => {
      expect(container.querySelector('.katex')).toBeInTheDocument();
    });
    expect(container.querySelector('.katex-display')).toBeInTheDocument();
  });

  it('normalizes TeX math delimiters without changing fenced code', async () => {
    const { container } = renderMarkdown(
      'Inline \\(a+b\\)\n\n\\[\nc=d\n\\]\n\n```ts\nconst raw = "\\\\(not math\\\\)";\n```'
    );

    await waitFor(() => {
      expect(container.querySelector('.katex')).toBeInTheDocument();
    });
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
