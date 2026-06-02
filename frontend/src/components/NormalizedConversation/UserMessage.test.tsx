import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insertPreviewElementToken } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import UserMessage from './UserMessage';

vi.mock('@/components/ui/wysiwyg', () => ({
  default: ({ value }: { value: string }) => (
    <div data-testid="readonly-wysiwyg">{value}</div>
  ),
  SESSION_INPUT_MARKDOWN_PRESET: {},
  SESSION_INPUT_TEXT_CLASS_NAME: 'session-input-text',
}));

vi.mock('@/components/dialogs/wysiwyg/ImagePreviewDialog', () => ({
  ImagePreviewDialog: { show: vi.fn() },
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
  useImageMetadata: () => ({ data: null, isLoading: false }),
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
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        disconnect() {}
      }
    );
  });

  it('keeps structured composer tokens as chips after send', () => {
    render(<UserMessage content="Review @src/App.tsx with $plan" />);

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
});
