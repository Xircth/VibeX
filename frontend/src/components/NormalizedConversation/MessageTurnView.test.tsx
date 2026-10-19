import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ContentBlock, MessageTurn } from 'shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageTurnView } from './MessageTurnView';
import { STREAMING_ACTIVITY_VERBS } from './assistantStreamingActivity';

const conversationMessageStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/conversation/conv-messages.css'),
  'utf8'
);

const {
  markdownMock,
  userMarkdownMock,
  openFilePreviewMock,
  openImagePreviewMock,
  useImageMetadataMock,
  hostFileSrcMock,
} = vi.hoisted(() => ({
  markdownMock: vi.fn(({ value }: { value: string }) => <div>{value}</div>),
  userMarkdownMock: vi.fn(({ value }: { value: string }) => <div>{value}</div>),
  openFilePreviewMock: vi.fn(),
  openImagePreviewMock: vi.fn(),
  useImageMetadataMock: vi.fn(),
  hostFileSrcMock: vi.fn(),
}));

function toolUseBlock(index: number, toolName: string, input: unknown) {
  return {
    type: 'tool_use' as const,
    tool_use_id: `tool-${index}`,
    tool_name: toolName,
    input_preview: JSON.stringify(input),
    meta: null,
  };
}

function completedCommands(count: number): ContentBlock[] {
  return Array.from({ length: count }, (_, index) => [
    toolUseBlock(index, 'bash', { command: `command-${index}` }),
    {
      type: 'tool_result' as const,
      tool_use_id: `tool-${index}`,
      output_preview: 'ok',
      is_error: false,
    },
  ]).flat();
}

vi.mock('./AstryxMarkdown', () => ({
  AstryxMarkdown: markdownMock,
}));

vi.mock('./UserMessageMarkdown', () => ({
  UserMessageMarkdown: userMarkdownMock,
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => ({
    openFilePreview: openFilePreviewMock,
  }),
}));

vi.mock('@/hooks/useOpenImagePreview', () => ({
  useOpenImagePreview: () => openImagePreviewMock,
}));

vi.mock('@/hooks/useImageMetadata', () => ({
  useImageMetadata: useImageMetadataMock,
}));

vi.mock('@/lib/hostAsset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hostAsset')>();
  return {
    ...actual,
    hostFileSrc: (...args: unknown[]) => hostFileSrcMock(...args),
  };
});

const hideThinkingMock = vi.hoisted(() => ({ value: true }));

vi.mock('@/components/ConfigProvider', () => ({
  useOptionalUserSystem: () => ({
    config: { hide_model_thinking: hideThinkingMock.value },
  }),
}));

vi.mock('./tools/ToolCardShell', () => ({
  ToolCardShell: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ToolCallResultDetail: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useToolCallResultDetail: () => false,
  getToolChatStatus: (status: { status: string }) =>
    status.status === 'created'
      ? 'running'
      : status.status === 'failed'
        ? 'error'
        : 'complete',
}));

vi.mock('./ConversationPlanCard', () => ({
  ConversationPlanCard: () => <div />,
}));

vi.mock('./DisplayConversationEntry', () => ({
  default: () => <div />,
}));

