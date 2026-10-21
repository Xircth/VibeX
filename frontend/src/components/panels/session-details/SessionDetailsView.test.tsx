import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeMode } from 'shared/types';
import { SessionDetailsView } from './SessionDetailsView';
import type { SessionDetailsModel } from './sessionDetailsModel';

vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => ({
    theme: ThemeMode.LIGHT,
    resolvedTheme: 'light',
    setTheme: () => undefined,
  }),
}));

const ready: SessionDetailsModel = {
  kind: 'ready',
  title: 'Toast 对比',
  agentId: 'grok',
  status: 'inprogress',
  model: 'Grok 4.6',
  branch: 'master',
  sessionId: '15',
  extensionId: 'ext-1',
  plan: [
    { content: '改样式', status: 'completed' },
    { content: '接线', status: 'pending' },
  ],
  activeMessageId: 'u2',
  messages: [
    {
      turnId: 'u1',
      ordinal: 1,
      preview: '第一条',
      changes: { files: [], additions: null, deletions: null },
    },
    {
      turnId: 'u2',
      ordinal: 2,
      preview: '第二条很长的预览',
      changes: {
        files: [
          {
            path: 'frontend/src/toast.tsx',
            changeKind: 'modified',
            additions: 10,
            deletions: 2,
            oldPath: null,
          },
        ],
        additions: 10,
        deletions: 2,
      },
    },
  ],
  usage: {
    totalTokens: 120,
    cacheRate: 0.5,
    truncated: true,
    itemized: true,
    contextUsed: 4000,
    contextWindowMax: 128000,
    byModel: [{ key: 'grok-4.6', label: 'Grok 4.6', tokens: 120 }],
    byMessage: [
      { turnId: 'u1', ordinal: 1, preview: '第一条', tokens: 120 },
      { turnId: 'u2', ordinal: 2, preview: '第二条很长的预览', tokens: null },
    ],
  },
};

function renderReady(onJump = vi.fn(), onOpen = vi.fn()) {
  render(
    <SessionDetailsView
      model={ready}
      onJumpToMessage={onJump}
      onOpenFile={onOpen}
      quota={<div data-testid="session-quota">额度槽</div>}
      quotaActive
    />
  );
  return { onJump, onOpen };
}

