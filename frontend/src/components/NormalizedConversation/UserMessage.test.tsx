import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatSessionComposerCommand,
  insertPreviewElementToken,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import UserMessage from './UserMessage';
import { UserMessageAttachments } from './UserMessageImageAttachment';

const imageMocks = vi.hoisted(() => ({
  showPreview: vi.fn(),
  useImageMetadata: vi.fn(),
  hostFileSrc: vi.fn(),
}));

vi.mock('@/components/dialogs/wysiwyg/ImagePreviewDialog', () => ({
  ImagePreviewDialog: { show: imageMocks.showPreview },
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({ capabilities: {} }),
}));

vi.mock('@/contexts/RetryUiContext', () => ({
  useRetryUi: () => ({
    activeRetryProcessId: null,
    setActiveRetryProcessId: vi.fn(),
    isProcessGreyed: () => false,
  }),
}));

vi.mock('@/hooks/useAttemptExecution', () => ({
  useAttemptExecution: () => ({ isAttemptRunning: false }),
}));

vi.mock('@/hooks/useBranchStatus', () => ({
  useBranchStatus: () => ({ data: null }),
}));

vi.mock('@/hooks/useImageMetadata', () => ({
  useImageMetadata: imageMocks.useImageMetadata,
}));

vi.mock('@/hooks/useTemporaryFlag', () => ({
  useTemporaryFlag: () => [false, vi.fn()],
}));

vi.mock('@/lib/api', () => ({
  fileTreeApi: { readBinaryAsset: vi.fn() },
  sessionsApi: { reset: vi.fn() },
}));

vi.mock('@/lib/hostAsset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hostAsset')>();
  return {
    ...actual,
    hostFileSrc: (...args: unknown[]) => imageMocks.hostFileSrc(...args),
  };
});

vi.mock('@/components/dialogs', () => ({
  RestoreLogsDialog: { show: vi.fn() },
}));

vi.mock('@/vscode/bridge', () => ({
  writeClipboardViaBridge: vi.fn(),
}));