describe('MessageTurnView', () => {
  beforeEach(() => {
    hideThinkingMock.value = true;
    markdownMock.mockClear();
    userMarkdownMock.mockClear();
    openFilePreviewMock.mockClear();
    openImagePreviewMock.mockClear();
    useImageMetadataMock.mockReset();
    useImageMetadataMock.mockReturnValue({
      data: null,
      isLoading: false,
    });
    hostFileSrcMock.mockReset();
    hostFileSrcMock.mockResolvedValue('blob:image/png');
  });

  it('shows the latest thinking until output moves on, then lets the user reopen it', () => {
    hideThinkingMock.value = false;
    const turn = {
      id: 'live-thinking:assistant',
      role: 'assistant' as const,
      blocks: [{ type: 'thinking' as const, text: 'Inspecting the renderer' }],
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);

    expect(screen.getByText('Inspecting the renderer')).toBeInTheDocument();
    rerender(
      <MessageTurnView
        {...props}
        turn={{
          ...turn,
          blocks: [
            ...turn.blocks,
            { type: 'thinking', text: 'Checking the next step' },
          ],
        }}
      />
    );
    expect(screen.getByText(/Checking the next step/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '收起思考' })).toHaveLength(1);

    rerender(
      <MessageTurnView
        {...props}
        turn={{
          ...turn,
          blocks: [
            ...turn.blocks,
            { type: 'text', text: 'I found the renderer' },
          ],
        }}
      />
    );
    expect(screen.getByText('I found the renderer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    expect(screen.getByText('Inspecting the renderer')).toBeInTheDocument();
  });

  it('folds older streaming activities and keeps only the last two mounted', () => {
    hideThinkingMock.value = false;
    const turn: MessageTurn = {
      id: 'running-activities:assistant',
      role: 'assistant',
      blocks: [
        ...Array.from({ length: 5 }, (_, index) =>
          toolUseBlock(index, 'bash', { command: `running-${index}` })
        ),
        { type: 'thinking', text: 'Inspecting the last result' },
      ],
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    render(
      <MessageTurnView
        turn={turn}
        phase="streaming"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.queryByText('running-0')).not.toBeInTheDocument();
    expect(screen.queryByText('running-3')).not.toBeInTheDocument();
    expect(screen.getByText('running-4')).toBeInTheDocument();
    expect(screen.getByText('Inspecting the last result')).toBeInTheDocument();
    const fold = screen.getByRole('button', { name: /4 条消息$/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    const aggregate = screen.getByRole('button', { name: /运行 4 个命令/ });
    expect(aggregate).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(aggregate);
    expect(screen.getByText('running-0')).toBeInTheDocument();
    expect(screen.getByText('running-3')).toBeInTheDocument();
  });

  it('keeps the latest two calls mounted and folds older calls until the disclosure opens', () => {
    const turn: MessageTurn = {
      id: 'batched-tools:assistant',
      role: 'assistant',
      blocks: completedCommands(8),
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);

    expect(screen.queryByText('command-5')).not.toBeInTheDocument();
    expect(screen.getByText('command-6')).toBeInTheDocument();
    expect(screen.getByText('command-7')).toBeInTheDocument();
    const fold = screen.getByRole('button', { name: /6 条消息$/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    const firstBatch = screen.getByRole('button', { name: /运行 6 个命令/ });
    expect(firstBatch).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(firstBatch);
    expect(screen.getByText('command-0')).toBeInTheDocument();

    rerender(
      <MessageTurnView
        {...props}
        turn={{ ...turn, blocks: completedCommands(13) }}
      />
    );
    expect(screen.getByText('command-0')).toBeInTheDocument();
    expect(screen.getByText('command-10')).toBeInTheDocument();
    expect(screen.getByText('command-11')).toBeInTheDocument();
    expect(screen.getByText('command-12')).toBeInTheDocument();
    const batches = screen.getAllByRole('button', {
      name: /运行 \d+ 个命令/,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveTextContent('运行 11 个命令');
    expect(batches[0]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('command-5')).toBeInTheDocument();
  });

  it('keeps resources and plans in one activity stage until prose arrives', () => {
    const turn: MessageTurn = {
      id: 'mixed-running-activities:assistant',
      role: 'assistant',
      blocks: [
        ...Array.from({ length: 3 }, (_, index) =>
          toolUseBlock(index, 'bash', { command: `mixed-${index}` })
        ),
        {
          type: 'resource',
          uri: 'file:///workspace/note.md',
          title: 'note.md',
        },
        toolUseBlock(3, 'bash', { command: 'mixed-3' }),
        { type: 'plan', entries: [] },
      ],
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
      collapseProcess: false,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);
    const aggregate = screen.getByRole('button', {
      name: '运行 3 个命令、1 项其他活动',
    });
    expect(aggregate).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('mixed-0')).not.toBeInTheDocument();
    expect(screen.queryByText('note.md')).not.toBeInTheDocument();
    expect(screen.getByText('mixed-3')).toBeInTheDocument();
    fireEvent.click(aggregate);
    expect(screen.getByText('mixed-0')).toBeInTheDocument();
    expect(screen.getByText('note.md')).toBeInTheDocument();

    rerender(
      <MessageTurnView
        {...props}
        turn={{
          ...turn,
          blocks: [...turn.blocks, { type: 'text', text: 'Done' }],
        }}
      />
    );
    const summaries = screen.getAllByRole('button', {
      name: /运行 \d+ 个命令/,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toHaveTextContent('运行 4 个命令、2 项其他活动');
    expect(summaries[0]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('mixed-3')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('uses one aggregate for consecutive completed commands with thinking between them', () => {
    hideThinkingMock.value = false;
    const commands = completedCommands(10);
    render(
      <MessageTurnView
        turn={{
          id: 'consecutive-commands:assistant',
          role: 'assistant',
          blocks: [
            { type: 'text', text: 'Checking the project' },
            ...commands.slice(0, 18),
            { type: 'thinking', text: 'Checking the final command' },
            ...commands.slice(18),
          ],
          timestamp: '2026-10-09T00:00:00.000Z',
        }}
        phase="persisted"
        collapseProcess={false}
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    const summaries = screen.getAllByRole('button', {
      name: /运行 \d+ 个命令/,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toHaveTextContent('运行 10 个命令');
    fireEvent.click(summaries[0]);
    expect(
      screen.getAllByRole('button', { name: /^终端command-/ })
    ).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    expect(screen.getByText('Checking the final command')).toBeInTheDocument();
  });

  it('keeps opened calls visible when an earlier running call finishes and batches regroup', () => {
    const completedBlocks = completedCommands(9);
    const turn: MessageTurn = {
      id: 'regrouped-tools:assistant',
      role: 'assistant',
      blocks: completedBlocks.filter(
        (block) =>
          block.type !== 'tool_result' || block.tool_use_id !== 'tool-2'
      ),
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);

    expect(screen.queryByText('command-2')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /7 条消息$/ }));
    fireEvent.click(screen.getByRole('button', { name: /运行 7 个命令/ }));
    expect(screen.getByText('command-2')).toBeInTheDocument();
    expect(screen.getByText('command-3')).toBeInTheDocument();
    expect(screen.getByText('command-5')).toBeInTheDocument();

    rerender(
      <MessageTurnView {...props} turn={{ ...turn, blocks: completedBlocks }} />
    );

    expect(
      screen.getByRole('button', { name: /运行 7 个命令/ })
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getAllByRole('button', { name: /运行 \d+ 个命令/ })
    ).toHaveLength(1);
    expect(screen.getByText('command-3')).toBeInTheDocument();
    expect(screen.getByText('command-5')).toBeInTheDocument();
  });

  it('aggregates the entire tool and thinking stage when the next prose starts', () => {
    hideThinkingMock.value = false;
    const turn: MessageTurn = {
      id: 'closed-stage:assistant',
      role: 'assistant',
      blocks: [
        ...completedCommands(7),
        { type: 'thinking', text: 'Preparing the next update' },
      ],
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);

    expect(screen.getByText('command-6')).toBeInTheDocument();
    expect(screen.getByText('Preparing the next update')).toBeInTheDocument();
    expect(screen.queryByText('command-0')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /6 条消息$/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );

    rerender(
      <MessageTurnView
        {...props}
        turn={{
          ...turn,
          blocks: [...turn.blocks, { type: 'text', text: 'Next update' }],
        }}
      />
    );

    expect(screen.getByText('Next update')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /6 条消息$/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    fireEvent.click(screen.getByRole('button', { name: /6 条消息$/ }));
    const hiddenBatch = screen
      .getAllByRole('button', { name: /运行 \d+ 个命令/ })
      .find((button) => /运行 6 个命令/.test(button.textContent ?? ''));
    expect(hiddenBatch).toBeTruthy();
    fireEvent.click(hiddenBatch!);
    expect(screen.getByText('command-0')).toBeInTheDocument();
  });

  it('progressively collapses earlier stages during streaming while keeping live activities aggregated', () => {
    const stage1Commands = completedCommands(4);
    const stage2Commands = Array.from({ length: 4 }, (_, index) => [
      toolUseBlock(index + 10, 'bash', { command: `stage2-${index}` }),
      {
        type: 'tool_result' as const,
        tool_use_id: `tool-${index + 10}`,
        output_preview: 'ok',
        is_error: false,
      },
    ]).flat();

    const turn: MessageTurn = {
      id: 'progressive-collapse:assistant',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Stage 1 update' },
        ...stage1Commands,
        { type: 'text', text: 'Stage 2 update' },
      ],
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);

    expect(screen.getByRole('button', { name: /2 条消息$/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByText('Stage 1 update')).toBeInTheDocument();
    expect(screen.getByText('Stage 2 update')).toBeInTheDocument();

    rerender(
      <MessageTurnView
        {...props}
        turn={{
          ...turn,
          blocks: [...turn.blocks, ...stage2Commands],
        }}
      />
    );

    const stage1 = screen.getByText('Stage 1 update');
    const stage2 = screen.getByText('Stage 2 update');
    const earlierFold = screen.getByRole('button', { name: /4 条消息$/ });
    const laterFold = screen.getByRole('button', { name: /2 条消息$/ });
    expect(earlierFold).toHaveAttribute('aria-expanded', 'false');
    expect(laterFold).toHaveAttribute('aria-expanded', 'false');
    expect(stage1.compareDocumentPosition(earlierFold)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(earlierFold.compareDocumentPosition(stage2)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(stage2.compareDocumentPosition(laterFold)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(screen.queryByText('stage2-0')).not.toBeInTheDocument();
    expect(screen.getByText('stage2-2')).toBeInTheDocument();
    expect(screen.getByText('stage2-3')).toBeInTheDocument();
    expect(
      laterFold.compareDocumentPosition(screen.getByText('stage2-2'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    rerender(
      <MessageTurnView
        {...props}
        turn={{
          ...turn,
          blocks: [
            ...turn.blocks,
            ...stage2Commands,
            { type: 'text', text: 'Stage 3 final' },
          ],
        }}
      />
    );

    expect(screen.getByRole('button', { name: /4 条消息$/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByRole('button', { name: /2 条消息$/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByText('Stage 1 update')).toBeInTheDocument();
    expect(screen.getByText('Stage 2 update')).toBeInTheDocument();
    expect(screen.getByText('stage2-3')).toBeInTheDocument();
    expect(screen.getByText('Stage 3 final')).toBeInTheDocument();
    expect(
      screen
        .getByText('stage2-3')
        .compareDocumentPosition(screen.getByText('Stage 3 final'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('uses one process disclosure for a settled turn with several prose and activity stages', () => {
    hideThinkingMock.value = false;
    const turn: MessageTurn = {
      id: 'single-process-disclosure:assistant',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'First progress update' },
        ...completedCommands(7),
        { type: 'thinking', text: 'Checking the result' },
        { type: 'text', text: 'Second progress update' },
        toolUseBlock(20, 'bash', { command: 'final-check' }),
        {
          type: 'tool_result',
          tool_use_id: 'tool-20',
          output_preview: 'ok',
          is_error: false,
        },
        { type: 'text', text: 'Final answer' },
      ],
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    render(
      <MessageTurnView
        turn={turn}
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    const disclosures = screen.getAllByRole('button', {
      name: /.* 条消息$/,
    });
    expect(disclosures).toHaveLength(1);
    expect(screen.getByText('Final answer')).toBeInTheDocument();
    expect(screen.queryByText('First progress update')).toBeNull();
    expect(screen.queryByRole('button', { name: /运行 .* 个命令/ })).toBeNull();
    fireEvent.click(disclosures[0]);
    expect(screen.getByText('First progress update')).toBeInTheDocument();
    expect(screen.getByText('Second progress update')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /运行 \d+ 个命令/ })
    ).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: /运行 7 个命令/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /运行 1 个命令/ })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /.* 条消息$/ })).toHaveLength(
      1
    );
  });

  it('folds running and failed calls into the same process disclosure', () => {
    render(
      <MessageTurnView
        turn={{
          id: 'important-activity:assistant',
          role: 'assistant',
          blocks: [
            toolUseBlock(0, 'bash', { command: 'still-running' }),
            toolUseBlock(1, 'bash', { command: 'failed-check' }),
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              output_preview: 'failed',
              is_error: true,
            },
            { type: 'text', text: 'Final answer' },
          ],
          timestamp: '2026-10-09T00:00:00.000Z',
        }}
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.queryByText('still-running')).toBeNull();
    expect(screen.queryByText('failed-check')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /2 条消息$/ }));
    const aggregate = screen.getByRole('button', { name: /运行 2 个命令/ });
    expect(aggregate).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(aggregate);
    expect(screen.getByText('still-running')).toBeInTheDocument();
    expect(screen.getByText('failed-check')).toBeInTheDocument();
  });

  it('includes interleaved thinking in the same activity stage', () => {
    hideThinkingMock.value = false;
    const commands = completedCommands(7);
    const turn: MessageTurn = {
      id: 'interleaved-activity:assistant',
      role: 'assistant',
      blocks: [
        ...commands.slice(0, 8),
        { type: 'thinking', text: 'Checking between calls' },
        ...commands.slice(8),
      ],
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);
    expect(
      screen.queryByRole('button', { name: /运行 \d+ 个命令/ })
    ).toBeNull();
    expect(screen.getByRole('button', { name: /6 条消息$/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.queryByRole('button', { name: '展开思考' })).toBeNull();
    expect(screen.queryByText('command-4')).not.toBeInTheDocument();
    expect(screen.getByText('command-5')).toBeInTheDocument();
    expect(screen.getByText('command-6')).toBeInTheDocument();

    rerender(
      <MessageTurnView
        {...props}
        turn={{
          ...turn,
          blocks: [...turn.blocks, { type: 'text', text: 'Next stage' }],
        }}
      />
    );
    expect(screen.getByText('Next stage')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /6 条消息$/ }));
    fireEvent.click(screen.getByRole('button', { name: /运行 5 个命令/ }));
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    expect(screen.getByText('Checking between calls')).toBeInTheDocument();
  });

  it('folds the final activity stage on settlement and preserves opened batch members', () => {
    hideThinkingMock.value = false;
    const turn: MessageTurn = {
      id: 'settled-activity:assistant',
      role: 'assistant',
      blocks: [
        ...completedCommands(7),
        { type: 'thinking', text: 'Final check' },
      ],
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
    };
    const { rerender } = render(
      <MessageTurnView {...props} turn={turn} phase="streaming" />
    );
    fireEvent.click(screen.getByRole('button', { name: /6 条消息$/ }));
    fireEvent.click(screen.getByRole('button', { name: /运行 6 个命令/ }));
    expect(screen.getByText('command-0')).toBeInTheDocument();

    rerender(<MessageTurnView {...props} turn={turn} phase="settled" />);
    expect(screen.getByRole('button', { name: /8 条消息$/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(
      screen.getByRole('button', { name: /运行 7 个命令/ })
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('command-0')).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /运行 \d+ 个命令/ })
    ).toHaveLength(1);
  });

  it('preserves an opened recent tool result when the stage closes', () => {
    const turn: MessageTurn = {
      id: 'opened-tool-result:assistant',
      role: 'assistant',
      blocks: completedCommands(7),
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);
    fireEvent.click(screen.getByRole('button', { name: '终端command-6' }));
    expect(
      screen.getByRole('button', { name: '终端command-6' })
    ).toHaveAttribute('aria-expanded', 'true');
    rerender(
      <MessageTurnView
        {...props}
        turn={{
          ...turn,
          blocks: [...turn.blocks, { type: 'text', text: 'Next update' }],
        }}
      />
    );
    expect(
      screen.getByRole('button', { name: '终端command-6' })
    ).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: /5 条消息$/ }));
    expect(
      screen.getByRole('button', { name: /运行 5 个命令/ })
    ).toBeInTheDocument();
  });

  it('keeps opened finished thinking visible when it joins a mixed batch', () => {
    hideThinkingMock.value = false;
    const turn: MessageTurn = {
      id: 'opened-thinking-member:assistant',
      role: 'assistant',
      blocks: [
        { type: 'thinking', text: 'Keep this thought visible' },
        ...completedCommands(1),
      ],
      timestamp: '2026-10-09T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    rerender(
      <MessageTurnView
        {...props}
        turn={{ ...turn, blocks: [turn.blocks[0], ...completedCommands(4)] }}
      />
    );
    expect(
      screen.queryByText('Keep this thought visible')
    ).not.toBeInTheDocument();
    expect(screen.getByText('command-2')).toBeInTheDocument();
    expect(screen.getByText('command-3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /3 条消息$/ }));
    expect(
      screen.getByRole('button', { name: /运行 2 个命令/ })
    ).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Keep this thought visible')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起思考' }));
    expect(
      screen.getByRole('button', { name: /运行 2 个命令/ })
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('button', { name: '终端command-0' })
    ).toBeInTheDocument();
  });

  it('renders a user turn with the Astryx user-message semantics', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [{ type: 'text', text: 'Inspect this project' }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(
      screen.getByRole('article', { name: 'Message from user' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('user-message-bubble')).toHaveTextContent(
      'Inspect this project'
    );

    const bubbleRule =
      conversationMessageStyles.match(
        /\.vibex-user-message \.conv-user-bubble\s*\{[^}]+\}/u
      )?.[0] ?? '';
    expect(bubbleRule).toContain('font-size: 0.875rem;');
    expect(bubbleRule).toContain('line-height: 1.43;');
    expect(bubbleRule).toContain('background: var(--conv-user-bg);');
    expect(bubbleRule).toContain('color: var(--conv-user-text);');
    expect(userMarkdownMock).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'Inspect this project' }),
      undefined
    );
  });

  it('renders user-turn image attachments above the message bubble', async () => {
    useImageMetadataMock.mockReturnValue({
      data: {
        exists: true,
        file_name: 'screen.png',
        path: 'C:\\Users\\me\\proj\\.vibe-images\\screen.png',
        size_bytes: 123n,
        format: 'png',
        proxy_url: 'C:\\Users\\me\\proj\\.vibe-images\\screen.png',
      },
      isLoading: false,
    });

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [
              { type: 'text', text: 'Please inspect this.' },
              {
                type: 'image',
                data: '',
                mime_type: 'image/png',
                uri: '.vibe-images/screen.png',
              },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={
          {
            id: 'attempt-1',
            container_ref: 'C:\\Users\\me\\proj',
          } as never
        }
        task={null}
      />
    );

    expect(screen.getByTestId('user-message-attachments')).toBeInTheDocument();
    const thumbnail = await screen.findByRole('img', { name: 'screen.png' });
    expect(thumbnail).toHaveAttribute('src', 'blob:image/png');
    expect(hostFileSrcMock).toHaveBeenCalledWith(
      'C:\\Users\\me\\proj\\.vibe-images\\screen.png'
    );
    expect(screen.getByTestId('user-message-bubble')).toHaveTextContent(
      'Please inspect this.'
    );
    expect(userMarkdownMock).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'Please inspect this.' }),
      undefined
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview image' }));
    expect(openImagePreviewMock).toHaveBeenCalledWith({
      imageUrl: 'blob:image/png',
      altText: 'screen.png',
      fileName: 'screen.png',
      format: 'png',
      sizeBytes: 123n,
    });
  });

  it('does not load the host image-cache path when a workspace copy is available', async () => {
    useImageMetadataMock.mockReturnValue({
      data: {
        exists: true,
        file_name: 'screen.png',
        path: 'C:\\Users\\me\\AppData\\VibeX\\images\\screen.png',
        size_bytes: 123n,
        format: 'png',
        proxy_url: 'C:\\Users\\me\\AppData\\VibeX\\images\\screen.png',
      },
      isLoading: false,
    });

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [
              { type: 'text', text: 'Please inspect this.' },
              {
                type: 'image',
                data: '',
                mime_type: 'image/png',
                uri: '.vibe-images/screen.png',
              },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={
          {
            id: 'attempt-1',
            container_ref: 'C:\\Users\\me\\proj',
          } as never
        }
        task={null}
      />
    );

    expect(
      await screen.findByRole('img', { name: 'screen.png' })
    ).toHaveAttribute('src', 'blob:image/png');
    expect(hostFileSrcMock).toHaveBeenCalledWith(
      'C:\\Users\\me\\proj\\.vibe-images\\screen.png'
    );
    expect(hostFileSrcMock).not.toHaveBeenCalledWith(
      'C:\\Users\\me\\AppData\\VibeX\\images\\screen.png'
    );
  });

  it('renders document attachments as file cards instead of image placeholders', () => {
    useImageMetadataMock.mockReturnValue({
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
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [
              { type: 'text', text: 'See the spec.' },
              {
                type: 'image',
                data: '',
                mime_type: 'image/png',
                uri: '.vibe-images/notes.pdf',
              },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('attachment-file-card')).toHaveTextContent(
      'notes.pdf'
    );
    expect(screen.getByTestId('attachment-file-card')).toHaveTextContent(
      '2.0 KB'
    );
    expect(screen.getByTestId('user-message-bubble')).toHaveTextContent(
      'See the spec.'
    );
  });

  it('renders an image-only user turn without an empty text bubble', async () => {
    useImageMetadataMock.mockReturnValue({
      data: {
        exists: true,
        file_name: 'shot.png',
        path: 'C:\\Users\\me\\proj\\.vibe-images\\shot.png',
        size_bytes: 10n,
        format: 'png',
        proxy_url: 'C:\\Users\\me\\proj\\.vibe-images\\shot.png',
      },
      isLoading: false,
    });

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [
              {
                type: 'image',
                data: '',
                mime_type: 'image/png',
                uri: '.vibe-images/shot.png',
              },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={
          {
            id: 'attempt-1',
            container_ref: 'C:\\Users\\me\\proj',
          } as never
        }
        task={null}
      />
    );

    expect(
      await screen.findByRole('img', { name: 'shot.png' })
    ).toHaveAttribute('src', 'blob:image/png');
    expect(screen.queryByTestId('user-message-bubble')).not.toBeInTheDocument();
    expect(userMarkdownMock).not.toHaveBeenCalled();
  });

  it('renders a cycling activity placeholder for an empty streaming assistant turn', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    const status = screen.getByRole('status', { name: 'AI 正在处理' });
    expect(status).toBeInTheDocument();
    const verb = STREAMING_ACTIVITY_VERBS.find((activity) =>
      status.textContent?.startsWith(`${activity}…`)
    );
    expect(verb).toBeDefined();
  });

  it('does not render a thinking placeholder for settled empty assistant turns', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('AI 正在思考中...')).not.toBeInTheDocument();
  });

  it('hides the streaming placeholder after cancel, failure, interrupt, or a turn error', () => {
    for (const phase of ['failed', 'cancelled', 'interrupted'] as const) {
      const { unmount } = render(
        <MessageTurnView
          turn={
            {
              id: 'turn-1:assistant',
              role: 'assistant',
              blocks: [],
              timestamp: '2026-06-14T00:00:00.000Z',
            } as never
          }
          phase={phase}
          attempt={{ id: 'attempt-1', container_ref: null } as never}
          task={null}
        />
      );
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      unmount();
    }

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        hasTurnError
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders streaming assistant text through the markdown pipeline', () => {
    const value = '```ts\nconst answer = 42;\n```';

    const { container } = render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: value }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(
      container.querySelector('.conv-streaming-markdown')
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: 'AI 正在处理' })
    ).toBeInTheDocument();
    expect(markdownMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ value, isStreaming: true })
    );
  });

  it('uses the full markdown renderer once an assistant turn is settled', () => {
    const value = '```ts\nconst answer = 42;\n```';

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: value }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(markdownMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ value, isStreaming: false })
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('collapses command prelude text by default', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-command:assistant',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: 'Wall time: 1.7 seconds\nOutput:\nFinal answer',
              },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.getByText('Final answer')).toBeInTheDocument();
    expect(screen.queryByText(/Wall time/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Expand previous AI content' })
    );
    expect(screen.getByText(/Wall time: 1\.7 seconds/)).toBeInTheDocument();
  });

  it('hides thinking blocks when the hide-thinking setting is on', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [
              { type: 'thinking', text: 'private reasoning' },
              { type: 'text', text: 'visible answer' },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={
          {
            id: 'attempt-1',
            container_ref: null,
            session: { executor: 'claude_code' as const },
          } as never
        }
        task={null}
      />
    );

    expect(screen.queryByText('private reasoning')).not.toBeInTheDocument();
    expect(screen.getByText('visible answer')).toBeInTheDocument();
  });

  it('shows thinking blocks when the hide-thinking setting is off', () => {
    hideThinkingMock.value = false;

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [
              { type: 'thinking', text: 'private reasoning' },
              { type: 'text', text: 'visible answer' },
            ],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={
          {
            id: 'attempt-1',
            container_ref: null,
            session: { executor: 'claude_code' as const },
          } as never
        }
        task={null}
        collapseProcess={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    expect(screen.getByText('private reasoning')).toBeInTheDocument();
    expect(screen.getByText('visible answer')).toBeInTheDocument();
  });

  it('hides thinking while preserving the streaming loading status', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [{ type: 'thinking', text: 'private reasoning' }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={
          {
            id: 'attempt-1',
            container_ref: null,
            session: { executor: 'codex' as const },
          } as never
        }
        task={null}
      />
    );

    expect(screen.queryByText('private reasoning')).not.toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: 'AI 正在处理' })
    ).toBeInTheDocument();
  });

  it('only renders edit controls when an editable retry callback is supplied', async () => {
    const onEditRetry = vi.fn().mockResolvedValue(true);
    const { rerender } = render(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [{ type: 'text', text: 'original prompt' }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(
      screen.queryByRole('button', { name: '编辑并重发' })
    ).not.toBeInTheDocument();

    rerender(
      <MessageTurnView
        turn={
          {
            id: 'turn-1:user',
            role: 'user',
            blocks: [{ type: 'text', text: 'original prompt' }],
            timestamp: '2026-06-14T00:00:00.000Z',
          } as never
        }
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        onEditRetry={onEditRetry}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '编辑并重发' }));
    const editor = screen.getByRole('textbox', { name: '编辑用户消息' });
    fireEvent.change(editor, { target: { value: 'revised prompt' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() =>
      expect(onEditRetry).toHaveBeenCalledWith('revised prompt')
    );
  });

  it('renders user message actions as unframed icon-only buttons', () => {
    const actionButtonRule =
      conversationMessageStyles.match(
        /\.conv-user-action-btn\s*\{[^}]+\}/u
      )?.[0] ?? '';

    expect(actionButtonRule).not.toBe('');

    render(
      <>
        <style>{actionButtonRule}</style>
        <MessageTurnView
          turn={
            {
              id: 'turn-1:user',
              role: 'user',
              blocks: [{ type: 'text', text: 'original prompt' }],
              timestamp: '2026-06-14T00:00:00.000Z',
            } as never
          }
          attempt={{ id: 'attempt-1', container_ref: null } as never}
          task={null}
          onRetry={vi.fn()}
          onEditRetry={vi.fn().mockResolvedValue(true)}
        />
      </>
    );

    const actionButtons = [
      screen.getByRole('button', { name: '复制消息' }),
      screen.getByRole('button', { name: '重发' }),
      screen.getByRole('button', { name: '编辑并重发' }),
    ];

    expect(actionButtonRule).toContain('border: 0;');

    for (const button of actionButtons) {
      expect(button).toContainHTML('<svg');
      expect(button).toHaveTextContent('');
      expect(getComputedStyle(button).boxShadow).toBe('none');
    }
  });

  it('leaves interrupted status out of the timeline when it is docked above the composer', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-interrupted:user',
            role: 'user',
            blocks: [{ type: 'text', text: 'inspect the project' }],
            timestamp: '2026-07-22T00:00:00.000Z',
          } as never
        }
        phase="interrupted"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        showInterruptedNotice={false}
      />
    );

    expect(screen.getByText('inspect the project')).toBeInTheDocument();
    expect(screen.queryByText('因重启中断')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重发' })).toBeNull();
  });

  it('keeps post-tool assistant text after the tool run while streaming', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-split:assistant',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'A' },
              toolUseBlock(1, 'bash', { command: 'ls' }),
              toolUseBlock(2, 'Task', { description: 'child' }),
              { type: 'text', text: 'D' },
            ],
            timestamp: '2026-08-08T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        collapseProcess={false}
      />
    );

    expect(markdownMock.mock.calls.map((call) => call[0].value)).toEqual([
      'A',
      'D',
    ]);
    expect(
      screen.getByText('A').compareDocumentPosition(screen.getByText('D'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the streaming tool fold after earlier prose', () => {
    render(
      <MessageTurnView
        turn={{
          id: 'prose-then-tools:assistant',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'A' }, ...completedCommands(5)],
          timestamp: '2026-10-09T00:00:00.000Z',
        }}
        phase="streaming"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        collapseProcess
      />
    );

    const prose = screen.getByText('A');
    const fold = screen.getByRole('button', { name: /3 条消息$/ });
    expect(prose.compareDocumentPosition(fold)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(screen.getByText('command-3')).toBeInTheDocument();
    expect(screen.getByText('command-4')).toBeInTheDocument();
    expect(screen.queryByText('command-0')).not.toBeInTheDocument();
    expect(prose.compareDocumentPosition(screen.getByText('command-3'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('labels a settled fold with the tool wall-clock span', () => {
    render(
      <MessageTurnView
        turn={{
          id: 'timed-fold:assistant',
          role: 'assistant',
          blocks: [
            {
              type: 'tool_use',
              tool_use_id: 'read-a',
              tool_name: 'Read',
              started_at: '2026-10-19T10:00:00.000Z',
              ended_at: '2026-10-19T10:20:00.000Z',
              input_preview: JSON.stringify({ file_path: 'a.ts' }),
            },
            {
              type: 'tool_use',
              tool_use_id: 'read-b',
              tool_name: 'Read',
              started_at: '2026-10-19T10:20:00.000Z',
              ended_at: '2026-10-19T11:30:00.000Z',
              input_preview: JSON.stringify({ file_path: 'b.ts' }),
            },
            { type: 'text', text: 'Done' },
          ],
          timestamp: '1970-01-01T00:00:00.000Z',
          duration_ms: 497894n * 60n * 60n * 1000n,
          completed_at: '2026-10-19T20:00:00.000Z',
        }}
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(
      screen.getByRole('button', { name: '1 h 30 min，2 条消息' })
    ).toBeInTheDocument();
  });

  it('collapses earlier prose and running tools together after settlement', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-split:assistant',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'A' },
              toolUseBlock(1, 'bash', { command: 'ls' }),
              toolUseBlock(2, 'Task', { description: 'child' }),
              { type: 'text', text: 'D' },
            ],
            timestamp: '2026-08-08T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        collapseProcess
      />
    );

    expect(screen.getByText('D')).toBeInTheDocument();
    expect(screen.queryByText('A')).not.toBeInTheDocument();
    expect(screen.queryByText('ls')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /.* 条消息$/ }));
    expect(
      screen.getByText('A').compareDocumentPosition(screen.getByText('D'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const foldBody = screen
      .getByRole('button', { name: /.* 条消息$/ })
      .parentElement?.querySelector('.conv-nested-scroll');
    expect(foldBody).not.toBeNull();
    expect(foldBody).toHaveAttribute('data-nested-scroll');
  });

  it('does not repeat earlier prose that matches the final answer after settlement', () => {
    render(
      <MessageTurnView
        turn={{
          id: 'duplicate-prose:assistant',
          role: 'assistant',
          blocks: [
            { type: 'text', text: 'The project is ready.' },
            ...completedCommands(1),
            { type: 'text', text: 'The project is ready.' },
          ],
          timestamp: '2026-10-09T00:00:00.000Z',
        }}
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    expect(screen.getAllByText('The project is ready.')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /.* 条消息$/ }));
    fireEvent.click(screen.getByRole('button', { name: /运行 1 个命令/ }));
    expect(screen.getByText('command-0')).toBeInTheDocument();
    expect(screen.getAllByText('The project is ready.')).toHaveLength(1);
  });

  it('shows a single recent tool call without an aggregate disclosure', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-single-tool:assistant',
            role: 'assistant',
            blocks: [toolUseBlock(1, 'bash', { command: 'git status' })],
            timestamp: '2026-08-08T00:00:00.000Z',
          } as never
        }
        phase="streaming"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        collapseProcess={false}
      />
    );

    expect(screen.getByText('git status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /运行 1 个命令/ })).toBeNull();
  });

  it('summarizes a mixed consecutive run by tool category', () => {
    const blocks = [
      ...Array.from({ length: 5 }, (_, index) =>
        toolUseBlock(index, 'bash', { command: `echo ${index}` })
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        toolUseBlock(10 + index, 'Read', { file_path: `src/${index}.ts` })
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        toolUseBlock(20 + index, 'Edit', {
          file_path: `src/${index}.ts`,
          old_string: 'before',
          new_string: 'after',
        })
      ),
    ];
    const completedBlocks = blocks.flatMap((block) => [
      block,
      {
        type: 'tool_result' as const,
        tool_use_id: block.tool_use_id,
        output_preview: 'ok',
        is_error: false,
      },
    ]);

    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-mixed-tools:assistant',
            role: 'assistant',
            blocks: completedBlocks,
            timestamp: '2026-08-08T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        collapseProcess={false}
        workspacePath="/workspace/project"
      />
    );

    const disclosure = screen.getByRole('button', {
      name: '运行 5 个命令、已读 3 个文件、已改 2 个文件',
    });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getAllByRole('button', { name: /运行 \d+ 个命令/ })
    ).toHaveLength(1);

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText('终端')).toHaveLength(5);
    expect(screen.getAllByText('0.ts')).not.toHaveLength(0);
    expect(screen.getAllByText('+1')).toHaveLength(2);
    expect(screen.getAllByText('-1')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'src/0.ts' })[0]);
    expect(openFilePreviewMock).toHaveBeenCalledWith(
      '/workspace/project/src/0.ts',
      { displayPath: 'src/0.ts', title: 'src/0.ts', location: null }
    );
  });

  it('expands images viewed by the agent and opens the configured preview', async () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-viewed-image:assistant',
            role: 'assistant',
            blocks: [
              {
                ...toolUseBlock(1, 'view_image', {
                  path: 'assets/logo.png',
                }),
                kind: 'read',
                images: [
                  {
                    data: 'AAAA',
                    mime_type: 'image/png',
                    uri: 'assets/logo.png',
                  },
                ],
              },
            ],
            timestamp: '2026-08-13T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        collapseProcess={false}
        workspacePath="/workspace/project"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /已读 1 个文件/ }));
    const disclosure = screen.getByRole('button', {
      name: '已查看 1 张图像',
    });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    expect(screen.queryByRole('img', { name: 'assets/logo.png' })).toBeNull();
    fireEvent.click(disclosure);
    const image = await screen.findByRole('img', { name: 'assets/logo.png' });
    expect(image.getAttribute('src')).toMatch(
      /^(blob:|data:image\/png;base64,)/
    );

    fireEvent.click(image);
    expect(openImagePreviewMock).toHaveBeenCalledWith({
      imageUrl: image.getAttribute('src'),
      altText: 'assets/logo.png',
      fileName: 'logo.png',
    });
  });

  it('renders context compaction duration and resulting context length', () => {
    render(
      <MessageTurnView
        turn={
          {
            id: 'turn-compact:assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: '上下文已压缩' }],
            timestamp: '2026-08-08T00:00:00.000Z',
          } as never
        }
        phase="settled"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
        contextCompact={{
          status: 'success',
          durationMs: 1840,
          contextTokens: 42300,
        }}
      />
    );

    expect(screen.getByText('上下文已压缩')).toBeInTheDocument();
    expect(screen.getByText('1.8 秒')).toBeInTheDocument();
    expect(screen.getByText('42.3k tokens')).toBeInTheDocument();
    expect(markdownMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ value: '上下文已压缩' }),
      undefined
    );
  });
});