describe('SessionDetailsView', () => {
  it('shows the inspector sections and jumps from a message', () => {
    const { onJump, onOpen } = renderReady();

    expect(screen.queryByText('基础信息')).not.toBeInTheDocument();
    expect(screen.queryByText('扩展 ID')).not.toBeInTheDocument();
    expect(screen.queryByText('ext-1')).not.toBeInTheDocument();
    expect(screen.queryByText('改动概览')).not.toBeInTheDocument();
    expect(screen.getByText('Toast 对比')).toBeInTheDocument();
    expect(screen.getByText('Grok')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(document.querySelector('img[alt="Grok"]')).toBeTruthy();
    expect(
      document.querySelector('.workspace-session-status--inprogress')
    ).toBeTruthy();
    const card = document.querySelector(
      '[data-panel="session-details"] section'
    );
    expect(card).toHaveClass('bg-[var(--surface-card)]', 'shadow-none');
    expect(card).not.toHaveClass('settings-surface');
    expect(screen.getByText('模型')).toBeInTheDocument();
    expect(screen.getByText('Git 分支')).toBeInTheDocument();
    expect(screen.getByText('会话 ID')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.getByText('计划任务')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('改样式')).toBeInTheDocument();
    expect(screen.getByText('消息导航')).toBeInTheDocument();
    expect(screen.getByTestId('session-message-nav')).toHaveClass(
      'max-h-48',
      'overflow-y-auto'
    );
    expect(screen.getByText('toast.tsx')).toBeInTheDocument();
    const usageCard = screen.getByTestId('session-usage-card');
    expect(usageCard).toHaveTextContent('用量概览');
    expect(usageCard.querySelector('h3')?.parentElement).toContainElement(
      screen.getByRole('radio', { name: '按模型' })
    );
    const totalTokens = screen.getByTestId('session-total-tokens');
    expect(totalTokens).toHaveTextContent('120');
    expect(totalTokens).toHaveTextContent('总 Token');
    const totalNumber = totalTokens.querySelector('strong');
    const totalLabel = totalTokens.querySelector('div');
    expect(totalNumber).toHaveClass('kanban-usage-stat__value');
    expect(totalNumber?.nextElementSibling).toBe(totalLabel);
    expect(totalLabel).toHaveTextContent('总 Token');
    const modelList = screen.getByTestId('session-usage-list');
    expect(modelList.tagName).toBe('DIV');
    expect(modelList).toHaveClass('border', 'bg-background');
    expect(
      modelList.querySelector('[class*="rounded-full"]')
    ).toHaveTextContent('120');
    const cacheRate = screen.getByTestId('session-cache-rate');
    expect(cacheRate).toHaveTextContent('50%');
    expect(cacheRate).toHaveTextContent('缓存率');
    expect(
      screen.getByRole('img', { name: '缓存率: 50%' })
    ).toBeInTheDocument();
    expect(usageCard).not.toHaveTextContent('上下文占用');
    expect(usageCard).not.toHaveTextContent('4,000');
    expect(usageCard).not.toHaveTextContent('套餐用量');
    expect(screen.getByText('列表只包含已加载的消息')).toBeInTheDocument();
    const quotaCard = screen.getByTestId('session-quota-card');
    expect(quotaCard).toHaveTextContent('套餐用量');
    expect(quotaCard).toContainElement(screen.getByTestId('session-quota'));
    expect(usageCard).not.toContainElement(screen.getByTestId('session-quota'));

    fireEvent.click(screen.getByRole('button', { name: /toast\.tsx/ }));
    expect(onOpen).toHaveBeenCalledWith('frontend/src/toast.tsx');

    fireEvent.click(screen.getByRole('button', { name: '跳转到第 1 条消息' }));
    expect(onJump).toHaveBeenCalledWith('u1');
  });

  it('switches the token list between model and message', () => {
    renderReady();

    expect(screen.getByTestId('session-usage-list')).not.toHaveClass(
      'max-h-48'
    );
    fireEvent.click(screen.getByRole('radio', { name: '按消息' }));
    const list = screen.getByTestId('session-usage-list');
    expect(list).toHaveClass('max-h-48', 'overflow-y-auto', 'border');
    expect(list).toHaveTextContent('第二条很长的预览');
    expect(
      Array.from(
        list.querySelectorAll('[class*="rounded-full"]'),
        (node) => node.textContent
      )
    ).toEqual(['120', '—']);
  });

  it('hides cards and facts that have no information', () => {
    render(
      <SessionDetailsView
        model={{
          ...ready,
          title: null,
          agentId: null,
          status: null,
          model: null,
          branch: null,
          extensionId: null,
          plan: [],
          activeMessageId: null,
          messages: [],
          usage: {
            totalTokens: null,
            cacheRate: null,
            truncated: false,
            itemized: false,
            contextUsed: 4000,
            contextWindowMax: 128000,
            byModel: [],
            byMessage: [],
          },
        }}
        onJumpToMessage={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    expect(screen.getByText('未命名会话')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
    expect(screen.queryByText('模型')).not.toBeInTheDocument();
    expect(screen.queryByText('Git 分支')).not.toBeInTheDocument();
    expect(screen.queryByText('扩展 ID')).not.toBeInTheDocument();
    expect(screen.queryByText('计划任务')).not.toBeInTheDocument();
    expect(screen.queryByText('消息导航')).not.toBeInTheDocument();
    expect(screen.queryByText('改动概览')).not.toBeInTheDocument();
    expect(screen.queryByText('用量概览')).not.toBeInTheDocument();
    expect(screen.queryByText('套餐用量')).not.toBeInTheDocument();
  });

  it('keeps the plan probe mounted before a subscription is confirmed', () => {
    render(
      <SessionDetailsView
        model={ready}
        quota={<div data-testid="session-quota">额度槽</div>}
        onJumpToMessage={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    expect(screen.getByTestId('session-quota')).toBeInTheDocument();
    expect(screen.getByTestId('session-quota-card')).toHaveAttribute('hidden');
  });

  it('shows plan usage on its own card when the session has no token spend', () => {
    render(
      <SessionDetailsView
        model={{
          ...ready,
          usage: {
            ...ready.usage,
            totalTokens: null,
            cacheRate: null,
            byModel: [],
            byMessage: [],
          },
        }}
        quota={<div data-testid="session-quota">额度槽</div>}
        quotaActive
        onJumpToMessage={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    expect(screen.queryByTestId('session-usage-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-quota-card')).toHaveTextContent(
      '套餐用量'
    );
  });

  it('says when no conversation is open', () => {
    render(
      <SessionDetailsView
        model={{ kind: 'empty' }}
        onJumpToMessage={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );
    expect(screen.getByText('当前没有打开的会话。')).toBeInTheDocument();
  });

  it('shows a completed status lamp and folds file changes into the open message', () => {
    render(
      <SessionDetailsView
        model={{ ...ready, status: 'done' }}
        onJumpToMessage={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );

    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(
      document.querySelector('.workspace-session-status--done')
    ).toBeTruthy();
    expect(screen.getByText('toast.tsx')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /消息导航/ }));
    expect(screen.queryByText('toast.tsx')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /消息导航/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});
