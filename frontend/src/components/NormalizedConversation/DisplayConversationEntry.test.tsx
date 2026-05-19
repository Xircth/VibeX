import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DisplayConversationEntry from './DisplayConversationEntry';

const useTaskStoppingMock = vi.fn();
const useUserSystemMock = vi.fn();

vi.mock('@/components/ui/wysiwyg', () => ({
  default: () => <div />,
}));

vi.mock('@/contexts/RetryUiContext', () => ({
  useRetryUi: () => ({
    isProcessGreyed: () => false,
  }),
}));

vi.mock('@/stores/useTaskDetailsUiStore', () => ({
  useTaskStopping: (...args: unknown[]) => useTaskStoppingMock(...args),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => useUserSystemMock(),
}));

vi.mock('./FileChangeRenderer', () => ({
  default: () => <div />,
}));

vi.mock('./Markdown', () => ({
  Markdown: ({ value }: { value: string }) => <div>{value}</div>,
}));

vi.mock('./UserMessage', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('./PendingApprovalEntry', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock('./ThinkingEntry', () => ({
  ThinkingEntry: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('./ToolCallCard', () => ({
  ToolCallCard: () => <div />,
  ScriptToolCallCard: () => <div />,
  PlanPresentationCard: () => <div />,
  LookupToolCallCard: () => <div />,
}));

vi.mock('./MessageCard', () => ({
  AssistantCommandOutputEntry: ({
    prefix,
    output,
  }: {
    prefix: string;
    output: string;
  }) => (
    <div>
      {prefix ? <div data-testid="collapsed-prefix-toggle" /> : null}
      <div>{output}</div>
    </div>
  ),
  CollapsibleEntry: ({ content }: { content: string }) => <div>{content}</div>,
  CompactNoticeEntry: ({ content }: { content: string }) => (
    <div>{content}</div>
  ),
  PlainNoticeEntry: ({ content }: { content: string }) => <div>{content}</div>,
}));

describe('DisplayConversationEntry', () => {
  beforeEach(() => {
    useTaskStoppingMock.mockReset();
    useTaskStoppingMock.mockReturnValue({ isStopping: false });
    useUserSystemMock.mockReset();
    useUserSystemMock.mockReturnValue({
      config: { ai_message_default_collapsed: false },
    });
  });

  it('shows a stopping-hook loading label when a run is stopping', () => {
    useTaskStoppingMock.mockReturnValue({ isStopping: true });

    render(
      <DisplayConversationEntry
        entry={{ entry_type: { type: 'loading' }, content: '' } as never}
        expansionKey="loading-entry"
        taskAttempt={{ task_id: 'task-1' } as never}
      />
    );

    expect(screen.getByText(/Hook/)).toBeInTheDocument();
    expect(screen.queryByText(/AI/)).not.toBeInTheDocument();
  });

  it('renders verbose assistant command output fully by default', () => {
    render(
      <DisplayConversationEntry
        entry={
          {
            entry_type: { type: 'assistant_message' },
            content: 'Wall time: 1.7 seconds\nOutput:\nFinal answer',
          } as never
        }
        expansionKey="assistant-entry"
      />
    );

    expect(screen.getByText(/Wall time: 1\.7 seconds/)).toBeInTheDocument();
    expect(screen.getByText(/Output:/)).toBeInTheDocument();
    expect(screen.getByText(/Final answer/)).toBeInTheDocument();
    expect(screen.queryByText('Command output:')).not.toBeInTheDocument();
  });

  it('keeps command-style assistant output fully visible when default collapse is enabled', () => {
    useUserSystemMock.mockReturnValue({
      config: { ai_message_default_collapsed: true },
    });

    render(
      <DisplayConversationEntry
        entry={
          {
            entry_type: { type: 'assistant_message' },
            content: 'Wall time: 1.7 seconds\nOutput:\nFinal answer',
          } as never
        }
        expansionKey="assistant-entry"
      />
    );

    expect(
      screen.getByText(/Wall time: 1\.7 seconds[\s\S]*Final answer/)
    ).toBeInTheDocument();
  });

  it('keeps a normal assistant message fully visible when default collapse is enabled', () => {
    useUserSystemMock.mockReturnValue({
      config: { ai_message_default_collapsed: true },
    });

    render(
      <DisplayConversationEntry
        entry={
          {
            entry_type: { type: 'assistant_message' },
            content:
              'First inspect the frontend entry and environment.\n\nThen verify the dev server port and proxy.\n\nFrontend is reachable again.',
          } as never
        }
        expansionKey="assistant-entry-final-block"
      />
    );

    expect(
      screen.getByText(
        /First inspect the frontend entry and environment\.[\s\S]*Frontend is reachable again\./
      )
    ).toBeInTheDocument();
  });

  it('renders impeccable preflight as compact metadata before assistant text', () => {
    render(
      <DisplayConversationEntry
        entry={
          {
            entry_type: { type: 'assistant_message' },
            content:
              'IMPECCABLE_PREFLIGHT: context=pass product=pass\nI will update the layout.',
          } as never
        }
        expansionKey="assistant-entry"
      />
    );

    expect(
      screen.getByText('IMPECCABLE_PREFLIGHT: context=pass product=pass')
    ).toBeInTheDocument();
    expect(screen.getByText('I will update the layout.')).toBeInTheDocument();
  });

  it('renders Codex unstable feature warning as metadata before assistant text', () => {
    const warning =
      'Under-development features enabled: child_agents_md. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set suppress_unstable_features_warning = true in C:\\Users\\Administrator\\.codex\\config.toml.';

    render(
      <DisplayConversationEntry
        entry={
          {
            entry_type: { type: 'assistant_message' },
            content: `${warning} 我是 Codex，一个基于 GPT 5 的编码代理。`,
          } as never
        }
        expansionKey="assistant-entry"
      />
    );

    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(
      screen.getByText('我是 Codex，一个基于 GPT 5 的编码代理。')
    ).toBeInTheDocument();
    expect(screen.queryByText(`${warning} 我是 Codex`)).not.toBeInTheDocument();
  });
});