describe('UserMessage', () => {
  beforeEach(() => {
    imageMocks.showPreview.mockReset();
    imageMocks.useImageMetadata.mockReset();
    imageMocks.hostFileSrc.mockReset();
    imageMocks.hostFileSrc.mockResolvedValue('blob:image/png');
    imageMocks.useImageMetadata.mockReturnValue({
      data: null,
      isLoading: false,
    });
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders legacy timeline entries with the Astryx user-message semantics', () => {
    render(<UserMessage content="Inspect this project" />);

    expect(
      screen.getByRole('article', { name: 'Message from user' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('user-message-bubble')).toHaveTextContent(
      'Inspect this project'
    );
  });

  it('keeps structured composer tokens as chips after send', () => {
    const fileCommand = formatSessionComposerCommand({
      type: '@',
      key: 'App.tsx',
      value: 'src/App.tsx',
    });
    const dollarCommand = formatSessionComposerCommand({
      type: '$',
      key: 'plan',
      value: '$plan',
    });

    render(
      <UserMessage content={`Review ${fileCommand} with ${dollarCommand}`} />
    );

    expect(screen.getByRole('document')).toBeInTheDocument();
    expect(screen.getAllByTestId('session-composer-token-chip')).toHaveLength(
      2
    );
    expect(screen.getByText('@App.tsx')).toBeInTheDocument();
    expect(screen.getByText('$plan')).toBeInTheDocument();
    expect(
      screen
        .getByText('@App.tsx')
        .closest('[data-testid="session-composer-token-chip"]')
    ).toHaveAttribute('title', 'src/App.tsx');
    expect(
      screen
        .getByText('$plan')
        .closest('[data-testid="session-composer-token-chip"]')
    ).not.toHaveAttribute('title');
  });

  it('keeps agent mentions as chips with the real agent icon after send', () => {
    render(<UserMessage content="Ask [&Codex](vibex://agent/codex) next" />);

    const chip = screen
      .getByText('&Codex')
      .closest('[data-testid="session-composer-token-chip"]');

    expect(chip).toHaveAttribute('data-token-kind', 'agent_mention');
    expect(chip).toHaveAttribute('data-variant', 'purple');
    expect(screen.getByRole('img', { name: 'Codex' })).toHaveAttribute(
      'src',
      '/agents/codex-light.svg'
    );
  });

  it('keeps selected preview elements as chips after send', () => {
    const elementContext =
      'From preview click:\n- DOM: button.primary\n- Selected start: SaveButton (`src/App.tsx:12:3`)';
    const content = insertPreviewElementToken({
      value: 'Fix',
      selectionStart: 3,
      selectionEnd: 3,
      componentName: 'SaveButton',
      filePath: 'src/App.tsx:12:3',
      fullMarkdown: elementContext,
    }).value;

    render(<UserMessage content={content} />);

    expect(screen.getByText('@SaveButton')).toBeInTheDocument();
    expect(
      screen
        .getByText('@SaveButton')
        .closest('[data-testid="session-composer-token-chip"]')
    ).toHaveAttribute('title', elementContext);
  });

  it('renders vibe image attachments as inline thumbnails and opens preview', () => {
    imageMocks.useImageMetadata.mockReturnValue({
      data: {
        exists: true,
        file_name: 'screen.png',
        path: '.vibe-images/screen.png',
        size_bytes: 123n,
        format: 'png',
        proxy_url: 'asset://screen.png',
      },
      isLoading: false,
    });

    render(
      <UserMessage
        content={'Please inspect this.\n![screen](.vibe-images/screen.png)'}
        taskAttempt={{ id: 'attempt-1' } as never}
      />
    );

    expect(screen.getByRole('document')).toHaveTextContent(
      'Please inspect this.'
    );
    expect(screen.getByRole('img', { name: 'screen' })).toHaveAttribute(
      'src',
      'asset://screen.png'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview image' }));

    expect(imageMocks.showPreview).toHaveBeenCalledWith({
      imageUrl: 'asset://screen.png',
      altText: 'screen',
      fileName: 'screen.png',
      format: 'png',
      sizeBytes: 123n,
    });
  });

  it('revokes data-URL blob object URLs when the attachment unmounts', () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      'URL',
      class {
        static createObjectURL() {
          return 'blob:data-image';
        }
        static revokeObjectURL(url: string) {
          revokeObjectURL(url);
        }
      }
    );

    const { unmount } = render(
      <UserMessageAttachments
        images={[
          {
            id: 'inline:0',
            path: '',
            altText: 'shot',
            kind: 'image',
            sourceUrl: `data:image/png;base64,${btoa('png')}`,
          },
        ]}
      />
    );

    expect(screen.getByRole('img', { name: 'shot' })).toHaveAttribute(
      'src',
      'blob:data-image'
    );
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:data-image');
    vi.unstubAllGlobals();
  });

  it('renders pdf attachments as file cards after send', () => {
    imageMocks.useImageMetadata.mockReturnValue({
      data: {
        exists: true,
        file_name: 'notes.pdf',
        path: '/tmp/notes.pdf',
        size_bytes: 2048n,
        format: 'pdf',
        proxy_url: null,
        updated_at: '2026-09-13T04:30:00.000Z',
      },
      isLoading: false,
    });

    render(
      <UserMessage
        content={'See the spec.\n![notes](.vibe-images/notes.pdf)'}
        taskAttempt={{ id: 'attempt-1' } as never}
      />
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('attachment-file-card')).toHaveTextContent(
      'notes.pdf'
    );
  });

  it('renders the real image after metadata resolves a filesystem path', async () => {
    imageMocks.useImageMetadata.mockReturnValue({
      data: {
        exists: true,
        file_name: 'screen.png',
        path: '/tmp/screen.png',
        size_bytes: 123n,
        format: 'png',
        proxy_url: '/tmp/screen.png',
      },
      isLoading: false,
    });

    render(
      <UserMessage
        content={'Please inspect this.\n![screen](.vibe-images/screen.png)'}
        taskAttempt={{ id: 'attempt-1' } as never}
      />
    );

    expect(await screen.findByRole('img', { name: 'screen' })).toHaveAttribute(
      'src',
      'blob:image/png'
    );
    expect(imageMocks.hostFileSrc).toHaveBeenCalledWith('/tmp/screen.png');
    expect(
      screen.queryByRole('img', { name: 'screen' })?.getAttribute('src')
    ).not.toMatch(/^data:/);
  });

  it('stacks file cards and expands the hovered card after 200ms', () => {
    vi.useFakeTimers();
    imageMocks.useImageMetadata.mockImplementation(
      (_attemptId: string | undefined, src: string) => ({
        data: {
          exists: true,
          file_name: src.endsWith('spec.docx') ? 'spec.docx' : 'notes.pdf',
          path: src,
          size_bytes: 2048n,
          format: src.endsWith('docx') ? 'docx' : 'pdf',
          proxy_url: null,
          updated_at: '2026-09-13T04:30:00.000Z',
        },
        isLoading: false,
      })
    );

    render(
      <UserMessage
        content={
          'See the spec.\n![notes](.vibe-images/notes.pdf)\n![spec](.vibe-images/spec.docx)'
        }
        taskAttempt={{ id: 'attempt-1' } as never}
      />
    );

    const cards = screen.getAllByTestId('attachment-file-card');
    expect(screen.getByTestId('user-message-file-attachments')).toHaveClass(
      'attachment-file-stack'
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('data-expanded', 'false');
    expect(cards[1]).toHaveAttribute('data-expanded', 'false');

    fireEvent.mouseEnter(cards[1]);
    expect(cards[1]).toHaveAttribute('data-expanded', 'false');

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(cards[1]).toHaveAttribute('data-expanded', 'false');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(cards[1]).toHaveAttribute('data-expanded', 'true');
    expect(cards[0]).toHaveAttribute('data-expanded', 'false');
    vi.useRealTimers();
  });

  it('stacks four or more images and keeps files on a separate row', () => {
    imageMocks.useImageMetadata.mockReturnValue({
      data: {
        exists: true,
        file_name: 'shot.png',
        path: '.vibe-images/shot.png',
        size_bytes: 10n,
        format: 'png',
        proxy_url: 'asset://shot.png',
      },
      isLoading: false,
    });

    render(
      <UserMessage
        content={[
          'Gallery',
          '![a](.vibe-images/a.png)',
          '![b](.vibe-images/b.png)',
          '![c](.vibe-images/c.png)',
          '![d](.vibe-images/d.png)',
          '![notes](.vibe-images/notes.pdf)',
        ].join('\n')}
        taskAttempt={{ id: 'attempt-1' } as never}
      />
    );

    expect(screen.getByTestId('user-message-image-attachments')).toHaveClass(
      'attachment-image-stack'
    );
    expect(
      screen.getByTestId('user-message-file-attachments')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('user-message-attachments').children
    ).toHaveLength(2);
  });
});
