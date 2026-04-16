import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DisplayConversationEntry from './DisplayConversationEntry';

const useTaskStoppingMock = vi.fn();

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
  CollapsibleEntry: ({ content }: { content: string }) => <div>{content}</div>,
  CompactNoticeEntry: ({ content }: { content: string }) => (
    <div>{content}</div>
  ),
}));

describe('DisplayConversationEntry', () => {
  beforeEach(() => {
    useTaskStoppingMock.mockReset();
    useTaskStoppingMock.mockReturnValue({ isStopping: false });
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

    expect(screen.getByText('正在停止Hook...')).toBeInTheDocument();
    expect(screen.queryByText('AI 正在思考...')).not.toBeInTheDocument();
  });
});
