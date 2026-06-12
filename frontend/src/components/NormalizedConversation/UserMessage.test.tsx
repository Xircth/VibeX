import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatSessionComposerCommand,
  insertPreviewElementToken,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import UserMessage from './UserMessage';

const imageMocks = vi.hoisted(() => ({
  showPreview: vi.fn(),
  useImageMetadata: vi.fn(),
}));

vi.mock('@/components/ui/wysiwyg', () => ({
  default: ({ value }: { value: string }) => (
    <div data-testid="readonly-wysiwyg">{value}</div>
  ),
  SESSION_INPUT_MARKDOWN_PRESET: {},
  SESSION_INPUT_TEXT_CLASS_NAME: 'session-input-text',
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

    render(<UserMessage content={`Review ${fileCommand} with ${dollarCommand}`} />);

    expect(screen.queryByTestId('readonly-wysiwyg')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('user-message-structured-tokens')
    ).toBeInTheDocument();
    expect(screen.getByText('App.tsx')).toBeInTheDocument();
    expect(screen.getByText('$plan')).toBeInTheDocument();
    expect(
      screen
        .getByText('App.tsx')
        .closest('[data-testid="session-composer-token-chip"]')
    ).toHaveAttribute('title', 'src/App.tsx');
    expect(
      screen
        .getByText('$plan')
        .closest('[data-testid="session-composer-token-chip"]')
    ).not.toHaveAttribute('title');
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

    expect(screen.queryByTestId('readonly-wysiwyg')).not.toBeInTheDocument();
    expect(screen.getByText('SaveButton')).toBeInTheDocument();
    expect(
      screen
      .getByText('SaveButton')
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

    expect(screen.getByTestId('readonly-wysiwyg')).toHaveTextContent(
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
});
