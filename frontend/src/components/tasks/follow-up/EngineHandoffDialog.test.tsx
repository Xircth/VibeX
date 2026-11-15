import { fireEvent, render, screen } from '@testing-library/react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { describe, expect, it, vi } from 'vitest';
import {
  EngineHandoffDialog,
  type EngineHandoffPreviewData,
} from './EngineHandoffDialog';

const SAMPLE_PREVIEW: EngineHandoffPreviewData = {
  sourceEngine: 'Claude',
  targetEngine: 'Codex',
  totalTokens: 12000,
  tokenBudget: 40000,
  packedMessages: [
    {
      id: 'msg-1',
      role: 'user',
      content: '帮我重构这个模块并抽取清晰的接口边界',
      sortIndex: 1,
    },
    {
      id: 'msg-2',
      role: 'assistant',
      content: '好的，先梳理依赖关系。',
      sortIndex: 2,
    },
    {
      id: 'msg-3',
      role: 'user',
      content: '请补充单元测试',
      sortIndex: 3,
    },
    {
      id: 'msg-4',
      role: 'user',
      content: '继续处理错误处理部分',
      sortIndex: 4,
    },
    {
      id: 'msg-5',
      role: 'assistant',
      content: '已完成 Result 类型定义，接下来处理错误映射。',
      sortIndex: 5,
    },
  ],
  omittedIds: ['old-1', 'old-2', 'old-3', 'old-4'],
};

describe('EngineHandoffDialog', () => {
  it('renders token budget with tabular-nums, packed message summary, omitted MCP count, expandable preview, and confirm/cancel actions', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <HotkeysProvider
        initiallyActiveScopes={['dialog', 'kanban', 'projects']}
      >
        <EngineHandoffDialog
          open
          preview={SAMPLE_PREVIEW}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </HotkeysProvider>
    );

    const dialog = await screen.findByTestId('engine-handoff-dialog');
    expect(dialog).toHaveTextContent('Claude');
    expect(dialog).toHaveTextContent('Codex');

    const budgetEl = screen.getByTestId('handoff-token-budget');
    expect(budgetEl).toHaveClass('tabular-nums');
    expect(budgetEl).toHaveTextContent('12,000 / 40,000 (30%)');

    expect(screen.getByTestId('handoff-first-user')).toHaveTextContent(
      '帮我重构这个模块并抽取清晰的接口边界'
    );
    expect(screen.getByTestId('handoff-last-user')).toHaveTextContent(
      '继续处理错误处理部分'
    );
    expect(screen.getByTestId('handoff-last-assistant')).toHaveTextContent(
      '已完成 Result 类型定义，接下来处理错误映射。'
    );
    expect(screen.getByTestId('handoff-recent-count')).toHaveTextContent('2');

    const omittedWarning = screen.getByTestId('handoff-omitted-warning');
    expect(omittedWarning).toHaveTextContent('4');
    expect(omittedWarning).toHaveTextContent('MCP');

    expect(screen.queryByTestId('handoff-preview-content')).toBeNull();
    fireEvent.click(screen.getByTestId('handoff-preview-toggle'));

    const previewPre = screen.getByTestId('handoff-preview-content');
    expect(previewPre).toHaveTextContent('[VibeX Context Handoff]');
    expect(previewPre).toHaveTextContent('item_id: msg-1');
    expect(previewPre).toHaveTextContent('thread_read_history');
    expect(previewPre).toHaveTextContent('old-1, old-2, old-3, old-4');

    fireEvent.click(screen.getByTestId('handoff-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('handoff-cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
