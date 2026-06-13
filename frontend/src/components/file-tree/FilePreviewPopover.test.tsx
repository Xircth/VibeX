import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FilePreviewPopover } from './FilePreviewPopover';

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

const CLOSE_PREVIEW_LABEL = '\u5173\u95ed\u9884\u89c8';
const IMAGE_PREVIEW_LABEL = '\u56fe\u7247\u9884\u89c8';
const NO_SELECTION_LABEL = '\u672a\u9009\u62e9\u884c';
const LOADING_FILE_LABEL = '\u6b63\u5728\u52a0\u8f7d\u6587\u4ef6...';
const CLEAR_SELECTION_LABEL = '\u6e05\u9664\u9009\u62e9';
const ADD_TO_CHAT_LABEL = '\u6dfb\u52a0\u5230\u804a\u5929';
const SELECTION_HINTS_LABEL = '\u9009\u62e9\u63d0\u793a';

const defaultProps = {
  path: 'src/index.ts',
  absolutePath: '/repo/src/index.ts',
  content: 'const value = 1;',
  truncated: false,
  selection: null,
  onSelectLine: vi.fn(),
  onClearSelection: vi.fn(),
  onAddSelection: vi.fn(),
  onClose: vi.fn(),
};

describe('FilePreviewPopover', () => {
  beforeEach(() => {
    shikiMock.createHighlighter.mockClear();
    shikiMock.codeToTokensWithThemes.mockClear();
    shikiMock.loadLanguage.mockClear();
  });

  it('renders readable text preview labels and actions', () => {
    render(
      <FilePreviewPopover
        {...defaultProps}
        content=""
        selectionHints={['Shift+\u70b9\u51fb\u6269\u5c55\u9009\u62e9']}
      />
    );

    expect(screen.getByText(NO_SELECTION_LABEL)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: CLOSE_PREVIEW_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: CLEAR_SELECTION_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: ADD_TO_CHAT_LABEL })
    ).toBeInTheDocument();
    expect(screen.getByLabelText(SELECTION_HINTS_LABEL)).toBeInTheDocument();
  });

  it('renders readable loading and image preview labels', () => {
    const { rerender } = render(
      <FilePreviewPopover {...defaultProps} content="" isLoading={true} />
    );

    expect(screen.getByText(LOADING_FILE_LABEL)).toBeInTheDocument();

    rerender(
      <FilePreviewPopover
        {...defaultProps}
        previewKind="image"
        imageSrc="blob:image"
      />
    );

    expect(screen.getByText(IMAGE_PREVIEW_LABEL)).toBeInTheDocument();
  });

  it('renders file preview code through Shiki token spans', async () => {
    render(<FilePreviewPopover {...defaultProps} />);

    await waitFor(() =>
      expect(shikiMock.codeToTokensWithThemes).toHaveBeenCalledWith(
        'const value = 1;',
        expect.objectContaining({
          lang: 'typescript',
        })
      )
    );

    const token = screen.getByText('const value = 1;');
    expect(token).toHaveClass('file-preview-token');
    expect(token.getAttribute('style')).toContain(
      '--shiki-token-light: rgb(17 17 17)'
    );
    expect(token.getAttribute('style')).toContain(
      '--shiki-token-dark: rgb(238 238 238)'
    );
  });
});
